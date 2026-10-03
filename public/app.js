let songs = [], downloadedSongIds = new Set(), currentSongIndex = -1;
let isPlaying = false, isShuffle = false, isRepeat = false;
let filterOfflineOnly = false, searchQuery = '';
let pendingYtSong = null; // YouTube song pending save

const AUDIO_CACHE = 'spotify-pwa-audio-v1';
const LOCAL_KEY = 'spotify_songs_v2';

const audioEngine = document.getElementById('audio-engine');
const trackListContainer = document.getElementById('track-list-container');

// Init
window.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  loadOfflineCache();
  await fetchSongs();
  setupPlayerControls();
  setupTabs();
  setupYouTube();
  setupUploadForm();
  setupSearch();
});

// ---- Network & Songs ----
async function fetchSongs() {
  try {
    const res = await fetch('/api/songs');
    if (!res.ok) throw new Error('Server error');
    const data = await res.json();
    songs = data;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(songs));
    setOnline(true);
  } catch {
    setOnline(false);
    const cached = localStorage.getItem(LOCAL_KEY);
    songs = cached ? JSON.parse(cached) : [];
  }
  renderTrackList();
}

function setOnline(online) {
  document.getElementById('status-dot').className = `status-indicator ${online ? 'online' : 'offline'}`;
  document.getElementById('status-text').textContent = online ? 'Online (24/7)' : 'Offline Modus';
}

window.addEventListener('online', fetchSongs);
window.addEventListener('offline', () => setOnline(false));

// ---- Tabs ----
function setupTabs() {
  document.getElementById('tab-youtube').addEventListener('click', () => switchTab('youtube'));
  document.getElementById('tab-upload').addEventListener('click', () => switchTab('upload'));
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById(`content-${tab}`).classList.add('active');
}

// ---- YouTube Import (Client-Side via Cobalt API) ----
function setupYouTube() {
  document.getElementById('yt-import-btn').addEventListener('click', handleYouTubeImport);
  document.getElementById('yt-url-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleYouTubeImport(); });
  document.getElementById('yt-confirm-save').addEventListener('click', confirmYouTubeSave);
}

function extractVideoId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:.*[?&]v=|embed\/|v\/))([\w-]{11})/);
  return m ? m[1] : (/^[\w-]{11}$/.test(url.trim()) ? url.trim() : null);
}

