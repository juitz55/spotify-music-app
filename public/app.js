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

// --- Service Worker ---
async function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
      console.error('SW registration failed:', err);
    }
  }
}

async function loadDownloadedCache() {
  try {
    const stored = localStorage.getItem(LOCAL_SONGS_KEY);
    if (stored) JSON.parse(stored).forEach(s => downloadedSongIds.add(s.id));
    if ('caches' in window) {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      const keys = await cache.keys();
      keys.forEach(req => {
        const match = req.url.match(/\/api\/stream\/([^\/]+)/);
        if (match) downloadedSongIds.add(match[1]);
      });
    }
    updateStats();
  } catch (err) {
    console.error('Cache load error:', err);
  }
}

// --- Fetch Songs ---
async function fetchSongs() {
  try {
    const res = await fetch('/api/songs');
    if (!res.ok) throw new Error('Network error');
    songs = await res.json();
    localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(songs));
    updateNetworkStatus(true);
  } catch {
    updateNetworkStatus(false);
    const cached = localStorage.getItem(LOCAL_SONGS_KEY);
    songs = cached ? JSON.parse(cached) : [];
  }
  renderTrackList();
  updateStats();
}

function updateNetworkStatus(online) {
  statusDot.className = `status-indicator ${online ? 'online' : 'offline'}`;
  statusText.textContent = online ? 'Online (24/7 Backend)' : 'Offline (Lokaler Modus)';
}

window.addEventListener('online', fetchSongs);
window.addEventListener('offline', () => updateNetworkStatus(false));

// --- YouTube Import (Server-only, clean & simple) ---
function extractVideoId(input) {
  if (!input) return null;
  const s = input.trim();
  // Standard patterns
  let m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/|watch\?.*v=))([\w-]{11})/);
  if (m) return m[1];
  // Shortened like tu.be/XXXX
  m = s.match(/be\/([\w-]{11})/);
  if (m) return m[1];
  // Just the 11-char ID
  m = s.match(/^([\w-]{11})$/);
  if (m) return m[1];
  // Anything with 11 char sequence
  m = s.match(/([\w-]{11})/);
  return m ? m[1] : null;
}

if (ytImportBtn) {
  ytImportBtn.addEventListener('click', handleYouTubeImport);
  ytUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleYouTubeImport(); });
}

async function handleYouTubeImport() {
  const raw = ytUrlInput.value.trim();
  const videoId = extractVideoId(raw);

  if (!videoId) {
    showYtStatus('Ungültiger YouTube Link. Bitte vollständigen Link einfügen.', 'error');
    return;
  }

  ytImportBtn.disabled = true;
  ytImportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Lade herunter...';
  showYtStatus(`<i class="fa-solid fa-spinner fa-spin"></i> Lädt YouTube Audio herunter... (kann bis zu 30 Sek. dauern)`, 'info');

  try {
    const res = await fetch('/api/youtube-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` })
    });

    const data = await res.json();

    if (res.ok && data.id) {
      songs.unshift(data);
      localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(songs));
      renderTrackList();
      updateStats();
      ytUrlInput.value = '';
      showYtStatus(`✓ "${data.title}" erfolgreich gespeichert!`, 'success');
      playSong(0);
    } else {
      showYtStatus(`Fehler: ${data.error || 'Import fehlgeschlagen'}`, 'error');
    }
  } catch (err) {
    showYtStatus('Netzwerkfehler. Bitte versuche es erneut.', 'error');
  } finally {
    ytImportBtn.disabled = false;
    ytImportBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Herunterladen & Speichern';
  }
}

function showYtStatus(msg, type) {
  ytStatusMessage.className = `yt-status ${type}`;
  ytStatusMessage.innerHTML = msg;
}

