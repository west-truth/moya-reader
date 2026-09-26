param([string]$BaselineInstaller)
$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem 'src-tauri/target/release/bundle/nsis/*-setup.exe' | Select-Object -First 1
if (!$installer) { throw 'Installer not found' }
$destination = Join-Path $env:TEMP 'Moya installed proof 한글'
$profile = Join-Path $env:APPDATA 'app.moya.reader.embedded-candidate/embedded-server'
if (Test-Path $profile) { throw 'Refusing to use an existing app profile for installation proof' }
$node = (Get-Command node).Source
$fixture = Join-Path $env:TEMP 'moya-installed-library-proof.json'
$oldPath = $env:PATH
$app = $null
function Install-Candidate([string]$file) {
  $installed = Start-Process -FilePath $file -ArgumentList @('/S', "/D=$destination") -PassThru -Wait
  if ($installed.ExitCode -notin @(0, 3010)) { throw "Installation failed: $($installed.ExitCode)" }
}
function Start-Candidate {
  $executable = Get-ChildItem $destination -File -Filter '*.exe' | Where-Object { $_.Name -notmatch 'uninstall|guard' } | Select-Object -First 1
  if (!$executable) { throw 'Installed app not found' }
  $script:app = Start-Process -FilePath $executable.FullName -PassThru
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    if ($script:app.HasExited) { throw 'Installed app exited before server readiness' }
    try {
      $config = Get-Content (Join-Path $profile 'server-credentials.json') -Raw | ConvertFrom-Json
      $url = "http://127.0.0.1:$($config.ports.api)"
      $health = Invoke-WebRequest "$url/api/ready" -TimeoutSec 2
      if ($health.StatusCode -eq 200) { return }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  throw 'Installed server did not become ready'
}
function Stop-Candidate {
  if ($script:app -and !$script:app.HasExited) { Stop-Process -Id $script:app.Id }
  $deadline = (Get-Date).AddSeconds(45)
  while ((Test-Path (Join-Path $profile 'server.lock')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Test-Path (Join-Path $profile 'server.lock')) { throw 'Installed server did not clean up after its window process exited' }
}
try {
  $firstInstaller = if ($BaselineInstaller) { (Resolve-Path $BaselineInstaller).Path } else { $installer.FullName }
  Install-Candidate $firstInstaller
  # The app must use bundled Node/DB even when developer tools exist on the runner.
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  Start-Candidate
  & $node scripts/desktop/verify-installed-library.mjs seed $profile $fixture
  if ($LASTEXITCODE -ne 0) { throw 'Installed fixture creation failed' }
  Stop-Candidate
  Install-Candidate $installer.FullName
  Start-Candidate
  & $node scripts/desktop/verify-installed-library.mjs verify $profile $fixture
  if ($LASTEXITCODE -ne 0) { throw 'Installed library did not survive update' }
  New-Item -ItemType Directory -Force '.tmp/embedded-evidence' | Out-Null
  @{ installedRelease = $true; bundledServer = $true; developerPathRemoved = $true; cleanMachine = $false;
     originalAndBookmarkPreserved = $true; previousInstallerUsed = [bool]$BaselineInstaller;
     installerBytes = $installer.Length } | ConvertTo-Json | Set-Content '.tmp/embedded-evidence/installer-smoke-result.json'
} finally {
  $env:PATH = $oldPath
  Stop-Candidate
}
