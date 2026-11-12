param([string]$Title = '10KB', [int]$DelayMs = 1400)
# Bring the fullscreen effect window to the front (HWND_TOPMOST + foreground).
# Called detached by window-server after spawning Edge; failure only affects z-order.
Start-Sleep -Milliseconds $DelayMs
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NtTop {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(IntPtr cls, string title);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr h);
}
"@
for ($i = 0; $i -lt 6; $i++) {
  $h = [NtTop]::FindWindow([IntPtr]::Zero, $Title)
  if ($h -ne [IntPtr]::Zero) {
    $SWP = 0x0001 -bor 0x0002 -bor 0x0040   # NOSIZE | NOMOVE | SHOWWINDOW
    [void][NtTop]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, $SWP)
    [void][NtTop]::SetForegroundWindow($h)
    exit 0
  }
  Start-Sleep -Milliseconds 350
}
exit 1
