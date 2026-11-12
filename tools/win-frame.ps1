<#
  win-frame.ps1 —— 把 Edge 的 --app 窗口改成无边框，并提供最小化 / 最大化 / 关闭 / 拖动。

  为什么需要它：Edge --app 开的窗口仍然带系统标题栏，而图一里的蓝色标题栏是页面
  自绘的，系统那层必须去掉。Chromium 没有「不要标题栏」的参数，只能开完窗再用
  Win32 改窗口样式（WS_CAPTION / WS_THICKFRAME 去掉）。

  为什么常驻：Add-Type 编译内嵌 C# 一次要几百毫秒。如果每次请求都重开一个
  PowerShell，拖动会明显卡。常驻进程里 P/Invoke 只编译一次。

  为什么用裸 TCP 而不是 HTTP：HttpListener 绑 127.0.0.1 也要预先做 URL 预留
  （netsh http add urlacl），非管理员容易踩 ACL 报错；TcpListener 没这个限制。

  协议：127.0.0.1:$Port，客户端发一行 `action=xxx&k=v`，服务端回一行 JSON 后关闭。
  调用方：tools/window-server.mjs 的 /elymes-api/win 路由。
#>
param(
  [int]$Port = 18801,
  [string]$Keyword = '',
  [int]$Width = 1000,
  [int]$Height = 760,
  [int]$X = -1,
  [int]$Y = -1,
  [int]$CutTop = 52,
  [string]$ChatProfile = ''
)

$ErrorActionPreference = 'Stop'
$script:Keyword = $Keyword
$script:ChatProfile = $ChatProfile
$script:TargetW = $Width
$script:TargetH = $Height
$script:TargetX = $X
$script:TargetY = $Y
$script:CutTop = $CutTop
$script:CutTopPx = $CutTop        # 真实像素；Apply-Frame 里按 DPI 重算
$script:DpiScale = 1.0
$script:WinW = $Width
$script:WinH = $Height
$script:Hwnd = [IntPtr]::Zero

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class CrtWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr val);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  // DPI：本进程声明感知后，SetWindowPos 的坐标才是真实像素；否则 Windows 会再乘一次缩放比。
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint act, uint p1, ref RECT r, uint p2);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  // SystemParametersInfo(SPI_GETWORKAREA) -> working rect (screen minus taskbar).
  // NOTE: keep this C# block ASCII-only; Add-Type writes the temp .cs in the ANSI
  // codepage, so CJK comments get mangled and break compilation.
  public static RECT WorkArea() {
    RECT r = new RECT();
    SystemParametersInfo(0x0030, 0, ref r, 0);
    return r;
  }
}
'@

# 先声明 DPI 感知，再碰任何窗口坐标。不声明的话，150% 缩放下 SetWindowPos
# 的请求值会被系统再乘一次 1.476，窗口会比屏幕还大，四周露出黑边。
try { [void][CrtWin]::SetProcessDPIAware() } catch { }

# 窗口样式常量
$GWL_STYLE      = -16
$WS_CAPTION     = [int64]0x00C00000
$WS_THICKFRAME  = [int64]0x00040000
$WS_SYSMENU     = [int64]0x00080000
$WS_MINIMIZEBOX = [int64]0x00020000
$WS_MAXIMIZEBOX = [int64]0x00010000
$FRAME_MASK     = $WS_CAPTION -bor $WS_THICKFRAME -bor $WS_SYSMENU -bor $WS_MINIMIZEBOX -bor $WS_MAXIMIZEBOX

$SWP_NOSIZE     = 0x0001
$SWP_NOMOVE     = 0x0002
$SWP_NOZORDER   = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020

<# 找目标窗口。
   为什么要排除宽度 < 600 的：Edge 启动瞬间会先建一个同标题的辅助窗（实测只有 300 多宽），
   匹配到它就会把边框去错窗口。为什么要排除坐标 < -10000 的：Chromium 会把不用的
   窗口挪到屏幕外，那些同样带标题。 #>
