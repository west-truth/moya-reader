$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem 'src-tauri/target/release/bundle/nsis/*-setup.exe' | Select-Object -First 1
if (!$installer) { throw 'Installer not found' }
$destination = Join-Path $env:TEMP 'Moya installed proof 한글'
$profile = Join-Path $env:APPDATA 'app.moya.reader.embedded-candidate/embedded-server'
if (Test-Path $profile) { throw 'Refusing to use an existing app profile for installation proof' }
$installed = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$destination") -PassThru -Wait
if ($installed.ExitCode -notin @(0, 3010)) { throw "Installation failed: $($installed.ExitCode)" }
$executable = Get-ChildItem $destination -File -Filter '*.exe' | Where-Object { $_.Name -notmatch 'uninstall|guard' } | Select-Object -First 1
if (!$executable) { throw 'Installed app not found' }
$oldPath = $env:PATH
$app = $null
try {
  # The installed app must use its bundled Node/DB, even when developer tools exist on the runner.
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  $app = Start-Process -FilePath $executable.FullName -PassThru
  $deadline = (Get-Date).AddSeconds(120)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ($app.HasExited) { throw 'Installed app exited before server readiness' }
    try {
      $config = Get-Content (Join-Path $profile 'server-credentials.json') -Raw | ConvertFrom-Json
      $url = "http://127.0.0.1:$($config.ports.api)"
      $health = Invoke-WebRequest "$url/api/ready" -TimeoutSec 2
      if ($health.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (!$ready) { throw 'Installed server did not become ready' }
  $books = Invoke-WebRequest "$url/api/books" -Headers @{ Authorization = "Bearer $($config.authToken)" } -TimeoutSec 5
  if ($books.StatusCode -ne 200) { throw 'Installed library request failed' }
  New-Item -ItemType Directory -Force '.tmp/embedded-evidence' | Out-Null
  @{ installedRelease = $true; bundledServer = $true; developerPathRemoved = $true; cleanMachine = $false; installerBytes = $installer.Length } | ConvertTo-Json | Set-Content '.tmp/embedded-evidence/installer-smoke-result.json'
} finally {
  $env:PATH = $oldPath
  if ($app -and !$app.HasExited) { Stop-Process -Id $app.Id }
  $deadline = (Get-Date).AddSeconds(45)
  while ((Test-Path (Join-Path $profile 'server.lock')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Test-Path (Join-Path $profile 'server.lock')) { throw 'Installed server did not clean up after its window process exited' }
}
