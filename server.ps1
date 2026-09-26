# PowerShell HTTP Server für Spotify-Style Music App
param(
    [int]$Port = 3000,
    [switch]$NoBrowser
)

$RootPath = $PSScriptRoot
$PublicPath = Join-Path $RootPath "public"
$DataPath = Join-Path $RootPath "data"
$UploadsPath = Join-Path $RootPath "uploads"
$AudioPath = Join-Path $UploadsPath "audio"
$CoversPath = Join-Path $UploadsPath "covers"

# Directories Setup
@($DataPath, $UploadsPath, $AudioPath, $CoversPath) | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
}

$SongsJsonPath = Join-Path $DataPath "songs.json"

# Default Sample Song Init
if (-not (Test-Path $SongsJsonPath)) {
    $initialSongs = @(
        @{
            id = "sample-1"
            title = "Synthwave Chillout"
            artist = "Antigravity Beats"
            album = "Chill Beats Vol. 1"
            duration = 124
            fileName = "sample-1.mp3"
            coverUrl = "/uploads/covers/default.jpg"
            audioUrl = "/api/stream/sample-1"
            addedAt = (Get-Date).ToString("o")
        }
    )
    $initialSongs | ConvertTo-Json -Depth 5 | Set-Content -Path $SongsJsonPath -Encoding UTF8
}

# Generate sample audio file if missing
$sampleAudioFile = Join-Path $AudioPath "sample-1.mp3"
if (-not (Test-Path $sampleAudioFile)) {
    # Generate simple 5s PCM WAV sample tone
    $sampleRate = 44100
    $duration = 5
    $numSamples = $sampleRate * $duration
    $dataSize = $numSamples * 2
    $bytes = New-Object byte[] (44 + $dataSize)
    
    # RIFF WAV Header
    [System.Text.Encoding]::ASCII.GetBytes("RIFF").CopyTo($bytes, 0)
    [BitConverter]::GetBytes([uint32](36 + $dataSize)).CopyTo($bytes, 4)
    [System.Text.Encoding]::ASCII.GetBytes("WAVEfmt ").CopyTo($bytes, 8)
    [BitConverter]::GetBytes([int32]16).CopyTo($bytes, 16)
    [BitConverter]::GetBytes([int16]1).CopyTo($bytes, 20) # PCM
    [BitConverter]::GetBytes([int16]1).CopyTo($bytes, 22) # Mono
    [BitConverter]::GetBytes([int32]$sampleRate).CopyTo($bytes, 24)
    [BitConverter]::GetBytes([int32]($sampleRate * 2)).CopyTo($bytes, 28)
    [BitConverter]::GetBytes([int16]2).CopyTo($bytes, 32)
    [BitConverter]::GetBytes([int16]16).CopyTo($bytes, 34)
    [System.Text.Encoding]::ASCII.GetBytes("data").CopyTo($bytes, 36)
    [BitConverter]::GetBytes([int32]$dataSize).CopyTo($bytes, 40)
    
    # Fill tone notes
    $freqs = @(261.63, 329.63, 392.00, 523.25)
    for ($i = 0; $i -lt $numSamples; $i++) {
        $t = $i / $sampleRate
        $noteIdx = [math]::Floor($t * 4) % $freqs.Length
        $freq = $freqs[$noteIdx]
        $val = [int16]([math]::Sin(2 * [math]::PI * $freq * $t) * 0.4 * 32767)
        [BitConverter]::GetBytes($val).CopyTo($bytes, 44 + ($i * 2))
    }
    [System.IO.File]::WriteAllBytes($sampleAudioFile, $bytes)
}

# Find local IPv4 address
$bestIp = "127.0.0.1"
try {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp, Manual -ErrorAction SilentlyContinue | 
        Where-Object { 
            $_.IPAddress -notlike "127.*" -and 
            $_.IPAddress -notlike "169.254.*" -and 
            $_.InterfaceAlias -notmatch "vEthernet|WSL|VirtualBox|VMware|Default Switch"
        }
    if ($ips) { $bestIp = ($ips | Select-Object -First 1).IPAddress }
} catch {}

$MimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".ico"  = "image/x-icon"
    ".mp3"  = "audio/mpeg"
    ".wav"  = "audio/wav"
    ".flac" = "audio/flac"
    ".ogg"  = "audio/ogg"
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://*:$Port/")
try {
    $listener.Start()
} catch {
    # Fallback to localhost if http://*:Port requires elevated privileges
    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add("http://localhost:$Port/")
    $listener.Start()
}

$pcUrl = "http://localhost:$Port"
$phoneUrl = "http://${bestIp}:$Port"

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   🎵 SPOTIFY OFFLINE MUSIC PWA SERVER LAEUFT" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " [PC]    Im Browser:       $pcUrl" -ForegroundColor White
Write-Host " [HANDY] Im WLAN-Browser:  $phoneUrl" -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " Beenden mit Strg + C"
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

