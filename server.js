const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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
const AUDIO_DIR = path.join(UPLOADS_DIR, 'audio');

[DATA_DIR, UPLOADS_DIR, COVERS_DIR, AUDIO_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

function loadSongs() {
  if (!fs.existsSync(SONGS_FILE)) {
    const s = [{ id: 'sample-1', title: 'Synthwave Chillout', artist: 'Antigravity Audio', album: 'Chill Vibes', duration: 124, fileName: 'sample-1.mp3', coverUrl: '/uploads/covers/default.jpg', audioUrl: '/api/stream/sample-1', addedAt: new Date().toISOString() }];
    fs.writeFileSync(SONGS_FILE, JSON.stringify(s, null, 2));
    return s;
  }
  try { return JSON.parse(fs.readFileSync(SONGS_FILE, 'utf-8')); } catch { return []; }
}
function saveSongs(songs) { fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2)); }

function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:.*[?&]v=|embed\/|v\/))([\w-]{11})/);
  return m ? m[1] : (/^[\w-]{11}$/.test(url.trim()) ? url.trim() : null);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === 'audio' ? AUDIO_DIR : COVERS_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.get('/api/songs', (req, res) => res.json(loadSongs()));

app.get('/api/stream/:id', (req, res) => {
  const song = loadSongs().find(s => s.id === req.params.id);
  if (!song) return res.status(404).send('Not found');
  const filePath = path.join(AUDIO_DIR, song.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).send('Missing');
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10), end = e ? parseInt(e, 10) : fileSize - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'audio/mpeg' });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'audio/mpeg' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// yt-dlp YouTube Download
app.post('/api/youtube-import', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL fehlt' });
  const videoId = extractVideoId(url.trim());
  if (!videoId) return res.status(400).json({ error: 'Ungültige YouTube URL' });

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const songId = 'yt-' + Date.now();
  const outTemplate = path.join(AUDIO_DIR, `${songId}.%(ext)s`);
  const finalMp3 = path.join(AUDIO_DIR, `${songId}.mp3`);

  // Try multiple yt-dlp strategies
  const strategies = [
    // Strategy 1: Android client (bypasses many blocks)
    `yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 0 --extractor-args "youtube:player_client=android" -o "${outTemplate}" "${ytUrl}"`,
    // Strategy 2: Web embedded player
    `yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 0 --extractor-args "youtube:player_client=web_embedded" -o "${outTemplate}" "${ytUrl}"`,
    // Strategy 3: TV client
    `yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 0 --extractor-args "youtube:player_client=tv_embedded" -o "${outTemplate}" "${ytUrl}"`,
    // Strategy 4: iOS client  
    `yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 0 --extractor-args "youtube:player_client=ios" -o "${outTemplate}" "${ytUrl}"`,
  ];

  // Get metadata first
  let title = 'YouTube Track', artist = 'YouTube Artist', duration = 0;
  try {
    const { stdout } = await execAsync(`yt-dlp --dump-json --no-playlist --skip-download "${ytUrl}"`, { timeout: 20000 });
    const meta = JSON.parse(stdout);
    title = meta.title || title;
    artist = meta.uploader || meta.channel || artist;
    duration = meta.duration || 0;
  } catch (e) {
    console.warn('[yt-dlp] Metadata fetch failed, continuing with defaults');
  }

  let downloaded = false;
  for (const cmd of strategies) {
    try {
      console.log(`[yt-dlp] Trying: ${cmd.slice(0, 80)}...`);
      await execAsync(cmd, { timeout: 120000 });
      
      // Check for output file (various extensions)
      for (const ext of ['mp3', 'm4a', 'webm', 'opus', 'ogg']) {
        const candidate = path.join(AUDIO_DIR, `${songId}.${ext}`);
        if (fs.existsSync(candidate)) {
          if (candidate !== finalMp3) fs.renameSync(candidate, finalMp3);
          downloaded = true;
          break;
        }
      }
      if (downloaded) { console.log('[yt-dlp] Download succeeded!'); break; }
    } catch (e) {
      console.warn(`[yt-dlp] Strategy failed: ${e.message.slice(0, 100)}`);
    }
  }

  if (!downloaded) {
    return res.status(500).json({ 
      error: 'YouTube Download fehlgeschlagen. YouTube blockiert Cloud-Server. Bitte MP3 direkt hochladen (Button "MP3 Hochladen").' 
    });
  }

  const newSong = {
    id: songId, title, artist, album: 'YouTube Import', duration,
    fileName: `${songId}.mp3`,
    coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    audioUrl: `/api/stream/${songId}`,
    addedAt: new Date().toISOString()
  };
  const songs = loadSongs();
  songs.unshift(newSong);
  saveSongs(songs);
  res.status(201).json(newSong);
});

app.post('/api/upload', upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  try {
    if (!req.files?.audio) return res.status(400).json({ error: 'Audio fehlt' });
    const audioFile = req.files.audio[0];
    const coverFile = req.files.cover?.[0];
    const songId = 'song-' + Date.now();
    const newSong = {
      id: songId,
      title: req.body.title || path.basename(audioFile.originalname, path.extname(audioFile.originalname)),
      artist: req.body.artist || 'Unbekannt',
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/songs/:id', (req, res) => {
  let songs = loadSongs();
  const idx = songs.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [song] = songs.splice(idx, 1);
  saveSongs(songs);
  const p = path.join(AUDIO_DIR, song.fileName);
  if (fs.existsSync(p)) fs.unlink(p, () => {});
  res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Music Server on http://localhost:${PORT}`);
  execAsync('yt-dlp --version').then(({stdout}) => console.log('✅ yt-dlp:', stdout.trim())).catch(() => console.warn('⚠️ yt-dlp not found!'));
});
