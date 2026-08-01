$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class GatewayWindowProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  public static IntPtr[] ForProcess(uint targetPid) {
    var handles = new List<IntPtr>();
    EnumWindows((handle, extra) => {
      uint pid;
      GetWindowThreadProcessId(handle, out pid);
      if (pid == targetPid) handles.Add(handle);
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }
}
'@

$artifactPath = (Resolve-Path -LiteralPath "release\AI Load Balancer.exe").Path
$existingListeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge 42891 -and $_.LocalPort -le 42940 }
if ($existingListeners) { throw "Gateway port range is not clean before the packaged smoke test." }
$preexistingAppPids = @(Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "AI Load Balancer.exe" } |
  Select-Object -ExpandProperty ProcessId)

$portBlocker = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 42891)
$firstLauncher = $null
$secondLauncher = $null
$mainPid = $null
$knownUtilityPids = [System.Collections.Generic.List[int]]::new()
$selectedPort = $null

try {
  $portBlocker.Start()
  $firstLauncher = Start-Process -FilePath $artifactPath -PassThru -WindowStyle Hidden
  $healthResult = $null
  for ($attempt = 0; $attempt -lt 180 -and -not $healthResult; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    $candidatePorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -eq "127.0.0.1" -and $_.LocalPort -ge 42892 -and $_.LocalPort -le 42940 } |
      Select-Object -ExpandProperty LocalPort -Unique)
    foreach ($candidatePort in $candidatePorts) {
      try {
        $candidateHealth = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $candidatePort) -TimeoutSec 1
        if ($candidateHealth.version -eq "0.2.0" -and $candidateHealth.name -eq "AI Load Balancer") {
          $selectedPort = $candidatePort
          $healthResult = $candidateHealth
          break
        }
      } catch {}
    }
  }
  if (-not $healthResult) { throw "Packaged app did not become healthy within 90 seconds." }
  if ($selectedPort -ne 42892) { throw "Expected occupied-port fallback to 42892, got $selectedPort." }

  $initialUtilityPid = (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $selectedPort -State Listen).OwningProcess
  $knownUtilityPids.Add($initialUtilityPid)
  $initialUtility = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $initialUtilityPid)
  $mainPid = $initialUtility.ParentProcessId
  Stop-Process -Id $initialUtilityPid -Force

  $restartedUtilityPid = $null
  for ($attempt = 0; $attempt -lt 40 -and -not $restartedUtilityPid; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    try {
      $recoveryHealth = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $selectedPort) -TimeoutSec 1
      $currentUtilityPid = (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $selectedPort -State Listen).OwningProcess
      if ($recoveryHealth.version -eq "0.2.0" -and $currentUtilityPid -ne $initialUtilityPid) {
        $restartedUtilityPid = $currentUtilityPid
        $knownUtilityPids.Add($restartedUtilityPid)
      }
    } catch {}
  }
  if (-not $restartedUtilityPid) { throw "Utility process did not recover after an intentional crash." }

  $secondLauncher = Start-Process -FilePath $artifactPath -PassThru -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 60 -and -not $secondLauncher.HasExited; $attempt += 1) {
    Start-Sleep -Milliseconds 500
  }
  $electronMains = @(Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "AI Load Balancer.exe" -and
      $_.ExecutablePath -like "*\AppData\Local\Temp\*\AI Load Balancer.exe" -and
      $_.CommandLine -notmatch "--type="
    })
  $activeGatewayListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq "127.0.0.1" -and $_.LocalPort -ge 42892 -and $_.LocalPort -le 42940 })
  if ($electronMains.Count -ne 1) { throw "Expected one Electron main process after second launch, found $($electronMains.Count)." }
  if ($activeGatewayListeners.Count -ne 1) { throw "Expected one gateway listener after second launch, found $($activeGatewayListeners.Count)." }

  $windowHandles = [GatewayWindowProbe]::ForProcess([uint32]$mainPid)
  foreach ($handle in $windowHandles) {
    [GatewayWindowProbe]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  }
  $listenerStopped = $false
  for ($attempt = 0; $attempt -lt 20 -and -not $listenerStopped; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    $listenerStopped = -not [bool](Get-NetTCPConnection -LocalPort $selectedPort -State Listen -ErrorAction SilentlyContinue)
  }
  if (-not $listenerStopped) { throw "Backend listener remained after window close." }

  [pscustomobject]@{
    OccupiedPort = 42891
    SelectedPort = $selectedPort
    Ready = $healthResult.ready
    InitialUtilityPid = $initialUtilityPid
    RestartedUtilityPid = $restartedUtilityPid
    UtilityRecovered = ($initialUtilityPid -ne $restartedUtilityPid)
    ElectronMainProcessesAfterSecondLaunch = $electronMains.Count
    GatewayListenersAfterSecondLaunch = $activeGatewayListeners.Count
    SecondLauncherExited = $secondLauncher.HasExited
    HiddenWindowHandlesFound = $windowHandles.Count
    ListenerStoppedAfterWindowClose = $listenerStopped
  } | ConvertTo-Json -Depth 6
}
finally {
  $portBlocker.Stop()
  foreach ($launcher in @($firstLauncher, $secondLauncher)) {
    if ($launcher -and -not $launcher.HasExited) { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue }
  }
  if ($mainPid) {
    $mainProcess = Get-Process -Id $mainPid -ErrorAction SilentlyContinue
    if ($mainProcess -and $mainProcess.ProcessName -eq "AI Load Balancer") {
      Stop-Process -Id $mainPid -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($utilityPid in $knownUtilityPids) {
    $utilityProcess = Get-Process -Id $utilityPid -ErrorAction SilentlyContinue
    if ($utilityProcess -and $utilityProcess.ProcessName -eq "AI Load Balancer") {
      Stop-Process -Id $utilityPid -Force -ErrorAction SilentlyContinue
    }
  }
  $testAppProcesses = @(Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "AI Load Balancer.exe" -and
      $_.ProcessId -notin $preexistingAppPids -and
      $_.CommandLine -like "*\AppData\Local\Temp\*"
    })
  if ($testAppProcesses) {
    Stop-Process -Id $testAppProcesses.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