if (-not $NoBrowser) {
    try { Start-Process $pcUrl } catch {}
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $rawUrl = $request.Url.AbsolutePath
        $method = $request.HttpMethod

        # CORS Headers
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "*")

        if ($method -eq "OPTIONS") {
            $response.StatusCode = 200
            $response.Close()
            continue
        }

        # API: GET /api/songs
        if ($rawUrl -eq "/api/songs" -and $method -eq "GET") {
            $response.ContentType = "application/json; charset=utf-8"
            if (Test-Path $SongsJsonPath) {
                $jsonBytes = [System.IO.File]::ReadAllBytes($SongsJsonPath)
                $response.ContentLength64 = $jsonBytes.Length
                $response.OutputStream.Write($jsonBytes, 0, $jsonBytes.Length)
            } else {
                $empty = [System.Text.Encoding]::UTF8.GetBytes("[]")
                $response.OutputStream.Write($empty, 0, $empty.Length)
            }
            $response.Close()
            continue
        }

        # API: GET /api/stream/:id
        if ($rawUrl.StartsWith("/api/stream/") -and $method -eq "GET") {
            $songId = $rawUrl.Replace("/api/stream/", "")
            $songs = Get-Content $SongsJsonPath | ConvertFrom-Json
            $song = $songs | Where-Object { $_.id -eq $songId } | Select-Object -First 1

            if ($null -eq $song) {
                $response.StatusCode = 404
                $response.Close()
                continue
            }

            $targetAudio = Join-Path $AudioPath $song.fileName
            if (-not (Test-Path $targetAudio)) {
                $response.StatusCode = 404
                $response.Close()
                continue
            }

            $fileInfo = [System.IO.FileInfo]::$targetAudio
            $totalLength = $fileInfo.Length
            $response.ContentType = "audio/mpeg"
            $response.Headers.Add("Accept-Ranges", "bytes")

            # Handle Range Header for smooth seeking & buffering
            $rangeHeader = $request.Headers["Range"]
            if ($rangeHeader -and $rangeHeader.StartsWith("bytes=")) {
                $range = $rangeHeader.Replace("bytes=", "").Split("-")
                $start = [long]$range[0]
                $end = if ($range.Length -gt 1 -and $range[1] -ne "") { [long]$range[1] } else { $totalLength - 1 }
                if ($end -ge $totalLength) { $end = $totalLength - 1 }
                $count = ($end - $start) + 1

                $response.StatusCode = 206
                $response.Headers.Add("Content-Range", "bytes $start-$end/$totalLength")
                $response.ContentLength64 = $count

                $fs = [System.IO.File]::OpenRead($targetAudio)
                $fs.Seek($start, [System.IO.SeekOrigin]::Begin) | Out-Null
                $buffer = New-Object byte[] 65536
                $bytesRemaining = $count

                while ($bytesRemaining -gt 0) {
                    $readSize = [int][Math]::Min($buffer.Length, $bytesRemaining)
                    $read = $fs.Read($buffer, 0, $readSize)
                    if ($read -le 0) { break }
                    $response.OutputStream.Write($buffer, 0, $read)
                    $bytesRemaining -= $read
                }
                $fs.Close()
            } else {
                $response.ContentLength64 = $totalLength
                $fs = [System.IO.File]::OpenRead($targetAudio)
                $fs.CopyTo($response.OutputStream)
                $fs.Close()
            }

            $response.Close()
            continue
        }

        # API: DELETE /api/songs/:id
        if ($rawUrl.StartsWith("/api/songs/") -and $method -eq "DELETE") {
            $songId = $rawUrl.Replace("/api/songs/", "")
            $songs = Get-Content $SongsJsonPath | ConvertFrom-Json
            $updated = @($songs | Where-Object { $_.id -ne $songId })
            $updated | ConvertTo-Json -Depth 5 | Set-Content -Path $SongsJsonPath -Encoding UTF8

            $resObj = @{ success = $true; deletedId = $songId } | ConvertTo-Json
            $resBytes = [System.Text.Encoding]::UTF8.GetBytes($resObj)
            $response.ContentType = "application/json"
            $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
            $response.Close()
            continue
        }

        # Serve Uploads
        if ($rawUrl.StartsWith("/uploads/")) {
            $relPath = $rawUrl.Substring(9).Replace("/", "\")
            $filePath = Join-Path $UploadsPath $relPath
            if (Test-Path $filePath) {
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $response.ContentType = if ($MimeTypes.ContainsKey($ext)) { $MimeTypes[$ext] } else { "application/octet-stream" }
                $b = [System.IO.File]::ReadAllBytes($filePath)
                $response.ContentLength64 = $b.Length
                $response.OutputStream.Write($b, 0, $b.Length)
            } else {
                $response.StatusCode = 404
            }
            $response.Close()
            continue
        }

        # Static Public Files Fallback
        $relStatic = $rawUrl.TrimStart("/").Replace("/", "\")
        if ($relStatic -eq "") { $relStatic = "index.html" }
        $filePath = Join-Path $PublicPath $relStatic

        if (-not (Test-Path $filePath)) {
            $filePath = Join-Path $PublicPath "index.html"
        }

        if (Test-Path $filePath) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $response.ContentType = if ($MimeTypes.ContainsKey($ext)) { $MimeTypes[$ext] } else { "text/html; charset=utf-8" }
            $b = [System.IO.File]::ReadAllBytes($filePath)
            $response.ContentLength64 = $b.Length
            $response.OutputStream.Write($b, 0, $b.Length)
        } else {
            $response.StatusCode = 404
        }

        $response.Close()
    } catch {
        try { $context.Response.Close() } catch {}
    }
}
