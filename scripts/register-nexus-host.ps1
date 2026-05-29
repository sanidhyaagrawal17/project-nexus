param(
    [string]$HostName = 'nexus'
)

$hostsPath = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'
$entry = "127.0.0.1`t$HostName"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "This script needs to run as Administrator to edit the hosts file." -ForegroundColor Yellow
    Write-Host "Right-click PowerShell and choose 'Run as administrator', then run:" -ForegroundColor Yellow
    Write-Host "  .\scripts\register-nexus-host.ps1" -ForegroundColor Yellow
    exit 1
}

$hostsContent = Get-Content -Path $hostsPath -ErrorAction Stop
if ($hostsContent -match "(?m)^127\.0\.0\.1\s+$([regex]::Escape($HostName))$") {
    Write-Host "$HostName is already registered in hosts." -ForegroundColor Green
    exit 0
}

Add-Content -Path $hostsPath -Value $entry
Write-Host "Added $entry to $hostsPath" -ForegroundColor Green
Write-Host "You can now open http://$HostName in your browser after Docker starts." -ForegroundColor Green
