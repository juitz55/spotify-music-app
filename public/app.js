// Spotify PWA Application State
let songs = [];
let downloadedSongIds = new Set();
let currentSongIndex = -1;
let isPlaying = false;
let isShuffle = false;
let isRepeat = false;
let filterOfflineOnly = false;
let searchQuery = '';

const AUDIO_CACHE_NAME = 'spotify-pwa-audio-v1';
const LOCAL_SONGS_KEY = 'spotify_offline_songs_metadata';

// DOM Elements
const audioEngine = document.getElementById('audio-engine');
const trackListContainer = document.getElementById('track-list-container');
const searchInput = document.getElementById('search-input');
const filterOfflineBtn = document.getElementById('filter-offline-only');

const btnPlayPause = document.getElementById('btn-play-pause');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnShuffle = document.getElementById('btn-shuffle');
const btnRepeat = document.getElementById('btn-repeat');

const playerCover = document.getElementById('player-cover');
const playerTitle = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');
const playerDownloadBtn = document.getElementById('player-download-btn');
const playerOfflineBadge = document.getElementById('player-offline-badge');

const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const seekBar = document.getElementById('seek-bar');
const seekFill = document.getElementById('seek-fill');

const volumeSlider = document.getElementById('volume-slider');
const volumeIcon = document.getElementById('volume-icon');

const uploadModal = document.getElementById('upload-modal');
const openUploadBtn = document.getElementById('open-upload-btn');
const closeUploadBtn = document.getElementById('close-upload-modal');
const cancelUploadBtn = document.getElementById('cancel-upload-btn');
const uploadForm = document.getElementById('upload-form');

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

const statTotalSongs = document.getElementById('stat-total-songs');
const statOfflineSongs = document.getElementById('stat-offline-songs');
const offlineCountBadge = document.getElementById('offline-count-badge');

const ytUrlInput = document.getElementById('yt-url-input');
const ytImportBtn = document.getElementById('yt-import-btn');
const ytStatusMessage = document.getElementById('yt-status-message');

// --- 1. Service Worker & Offline Initialization ---
async function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[App] Service Worker registered with scope:', reg.scope);
    } catch (err) {
      console.error('[App] Service Worker registration failed:', err);
    }
  }
}

async function loadDownloadedCache() {
  try {
    const storedOfflineMetadata = localStorage.getItem(LOCAL_SONGS_KEY);
    if (storedOfflineMetadata) {
      const offlineArray = JSON.parse(storedOfflineMetadata);
      offlineArray.forEach(s => downloadedSongIds.add(s.id));
    }

    if ('caches' in window) {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      const keys = await cache.keys();
      keys.forEach(req => {
        const match = req.url.match(/\/api\/stream\/([^\/]+)/);
        if (match && match[1]) {
          downloadedSongIds.add(match[1]);
        }
      });
    }
    updateStats();
  } catch (err) {
    console.error('Error loading downloaded cache:', err);
  }
}

// --- 2. Data Fetching & Sync ---
async function fetchSongs() {
  try {
    const res = await fetch('/api/songs');
    if (!res.ok) throw new Error('Network response failed');
    const data = await res.json();
    songs = data;

    // Save metadata locally for offline access
    localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(songs));
    updateNetworkStatus(true);
  } catch (err) {
    console.warn('[App] Fetch failed, loading from local offline storage:', err);
    updateNetworkStatus(false);
    const cachedMetadata = localStorage.getItem(LOCAL_SONGS_KEY);
    if (cachedMetadata) {
      songs = JSON.parse(cachedMetadata);
    } else {
      songs = [];
    }
  }

  renderTrackList();
  updateStats();
}

function updateNetworkStatus(isOnline) {
  if (isOnline) {
    statusDot.className = 'status-indicator online';
    statusText.textContent = 'Online (24/7 Backend)';
  } else {
    statusDot.className = 'status-indicator offline';
    statusText.textContent = 'Offline (Lokaler Modus)';
  }
}

window.addEventListener('online', () => fetchSongs());
window.addEventListener('offline', () => updateNetworkStatus(false));

