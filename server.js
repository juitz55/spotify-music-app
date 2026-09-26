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

// Helper: Extract YouTube Video ID
function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return match ? match[1] : null;
}

// Multi-Layer YouTube Downloader (Cobalt + Invidious + Piped + oEmbed)
async function fetchYouTubeViaAPI(url, videoId) {
  // Layer 1: Cobalt API
  try {
    console.log(`[YouTube API] Trying Cobalt API for videoId ${videoId}...`);
    const cobaltRes = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        downloadMode: 'audio',
        audioFormat: 'mp3'
      })
    });

    if (cobaltRes.ok) {
      const data = await cobaltRes.json();
      if (data && data.url) {
        let title = 'YouTube Audio';
        let author = 'YouTube Artist';
        const cover = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        try {
          const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
          if (oembedRes.ok) {
            const oembed = await oembedRes.json();
            title = oembed.title || title;
            author = oembed.author_name || author;
          }
        } catch (e) {}

        console.log(`[YouTube API] Cobalt succeeded for "${title}"`);
        return {
          title,
          artist: author,
          duration: 0,
          coverUrl: cover,
          streamUrl: data.url
        };
      }
    }
  } catch (err) {
    console.warn('[YouTube API] Cobalt API error:', err.message);
  }

  // Layer 2: Invidious API
  const invidiousInstances = [
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
    `https://inv.tux.pizza/api/v1/videos/${videoId}`,
    `https://invidious.drgns.space/api/v1/videos/${videoId}`,
    `https://vid.puffyan.us/api/v1/videos/${videoId}`
  ];

  for (const invUrl of invidiousInstances) {
    try {
      console.log(`[YouTube API] Trying Invidious API ${invUrl}...`);
      const invRes = await fetch(invUrl);
      if (invRes.ok) {
        const data = await invRes.json();
        if (data && data.adaptiveFormats) {
          const audio = data.adaptiveFormats.find(f => f.type && f.type.includes('audio/'));
          if (audio && audio.url) {
            console.log(`[YouTube API] Invidious succeeded for "${data.title}"`);
            return {
              title: data.title || 'YouTube Audio',
              artist: data.author || 'YouTube Artist',
              duration: parseInt(data.lengthSeconds) || 0,
              coverUrl: (data.videoThumbnails && data.videoThumbnails.length > 0) ? data.videoThumbnails[0].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              streamUrl: audio.url
            };
          }
        }
      }
    } catch (e) {
      console.warn(`[YouTube API] Invidious ${invUrl} failed:`, e.message);
    }
  }

  // Layer 3: Piped API
  const pipedInstances = [
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://api.piped.privacydev.net/streams/${videoId}`,
    `https://pipedapi.palvelintila.fi/streams/${videoId}`,
    `https://pipedapi.adminforge.de/streams/${videoId}`
  ];

  for (const pipedUrl of pipedInstances) {
    try {
      console.log(`[YouTube API] Trying Piped API ${pipedUrl}...`);
      const pipedRes = await fetch(pipedUrl);
      if (pipedRes.ok) {
        const data = await pipedRes.json();
        if (data && data.audioStreams && data.audioStreams.length > 0) {
          const best = data.audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          console.log(`[YouTube API] Piped succeeded for "${data.title}"`);
          return {
            title: data.title || 'YouTube Audio',
            artist: data.uploader || 'YouTube Artist',
            duration: parseInt(data.duration) || 0,
            coverUrl: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            streamUrl: best.url
          };
        }
      }
    } catch (e) {
      console.warn(`[YouTube API] Piped ${pipedUrl} failed:`, e.message);
    }
  }

  return null;
}

// Helper: Download Remote Stream URL to local file
async function downloadFile(streamUrl, targetPath) {
  const response = await fetch(streamUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(targetPath, buffer);
}

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
    const videoId = extractVideoId(cleanUrl);

    if (!videoId) {
      return res.status(400).json({ error: 'Ungültiges YouTube URL Format (z.B. https://youtu.be/...)' });
    }

    console.log(`[YouTube Import] Extracting videoId ${videoId}...`);
    const ytData = await fetchYouTubeViaAPI(cleanUrl, videoId);

    if (!ytData || !ytData.streamUrl) {
      return res.status(500).json({ error: 'Der YouTube-Link konnte nicht verarbeitet werden. Überprüfe die URL.' });
    }

    const songId = 'yt-' + Date.now();
    const fileName = `${songId}.mp3`;
    const audioFilePath = path.join(AUDIO_DIR, fileName);

    console.log(`[YouTube Import] Downloading audio for "${ytData.title}"...`);
    await downloadFile(ytData.streamUrl, audioFilePath);

    console.log(`[YouTube Import] Download complete: ${fileName}`);

    const songs = loadSongs();
    const newSong = {
      id: songId,
      title: ytData.title,
      artist: ytData.artist,
      album: 'YouTube Import',
      duration: ytData.duration,
      fileName: fileName,
      coverUrl: ytData.coverUrl,
      audioUrl: `/api/stream/${songId}`,
      addedAt: new Date().toISOString()
    };

    songs.unshift(newSong);
    saveSongs(songs);

    res.status(201).json(newSong);

  } catch (err) {
    console.error('[YouTube Import] Error:', err);
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
