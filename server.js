const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const SONGS_FILE = path.join(DATA_DIR, 'songs.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');
const AUDIO_DIR = path.join(__dirname, 'uploads', 'audio');

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR, COVERS_DIR, AUDIO_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Detect yt-dlp binary path
async function getYtDlpPath() {
  const candidates = ['yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', path.join(__dirname, 'yt-dlp')];
  for (const c of candidates) {
    try {
      await execAsync(`"${c}" --version`);
      return c;
    } catch {}
  }
  return null;
}

// Storage helper
function loadSongs() {
  if (!fs.existsSync(SONGS_FILE)) {
    const initialSongs = [
      {
        id: 'sample-1',
        title: 'Synthwave Chillout',
        artist: 'Antigravity Audio',
        album: 'Chill Vibes Vol. 1',
        duration: 124,
        fileName: 'sample-1.mp3',
        coverUrl: '/uploads/covers/default.jpg',
        audioUrl: '/api/stream/sample-1',
        addedAt: new Date().toISOString()
      }
    ];
    fs.writeFileSync(SONGS_FILE, JSON.stringify(initialSongs, null, 2));
    return initialSongs;
  }
  try {
    return JSON.parse(fs.readFileSync(SONGS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveSongs(songs) {
  fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2));
}

// Multer Config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, file.fieldname === 'audio' ? AUDIO_DIR : COVERS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.get('/api/songs', (req, res) => {
  res.json(loadSongs());
});

// Stream audio with Range support
app.get('/api/stream/:id', (req, res) => {
  const song = loadSongs().find(s => s.id === req.params.id);
  if (!song) return res.status(404).send('Song not found');

  const filePath = path.join(AUDIO_DIR, song.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).send('Audio file missing');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunksize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'audio/mpeg',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'audio/mpeg' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ============================================================
// YouTube Import via yt-dlp (most reliable method)
// ============================================================
app.post('/api/youtube-import', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL fehlt' });

  const videoIdMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:.*[?&]v=|embed\/|v\/))([\w-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;
  if (!videoId) return res.status(400).json({ error: 'Ungültige YouTube URL' });

  const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const songId = 'yt-' + Date.now();
  const outputTemplate = path.join(AUDIO_DIR, `${songId}.%(ext)s`);
  const finalFile = path.join(AUDIO_DIR, `${songId}.mp3`);

  try {
    const ytdlpPath = await getYtDlpPath();
    if (!ytdlpPath) {
      return res.status(500).json({ error: 'yt-dlp ist nicht installiert auf dem Server' });
    }

    // Get video metadata first
    const metaCmd = `"${ytdlpPath}" --dump-json --no-playlist "${cleanUrl}"`;
    const { stdout: metaOut } = await execAsync(metaCmd, { timeout: 30000 });
    const meta = JSON.parse(metaOut);

    const title = meta.title || 'YouTube Track';
    const artist = meta.uploader || meta.channel || 'YouTube Artist';
    const duration = meta.duration || 0;
    const coverUrl = meta.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // Download best audio as mp3
    const dlCmd = `"${ytdlpPath}" -x --audio-format mp3 --audio-quality 0 --no-playlist -o "${outputTemplate}" "${cleanUrl}"`;
    console.log(`[yt-dlp] Downloading: ${cleanUrl}`);
    await execAsync(dlCmd, { timeout: 120000 });

    // Handle .webm → mp3 naming
    let actualFile = finalFile;
    if (!fs.existsSync(finalFile)) {
      const webmFile = path.join(AUDIO_DIR, `${songId}.webm`);
      if (fs.existsSync(webmFile)) {
        fs.renameSync(webmFile, finalFile);
        actualFile = finalFile;
      } else {
        return res.status(500).json({ error: 'Audio-Datei nach dem Download nicht gefunden' });
      }
    }

    const newSong = {
      id: songId,
      title,
      artist,
      album: 'YouTube Import',
      duration,
      fileName: `${songId}.mp3`,
      coverUrl,
      audioUrl: `/api/stream/${songId}`,
      addedAt: new Date().toISOString()
    };

    const songs = loadSongs();
    songs.unshift(newSong);
    saveSongs(songs);

    console.log(`[yt-dlp] Done: "${title}"`);
    res.status(201).json(newSong);

  } catch (err) {
    console.error('[yt-dlp] Error:', err.message);
    // Clean up partial files
    try {
      [finalFile, path.join(AUDIO_DIR, `${songId}.webm`)].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    } catch {}
    res.status(500).json({ error: 'YouTube Download fehlgeschlagen: ' + err.message.split('\n')[0] });
  }
});

// Upload song
app.post('/api/upload', upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  try {
    if (!req.files?.audio) return res.status(400).json({ error: 'Audio file required' });

    const audioFile = req.files.audio[0];
    const coverFile = req.files.cover?.[0];
    const songId = 'song-' + Date.now();

    const newSong = {
      id: songId,
      title: req.body.title || path.basename(audioFile.originalname, path.extname(audioFile.originalname)),
      artist: req.body.artist || 'Unknown Artist',
      album: req.body.album || 'Single',
      duration: parseFloat(req.body.duration) || 0,
      fileName: audioFile.filename,
      coverUrl: coverFile ? `/uploads/covers/${coverFile.filename}` : '/uploads/covers/default.jpg',
      audioUrl: `/api/stream/${songId}`,
      addedAt: new Date().toISOString()
    };

    const songs = loadSongs();
    songs.unshift(newSong);
    saveSongs(songs);
    res.status(201).json(newSong);
  } catch (err) {
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// Delete song
app.delete('/api/songs/:id', (req, res) => {
  let songs = loadSongs();
  const idx = songs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Song not found' });

  const [song] = songs.splice(idx, 1);
  saveSongs(songs);

  const audioPath = path.join(AUDIO_DIR, song.fileName);
  if (fs.existsSync(audioPath)) fs.unlink(audioPath, () => {});

  res.json({ success: true, deletedId: req.params.id });
});

// Fallback to PWA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Music Server running on http://localhost:${PORT}`);
  getYtDlpPath().then(p => {
    if (p) console.log(`✅ yt-dlp found at: ${p}`);
    else console.warn('⚠️ yt-dlp not found! YouTube import will not work.');
  });
});
