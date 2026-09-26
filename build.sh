#!/bin/bash
# Install yt-dlp during Render build
echo "📦 Installing yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
echo "✅ yt-dlp installed!"

# Install Node dependencies
npm install
