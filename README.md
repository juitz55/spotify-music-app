# 🎵 Spotify-Style Offline Music Player App (PWA)

Eine moderne Progressive Web App (PWA) im Spotify Dark-Design zur Erfassung, Verwaltung und zum **Offline-Hören deiner Musik** auf dem Smartphone und PC – mit Unterstützung für 24/7 Cloud-Hosting.

---

## 🚀 Schnellstart

### Am PC starten:
Doppelklicke einfach auf:
👉 **`start_app.bat`**

Die App öffnet sich automatisch in deinem Browser unter `http://localhost:3000`.

### Auf dem Smartphone öffnen:
1. Stelle sicher, dass dein Smartphone im **selben WLAN** wie dein PC ist.
2. Beim Start von `start_app.bat` wird dir in der Konsole die **Handy-WLAN-IP** angezeigt (z.B. `http://192.168.1.x:3000`).
3. Öffne diese URL in **Safari (iOS)** oder **Chrome (Android)**.

---

## 📲 Als echte App auf dem Smartphone installieren (Home-Screen)

### iPhone (iOS Safari):
1. Öffne die Seite in **Safari**.
2. Tippe unten auf den **„Teilen“-Button** (Viereck mit Pfeil nach oben).
3. Wähle **„Zum Home-Bildschirm“** (Add to Home Screen).
4. Die App erscheint nun mit eigenem Icon auf deinem Startbildschirm und öffnet sich im echten Vollbildmodus!

### Android (Google Chrome):
1. Öffne die Seite in **Chrome**.
2. Tippe oben rechts auf die **drei Punkte (Menü)**.
3. Wähle **„App installieren“** oder **„Zum Startbildschirm hinzufügen“**.

---

## 🎧 Wie funktioniert das Offline-Hören?

1. **Song Herunterladen**: Klicke in der Song-Liste oder im Player auf das **Download-Symbol** (Pfeil nach unten).
2. **Speicherung**: Der Service Worker lädt die MP3-Datei und das Cover herunter und speichert sie sicher im Browser (`CacheStorage` & `localStorage`).
3. **Flugmodus**: Schalte das Internet / WLAN ab – du kannst deine heruntergeladenen Songs weiterhin direkt in der App abspielen!
4. **Lockscreen Controls**: Über die Media Session API kannst du Musik auch auf dem Sperrbildschirm deines Smartphones steuern (Play/Pause, Vor/Zurück).

---

## ☁️ 24/7 Cloud Deployment (Immer Online)

Du kannst die App auch kostenlos rund um die Uhr online hosten, um deine Musikbibliothek immer und überall zu erreichen:

### Deployment auf Render.com:
1. Repository / Ordner `music-app` zu GitHub pushen.
2. Auf [Render.com](https://render.com) ein kostenloses **Web Service** erstellen.
3. Git Repository verbinden.
4. **Build Command**: `npm install`
5. **Start Command**: `npm start`
6. Render stellt deine 24/7 HTTPS-URL bereit (z.B. `https://deine-music-app.onrender.com`).
