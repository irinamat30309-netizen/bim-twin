#requires -version 5
<#
  BIM Twin - persistent native-window embedding helper (Windows only).

  Reparents a foreign top-level window (e.g. CloudCompare.exe) into a BIM Twin
  panel so the editor appears INSIDE the app window instead of opening as a
  separate application. Driven from the Electron main process over stdin with
  newline-delimited JSON commands:

    {"cmd":"embed","pid":1234,"parent":"<hwnd-decimal>","x":0,"y":0,"w":800,"h":600}
    {"cmd":"move","x":0,"y":0,"w":800,"h":600}
    {"cmd":"release"}
    {"cmd":"quit"}

  It prints short status lines ("OK embedded", "ERR window_not_found", ...) on
  stdout. ASCII-only on purpose: PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
  so any non-ASCII here could be misparsed. Keep this file ASCII.
#>
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BtWin {
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left; public int top; public int right; public int bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  public static uint WantPid = 0;
  public static IntPtr Best = IntPtr.Zero;
  public static long BestArea = 0;
  // Pick the LARGEST visible top-level window of the process. CloudCompare shows a small
  // borderless splash first, then a large main window; by area we skip the splash and grab
  // the real editor window. Already-embedded windows become children (GetParent != 0) and
  // are excluded, so a later main window can still be found.
  public static bool Cb(IntPtr h, IntPtr lp){
    uint p; GetWindowThreadProcessId(h, out p);
    if(p==WantPid && IsWindowVisible(h) && GetParent(h)==IntPtr.Zero){
      int tl = GetWindowTextLength(h);
      if(tl > 0){
        System.Text.StringBuilder sb = new System.Text.StringBuilder(tl + 2);
        GetWindowText(h, sb, sb.Capacity);
        string t = sb.ToString();
        // Настоящее ГЛАВНОЕ окно CloudCompare содержит "CloudCompare" в заголовке.
        // Модальные диалоги (Open LAS file, Global shift/scale, Loading LAS points) — НЕТ,
        // поэтому отсекаются и не «крадут» встраивание.
        if(t.IndexOf("CloudCompare", StringComparison.OrdinalIgnoreCase) >= 0){
          RECT r;
          if(GetWindowRect(h, out r)){
            long area = (long)(r.right-r.left) * (long)(r.bottom-r.top);
            if(area > BestArea){ BestArea = area; Best = h; }
          }
        }
      }
    }
    return true;
  }
  public static IntPtr FindMainByPid(uint pid){ Best=IntPtr.Zero; BestArea=0; WantPid=pid; EnumWindows(new EnumProc(Cb), IntPtr.Zero); return Best; }
}
"@

$GWL_STYLE        = -16
$WS_CHILD         = 0x40000000
$WS_CAPTION       = 0x00C00000
$WS_THICKFRAME    = 0x00040000
$WS_BORDER        = 0x00800000
$SWP_FRAMECHANGED = 0x0020
$SWP_SHOWWINDOW   = 0x0040
$SWP_NOZORDER     = 0x0004

$script:child     = [IntPtr]::Zero
$script:parent    = [IntPtr]::Zero
$script:origStyle = 0

function Do-Embed($cpid, $parentDec, $x, $y, $w, $h){
  $deadline = (Get-Date).AddSeconds(60)
  $h1 = [IntPtr]::Zero
  # 1) Wait for the MAIN window to appear (largest top-level window, not the splash).
  while((Get-Date) -lt $deadline){
    $cand = [BtWin]::FindMainByPid([uint32]$cpid)
    if($cand -ne [IntPtr]::Zero -and [BtWin]::BestArea -ge 120000){ $h1 = $cand; break }
    Start-Sleep -Milliseconds 200
  }
  if($h1 -eq [IntPtr]::Zero){ $h1 = [BtWin]::FindMainByPid([uint32]$cpid) }
  if($h1 -eq [IntPtr]::Zero){ Write-Output 'ERR window_not_found'; return }
  # 2) Let it settle (splash -> main swap) and take the largest window again.
  Start-Sleep -Milliseconds 600
  $again = [BtWin]::FindMainByPid([uint32]$cpid)
  if($again -ne [IntPtr]::Zero){ $h1 = $again }
  $script:child  = $h1
  $script:parent = [IntPtr]([int64]$parentDec)
  $st = [BtWin]::GetWindowLong($h1, $GWL_STYLE)
  $script:origStyle = $st
  $new = $st -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME -bor $WS_BORDER))
  $new = $new -bor $WS_CHILD
  [void][BtWin]::SetWindowLong($h1, $GWL_STYLE, $new)
  [void][BtWin]::SetParent($h1, $script:parent)
  [void][BtWin]::SetWindowPos($h1, [IntPtr]::Zero, [int]$x, [int]$y, [int]$w, [int]$h, ($SWP_FRAMECHANGED -bor $SWP_SHOWWINDOW -bor $SWP_NOZORDER))
  # 3) Force a repaint (a reparented Qt/OpenGL viewport often stays BLACK otherwise).
  [void][BtWin]::ShowWindow($h1, 0)   # SW_HIDE
  [void][BtWin]::ShowWindow($h1, 5)   # SW_SHOW
  [void][BtWin]::MoveWindow($h1, [int]$x, [int]$y, [int]$w, [int]([int]$h - 1), $true)
  [void][BtWin]::MoveWindow($h1, [int]$x, [int]$y, [int]$w, [int]$h, $true)
  Write-Output 'OK embedded'
}

function Do-Move($x, $y, $w, $h){
  if($script:child -ne [IntPtr]::Zero){
    [void][BtWin]::MoveWindow($script:child, [int]$x, [int]$y, [int]$w, [int]$h, $true)
  }
}

function Do-Release(){
  if($script:child -ne [IntPtr]::Zero){
    [void][BtWin]::SetWindowLong($script:child, $GWL_STYLE, $script:origStyle)
    [void][BtWin]::SetParent($script:child, [IntPtr]::Zero)
    $script:child = [IntPtr]::Zero
  }
  Write-Output 'OK released'
}

Write-Output 'OK ready'
while($true){
  $line = [Console]::In.ReadLine()
  if($line -eq $null){ break }
  $line = $line.Trim()
  if($line -eq ''){ continue }
  try { $c = $line | ConvertFrom-Json } catch { Write-Output 'ERR bad_json'; continue }
  switch([string]$c.cmd){
    'embed'   { Do-Embed $c.pid $c.parent $c.x $c.y $c.w $c.h }
    'move'    { Do-Move $c.x $c.y $c.w $c.h }
    'release' { Do-Release }
    'quit'    { Do-Release; break }
    default   { Write-Output 'ERR unknown_cmd' }
  }
}
