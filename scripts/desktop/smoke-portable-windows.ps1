Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$source = Join-Path (Get-Location) 'release/Moya.exe'
if (!(Test-Path $source)) { throw 'Portable executable is missing.' }

$firstFolder = Join-Path $env:RUNNER_TEMP 'Moya portable 한글 path'
$movedFolder = Join-Path $env:RUNNER_TEMP 'Moya portable moved path'
New-Item -ItemType Directory -Path $firstFolder -Force | Out-Null
Copy-Item $source (Join-Path $firstFolder 'Moya.exe') -Force

function Wait-ForRuntime($process, $folder, $stderrName) {
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
    if ($sidecar -and (Test-Path (Join-Path $folder 'MoyaData/webview'))) { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'Moya.exe did not prepare its portable runtime and WebView data.'
}

function Wait-ForFixedWebView($process, $folder) {
  $deadline = (Get-Date).AddSeconds(150)
  do {
    $process.Refresh()
    if ($process.HasExited) {
      $stderr = Join-Path $folder 'moya-fixed-stderr.txt'
      if (Test-Path $stderr) { Get-Content $stderr -Tail 30 }
      throw "Moya.exe exited while preparing fixed WebView2 (code $($process.ExitCode))."
    }
    $fixed = Get-ChildItem (Join-Path $folder 'MoyaData/runtime') -Filter 'msedgewebview2.exe' -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like '*webview2-fixed*' } | Select-Object -First 1
    if ($fixed) { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  Write-Host 'Fixed WebView2 extraction diagnostics:'
  Get-ChildItem (Join-Path $folder 'MoyaData/runtime') -Recurse -Depth 2 -ErrorAction SilentlyContinue |
    Select-Object -First 80 FullName, Length | Format-Table -AutoSize
  Get-CimInstance Win32_Process -Filter "name = 'Moya.exe' or name = 'expand.exe'" |
    Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-Table -Wrap
  $stderr = Join-Path $folder 'moya-fixed-stderr.txt'
  if (Test-Path $stderr) { Get-Content $stderr -Tail 30 }
  throw 'The embedded fixed WebView2 runtime was not extracted.'
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
$forced = $null
$moved = $null
try {
  $first = Start-Process (Join-Path $firstFolder 'Moya.exe') -PassThru -RedirectStandardError (Join-Path $firstFolder 'moya-stderr.txt')
  Wait-ForRuntime $first $firstFolder 'moya-stderr.txt'
  Start-Sleep -Seconds 5
  $first.Refresh()
  if ($first.HasExited) { throw 'Moya.exe exited after portable runtime preparation.' }

  $second = Start-Process (Join-Path $firstFolder 'Moya.exe') -PassThru
  if (!$second.WaitForExit(15000)) { throw 'A second Moya.exe did not focus or reject the running profile.' }
  $first.Refresh()
  if ($first.HasExited) { throw 'A second launch closed the running Moya.exe.' }

  Stop-Moya $first
  $first = $null
  $env:MOYA_PORTABLE_FORCE_FIXED_WEBVIEW2 = '1'
  $forced = Start-Process (Join-Path $firstFolder 'Moya.exe') -PassThru -RedirectStandardError (Join-Path $firstFolder 'moya-fixed-stderr.txt')
  Remove-Item Env:MOYA_PORTABLE_FORCE_FIXED_WEBVIEW2
  Wait-ForFixedWebView $forced $firstFolder
  Stop-Moya $forced
  $forced = $null
  Move-Item $firstFolder $movedFolder
  $moved = Start-Process (Join-Path $movedFolder 'Moya.exe') -PassThru -RedirectStandardError (Join-Path $movedFolder 'moya-moved-stderr.txt')
  Wait-ForRuntime $moved $movedFolder 'moya-moved-stderr.txt'
  Start-Sleep -Seconds 5
  $moved.Refresh()
  if ($moved.HasExited) { throw 'Moya.exe exited after moving the entire portable folder.' }
  Write-Host 'Portable first launch, second launch, and folder move passed.'
} finally {
  Remove-Item Env:MOYA_PORTABLE_FORCE_FIXED_WEBVIEW2 -ErrorAction SilentlyContinue
  Stop-Moya $second
  Stop-Moya $first
  Stop-Moya $forced
  Stop-Moya $moved
}
