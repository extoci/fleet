$ErrorActionPreference = 'Stop'

$Repository = if ($env:FLEET_REPOSITORY) { $env:FLEET_REPOSITORY } else { 'extoci/fleet' }
$Version = if ($env:FLEET_VERSION) { $env:FLEET_VERSION } else { 'latest' }
$InstallDir = if ($env:FLEET_INSTALL_DIR) { $env:FLEET_INSTALL_DIR } else { Join-Path $HOME '.local\bin' }
$AppDir = if ($env:FLEET_APP_DIR) { $env:FLEET_APP_DIR } else { Join-Path $HOME '.fleet\runtime' }
$NoInstallBun = $env:FLEET_NO_INSTALL_BUN -eq '1'

function Find-Bun {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $defaultBun = Join-Path $HOME '.bun\bin\bun.exe'
  if (Test-Path $defaultBun) { return $defaultBun }
  return $null
}

$BunExe = Find-Bun
if (-not $BunExe) {
  if ($NoInstallBun) {
    throw 'Bun 1.4.0 or later is required. Install it from https://bun.com'
  }
  Write-Host 'Installing Bun...'
  powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://bun.sh/install.ps1 | iex'
  $BunExe = Find-Bun
  if (-not $BunExe) {
    throw 'Bun was installed, but bun.exe could not be found.'
  }
}

$RawVersion = (& $BunExe --version).Trim()
$Parts = $RawVersion.Split('.')
if ($Parts.Length -lt 2 -or ([int]$Parts[0] -lt 1) -or (([int]$Parts[0] -eq 1) -and ([int]$Parts[1] -lt 4))) {
  throw "Bun 1.4.0 or later is required (found $RawVersion). Run: bun upgrade"
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("fleet-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
  $ArchivePath = Join-Path $TempDir 'fleet.tar.gz'
  if ($env:FLEET_ARCHIVE) {
    if (-not (Test-Path $env:FLEET_ARCHIVE)) {
      throw "FLEET_ARCHIVE does not exist: $($env:FLEET_ARCHIVE)"
    }
    Copy-Item $env:FLEET_ARCHIVE $ArchivePath
    $LocalChecksum = "$($env:FLEET_ARCHIVE).sha256"
    if (Test-Path $LocalChecksum) {
      $Expected = ((Get-Content $LocalChecksum -Raw).Trim().Split()[0]).ToLowerInvariant()
      $Actual = (Get-FileHash $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($Expected -ne $Actual) { throw 'Release checksum did not match.' }
    }
  } elseif ($Version -eq 'main') {
    Write-Host "Downloading Fleet from $Repository (main)..."
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repository/archive/refs/heads/main.tar.gz" -OutFile $ArchivePath
  } else {
    $Base = if ($Version -eq 'latest') {
      "https://github.com/$Repository/releases/latest/download"
    } else {
      "https://github.com/$Repository/releases/download/$Version"
    }
    Write-Host "Downloading Fleet ($Version)..."
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$Base/fleet.tar.gz" -OutFile $ArchivePath
    } catch {
      if ($Version -eq 'latest') {
        throw 'Could not download the latest Fleet release archive. To install from main instead, run: $env:FLEET_VERSION="main"; irm https://fleet.extoci.lol/install.ps1 | iex'
      }
      throw "Could not download Fleet release $Version."
    }
    $ChecksumPath = "$ArchivePath.sha256"
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/fleet.tar.gz.sha256" -OutFile $ChecksumPath
    $Expected = ((Get-Content $ChecksumPath -Raw).Trim().Split()[0]).ToLowerInvariant()
    $Actual = (Get-FileHash $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Expected -ne $Actual) { throw 'Release checksum did not match.' }
  }

  $UnpackDir = Join-Path $TempDir 'unpack'
  New-Item -ItemType Directory -Path $UnpackDir -Force | Out-Null
  tar -xzf $ArchivePath -C $UnpackDir

  $SourceRoot = $null
  if ((Test-Path (Join-Path $UnpackDir 'package.json')) -and (Test-Path (Join-Path $UnpackDir 'src\cli.ts'))) {
    $SourceRoot = $UnpackDir
  } else {
    foreach ($Entry in Get-ChildItem -Directory $UnpackDir) {
      if ((Test-Path (Join-Path $Entry.FullName 'package.json')) -and (Test-Path (Join-Path $Entry.FullName 'src\cli.ts'))) {
        $SourceRoot = $Entry.FullName
        break
      }
    }
  }
  if (-not $SourceRoot) {
    throw 'Archive did not contain Fleet (missing package.json or src/cli.ts).'
  }

  if (-not (Test-Path (Join-Path $SourceRoot 'node_modules\preact'))) {
    Write-Host 'Installing Fleet runtime dependencies with Bun...'
    Push-Location $SourceRoot
    try {
      & $BunExe install --production --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { throw 'bun install failed.' }
    } finally {
      Pop-Location
    }
  }

  $AppParent = Split-Path -Parent $AppDir
  New-Item -ItemType Directory -Path $AppParent -Force | Out-Null
  $StagingDir = "$AppDir.staging.$PID"
  if (Test-Path $StagingDir) { Remove-Item $StagingDir -Recurse -Force }
  Move-Item $SourceRoot $StagingDir

  $BackupDir = "$AppDir.old.$PID"
  if (Test-Path $BackupDir) { Remove-Item $BackupDir -Recurse -Force }
  if (Test-Path $AppDir) { Move-Item $AppDir $BackupDir }

  try {
    Move-Item $StagingDir $AppDir
  } catch {
    if (Test-Path $BackupDir) { Move-Item $BackupDir $AppDir -ErrorAction SilentlyContinue }
    throw
  }
  if (Test-Path $BackupDir) { Remove-Item $BackupDir -Recurse -Force }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $CliPath = Join-Path $AppDir 'src\cli.ts'
  $CmdFile = Join-Path $InstallDir 'fleet.cmd'
  @"
@echo off
"$BunExe" "$CliPath" %*
"@ | Set-Content -Path $CmdFile -Encoding Ascii

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $PathParts = if ($UserPath) { $UserPath.Split(';') } else { @() }
  if ($PathParts -notcontains $InstallDir) {
    $NextPath = if ($UserPath) { "$InstallDir;$UserPath" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $NextPath, 'User')
    $env:Path = "$InstallDir;$env:Path"
    Write-Host "Added $InstallDir to your user PATH."
  }

  $InstalledVersion = (& $CmdFile --version).Trim()
  Write-Host "$InstalledVersion installed at $CmdFile"
  Write-Host ''
  Write-Host 'Next steps:'
  Write-Host '  fleet setup --install'
  Write-Host '  fleet init notes'
  Write-Host '  fleet open notes'
} finally {
  if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
}