function Find-Target {
  $script:cands = @()
  $cb = [CrtWin+EnumProc]{
    param([IntPtr]$h, [IntPtr]$p)
    if (-not [CrtWin]::IsWindowVisible($h)) { return $true }
    $sb = New-Object System.Text.StringBuilder 512
    [void][CrtWin]::GetWindowTextW($h, $sb, 512)
    $t = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($t)) { return $true }
    if ($script:Keyword -and ($t -notlike "*$($script:Keyword)*")) { return $true }
    $r = [CrtWin+RECT]::new()
    [void][CrtWin]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -lt 600 -or $hh -lt 400) { return $true }
    if ($r.Left -lt -10000 -or $r.Top -lt -10000) { return $true }
    if ($r.Left -gt 20000 -or $r.Top -gt 20000) { return $true }
    # 跳过「已经最小化」的窗：它的矩形是 (-21333,-21333) 这种屏幕外坐标，
    # 而且 IsWindow() 对最小化的窗照样返回真，会被当成“还活着”一直复用。
    if ([CrtWin]::IsIconic($h)) { return $true }
    $script:cands += [pscustomobject]@{ H = $h; W = $w; Hh = $hh; T = $t; L = $r.Left; Tp = $r.Top }
    return $true
  }
  [void][CrtWin]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:cands.Count -eq 0) { return [IntPtr]::Zero }
  # 取面积最小的那个：桌宠（360×360）和辅助窗已经被上面的尺寸筛掉了，
  # 剩下的如果不止一个，面积小的更可能是聊天窗。
  $best = $script:cands | Sort-Object { $_.W * $_.Hh } | Select-Object -First 1
  return $best.H
}

function Get-Hwnd {
  if ($script:Hwnd -ne [IntPtr]::Zero -and [CrtWin]::IsWindow($script:Hwnd)) { return $script:Hwnd }
  $script:Hwnd = Find-Target
  return $script:Hwnd
}

<# 去边框 + 定尺寸。顺序不能换：先改样式再改大小，否则 SetWindowPos 设的是
   「带边框的外框尺寸」，去掉边框后客户区会变大，页面就会多出滚动条。 #>
function Apply-Frame([IntPtr]$h) {
  $style = [int64]([CrtWin]::GetWindowLongPtr($h, $GWL_STYLE).ToInt64())
  $new = $style -band (-bnot $FRAME_MASK)
  if ($new -ne $style) {
    [void][CrtWin]::SetWindowLongPtr($h, $GWL_STYLE, [IntPtr]$new)
  }
  [void][CrtWin]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0,
    ($SWP_FRAMECHANGED -bor $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE))

  # ── 尺寸：设计稿是 1000×760 的 CSS 像素，先按 DPI 换成真实像素，再夹进工作区 ──
  # 为什么要自己换算：本进程原来不感知 DPI，请求 1000×819 被系统又乘了 1.476，
  # 真实窗口约 1476×1209，比这块屏还宽 → 页面被撑大、四周露黑边、对话框跑出屏幕。
  # 现在按「设计尺寸 × dpi/96」算出这台机器上应有的像素尺寸；屏幕放不下就整体
  # 等比缩小（不是只缩高），保证窗口比例和设计稿一致，页面里的 --fit 正好等于
  # 这个比例，四周就不会留下黑边。
  $dpi = 96
  try { $dpi = [int][CrtWin]::GetDpiForWindow($h) } catch { $dpi = 96 }
  if ($dpi -le 0) { $dpi = 96 }
  $script:DpiScale = $dpi / 96.0
  # 标题栏高度（Edge --app 自绘的那条，设计稿里占 52 CSS px）。
  # 它要么被裁掉（CutTop>0），要么留在窗内（CutTop=0）。两种情况下窗口都得
  # 先把它算进去，否则页面可视区会少掉一条，设计稿会被压扁。
  $script:BarPx = [int][Math]::Round(52 * $script:DpiScale)
  $script:CutTopPx = [int][Math]::Round($script:CutTop * $script:DpiScale)

  $wa = [CrtWin]::WorkArea()
  $waW = [double]($wa.Right - $wa.Left)
  $waH = [double]($wa.Bottom - $wa.Top)
  $dw = $script:TargetW * $script:DpiScale
  $dh = $script:TargetH * $script:DpiScale
  $s = 1.0
  # 留 8% 边距：铺满屏会显得“框特别大”，而且贴边时平台任务的屏幕边缘拖动会失手。
  $limitW = $waW * 0.92
  $limitH = ($waH * 0.92) - $script:BarPx
  if ($dw -gt $limitW) { $s = [Math]::Min($s, $limitW / $dw) }
  if (($limitH -gt 0) -and ($dh -gt $limitH)) { $s = [Math]::Min($s, $limitH / $dh) }
  $winW = [int][Math]::Round($dw * $s)
  $winH = [int][Math]::Round($dh * $s) + $script:BarPx
  $script:WinW = $winW
  $script:WinH = $winH

  $x = $script:TargetX
  $y = $script:TargetY
  if ($x -lt 0 -or $y -lt 0) {
    $x = [int](($waW - $winW) / 2)
    $y = [int](($waH - $winH) / 2)
    if ($x -lt 0) { $x = 0 }
    if ($y -lt 0) { $y = 0 }
    if (($x + $winW) -gt $waW) { $x = [int]($waW - $winW) }
    if (($y + $winH) -gt $waH) { $y = [int]($waH - $winH) }
  }
  # 为什么不是「设一次就完」：实测点掉标题栏后，第一次 SetWindowPos 的 1000×760
  # 会被当成「外框尺寸」，等句柄真正重算完，客户区只剩 1000×737（少了 23px 标题栏）。
  # 所以这里量一次、差就差、再设一次，最多三轮。
  # 实测：请求 1000×760 量出来是 1000×737，位置还会自己漂（x 跑成 -106）。
  # 说明 Chromium 接到 WM_WINDOWPOSCHANGED 后会用自己的边框量再改一遭，
  # 所以不能固定地“设同一个值”，要按「目标 − 实测」逐轮反推请求值。
  $wantW = $winW
  $wantH = $winH
  $ax = $x
  $ay = $y
  $r = [CrtWin+RECT]::new()
  for ($i = 0; $i -lt 4; $i++) {
    [void][CrtWin]::SetWindowPos($h, [IntPtr]::Zero, $ax, $ay, $wantW, $wantH,
      ($SWP_NOZORDER -bor $SWP_NOACTIVATE))
    Start-Sleep -Milliseconds 120
    $r = [CrtWin+RECT]::new()
    [void][CrtWin]::GetWindowRect($h, [ref]$r)
    $curW = $r.Right - $r.Left
    $curH = $r.Bottom - $r.Top
    if (($curW -eq $winW) -and ($curH -eq $winH) -and
        ($r.Left -eq $x) -and ($r.Top -eq $y)) { break }
    $ax = $ax + ($x - $r.Left)
    $ay = $ay + ($y - $r.Top)
    $wantW = $wantW + ($winW - $curW)
    $wantH = $wantH + ($winH - $curH)
  }
  # 尺寸定下来再裁区域：区域坐标是相对窗口的，尺寸一变就必须重算，否则会裁少或裁多。
  Apply-Cut $h
  return $r.Left, $r.Top
}

