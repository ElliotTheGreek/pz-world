Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PZInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
}
'@
$process = Get-Process ProjectZomboid64 -ErrorAction Stop
[PZInput]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500
# Skip any remaining logo/movie, then allow the main menu and pz-world panel to settle.
[PZInput]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
[PZInput]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Seconds 3
# 580x560 panel centered on 1920x1080. Build button center is x=1139, y=785.
[PZInput]::SetCursorPos(1139, 785) | Out-Null
Start-Sleep -Milliseconds 250
[PZInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[PZInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "clicked pz-world Build this world at 1139,785"
