#!/usr/bin/env bash
set -e

echo "=== Installing ffmpeg ==="
apt-get update -qq && apt-get install -y ffmpeg 2>/dev/null || echo "apt-get not available, trying alternatives..."

echo "=== Installing yt-dlp ==="
curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version && echo "✅ yt-dlp OK"

echo "=== npm install ==="
npm install
echo "=== Build complete ==="