function Close-AllTargets {
  $script:closed = 0
  $cb = [CrtWin+EnumProc]{
    param([IntPtr]$h, [IntPtr]$p)
    $sb = New-Object System.Text.StringBuilder 512
    [void][CrtWin]::GetWindowTextW($h, $sb, 512)
    $t = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($t)) { return $true }
    if ($script:Keyword -and ($t -notlike "*$($script:Keyword)*")) { return $true }
    [void][CrtWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE
    $script:closed++
    return $true
  }
  [void][CrtWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:closed
}

function Apply-Cut([IntPtr]$h) {
  # Edge 的 --app 窗会在客户区顶部自绘一条约 52px 的标题栏（带地球图标和页面标题）。
  # 量过了：窗口矩形和客户区起点完全重合（nonClientTop=0），它不是非客户区，
  # 所以去 WS_CAPTION 碰不到它。唯一的办法是用窗口区域把它裁掉。
  if ($script:CutTopPx -le 0) { return }
  $r = [CrtWin+RECT]::new()
  [void][CrtWin]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left
  $hh = $r.Bottom - $r.Top
  $rgn = [CrtWin]::CreateRectRgn(0, $script:CutTopPx, $w, $hh)
  [void][CrtWin]::SetWindowRgn($h, $rgn, $true)
}

function Invoke-Action([string]$action, [hashtable]$q) {
  # attach 一律重新找窗：可能是「旧的关了、新的开了」，缓存句柄完全不可信。
  # 顺带清掉伪最大化的记账，否则新窗一上来就被当成最大化状态。
  if ($action -eq 'attach') { $script:Hwnd = [IntPtr]::Zero; $script:FakeMax = $false }
  if ($action -eq 'closeall') {
    $n = Close-AllTargets
    $script:Hwnd = [IntPtr]::Zero
    $script:FakeMax = $false
    return @{ ok = $true; closed = [int]$n }
  }

  $h = Get-Hwnd
  if ($action -eq 'killchat') {
    # Edge 单实例认配置目录：目录里留着无窗口实例时，新起的 --app 会被它吞掉。
    # 放到常驻进程里做，比每次新开一个 PowerShell 快很多（那是秒级的开销）。
    $n = 0
    if ($script:ChatProfile) {
      $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
          $_.CommandLine -and
          $_.CommandLine.Contains($script:ChatProfile) -and
          -not $_.CommandLine.Contains('--type=')
        }
      foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $n++ } catch { }
      }
    }
    return @{ ok = $true; killed = [int]$n }
  }
  if ($action -eq 'unmin') {
    # Edge 会把“上次关窗时的窗口状态”记在配置目录里。如果上一次聊天窗是最小化
    # 关的，下一次 --app 起来直接就是最小化的（矩形 -21333,-21333），用户以为没打开。
    # 这里单独枚举一遍：**不过滤最小化**，找到就用 SW_RESTORE(9) 恢复。
    $script:hits = @()
    $cb = [CrtWin+EnumProc]{
      param([IntPtr]$hh, [IntPtr]$p)
      if (-not [CrtWin]::IsWindowVisible($hh)) { return $true }
      $sb = New-Object System.Text.StringBuilder 512
      [void][CrtWin]::GetWindowTextW($hh, $sb, 512)
      $t = $sb.ToString()
      if (-not $t -or -not $script:Keyword -or ($t -notlike "*$($script:Keyword)*")) { return $true }
      if (-not [CrtWin]::IsIconic($hh)) { return $true }
      $script:hits += $hh
      return $true
    }
    [void][CrtWin]::EnumWindows($cb, [IntPtr]::Zero)
    $n = 0
    foreach ($hh in $script:hits) {
      [void][CrtWin]::ShowWindow($hh, 9)
      $n++
    }
    return @{ ok = $true; unmin = [int]$n }
  }

  if ($action -eq 'ping') { return @{ ok = $true; target = ($h -ne [IntPtr]::Zero); hwnd = [int64]$h }
  }
  if ($h -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'no-window' } }

  switch ($action) {
    'attach' {
      $pos = Apply-Frame $h
      [void][CrtWin]::SetForegroundWindow($h)
      return @{ ok = $true; hwnd = [int64]$h; x = $pos[0]; y = $pos[1]; w = $script:WinW; h = $script:WinH; dpi = $script:DpiScale }
    }
    'drag' {
      # 交给系统自己拖：比每帧算 dx/dy 发请求跟手得多，而且松手后 Edge 也不会抢回焦点
      [void][CrtWin]::ReleaseCapture()
      [void][CrtWin]::SendMessage($h, 0x00A1, [IntPtr]2, [IntPtr]::Zero)   # WM_NCLBUTTONDOWN / HTCAPTION
      return @{ ok = $true }
    }
    'move' {
      $r = [CrtWin+RECT]::new()
      [void][CrtWin]::GetWindowRect($h, [ref]$r)
      $dx = [int]$q['dx']; $dy = [int]$q['dy']
      $w = $r.Right - $r.Left
      $hgt = $r.Bottom - $r.Top
      $nx = $r.Left + $dx
      $ny = $r.Top + $dy
      $wa = [CrtWin]::WorkArea()
      # 留 120×40 在屏幕内：拖太狠时窗口会整块跑到屏幕外，之后就再也抓不回来了。
      $minX = $wa.Left - $w + 120
      $maxX = $wa.Right - 120
      $minY = $wa.Top
      $maxY = $wa.Bottom - 40
      if ($nx -lt $minX) { $nx = $minX }
      if ($nx -gt $maxX) { $nx = $maxX }
      if ($ny -lt $minY) { $ny = $minY }
      if ($ny -gt $maxY) { $ny = $maxY }
      [void][CrtWin]::SetWindowPos($h, [IntPtr]::Zero, [int]$nx, [int]$ny, 0, 0,
        ($SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE))
      return @{ ok = $true; x = [int]$nx; y = [int]$ny }
    }
    'resize' {
      # 页面上的 8 个缩放热区把想要的尺寸发过来。调用方给的是物理像素。
      #
      # 三件事，顺序不能变：
      #   1) 最大化状态下 SetWindowPos 改不了尺寸，先还原
      #   2) 按 edge 决定哪条边在动：拖西边时原点跟着走，东/南边时原点不变
      #   3) 碰到工作区边界只夹尺寸，绝不挪原点（早期版本会挪，表现为“左右同时拉伸”）
      if ([CrtWin]::IsZoomed($h)) { [void][CrtWin]::ShowWindow($h, 9); Start-Sleep -Milliseconds 150 }
      $edge = [string]$q['edge']
      $r = [CrtWin+RECT]::new()
      [void][CrtWin]::GetWindowRect($h, [ref]$r)
      $wa = [CrtWin]::WorkArea()
      $newW = [int]$q['w']
      $newH = [int]$q['h']
      # 锁宽高比：页面区始终保持 1000:760（= 设计稿比例），这样内容整体等比缩放，
      # 既不会四周留黑边，也不会被拉伸。窗口高度 = 页面高 + 被裁掉的标题栏高度。
      $bar = $script:CutTopPx
      if ($bar -le 0) { $bar = [int][Math]::Round(52 * $script:DpiScale) }
      $byHeight = (-not $edge.Contains('e')) -and (-not $edge.Contains('w'))
      if ($byHeight) {
        if ($newH -lt ($bar + 240)) { $newH = $bar + 240 }
        $newW = [int][Math]::Round(($newH - $bar) * 1000 / 760)
        $newH = [int][Math]::Round($newW * 760 / 1000) + $bar
      } else {
        if ($newW -lt 320) { $newW = 320 }
        $newH = [int][Math]::Round($newW * 760 / 1000) + $bar
      }
      if ($newW -lt 320) { $newW = 320 }
      if ($newH -lt 240) { $newH = 240 }
      $x = $r.Left
      $y = $r.Top
      if ($edge.Contains('w')) { $x = $r.Right - $newW }
      if ($edge.Contains('n')) { $y = $r.Bottom - $newH }
      if ($x -lt $wa.Left) {
        if ($edge.Contains('w')) { $newW = $r.Right - $wa.Left }
        $x = $wa.Left
      }
      if ($y -lt $wa.Top) {
        if ($edge.Contains('n')) { $newH = $r.Bottom - $wa.Top }
        $y = $wa.Top
      }
      if (($x + $newW) -gt $wa.Right) { $newW = $wa.Right - $x }
      if (($y + $newH) -gt $wa.Bottom) { $newH = $wa.Bottom - $y }
      if ($newW -lt 320) { $newW = 320 }
      if ($newH -lt 240) { $newH = 240 }
      [void][CrtWin]::SetWindowPos($h, [IntPtr]::Zero, [int]$x, [int]$y, [int]$newW, [int]$newH,
        ($SWP_NOZORDER -bor $SWP_NOACTIVATE))
      Apply-Cut $h
      return @{ ok = $true; x = [int]$x; y = [int]$y; w = [int]$newW; h = [int]$newH }
    }
    'fullscreen' {
      # 旧界面（index.html）的历史默认：最大化 + 置顶。速览 2026-11-10 第 29 条记载的
      # 用户要求为「全屏置顶」（-W 0 -H 0 -TopMost 1），这里用常驻外挂直接做，比再起一个
      # PowerShell 快得多。
      [void][CrtWin]::ShowWindow($h, 3)
      Start-Sleep -Milliseconds 150
      $HWND_TOPMOST = [IntPtr](-1)
      [void][CrtWin]::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0,
        ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))
      $r = [CrtWin+RECT]::new()
      [void][CrtWin]::GetWindowRect($h, [ref]$r)
      return @{ ok = $true; w = [int]($r.Right - $r.Left); h = [int]($r.Bottom - $r.Top) }
    }
    'min' {
      [void][CrtWin]::ShowWindow($h, 6)   # SW_MINIMIZE
      return @{ ok = $true; state = 'min' }
    }
    'max' {
      # 不用 SW_MAXIMIZE：去边框后它会撑成「屏幕 + 四周 7px」，而外部的 SetWindowPos
      # 又会被 Chromium 按最大化语义再改回去（实测反复被覆盖）。这里自己做「伪最大化」：
      # 先把当前矩形记账，再直接摆到工作区；再点一次就还原回去。
      if ($script:FakeMax) {
        $rr = $script:RestoreRect
        $script:FakeMax = $false
        [void][CrtWin]::SetWindowPos($h, [IntPtr]::Zero, $rr.Left, $rr.Top, $rr.Right - $rr.Left, $rr.Bottom - $rr.Top,
          [uint32]($SWP_NOZORDER -bor $SWP_NOACTIVATE))
        return @{ ok = $true; state = 'normal' }
      }
      $cur = [CrtWin+RECT]::new()
      [void][CrtWin]::GetWindowRect($h, [ref]$cur)
      $script:RestoreRect = $cur
      $script:FakeMax = $true
      $wa = [CrtWin]::WorkArea()
      [void][CrtWin]::SetWindowPos($h, [IntPtr]::Zero, $wa.Left, $wa.Top, $wa.Right - $wa.Left, $wa.Bottom - $wa.Top,
        [uint32]($SWP_NOZORDER -bor $SWP_NOACTIVATE))
      # 不调 Apply-FrameCore：它按“设计尺寸留 8% 边距”算，最大化要的是贴满，
      # 调了会在中间插一小段带边距的尺寸，看起来就像最大化后左右各留一条缝。
      Start-Sleep -Milliseconds 160
      # 撑满后 Chromium 可能把高度再收 23px，这里补一次，最终以工作区为准
      [void][CrtWin]::SetWindowPos($h, [IntPtr]::Zero, $wa.Left, $wa.Top, $wa.Right - $wa.Left, $wa.Bottom - $wa.Top,
        [uint32]($SWP_NOZORDER -bor $SWP_NOACTIVATE))
      Apply-Cut $h
      return @{ ok = $true; state = 'max' }
    }
    'restore' {
      $script:FakeMax = $false
      [void][CrtWin]::ShowWindow($h, 9)   # SW_RESTORE
      [void](Apply-FrameCore $h)
      [void][CrtWin]::SetForegroundWindow($h)
      return @{ ok = $true; state = 'normal' }
    }
    'close' {
      [void][CrtWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE
      $script:Hwnd = [IntPtr]::Zero
      return @{ ok = $true; state = 'closing' }
    }
    'state' {
      $r = [CrtWin+RECT]::new()
      [void][CrtWin]::GetWindowRect($h, [ref]$r)
      $style = [int64]([CrtWin]::GetWindowLongPtr($h, $GWL_STYLE).ToInt64())
      return @{ ok = $true; hwnd = [int64]$h; x = $r.Left; y = $r.Top;
                w = $r.Right - $r.Left; h = $r.Bottom - $r.Top;
                framed = (($style -band $WS_CAPTION) -ne 0);
                min = [CrtWin]::IsIconic($h); max = [bool]$script:FakeMax }
    }
    default { return @{ ok = $false; error = "unknown-action:$action" } }
  }
}

