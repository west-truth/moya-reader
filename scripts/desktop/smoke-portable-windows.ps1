Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$source = Join-Path (Get-Location) 'release/Moya.exe'
if (!(Test-Path $source)) { throw 'Portable executable is missing.' }

$firstFolder = Join-Path $env:RUNNER_TEMP 'Moya portable 한글 path'
$movedFolder = Join-Path $env:RUNNER_TEMP 'Moya portable moved path'
New-Item -ItemType Directory -Path $firstFolder -Force | Out-Null
Copy-Item $source (Join-Path $firstFolder 'Moya.exe') -Force

function Wait-ForRuntime($process, $folder) {
  $deadline = (Get-Date).AddSeconds(150)
  do {
    $process.Refresh()
    if ($process.HasExited) { throw "Moya.exe exited during first launch (code $($process.ExitCode))." }
    $sidecar = Get-ChildItem (Join-Path $folder 'MoyaData/runtime') -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like '*extension-sidecar*' } | Select-Object -First 1
    if ($sidecar -and (Test-Path (Join-Path $folder 'MoyaData/webview'))) { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'Moya.exe did not prepare its portable runtime and WebView data.'
}

function Stop-Moya($process) {
  if ($process) {
    $process.Refresh()
    if (!$process.HasExited) {
      Stop-Process -Id $process.Id -Force
      $process.WaitForExit(10000) | Out-Null
    }
  }
}

$first = $null
$second = $null
$moved = $null
try {
  $env:MOYA_PORTABLE_FORCE_FIXED_WEBVIEW2 = '1'
  $first = Start-Process (Join-Path $firstFolder 'Moya.exe') -PassThru
  Remove-Item Env:MOYA_PORTABLE_FORCE_FIXED_WEBVIEW2
  Wait-ForRuntime $first $firstFolder
  $fixed = Get-ChildItem (Join-Path $firstFolder 'MoyaData/runtime') -Filter 'msedgewebview2.exe' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*webview2-fixed*' } | Select-Object -First 1
  if (!$fixed) { throw 'The embedded fixed WebView2 runtime was not extracted.' }
  Start-Sleep -Seconds 5
  $first.Refresh()
  if ($first.HasExited) { throw 'Moya.exe exited after portable runtime preparation.' }

  $second = Start-Process (Join-Path $firstFolder 'Moya.exe') -PassThru
  if (!$second.WaitForExit(15000)) { throw 'A second Moya.exe did not focus or reject the running profile.' }
  $first.Refresh()
  if ($first.HasExited) { throw 'A second launch closed the running Moya.exe.' }

  Stop-Moya $first
  $first = $null
  Move-Item $firstFolder $movedFolder
  $moved = Start-Process (Join-Path $movedFolder 'Moya.exe') -PassThru
  Wait-ForRuntime $moved $movedFolder
  Start-Sleep -Seconds 5
  $moved.Refresh()
  if ($moved.HasExited) { throw 'Moya.exe exited after moving the entire portable folder.' }
  Write-Host 'Portable first launch, second launch, and folder move passed.'
} finally {
  Remove-Item Env:MOYA_PORTABLE_FORCE_FIXED_WEBVIEW2 -ErrorAction SilentlyContinue
  Stop-Moya $second
  Stop-Moya $first
  Stop-Moya $moved
}
