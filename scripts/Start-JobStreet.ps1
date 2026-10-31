[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8131,
    [switch]$SetupOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$UpstreamUrl = 'https://github.com/omkarcloud/jobstreet-scraper.git'
$UpstreamCommit = '47c0b1712671d07e56696b3f4a69013ba4f66a0c'

function Get-ProjectPath([string]$RelativePath) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $RelativePath))
    if (-not $candidate.StartsWith($ProjectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The service path must stay inside this project.'
    }
    $ancestor = $candidate
    while ($ancestor -and $ancestor -ne $ProjectRoot) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Service paths may not contain symbolic links or directory junctions.'
            }
        }
        $ancestor = Split-Path -Parent $ancestor
    }
    return $candidate
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "A setup command failed with exit code $LASTEXITCODE."
    }
}

$LocalRoot = Get-ProjectPath '.local/jobstreet-service'
$SourceRoot = Get-ProjectPath '.local/jobstreet-service/upstream'
$VenvRoot = Get-ProjectPath '.local/jobstreet-service/venv'
$Python = Get-ProjectPath '.local/jobstreet-service/venv/Scripts/python.exe'
$CacheRoot = Get-ProjectPath '.local/jobstreet-service/cache'
$TempRoot = Get-ProjectPath '.local/jobstreet-service/tmp'
$BytecodeRoot = Get-ProjectPath '.local/jobstreet-service/pycache'
$StatePath = Get-ProjectPath '.local/jobstreet-service/dependencies.sha256'
$LockPath = Join-Path $PSScriptRoot 'jobstreet-requirements.txt'
$RunnerPath = Join-Path $PSScriptRoot 'jobstreet-service.py'
$PythonOptions = @('-I', '-X', "pycache_prefix=$BytecodeRoot")

$previousEnvironment = @{}
foreach ($name in @('TEMP', 'TMP', 'PIP_CACHE_DIR', 'PYTHONPYCACHEPREFIX', 'PYTHONNOUSERSITE')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    New-Item -ItemType Directory -Path $LocalRoot, $CacheRoot, $TempRoot, $BytecodeRoot -Force | Out-Null
    $env:TEMP = $TempRoot
    $env:TMP = $TempRoot
    $env:PIP_CACHE_DIR = $CacheRoot
    $env:PYTHONPYCACHEPREFIX = $BytecodeRoot
    $env:PYTHONNOUSERSITE = '1'

    if (-not (Test-Path -LiteralPath $SourceRoot)) {
        Invoke-Checked 'git' @('-c', 'core.hooksPath=NUL', 'clone', '--no-checkout', $UpstreamUrl, $SourceRoot)
        Invoke-Checked 'git' @('-C', $SourceRoot, '-c', 'core.hooksPath=NUL', 'checkout', '--detach', $UpstreamCommit)
    }
    if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot '.git'))) {
        throw 'The upstream directory exists but is not the expected Git checkout.'
    }
    $revision = & git -C $SourceRoot rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or "$revision".Trim() -ne $UpstreamCommit) {
        throw 'The upstream checkout is not at the reviewed commit; it was not changed automatically.'
    }
    if ((Get-Content -LiteralPath (Join-Path $SourceRoot '.git/HEAD') -Raw).Trim() -ne $UpstreamCommit) {
        throw 'The upstream checkout must be detached at the reviewed commit.'
    }
    $origin = & git -C $SourceRoot remote get-url origin
    if ($LASTEXITCODE -ne 0 -or "$origin".Trim() -ne $UpstreamUrl) {
        throw 'The upstream origin does not match the reviewed repository.'
    }
    $changes = & git -C $SourceRoot status --porcelain
    if ($LASTEXITCODE -ne 0 -or $changes) {
        throw 'The upstream checkout has local changes; it was not changed automatically.'
    }

    if (-not (Test-Path -LiteralPath $Python)) {
        Invoke-Checked 'py' @('-3.13', '-I', '-B', '-m', 'venv', $VenvRoot)
    }
    Invoke-Checked $Python ($PythonOptions + @('-c', 'import sys; assert sys.version_info[:2] == (3, 13), "Python 3.13 is required"'))

    $lockHash = (Get-FileHash -LiteralPath $LockPath -Algorithm SHA256).Hash
    $installedHash = if (Test-Path -LiteralPath $StatePath) { (Get-Content -LiteralPath $StatePath -Raw).Trim() } else { '' }
    if ($installedHash -ne $lockHash) {
        Invoke-Checked $Python ($PythonOptions + @('-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--require-hashes', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '--cache-dir', $CacheRoot, '--requirement', $LockPath))
        Invoke-Checked $Python ($PythonOptions + @('-m', 'pip', '--isolated', '--disable-pip-version-check', 'check'))
        Set-Content -LiteralPath $StatePath -Value $lockHash -Encoding Ascii
    }
    Invoke-Checked $Python ($PythonOptions + @('-c', 'import bottle, cheroot, curl_cffi, marshmallow'))

    if ($SetupOnly) {
        Write-Host 'JobStreet setup complete. No upstream job request was made.'
    } else {
        Write-Host "Starting the read-only JobStreet service at http://127.0.0.1:$Port/ (Ctrl+C stops it)."
        Invoke-Checked $Python ($PythonOptions + @($RunnerPath, '--port', "$Port"))
    }
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}
