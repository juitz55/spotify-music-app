const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ytdl = require('@distube/ytdl-core');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const SONGS_FILE = path.join(DATA_DIR, 'songs.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');
const AUDIO_DIR = path.join(UPLOADS_DIR, 'audio');

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
    const data = fs.readFileSync(SONGS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading songs.json:', err);
    return [];
  }
}

function saveSongs(songs) {
  fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2));
}

// Multer Config for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'audio') {
      cb(null, AUDIO_DIR);
    } else if (file.fieldname === 'cover') {
      cb(null, COVERS_DIR);
    } else {
      cb(null, UPLOADS_DIR);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max per song
});

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.get('/api/songs', (req, res) => {
  const songs = loadSongs();
  res.json(songs);
});

// Stream audio with HTTP Range support
app.get('/api/stream/:id', (req, res) => {
  const songs = loadSongs();
  const song = songs.find(s => s.id === req.params.id);

  if (!song) {
    return res.status(404).send('Song not found');
  }

  const filePath = path.join(AUDIO_DIR, song.fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Audio file missing');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'audio/mpeg',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'audio/mpeg',
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// YouTube Import Endpoint
app.post('/api/youtube-import', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'YouTube URL ist erforderlich' });
    }

    const cleanUrl = url.trim();
    if (!ytdl.validateURL(cleanUrl)) {
      return res.status(400).json({ error: 'Ungültige YouTube URL (z.B. https://youtu.be/...)' });
    }

    console.log(`[YouTube Import] Fetching info for ${cleanUrl}...`);
    const info = await ytdl.getInfo(cleanUrl);

    const title = info.videoDetails.title || 'YouTube Audio';
    const artist = info.videoDetails.author?.name || info.videoDetails.ownerChannelName || 'YouTube Artist';
    const duration = parseInt(info.videoDetails.lengthSeconds) || 0;
    const thumbnails = info.videoDetails.thumbnails || [];
    const coverUrl = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : '/uploads/covers/default.jpg';

    const songId = 'yt-' + Date.now();
    const fileName = `${songId}.mp3`;
    const audioFilePath = path.join(AUDIO_DIR, fileName);

    console.log(`[YouTube Import] Downloading audio to ${fileName}...`);
    const stream = ytdl(cleanUrl, {
      quality: 'highestaudio',
      filter: 'audioonly'
    });

    const fileStream = fs.createWriteStream(audioFilePath);
    stream.pipe(fileStream);

    fileStream.on('finish', () => {
      console.log(`[YouTube Import] Finished saving ${fileName}`);
      const songs = loadSongs();
      const newSong = {
        id: songId,
        title: title,
        artist: artist,
        album: 'YouTube Import',
        duration: duration,
        fileName: fileName,
        coverUrl: coverUrl,
        audioUrl: `/api/stream/${songId}`,
        addedAt: new Date().toISOString()
      };

      songs.unshift(newSong);
      saveSongs(songs);
      res.status(201).json(newSong);
    });

    fileStream.on('error', (err) => {
      console.error('[YouTube Import] File stream error:', err);
      res.status(500).json({ error: 'Fehler beim Speichern der Audio-Datei' });
    });

    stream.on('error', (err) => {
      console.error('[YouTube Import] YTDL Stream error:', err);
      res.status(500).json({ error: 'YouTube Stream konnte nicht geladen werden: ' + err.message });
    });

  } catch (err) {
    console.error('[YouTube Import] Exception:', err);
    res.status(500).json({ error: 'YouTube Import fehlgeschlagen: ' + err.message });
  }
});

// Upload song endpoint
app.post('/api/upload', upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]), (req, res) => {
  try {
    if (!req.files || !req.files.audio) {
      return res.status(400).json({ error: 'Audio file is required' });
    }

    const audioFile = req.files.audio[0];
    const coverFile = req.files.cover ? req.files.cover[0] : null;

    const songs = loadSongs();
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

    songs.unshift(newSong);
    saveSongs(songs);

    res.status(201).json(newSong);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to upload song' });
  }
});

// Delete song
app.delete('/api/songs/:id', (req, res) => {
  let songs = loadSongs();
  const songIndex = songs.findIndex(s => s.id === req.params.id);

  if (songIndex === -1) {
    return res.status(404).json({ error: 'Song not found' });
  }

  const [song] = songs.splice(songIndex, 1);
  saveSongs(songs);

  // Delete audio file asynchronously
  const audioPath = path.join(AUDIO_DIR, song.fileName);
  if (fs.existsSync(audioPath)) {
    fs.unlink(audioPath, (err) => { if (err) console.error(err); });
  }

  res.json({ success: true, deletedId: req.params.id });
});

// Fallback to PWA index.html for unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Spotify-Style Music Server running on http://localhost:${PORT}`);
});