// --- 3. Ultra-Smart YouTube Video ID Matcher ---
function extractVideoId(inputStr) {
  if (!inputStr) return null;
  const str = inputStr.trim();
  
  // Exact 11 char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;

  // Match youtube.com, youtu.be, tu.be, etc.
  const beMatch = str.match(/be\/([a-zA-Z0-9_-]{11})/);
  if (beMatch && beMatch[1]) return beMatch[1];

  const vMatch = str.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (vMatch && vMatch[1]) return vMatch[1];

  const embedMatch = str.match(/(?:embed|v)\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch && embedMatch[1]) return embedMatch[1];

  const generic = str.match(/([a-zA-Z0-9_-]{11})/);
  return generic ? generic[1] : null;
}

if (ytImportBtn) {
  ytImportBtn.addEventListener('click', handleYouTubeImport);
  ytUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleYouTubeImport();
  });
}

async function handleYouTubeImport() {
  const rawUrl = ytUrlInput.value.trim();
  const videoId = extractVideoId(rawUrl);

  if (!videoId) {
    showYtStatus('Bitte gib einen gültigen YouTube Link oder Video-ID ein.', 'error');
    return;
  }

  const cleanFullUrl = `https://www.youtube.com/watch?v=${videoId}`;

  ytImportBtn.disabled = true;
  ytImportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verarbeite...';
  showYtStatus(`<i class="fa-solid fa-spinner fa-spin"></i> Video "${videoId}" wird konvertiert & heruntergeladen... (dauert ca. 10 Sek.)`, 'info');

  try {
    // Step A: Fetch oEmbed Metadata (Title, Artist, Cover)
    let title = 'YouTube Track';
    let artist = 'YouTube Artist';
    const coverUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(cleanFullUrl)}&format=json`);
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        title = oembed.title || title;
        artist = oembed.author_name || artist;
      }
    } catch (e) {
      console.warn('oEmbed fetch error:', e);
    }

    // Step B: Try multi-source client audio extraction
    let audioBlob = null;

    // Source 1: Cobalt API
    try {
      console.log('[YouTube Client] Fetching Cobalt API...');
      const cobRes = await fetch('https://api.cobalt.tools/', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanFullUrl, downloadMode: 'audio', audioFormat: 'mp3' })
      });
      if (cobRes.ok) {
        const cobData = await cobRes.json();
        if (cobData && cobData.url) {
          const aRes = await fetch(cobData.url);
          if (aRes.ok) audioBlob = await aRes.blob();
        }
      }
    } catch (e) { console.warn('[YouTube Client] Cobalt failed:', e); }

    // Source 2: Piped API Fallback
    if (!audioBlob) {
      const pipedApis = [
        `https://api.piped.privacydev.net/streams/${videoId}`,
        `https://pipedapi.kavin.rocks/streams/${videoId}`,
        `https://pipedapi.palvelintila.fi/streams/${videoId}`
      ];
      for (const pUrl of pipedApis) {
        try {
          console.log(`[YouTube Client] Trying Piped ${pUrl}...`);
          const pRes = await fetch(pUrl);
          if (pRes.ok) {
            const pData = await pRes.json();
            if (pData && pData.audioStreams && pData.audioStreams.length > 0) {
              const best = pData.audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
              const aRes = await fetch(best.url);
              if (aRes.ok) {
                audioBlob = await aRes.blob();
                if (pData.title) title = pData.title;
                if (pData.uploader) artist = pData.uploader;
                break;
              }
            }
          }
        } catch (e) { console.warn(`[YouTube Client] Piped ${pUrl} failed:`, e); }
      }
    }

    // Step C: Send Audio Blob or URL to backend server
    if (audioBlob) {
      const audioFile = new File([audioBlob], `${videoId}.mp3`, { type: 'audio/mpeg' });
      const formData = new FormData();
      formData.append('title', title);
      formData.append('artist', artist);
      formData.append('album', 'YouTube Import');
      formData.append('audio', audioFile);

      const uploadRes = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      if (uploadRes.ok) {
        const newSong = await uploadRes.json();
        songs.unshift(newSong);
        localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(songs));
        renderTrackList();
        updateStats();
        ytUrlInput.value = '';
        showYtStatus(`✓ "${newSong.title}" erfolgreich gespeichert!`, 'success');
        playSong(0);
        return;
      }
    }

    // Fallback: Try backend server endpoint directly
    const backendRes = await fetch('/api/youtube-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: cleanFullUrl })
    });

    if (backendRes.ok) {
      const data = await backendRes.json();
      songs.unshift(data);
      localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(songs));
      renderTrackList();
      updateStats();
      ytUrlInput.value = '';
      showYtStatus(`✓ "${data.title}" erfolgreich gespeichert!`, 'success');
      playSong(0);
      return;
    }

    throw new Error('Kein Audio-Stream gefunden.');

  } catch (err) {
    console.error('YouTube import error:', err);
    showYtStatus(`Fehler: ${err.message || 'Import fehlgeschlagen'}. Du kannst auch jederzeit MP3-Dateien direkt hochladen.`, 'error');
  } finally {
    ytImportBtn.disabled = false;
    ytImportBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Herunterladen & Speichern';
  }
}

