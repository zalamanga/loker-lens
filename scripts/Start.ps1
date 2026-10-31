param([ValidateRange(1024, 65535)][int]$Port = 8132)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$oldPort = $env:PORT
$oldApi = $env:JOBSTREET_API_URL
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
try {
    $env:PORT = [string]$Port
    if (-not $env:JOBSTREET_API_URL) { $env:JOBSTREET_API_URL = 'http://127.0.0.1:8131/' }
    $tempRoot = Join-Path $projectRoot '.local\tmp'
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    $env:TEMP = $tempRoot
    $env:TMP = $tempRoot
    Push-Location -LiteralPath $projectRoot
    try {
        Write-Host "Loker Lens: http://127.0.0.1:$Port/pencarian"
        Write-Host 'Untuk JobStreet, jalankan scripts/Start-JobStreet.ps1 pada terminal lain.'
        & node server.js
        if ($LASTEXITCODE -ne 0) { throw "Server berhenti dengan kode $LASTEXITCODE." }
    } finally { Pop-Location }
} finally {
    $env:PORT = $oldPort
    $env:JOBSTREET_API_URL = $oldApi
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
}
