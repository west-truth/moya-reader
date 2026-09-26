Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$env:MOYA_PORTABLE_SMOKE_TOKEN = [guid]::NewGuid().ToString('N')
$source = Join-Path (Get-Location) 'release/Moya.exe'
if (!(Test-Path $source)) { throw 'Portable executable is missing.' }

$firstFolder = Join-Path $env:RUNNER_TEMP 'Moya portable 한글 path'
$movedFolder = Join-Path $env:RUNNER_TEMP 'Moya portable moved path'
New-Item -ItemType Directory -Path $firstFolder -Force | Out-Null
Copy-Item $source (Join-Path $firstFolder 'Moya.exe') -Force

function Wait-ForRuntime($process, $folder, $stderrName, $expectPersisted = $false) {
  $deadline = (Get-Date).AddSeconds(150)
  do {
    $process.Refresh()
    if ($process.HasExited) {
      Write-Host "Profile exists: $(Test-Path (Join-Path $folder 'MoyaData'))"
      Get-ChildItem $folder -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 60 -ExpandProperty FullName
      $stderr = Join-Path $folder $stderrName
      if (Test-Path $stderr) { Get-Content $stderr -Tail 30 }
      throw "Moya.exe exited during launch (code $($process.ExitCode))."
    }
    $sidecar = Get-ChildItem (Join-Path $folder 'MoyaData/runtime') -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like '*extension-sidecar*' } | Select-Object -First 1
    $marker = Join-Path $folder "MoyaData/.smoke-$env:MOYA_PORTABLE_SMOKE_TOKEN.json"
    if ($sidecar -and (Test-Path $marker)) {
      $ready = Get-Content $marker -Raw | ConvertFrom-Json
      if ($ready.pid -eq $process.Id -and (!$expectPersisted -or $ready.persisted)) { return }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'Moya.exe did not prepare its portable runtime and WebView data.'
}

function Stop-Moya($process) {
  if ($process) {
    $process.Refresh()
    if (!$process.HasExited) {
      $null = $process.CloseMainWindow()
      if (!$process.WaitForExit(10000)) { Stop-Process -Id $process.Id -Force; $process.WaitForExit(10000) | Out-Null }
    }
  }
}

$first = $null
$second = $null
$moved = $null
try {
  $first = Start-Process (Join-Path $firstFolder 'Moya.exe') -PassThru -RedirectStandardError (Join-Path $firstFolder 'moya-stderr.txt')
  Write-Host "Normal Moya process: $($first.Id)"
  Wait-ForRuntime $first $firstFolder 'moya-stderr.txt'
  Start-Sleep -Seconds 5
  $first.Refresh()
  if ($first.HasExited) { throw 'Moya.exe exited after portable runtime preparation.' }

  $second = Start-Process (Join-Path $firstFolder 'Moya.exe') -PassThru
  Write-Host "Second Moya process: $($second.Id)"
  if (!$second.WaitForExit(15000)) { throw 'A second Moya.exe did not focus or reject the running profile.' }
  $first.Refresh()
  if ($first.HasExited) { throw 'A second launch closed the running Moya.exe.' }

  Stop-Moya $first
  $first = $null
  Move-Item $firstFolder $movedFolder
  $moved = Start-Process (Join-Path $movedFolder 'Moya.exe') -PassThru -RedirectStandardError (Join-Path $movedFolder 'moya-moved-stderr.txt')
  Wait-ForRuntime $moved $movedFolder 'moya-moved-stderr.txt' $true
  Start-Sleep -Seconds 5
  $moved.Refresh()
  if ($moved.HasExited) { throw 'Moya.exe exited after moving the entire portable folder.' }
  Write-Host 'Portable UI mount, second launch exclusion, and setting preservation after folder move passed.'
} finally {
  Remove-Item Env:MOYA_PORTABLE_SMOKE_TOKEN -ErrorAction SilentlyContinue
  Stop-Moya $second
  Stop-Moya $first
  Stop-Moya $moved
}