function showYtStatus(msg, type) {
  ytStatusMessage.className = `yt-status ${type}`;
  ytStatusMessage.innerHTML = msg;
}

// --- 4. Offline Download Manager ---
async function toggleDownloadSong(songId, event) {
  if (event) event.stopPropagation();

  const song = songs.find(s => s.id === songId);
  if (!song) return;

  if (downloadedSongIds.has(songId)) {
    // Delete from offline cache
    try {
      if ('caches' in window) {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        await cache.delete(song.audioUrl);
        if (song.coverUrl && !song.coverUrl.includes('default.jpg')) {
          await cache.delete(song.coverUrl);
        }
      }
      downloadedSongIds.delete(songId);
      console.log(`[Offline] Song ${song.title} removed from offline cache.`);
    } catch (err) {
      console.error('Failed to remove song from cache:', err);
    }
  } else {
    // Download to offline cache
    try {
      if ('caches' in window) {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        console.log(`[Offline] Downloading song ${song.title}...`);
        await cache.add(song.audioUrl);
        if (song.coverUrl && !song.coverUrl.includes('default.jpg')) {
          await cache.add(song.coverUrl);
        }
        downloadedSongIds.add(songId);
        console.log(`[Offline] Song ${song.title} downloaded successfully.`);
      }
    } catch (err) {
      alert('Fehler beim Herunterladen des Songs. Bist du online?');
      console.error('Download error:', err);
    }
  }

  // Persist offline metadata
  const offlineSongs = songs.filter(s => downloadedSongIds.has(s.id));
  localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(offlineSongs));

  renderTrackList();
  updateStats();
  updatePlayerOfflineBadge();
}

function updateStats() {
  statTotalSongs.textContent = songs.length;
  statOfflineSongs.textContent = downloadedSongIds.size;
  offlineCountBadge.textContent = downloadedSongIds.size;
}

