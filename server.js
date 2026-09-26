const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const multer = require('multer');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const SONGS_FILE = path.join(DATA_DIR, 'songs.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');
const AUDIO_DIR = path.join(__dirname, 'uploads', 'audio');
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');

[DATA_DIR, UPLOADS_DIR, COVERS_DIR, AUDIO_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================================
// Auto-install yt-dlp on startup
// ============================================================
let ytdlpReady = false;

async function ensureYtDlp() {
  // Check if already available
  for (const p of ['yt-dlp', '/usr/local/bin/yt-dlp', YTDLP_PATH]) {
    try {
      await execAsync(`"${p}" --version`);
      console.log(`✅ yt-dlp found: ${p}`);
      ytdlpReady = p;
      return p;
    } catch {}
  }

  // Not found – download it
  console.log('⬇️ yt-dlp not found, downloading automatically...');
  
  // Try with curl first (Linux/Render)
  try {
    await execAsync('curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp', { timeout: 60000 });
    await execAsync('/usr/local/bin/yt-dlp --version');
    console.log('✅ yt-dlp installed via curl to /usr/local/bin');
    ytdlpReady = '/usr/local/bin/yt-dlp';
    return '/usr/local/bin/yt-dlp';
  } catch (e) {
    console.warn('curl to /usr/local/bin failed, trying local download:', e.message);
  }

  // Fallback: download to local project dir
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(YTDLP_PATH);
      const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
      https.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          https.get(res.headers.location, (res2) => {
            res2.pipe(file);
            file.on('finish', resolve);
          }).on('error', reject);
        } else {
          res.pipe(file);
          file.on('finish', resolve);
        }
      }).on('error', reject);
    });
    fs.chmodSync(YTDLP_PATH, '755');
    await execAsync(`"${YTDLP_PATH}" --version`, { timeout: 10000 });
    console.log(`✅ yt-dlp downloaded locally to ${YTDLP_PATH}`);
    ytdlpReady = YTDLP_PATH;
    return YTDLP_PATH;
  } catch (e) {
    console.error('❌ yt-dlp auto-install failed:', e.message);
    return null;
  }
}

// ============================================================
// Middleware
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ============================================================
// Song database helpers
// ============================================================
function loadSongs() {
  if (!fs.existsSync(SONGS_FILE)) {
    const initialSongs = [{
      id: 'sample-1',
      title: 'Synthwave Chillout',
      artist: 'Antigravity Audio',
      album: 'Chill Vibes Vol. 1',
      duration: 124,
      fileName: 'sample-1.mp3',
      coverUrl: '/uploads/covers/default.jpg',
      audioUrl: '/api/stream/sample-1',
      addedAt: new Date().toISOString()
    }];
    fs.writeFileSync(SONGS_FILE, JSON.stringify(initialSongs, null, 2));
    return initialSongs;
  }
  try {
    return JSON.parse(fs.readFileSync(SONGS_FILE, 'utf-8'));
  } catch { return []; }
}

function saveSongs(songs) {
  fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2));
}

// ============================================================
// Multer
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === 'audio' ? AUDIO_DIR : COVERS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ============================================================
// Routes
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ytdlp: ytdlpReady ? 'ready' : 'not_ready', timestamp: new Date() });
});

app.get('/api/songs', (req, res) => res.json(loadSongs()));

// Audio streaming with Range support
app.get('/api/stream/:id', (req, res) => {
  const song = loadSongs().find(s => s.id === req.params.id);
  if (!song) return res.status(404).send('Song not found');

  const filePath = path.join(AUDIO_DIR, song.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).send('Audio file missing');

  const { size: fileSize } = fs.statSync(filePath);
  const range = req.headers.range;

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'audio/mpeg'
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'audio/mpeg' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// YouTube Import via yt-dlp
app.post('/api/youtube-import', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL fehlt' });

  const videoIdMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:.*[?&]v=|embed\/|v\/))([\w-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : url.match(/[\w-]{11}/)?.[0];
  if (!videoId) return res.status(400).json({ error: 'Ungültige YouTube URL' });

  const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Make sure yt-dlp is ready
  if (!ytdlpReady) {
    console.log('[yt-dlp] Not ready, trying install now...');
    const p = await ensureYtDlp();
    if (!p) return res.status(500).json({ error: 'yt-dlp konnte nicht installiert werden. Bitte lade eine MP3-Datei direkt hoch.' });
  }

  const songId = 'yt-' + Date.now();
  const outputTemplate = path.join(AUDIO_DIR, `${songId}.%(ext)s`);
  const finalMp3 = path.join(AUDIO_DIR, `${songId}.mp3`);

  try {
    // Get metadata
    console.log(`[yt-dlp] Fetching info for ${videoId}...`);
    const { stdout: metaOut } = await execAsync(`"${ytdlpReady}" --dump-json --no-playlist "${cleanUrl}"`, { timeout: 30000 });
    const meta = JSON.parse(metaOut);

    const title = meta.title || 'YouTube Track';
    const artist = meta.uploader || meta.channel || 'YouTube Artist';
    const duration = meta.duration || 0;
    const coverUrl = meta.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // Download as mp3
    console.log(`[yt-dlp] Downloading "${title}"...`);
    const dlCmd = `"${ytdlpReady}" -x --audio-format mp3 --audio-quality 0 --no-playlist -o "${outputTemplate}" "${cleanUrl}"`;
    await execAsync(dlCmd, { timeout: 180000 });

    // Find the downloaded file (might be .mp3 or .webm)
    let downloadedFile = finalMp3;
    if (!fs.existsSync(finalMp3)) {
      const candidates = fs.readdirSync(AUDIO_DIR).filter(f => f.startsWith(songId));
      if (candidates.length === 0) return res.status(500).json({ error: 'Audio-Datei nach dem Download nicht gefunden' });
      const srcFile = path.join(AUDIO_DIR, candidates[0]);
      fs.renameSync(srcFile, finalMp3);
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

    console.log(`[yt-dlp] ✅ Done: "${title}"`);
    res.status(201).json(newSong);

  } catch (err) {
    console.error('[yt-dlp] Error:', err.message);
    try {
      fs.readdirSync(AUDIO_DIR).filter(f => f.startsWith(songId)).forEach(f => fs.unlinkSync(path.join(AUDIO_DIR, f)));
    } catch {}
    res.status(500).json({ error: 'YouTube Download fehlgeschlagen. Bitte lade die MP3 direkt hoch.' });
  }
});

// File upload
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
    res.status(500).json({ error: err.message });
  }
});

// Delete song
app.delete('/api/songs/:id', (req, res) => {
  let songs = loadSongs();
  const idx = songs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [song] = songs.splice(idx, 1);
  saveSongs(songs);
  const audioPath = path.join(AUDIO_DIR, song.fileName);
  if (fs.existsSync(audioPath)) fs.unlink(audioPath, () => {});
  res.json({ success: true });
});

// Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Start server and auto-install yt-dlp
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Music Server running on http://localhost:${PORT}`);
  ensureYtDlp().catch(err => console.error('yt-dlp setup failed:', err));
});