// --- Offline Download ---
async function toggleDownloadSong(songId, event) {
  if (event) event.stopPropagation();
  const song = songs.find(s => s.id === songId);
  if (!song) return;

  if (downloadedSongIds.has(songId)) {
    try {
      if ('caches' in window) {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        await cache.delete(song.audioUrl);
      }
      downloadedSongIds.delete(songId);
    } catch (err) { console.error(err); }
  } else {
    try {
      if ('caches' in window) {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        await cache.add(song.audioUrl);
        downloadedSongIds.add(songId);
      }
    } catch (err) {
      alert('Fehler beim Herunterladen. Bist du online?');
    }
  }

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

// --- Track List ---
function renderTrackList() {
  const filtered = songs.filter(song => {
    const q = searchQuery.toLowerCase();
    const matchSearch = song.title.toLowerCase().includes(q) || song.artist.toLowerCase().includes(q) || (song.album || '').toLowerCase().includes(q);
    return matchSearch && (!filterOfflineOnly || downloadedSongIds.has(song.id));
  });

  document.getElementById('track-count-text').textContent = `${filtered.length} Titel`;

  if (filtered.length === 0) {
    trackListContainer.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-subdued);">
      <i class="fa-solid fa-music" style="font-size:32px;margin-bottom:12px;display:block;"></i>
      Keine Songs. Füge einen YouTube-Link ein oder lade eine MP3 hoch!
    </div>`;
    return;
  }

  trackListContainer.innerHTML = filtered.map((song, idx) => {
    const isCurrent = currentSongIndex >= 0 && songs[currentSongIndex]?.id === song.id;
    const isDl = downloadedSongIds.has(song.id);
    return `
      <div class="track-row ${isCurrent ? 'playing' : ''}" onclick="playSongById('${song.id}')">
        <span class="track-num">${isCurrent && isPlaying ? '<i class="fa-solid fa-volume-high fa-beat" style="color:var(--primary)"></i>' : (idx + 1)}</span>
        <img class="track-cover-img" src="${song.coverUrl}" alt="Cover" onerror="this.src='/uploads/covers/default.jpg'">
        <div class="track-details">
          <span class="track-title">${escapeHtml(song.title)}</span>
          <span class="track-artist">${escapeHtml(song.artist)}</span>
        </div>
        <span class="track-album">${escapeHtml(song.album || 'Single')}</span>
        <span class="track-duration">${formatTime(song.duration || 0)}</span>
        <div class="track-actions">
          <button class="btn-icon ${isDl ? 'downloaded' : ''}" onclick="toggleDownloadSong('${song.id}', event)" title="${isDl ? 'Offline gespeichert' : 'Offline speichern'}">
            <i class="${isDl ? 'fa-solid fa-circle-down' : 'fa-regular fa-circle-down'}"></i>
          </button>
          <button class="btn-icon" onclick="deleteSong('${song.id}', event)" title="Löschen">
            <i class="fa-regular fa-trash-can"></i>
          </button>
        </div>
      </div>`;
  }).join('');
}

// --- Player ---
function playSongById(songId) {
  const i = songs.findIndex(s => s.id === songId);
  if (i !== -1) playSong(i);
}

function playSong(index) {
  if (index < 0 || index >= songs.length) return;
  currentSongIndex = index;
  const song = songs[index];
  audioEngine.src = song.audioUrl;
  audioEngine.play().then(() => {
    isPlaying = true;
    updatePlayPauseBtn();
    updatePlayerUI();
    setupMediaSession(song);
    renderTrackList();
  }).catch(err => {
    console.error('Playback error:', err);
    if (!navigator.onLine && !downloadedSongIds.has(song.id)) {
      alert('Song nicht offline verfügbar. Bitte zuerst herunterladen!');
    }
  });
}

function togglePlayPause() {
  if (currentSongIndex === -1 && songs.length > 0) { playSong(0); return; }
  if (isPlaying) { audioEngine.pause(); isPlaying = false; }
  else { audioEngine.play(); isPlaying = true; }
  updatePlayPauseBtn();
  renderTrackList();
}

function playNextSong() {
  if (!songs.length) return;
  playSong(isShuffle ? Math.floor(Math.random() * songs.length) : (currentSongIndex + 1) % songs.length);
}

function playPrevSong() {
  if (!songs.length) return;
  if (audioEngine.currentTime > 3) { audioEngine.currentTime = 0; return; }
  playSong((currentSongIndex - 1 + songs.length) % songs.length);
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
  const dl = downloadedSongIds.has(songs[currentSongIndex].id);
  playerOfflineBadge.style.color = dl ? 'var(--primary)' : 'var(--text-muted)';
}

function setupMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title, artist: song.artist, album: song.album || '',
    artwork: [{ src: song.coverUrl, sizes: '512x512', type: 'image/jpeg' }]
  });
  navigator.mediaSession.setActionHandler('play', togglePlayPause);
  navigator.mediaSession.setActionHandler('pause', togglePlayPause);
  navigator.mediaSession.setActionHandler('previoustrack', playPrevSong);
  navigator.mediaSession.setActionHandler('nexttrack', playNextSong);
}

audioEngine.addEventListener('timeupdate', () => {
  const c = audioEngine.currentTime, d = audioEngine.duration || 0;
  timeCurrent.textContent = formatTime(c);
  timeTotal.textContent = formatTime(d);
  if (d > 0) seekFill.style.width = `${(c / d) * 100}%`;
});

audioEngine.addEventListener('ended', () => {
  if (isRepeat) { audioEngine.currentTime = 0; audioEngine.play(); }
  else playNextSong();
});

seekBar.addEventListener('click', e => {
  const { left, width } = seekBar.getBoundingClientRect();
  const d = audioEngine.duration;
  if (d) audioEngine.currentTime = ((e.clientX - left) / width) * d;
});

volumeSlider.addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  audioEngine.volume = v;
  volumeIcon.className = v === 0 ? 'fa-solid fa-volume-xmark' : v < 0.5 ? 'fa-solid fa-volume-low' : 'fa-solid fa-volume-high';
});

btnPlayPause.addEventListener('click', togglePlayPause);
btnNext.addEventListener('click', playNextSong);
btnPrev.addEventListener('click', playPrevSong);
btnShuffle.addEventListener('click', () => { isShuffle = !isShuffle; btnShuffle.classList.toggle('active', isShuffle); });
btnRepeat.addEventListener('click', () => { isRepeat = !isRepeat; btnRepeat.classList.toggle('active', isRepeat); });
playerDownloadBtn.addEventListener('click', () => { if (currentSongIndex !== -1) toggleDownloadSong(songs[currentSongIndex].id); });

searchInput.addEventListener('input', e => { searchQuery = e.target.value; renderTrackList(); });
filterOfflineBtn.addEventListener('click', () => { filterOfflineOnly = !filterOfflineOnly; filterOfflineBtn.classList.toggle('active', filterOfflineOnly); renderTrackList(); });

document.getElementById('nav-offline').addEventListener('click', () => { filterOfflineOnly = true; filterOfflineBtn.classList.add('active'); renderTrackList(); });
document.getElementById('nav-home').addEventListener('click', () => { filterOfflineOnly = false; searchQuery = ''; searchInput.value = ''; filterOfflineBtn.classList.remove('active'); renderTrackList(); });

async function deleteSong(songId, event) {
  if (event) event.stopPropagation();
  if (!confirm('Löschen?')) return;
  try {
    const res = await fetch(`/api/songs/${songId}`, { method: 'DELETE' });
    if (res.ok) {
      songs = songs.filter(s => s.id !== songId);
      downloadedSongIds.delete(songId);
      localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(songs));
      renderTrackList(); updateStats();
    }
  } catch { alert('Löschen fehlgeschlagen.'); }
}

openUploadBtn.addEventListener('click', () => uploadModal.classList.add('active'));
closeUploadBtn.addEventListener('click', () => uploadModal.classList.remove('active'));
cancelUploadBtn.addEventListener('click', () => uploadModal.classList.remove('active'));

uploadForm.addEventListener('submit', async e => {
  e.preventDefault();
  const audioFile = document.getElementById('upload-audio').files[0];
  if (!audioFile) { alert('Bitte eine Audiodatei auswählen.'); return; }

  const fd = new FormData();
  fd.append('title', document.getElementById('upload-title').value.trim());
  fd.append('artist', document.getElementById('upload-artist').value.trim());
  fd.append('album', document.getElementById('upload-album').value.trim());
  fd.append('audio', audioFile);
  const cover = document.getElementById('upload-cover').files[0];
  if (cover) fd.append('cover', cover);

  const btn = document.getElementById('submit-upload-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Hochladen...';

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (res.ok) {
      const song = await res.json();
      songs.unshift(song);
      localStorage.setItem(LOCAL_SONGS_KEY, JSON.stringify(songs));
      renderTrackList(); updateStats();
      uploadModal.classList.remove('active');
      uploadForm.reset();
    } else { alert('Upload fehlgeschlagen.'); }
  } catch { alert('Netzwerkfehler.'); }
  finally { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-upload"></i> Hochladen'; }
});

function formatTime(s) {
  if (isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.addEventListener('DOMContentLoaded', async () => {
  await initServiceWorker();
  await loadDownloadedCache();
  await fetchSongs();
});