<# 只去样式、不改尺寸（最大化/还原后补刀用），跟 Apply-Frame 拆开是为了
   避免还原时又被强制摆回 1000×760。 #>
function Apply-FrameCore([IntPtr]$h) {
  $style = [int64]([CrtWin]::GetWindowLongPtr($h, $GWL_STYLE).ToInt64())
  $new = $style -band (-bnot $FRAME_MASK)
  if ($new -ne $style) { [void][CrtWin]::SetWindowLongPtr($h, $GWL_STYLE, [IntPtr]$new) }
  [void][CrtWin]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0,
    ($SWP_FRAMECHANGED -bor $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE))
}

function Parse-Query([string]$line) {
  $q = @{}
  foreach ($pair in ($line -split '&')) {
    if ([string]::IsNullOrWhiteSpace($pair)) { continue }
    $kv = $pair -split '=', 2
    if ($kv.Count -eq 2) { $q[$kv[0].Trim()] = [System.Uri]::UnescapeDataString($kv[1].Trim()) }
    elseif ($kv.Count -eq 1) { $q[$kv[0].Trim()] = '' }
  }
  return $q
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() }
catch {
  [Console]::Error.WriteLine("端口 $Port 起不来：$($_.Exception.Message)")
  exit 1
}

while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 3000
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
    $line = $reader.ReadLine()
    $q = Parse-Query $line
    $action = [string]$q['action']
    if (-not $action) { $action = 'state' }

    $resp = Invoke-Action $action $q
    $json = $resp | ConvertTo-Json -Compress -Depth 4
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json + "`n")
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
  }
  catch {
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress) + "`n")
      $client.GetStream().Write($bytes, 0, $bytes.Length)
    } catch { }
  }
  finally {
    if ($client) { $client.Close() }
  }
}