// --- 5. Render Track List ---
function renderTrackList() {
  const filtered = songs.filter(song => {
    const matchesSearch = song.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          song.artist.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          song.album.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesOffline = !filterOfflineOnly || downloadedSongIds.has(song.id);
    return matchesSearch && matchesOffline;
  });

  document.getElementById('track-count-text').textContent = `${filtered.length} Titel`;

  if (filtered.length === 0) {
    trackListContainer.innerHTML = `
      <div style="padding: 40px; text-align: center; color: var(--text-subdued);">
        <i class="fa-solid fa-music" style="font-size: 32px; margin-bottom: 12px; display: block;"></i>
        Keine Songs gefunden. Füge einen YouTube-Link ein oder lade neue Dateien hoch!
      </div>
    `;
    return;
  }

  trackListContainer.innerHTML = filtered.map((song, idx) => {
    const isCurrent = currentSongIndex >= 0 && songs[currentSongIndex]?.id === song.id;
    const isDownloaded = downloadedSongIds.has(song.id);
    const durationFormatted = formatTime(song.duration || 0);

    return `
      <div class="track-row ${isCurrent ? 'playing' : ''}" onclick="playSongById('${song.id}')">
        <span class="track-num">${isCurrent && isPlaying ? '<i class="fa-solid fa-waveform fa-bounce" style="color: var(--primary)"></i>' : (idx + 1)}</span>
        <img class="track-cover-img" src="${song.coverUrl}" alt="Cover" onerror="this.src='/uploads/covers/default.jpg'">
        <div class="track-details">
          <span class="track-title">${escapeHtml(song.title)}</span>
          <span class="track-artist">${escapeHtml(song.artist)}</span>
        </div>
        <span class="track-album">${escapeHtml(song.album || 'Single')}</span>
        <span class="track-duration">${durationFormatted}</span>
        <div class="track-actions">
          <button class="btn-icon ${isDownloaded ? 'downloaded' : ''}" onclick="toggleDownloadSong('${song.id}', event)" title="${isDownloaded ? 'Heruntergeladen' : 'Offline speichern'}">
            <i class="${isDownloaded ? 'fa-solid fa-circle-down' : 'fa-regular fa-circle-down'}"></i>
          </button>
          <button class="btn-icon" onclick="deleteSong('${song.id}', event)" title="Löschen">
            <i class="fa-regular fa-trash-can"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// --- 6. Audio Player Engine & Controls ---
function playSongById(songId) {
  const index = songs.findIndex(s => s.id === songId);
  if (index !== -1) {
    playSong(index);
  }
}

function playSong(index) {
  if (index < 0 || index >= songs.length) return;

  currentSongIndex = index;
  const song = songs[currentSongIndex];

  audioEngine.src = song.audioUrl;
  audioEngine.play().then(() => {
    isPlaying = true;
    updatePlayPauseBtn();
    updatePlayerUI();
    setupMediaSession(song);
    renderTrackList();
  }).catch(err => {
    console.error('Audio playback failed:', err);
    if (!navigator.onLine && !downloadedSongIds.has(song.id)) {
      alert('Dieser Song ist nicht offline verfügbar. Lade ihn vorher herunter!');
    }
  });
}

function togglePlayPause() {
  if (currentSongIndex === -1 && songs.length > 0) {
    playSong(0);
    return;
  }

  if (isPlaying) {
    audioEngine.pause();
    isPlaying = false;
  } else {
    audioEngine.play();
    isPlaying = true;
  }
  updatePlayPauseBtn();
  renderTrackList();
}

function playNextSong() {
  if (songs.length === 0) return;
  if (isShuffle) {
    const randomIndex = Math.floor(Math.random() * songs.length);
    playSong(randomIndex);
  } else {
    const nextIndex = (currentSongIndex + 1) % songs.length;
    playSong(nextIndex);
  }
}

function playPrevSong() {
  if (songs.length === 0) return;
  if (audioEngine.currentTime > 3) {
    audioEngine.currentTime = 0;
    return;
  }
  const prevIndex = (currentSongIndex - 1 + songs.length) % songs.length;
  playSong(prevIndex);
}

function updatePlayPauseBtn() {
  btnPlayPause.innerHTML = isPlaying ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
}

function updatePlayerUI() {
  if (currentSongIndex === -1) return;
  const song = songs[currentSongIndex];

  playerTitle.textContent = song.title;
  playerArtist.textContent = song.artist;
  playerCover.src = song.coverUrl;
  updatePlayerOfflineBadge();
}

function updatePlayerOfflineBadge() {
  if (currentSongIndex === -1) return;
  const song = songs[currentSongIndex];
  const isDownloaded = downloadedSongIds.has(song.id);

  if (isDownloaded) {
    playerOfflineBadge.style.color = 'var(--primary)';
    playerOfflineBadge.title = 'Offline Verfügbar';
  } else {
    playerOfflineBadge.style.color = 'var(--text-muted)';
    playerOfflineBadge.title = 'Nur Online verfügbar';
  }
}

// Media Session API for Lock Screen Controls
function setupMediaSession(song) {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: song.album || 'Single',
      artwork: [
        { src: song.coverUrl, sizes: '512x512', type: 'image/jpeg' }
      ]
    });

    navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrevSong());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNextSong());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime) audioEngine.currentTime = details.seekTime;
    });
  }
}

// Audio Engine Events
audioEngine.addEventListener('timeupdate', () => {
  const current = audioEngine.currentTime;
  const duration = audioEngine.duration || 0;

  timeCurrent.textContent = formatTime(current);
  timeTotal.textContent = formatTime(duration);

  if (duration > 0) {
    const percentage = (current / duration) * 100;
    seekFill.style.width = `${percentage}%`;
  }
});

audioEngine.addEventListener('ended', () => {
  if (isRepeat) {
    audioEngine.currentTime = 0;
    audioEngine.play();
  } else {
    playNextSong();
  }
});

// Seek Bar Interaction
seekBar.addEventListener('click', (e) => {
  const rect = seekBar.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const width = rect.width;
  const duration = audioEngine.duration;

  if (duration) {
    audioEngine.currentTime = (clickX / width) * duration;
  }
});

// Volume Controls
volumeSlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  audioEngine.volume = val;
  if (val === 0) {
    volumeIcon.className = 'fa-solid fa-volume-xmark';
  } else if (val < 0.5) {
    volumeIcon.className = 'fa-solid fa-volume-low';
  } else {
    volumeIcon.className = 'fa-solid fa-volume-high';
  }
});

// Controls Handlers
btnPlayPause.addEventListener('click', togglePlayPause);
btnNext.addEventListener('click', playNextSong);
btnPrev.addEventListener('click', playPrevSong);

btnShuffle.addEventListener('click', () => {
  isShuffle = !isShuffle;
  btnShuffle.classList.toggle('active', isShuffle);
});

btnRepeat.addEventListener('click', () => {
  isRepeat = !isRepeat;
  btnRepeat.classList.toggle('active', isRepeat);
});

playerDownloadBtn.addEventListener('click', () => {
  if (currentSongIndex !== -1) {
    toggleDownloadSong(songs[currentSongIndex].id);
  }
});

// Search & Filter
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderTrackList();
});

filterOfflineBtn.addEventListener('click', () => {
  filterOfflineOnly = !filterOfflineOnly;
  filterOfflineBtn.classList.toggle('active', filterOfflineOnly);
  renderTrackList();
});

document.getElementById('nav-offline').addEventListener('click', () => {
  filterOfflineOnly = true;
  filterOfflineBtn.classList.add('active');
  renderTrackList();
});

document.getElementById('nav-home').addEventListener('click', () => {
  filterOfflineOnly = false;
  searchQuery = '';
  searchInput.value = '';
  filterOfflineBtn.classList.remove('active');
  renderTrackList();
});

// Delete Song
async function deleteSong(songId, event) {
  if (event) event.stopPropagation();
  if (!confirm('Möchtest du diesen Song wirklich löschen?')) return;

  try {
    const res = await fetch(`/api/songs/${songId}`, { method: 'DELETE' });
    if (res.ok) {
      songs = songs.filter(s => s.id !== songId);
      downloadedSongIds.delete(songId);
      localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(songs));
      renderTrackList();
      updateStats();
    } else {
      alert('Fehler beim Löschen des Songs');
    }
  } catch (err) {
    alert('Löschen im Offline-Modus nicht möglich.');
  }
}

// Upload Modal Management
openUploadBtn.addEventListener('click', () => uploadModal.classList.add('active'));
closeUploadBtn.addEventListener('click', () => uploadModal.classList.remove('active'));
cancelUploadBtn.addEventListener('click', () => uploadModal.classList.remove('active'));

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const title = document.getElementById('upload-title').value.trim();
  const artist = document.getElementById('upload-artist').value.trim();
  const album = document.getElementById('upload-album').value.trim();
  const audioFile = document.getElementById('upload-audio').files[0];
  const coverFile = document.getElementById('upload-cover').files[0];

  if (!audioFile) {
    alert('Bitte wähle eine Audiodatei aus.');
    return;
  }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('artist', artist);
  formData.append('album', album);
  formData.append('audio', audioFile);
  if (coverFile) {
    formData.append('cover', coverFile);
  }

  const submitBtn = document.getElementById('submit-upload-btn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Lade hoch...';

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    if (res.ok) {
      const newSong = await res.json();
      songs.unshift(newSong);
      localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(songs));
      renderTrackList();
      updateStats();
      uploadModal.classList.remove('active');
      uploadForm.reset();
      alert('Song erfolgreich hochgeladen!');
    } else {
      alert('Fehler beim Hochladen.');
    }
  } catch (err) {
    console.error(err);
    alert('Netzwerkfehler beim Hochladen.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Hochladen';
  }
});

// Helpers
function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Global Initialization
window.addEventListener('DOMContentLoaded', async () => {
  await initServiceWorker();
  await loadDownloadedCache();
  await fetchSongs();
});
