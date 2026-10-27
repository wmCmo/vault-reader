# Stops the vault reader. With -RemoveServe it also removes its Tailscale
# serve entry (only this app's port; never `tailscale serve reset`).
param([switch]$RemoveServe)
$root = $PSScriptRoot
$config = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json

$conn = Get-NetTCPConnection -LocalPort $config.port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force
    Write-Host "Stopped vault reader (pid $($conn.OwningProcess))"
} else {
    Write-Host 'Vault reader was not running'
}

if ($RemoveServe) {
    & tailscale serve --https=$($config.tailscaleHttpsPort) off
    Write-Host "Removed Tailscale serve on :$($config.tailscaleHttpsPort)"
}
