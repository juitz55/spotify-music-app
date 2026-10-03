const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

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
    const s = [];
    fs.writeFileSync(SONGS_FILE, JSON.stringify(s, null, 2));
    return s;
  }
  try { return JSON.parse(fs.readFileSync(SONGS_FILE, 'utf-8')); }
  catch { return []; }
}
function saveSongs(songs) {
  fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2));
}

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

// Health check - also returns server info
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date(), songs: loadSongs().length });
});

app.get('/api/songs', (req, res) => {
  try {
    res.json(loadSongs());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stream with Range support
app.get('/api/stream/:id', (req, res) => {
  try {
    const song = loadSongs().find(s => s.id === req.params.id);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    const filePath = path.join(AUDIO_DIR, song.fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(s, 10), end = e ? parseInt(e, 10) : fileSize - 1;
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// YouTube info only (metadata - this works even on cloud)
app.post('/api/youtube-info', async (req, res) => {
  try {
    const { url } = req.body;
    const videoId = extractVideoId(url || '');
    if (!videoId) return res.status(400).json({ error: 'Ungültige URL' });

    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);
    if (!response.ok) return res.status(400).json({ error: 'Video nicht gefunden' });
    const data = await response.json();

    res.json({
      videoId,
      title: data.title || 'YouTube Track',
      artist: data.author_name || 'YouTube Artist',
      coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload MP3 from client (after client-side YouTube extraction OR direct upload)
app.post('/api/upload', upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]), (req, res) => {
  try {
    if (!req.files?.audio) return res.status(400).json({ error: 'Keine Audio-Datei' });
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
      coverUrl: coverFile ? `/uploads/covers/${coverFile.filename}` : (req.body.coverUrl || '/uploads/covers/default.jpg'),
      audioUrl: `/api/stream/${songId}`,
      addedAt: new Date().toISOString()
    };

    const songs = loadSongs();
    songs.unshift(newSong);
    saveSongs(songs);
    res.status(201).json(newSong);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete song
app.delete('/api/songs/:id', (req, res) => {
  try {
    let songs = loadSongs();
    const idx = songs.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const [song] = songs.splice(idx, 1);
    saveSongs(songs);
    const p = path.join(AUDIO_DIR, song.fileName);
    if (fs.existsSync(p)) fs.unlink(p, () => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Music Server on http://localhost:${PORT}`);
});