async function handleYouTubeImport() {
  const rawUrl = document.getElementById('yt-url-input').value.trim();
  const videoId = extractVideoId(rawUrl);

  if (!videoId) {
    showYtStatus('Kein gültiger YouTube-Link gefunden.', 'error');
    return;
  }

  const btn = document.getElementById('yt-import-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Lädt...';
  document.getElementById('yt-info-box').style.display = 'none';
  showYtStatus('Lade Video-Info...', 'info');

  try {
    // Step 1: Get video metadata from our server (works even on cloud)
    const infoRes = await fetch('/api/youtube-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: rawUrl })
    });

    if (!infoRes.ok) {
      const err = await infoRes.json();
      throw new Error(err.error || 'Video nicht gefunden');
    }

    const info = await infoRes.json();
    pendingYtSong = info;

    // Show preview
    document.getElementById('yt-thumb').src = info.coverUrl;
    document.getElementById('yt-title-preview').textContent = info.title;
    document.getElementById('yt-artist-preview').textContent = info.artist;
    document.getElementById('yt-info-box').style.display = 'flex';

    showYtStatus('✓ Video gefunden! Klicke "Speichern" um das Audio herunterzuladen.', 'success');

  } catch (err) {
    showYtStatus(`Fehler: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Importieren';
  }
}

async function confirmYouTubeSave() {
  if (!pendingYtSong) return;

  const saveBtn = document.getElementById('yt-confirm-save');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  showYtStatus('Audio wird heruntergeladen... (kann 15-30 Sek. dauern)', 'info');

  const { videoId, title, artist, coverUrl } = pendingYtSong;

  try {
    // Try Cobalt API (client-side, from user's browser - not blocked!)
    let audioBlob = null;

    // Cobalt API v7+
    const cobaltApis = [
      'https://api.cobalt.tools/',
      'https://cobalt.privacyredirect.com/',
    ];

    for (const cobaltUrl of cobaltApis) {
      try {
        showYtStatus(`Lade Audio herunter (${cobaltUrl.replace('https://', '')})...`, 'info');
        const cobRes = await fetch(cobaltUrl, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            url: `https://www.youtube.com/watch?v=${videoId}`,
            downloadMode: 'audio',
            audioFormat: 'mp3',
            filenameStyle: 'basic'
          })
        });

        if (!cobRes.ok) continue;
        const cobData = await cobRes.json();
        console.log('Cobalt response:', cobData);

        const downloadUrl = cobData.url || (cobData.tunnel ? cobData.tunnel : null);
        if (downloadUrl) {
          showYtStatus('Audio wird verarbeitet...', 'info');
          const audioRes = await fetch(downloadUrl);
          if (audioRes.ok) {
            audioBlob = await audioRes.blob();
            if (audioBlob.size > 10000) break; // Valid audio blob
            audioBlob = null;
          }
        }
      } catch (e) {
        console.warn('Cobalt source failed:', e);
      }
    }

    if (!audioBlob) {
      // Show manual fallback instructions
      showYtStatus(
        `⚠️ Automatischer Download nicht möglich. <br><br>` +
        `<b>So geht es trotzdem:</b><br>` +
        `1. Gehe auf <a href="https://cobalt.tools/" target="_blank" style="color:#1DB954">cobalt.tools</a><br>` +
        `2. Füge diesen Link ein: <code style="color:#1DB954">https://youtu.be/${videoId}</code><br>` +
        `3. Wähle "Audio" → lade die MP3 herunter<br>` +
        `4. Lade die MP3 hier über den Tab "MP3 Datei" hoch`,
        'error'
      );
      document.getElementById('yt-info-box').style.display = 'none';
      return;
    }

    // Upload audio blob to our server
    showYtStatus('Wird gespeichert...', 'info');
    const formData = new FormData();
    formData.append('title', title);
    formData.append('artist', artist);
    formData.append('album', 'YouTube Import');
    formData.append('coverUrl', coverUrl);
    formData.append('audio', new File([audioBlob], `${videoId}.mp3`, { type: 'audio/mpeg' }));

    const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!uploadRes.ok) throw new Error('Upload fehlgeschlagen');
    const newSong = await uploadRes.json();

    songs.unshift(newSong);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(songs));
    renderTrackList();

    document.getElementById('yt-url-input').value = '';
    document.getElementById('yt-info-box').style.display = 'none';
    pendingYtSong = null;
    showYtStatus(`✓ "${newSong.title}" wurde gespeichert!`, 'success');
    playSong(0);

  } catch (err) {
    showYtStatus(`Fehler: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Speichern';
  }
}

function showYtStatus(msg, type) {
  const el = document.getElementById('yt-status-message');
  el.className = `yt-status ${type}`;
  el.innerHTML = msg;
}

// ---- Upload Form ----
function setupUploadForm() {
  document.getElementById('upload-form-inline').addEventListener('submit', async e => {
    e.preventDefault();
    const title = document.getElementById('ul-title').value.trim();
    const artist = document.getElementById('ul-artist').value.trim();
    const album = document.getElementById('ul-album').value.trim();
    const audioFile = document.getElementById('ul-audio').files[0];
    const coverFile = document.getElementById('ul-cover').files[0];

    if (!audioFile) return alert('Bitte wähle eine Audiodatei!');

    const submitBtn = document.getElementById('ul-submit-btn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Lädt hoch...';

    const formData = new FormData();
    formData.append('title', title);
    formData.append('artist', artist);
    formData.append('album', album);
    formData.append('audio', audioFile);
    if (coverFile) formData.append('cover', coverFile);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('Upload fehlgeschlagen');
      const newSong = await res.json();
      songs.unshift(newSong);
      localStorage.setItem(LOCAL_KEY, JSON.stringify(songs));
      renderTrackList();
      document.getElementById('upload-form-inline').reset();
      alert(`✓ "${newSong.title}" hochgeladen!`);
    } catch (err) {
      alert('Fehler: ' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Hochladen';
    }
  });
}

// ---- Search ----
function setupSearch() {
  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value;
    renderTrackList();
  });
  document.getElementById('filter-offline-only').addEventListener('click', e => {
    filterOfflineOnly = !filterOfflineOnly;
    e.currentTarget.classList.toggle('active', filterOfflineOnly);
    renderTrackList();
  });
  document.getElementById('nav-offline').addEventListener('click', () => {
    filterOfflineOnly = true;
    document.getElementById('filter-offline-only').classList.add('active');
    renderTrackList();
  });
  document.getElementById('nav-home').addEventListener('click', () => {
    filterOfflineOnly = false;
    searchQuery = '';
    document.getElementById('search-input').value = '';
    document.getElementById('filter-offline-only').classList.remove('active');
    renderTrackList();
  });
}

// ---- Offline Cache ----
function loadOfflineCache() {
  const cached = localStorage.getItem(LOCAL_KEY);
  if (cached) JSON.parse(cached).forEach(s => downloadedSongIds.add(s.id));
  if ('caches' in window) {
    caches.open(AUDIO_CACHE).then(c => c.keys().then(keys => {
      keys.forEach(r => {
        const m = r.url.match(/\/api\/stream\/([^/]+)/);
        if (m) downloadedSongIds.add(m[1]);
      });
      updateOfflineBadge();
    }));
  }
}

async function toggleDownloadSong(songId, event) {
  if (event) event.stopPropagation();
  const song = songs.find(s => s.id === songId);
  if (!song) return;

  if (downloadedSongIds.has(songId)) {
    if ('caches' in window) {
      const cache = await caches.open(AUDIO_CACHE);
      await cache.delete(song.audioUrl);
    }
    downloadedSongIds.delete(songId);
  } else {
    try {
      if ('caches' in window) {
        const cache = await caches.open(AUDIO_CACHE);
        await cache.add(song.audioUrl);
      }
      downloadedSongIds.add(songId);
    } catch (e) {
      alert('Download fehlgeschlagen. Bist du online?');
    }
  }
  updateOfflineBadge();
  renderTrackList();
}

function updateOfflineBadge() {
  document.getElementById('offline-count-badge').textContent = downloadedSongIds.size;
}

// ---- Render Tracks ----
function renderTrackList() {
  const filtered = songs.filter(s => {
    const q = searchQuery.toLowerCase();
    const match = s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q) || (s.album || '').toLowerCase().includes(q);
    return match && (!filterOfflineOnly || downloadedSongIds.has(s.id));
  });

  document.getElementById('track-count-text').textContent = `${filtered.length} Titel`;
  updateOfflineBadge();

  if (!filtered.length) {
    trackListContainer.innerHTML = `<div class="loading-state"><i class="fa-solid fa-music"></i><br><br>${songs.length === 0 ? 'Noch keine Songs. Füge YouTube-Links hinzu oder lade MP3-Dateien hoch!' : 'Keine Ergebnisse.'}</div>`;
    return;
  }

  trackListContainer.innerHTML = filtered.map((song, idx) => {
    const isCurrent = currentSongIndex >= 0 && songs[currentSongIndex]?.id === song.id;
    const isDownloaded = downloadedSongIds.has(song.id);
    return `
      <div class="track-row ${isCurrent ? 'playing' : ''}" onclick="playSongById('${song.id}')">
        <span class="track-num">${isCurrent && isPlaying ? '<i class="fa-solid fa-music" style="color:var(--primary)"></i>' : (idx + 1)}</span>
        <img class="track-cover-img" src="${escHtml(song.coverUrl)}" alt="" onerror="this.src='/uploads/covers/default.jpg'">
        <div class="track-details">
          <span class="track-title">${escHtml(song.title)}</span>
          <span class="track-artist">${escHtml(song.artist)}</span>
        </div>
        <span class="track-album">${escHtml(song.album || '')}</span>
        <span class="track-duration">${fmtTime(song.duration || 0)}</span>
        <div class="track-actions">
          <button class="btn-icon ${isDownloaded ? 'downloaded' : ''}" onclick="toggleDownloadSong('${song.id}', event)" title="${isDownloaded ? 'Offline ✓' : 'Offline speichern'}">
            <i class="${isDownloaded ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle-down'}"></i>
          </button>
          <button class="btn-icon" onclick="deleteSong('${song.id}', event)" title="Löschen">
            <i class="fa-regular fa-trash-can"></i>
          </button>
        </div>
      </div>`;
  }).join('');
}

// ---- Player ----
function setupPlayerControls() {
  document.getElementById('btn-play-pause').addEventListener('click', togglePlayPause);
  document.getElementById('btn-prev').addEventListener('click', playPrev);
  document.getElementById('btn-next').addEventListener('click', playNext);
  document.getElementById('btn-shuffle').addEventListener('click', e => {
    isShuffle = !isShuffle;
    e.currentTarget.classList.toggle('active', isShuffle);
  });
  document.getElementById('btn-repeat').addEventListener('click', e => {
    isRepeat = !isRepeat;
    e.currentTarget.classList.toggle('active', isRepeat);
  });
  document.getElementById('player-download-btn').addEventListener('click', () => {
    if (currentSongIndex >= 0) toggleDownloadSong(songs[currentSongIndex].id);
  });
  document.getElementById('seek-bar').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect();
    if (audioEngine.duration) audioEngine.currentTime = ((e.clientX - r.left) / r.width) * audioEngine.duration;
  });
  document.getElementById('volume-slider').addEventListener('input', e => {
    audioEngine.volume = parseFloat(e.target.value);
    const v = parseFloat(e.target.value);
    document.getElementById('volume-icon').className = `fa-solid fa-volume-${v === 0 ? 'xmark' : v < 0.5 ? 'low' : 'high'}`;
  });
  audioEngine.addEventListener('timeupdate', () => {
    const c = audioEngine.currentTime, d = audioEngine.duration || 0;
    document.getElementById('time-current').textContent = fmtTime(c);
    document.getElementById('time-total').textContent = fmtTime(d);
    document.getElementById('seek-fill').style.width = d > 0 ? `${(c / d) * 100}%` : '0%';
  });
  audioEngine.addEventListener('ended', () => { if (isRepeat) { audioEngine.currentTime = 0; audioEngine.play(); } else playNext(); });
}

function playSongById(id) {
  const idx = songs.findIndex(s => s.id === id);
  if (idx >= 0) playSong(idx);
}

function playSong(idx) {
  if (idx < 0 || idx >= songs.length) return;
  currentSongIndex = idx;
  const song = songs[idx];
  audioEngine.src = song.audioUrl;
  audioEngine.play().then(() => {
    isPlaying = true;
    document.getElementById('btn-play-pause').innerHTML = '<i class="fa-solid fa-pause"></i>';
    document.getElementById('player-title').textContent = song.title;
    document.getElementById('player-artist').textContent = song.artist;
    document.getElementById('player-cover').src = song.coverUrl;
    document.getElementById('player-cover').onerror = () => { document.getElementById('player-cover').src = '/uploads/covers/default.jpg'; };
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: song.title, artist: song.artist, album: song.album || '', artwork: [{ src: song.coverUrl }] });
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      navigator.mediaSession.setActionHandler('nexttrack', playNext);
      navigator.mediaSession.setActionHandler('play', () => { audioEngine.play(); isPlaying = true; });
      navigator.mediaSession.setActionHandler('pause', () => { audioEngine.pause(); isPlaying = false; });
    }
    renderTrackList();
  }).catch(e => console.error('Playback error:', e));
}

function togglePlayPause() {
  if (currentSongIndex < 0 && songs.length) { playSong(0); return; }
  if (isPlaying) { audioEngine.pause(); isPlaying = false; document.getElementById('btn-play-pause').innerHTML = '<i class="fa-solid fa-play"></i>'; }
  else { audioEngine.play(); isPlaying = true; document.getElementById('btn-play-pause').innerHTML = '<i class="fa-solid fa-pause"></i>'; }
}

function playNext() {
  if (!songs.length) return;
  const next = isShuffle ? Math.floor(Math.random() * songs.length) : (currentSongIndex + 1) % songs.length;
  playSong(next);
}

function playPrev() {
  if (!songs.length) return;
  if (audioEngine.currentTime > 3) { audioEngine.currentTime = 0; return; }
  playSong((currentSongIndex - 1 + songs.length) % songs.length);
}

// ---- Delete ----
async function deleteSong(id, event) {
  if (event) event.stopPropagation();
  if (!confirm('Song löschen?')) return;
  try {
    const res = await fetch(`/api/songs/${id}`, { method: 'DELETE' });
    if (res.ok) { songs = songs.filter(s => s.id !== id); downloadedSongIds.delete(id); localStorage.setItem(LOCAL_KEY, JSON.stringify(songs)); renderTrackList(); }
  } catch { alert('Löschen fehlgeschlagen (offline?)'); }
}

// ---- Helpers ----
function fmtTime(s) { if (!s || isNaN(s)) return '0:00'; const m = Math.floor(s / 60); const ss = Math.floor(s % 60); return `${m}:${ss < 10 ? '0' : ''}${ss}`; }
function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
