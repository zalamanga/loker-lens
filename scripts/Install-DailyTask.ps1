param(
    [Parameter(Mandatory = $true)][ValidateLength(1, 120)][string]$Query,
    [ValidateLength(0, 100)][string]$Location = '',
    [ValidatePattern('^(?:[01][0-9]|2[0-3]):[0-5][0-9]$')][string]$At = '09:00'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$taskName = 'LokerLens-PencarianHarian'
if (-not $Query.Trim()) { throw 'Kata kunci wajib diisi.' }
if ([TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).TotalHours -ne 7) { throw 'Jadwal ini mengharapkan zona waktu komputer UTC+7 (WIB). Kuota tetap dihitung Asia/Jakarta.' }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Task sudah ada. Tinjau lewat Task Scheduler sebelum mengubahnya.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.local\jobstreet-service\dependencies.sha256'))) { throw 'Jalankan scripts/Start-JobStreet.ps1 -SetupOnly dahulu.' }
$configRoot = Join-Path $projectRoot '.data\board'
New-Item -ItemType Directory -Force -Path $configRoot | Out-Null
$configPath = Join-Path $configRoot 'daily-query.json'
$config = @{ query = $Query.Trim(); location = $Location.Trim() } | ConvertTo-Json
[IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$collector = Join-Path $PSScriptRoot 'Collect-Daily.mjs'
$taskArguments = '"' + $collector + '" --config "' + $configPath + '"'
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $taskArguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Mengambil loker JobStreet ke antrean lokal, maksimal 20 pilihan/hari. Tidak mengirim lamaran.' | Out-Null
Write-Host "Task $taskName terdaftar pukul $At waktu komputer. Hanya berjalan saat pengguna login dan komputer menyala."
