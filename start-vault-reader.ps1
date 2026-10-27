# Starts the vault reader in the background (skips it if it's already running)
# and makes sure Tailscale serves it to the tailnet over HTTPS.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$configPath = Join-Path $root 'config.json'
if (-not (Test-Path $configPath)) {
    Copy-Item (Join-Path $root 'config.example.json') $configPath
    Write-Warning "Created config.json from the example. Set ""vault"" to your vault folder, then run this again."
    return
}
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$port = $config.port
$httpsPort = $config.tailscaleHttpsPort

# A server started from an elevated shell runs as admin, and a normal shell
# can't stop it afterwards.
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning 'This shell is elevated. Run the vault reader from a normal (non-admin) PowerShell.'
    return
}

if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Vault reader already running on 127.0.0.1:$port"
} else {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) {
        Push-Location $root
        try { npm install --omit=dev } finally { Pop-Location }
    }
    Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WorkingDirectory $root -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        if ((Get-Date) -gt $deadline) { throw "Server didn't start. See $root\logs\server.log" }
        Start-Sleep -Milliseconds 300
    }
    Write-Host "Vault reader started on 127.0.0.1:$port"
}

# Only ever touch our own port: other apps may be served on other ports, so
# never `tailscale serve reset`.
$serveStatus = (& tailscale serve status 2>&1) -join "`n"
if ($serveStatus -notmatch ":$httpsPort\b") {
    & tailscale serve --bg --https=$httpsPort "http://127.0.0.1:$port" | Out-Null
    $serveStatus = (& tailscale serve status 2>&1) -join "`n"
}
# Read the URL from `serve status` rather than `tailscale status --json`: the
# JSON holds the Japanese hostnames, which Windows PowerShell decodes with the
# console code page and then fails to parse.
if ($serveStatus -match "https://[^\s/]+:$httpsPort\b") {
    Write-Host "Phone URL: $($Matches[0])/"
} else {
    Write-Warning "tailscale serve isn't serving :$httpsPort. Output:`n$serveStatus"
}
