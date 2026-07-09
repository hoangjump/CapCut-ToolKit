import { spawn } from 'node:child_process';
import { createLogger } from './logger.js';

const IS_WINDOWS = process.platform === 'win32';
const log = createLogger('tiler');

// Khoảng hở giữa các ô lưới (px) để nhìn rõ ranh giới từng cửa sổ.
const GAP = 6;
// Kích thước ô tối thiểu: khi quá đông cửa sổ, không co nhỏ hơn mức này —
// dưới ngưỡng thì không còn click/thao tác được. Cửa sổ dư sẽ cascade.
const MIN_CELL_W = 360;
const MIN_CELL_H = 280;
// Cascade: khi vượt sức chứa lưới, các cửa sổ dư lệch nhau chừng này (px) để
// vẫn thấy title bar mà bấm.
const CASCADE = 28;

// Script PowerShell: liệt kê cửa sổ chính của mọi tiến trình camoufox.exe rồi
// SetWindowPos vào ô lưới. Chạy self-contained (tự lấy WorkingArea, tự tính
// lưới) — Node chỉ truyền hằng số qua các biến $Gap/$MinW/... ở đầu.
//
// Vì sao PowerShell + P/Invoke chứ không native addon: user32 có sẵn trên mọi
// Windows, không phải build node-gyp (koffi/ffi-napi) — tránh vỡ khi
// electron-builder đóng gói. Chi phí spawn không đáng kể vì chỉ chạy khi
// mở/đóng cửa sổ (đã debounce).
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$Gap = ${GAP}
$MinW = ${MIN_CELL_W}
$MinH = ${MIN_CELL_H}
$Cascade = ${CASCADE}

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinTiler {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> Find(uint pid) {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid != pid) return true;
      if (!IsWindowVisible(h)) return true;
      // Chỉ cửa sổ top-level (không owner) — loại popup/dialog con.
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      if (GetWindowTextLength(h) == 0) return true;
      RECT r; GetWindowRect(h, out r);
      if ((r.Right - r.Left) < 200 || (r.Bottom - r.Top) < 200) return true;
      found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

# Map PID -> profileId (lấy từ CommandLine chứa data\\<profileId>) để sắp xếp ổn
# định theo thứ tự profile, không nhảy loạn mỗi lần tile.
$procs = Get-CimInstance Win32_Process -Filter "Name='camoufox.exe'"
$items = @()
foreach ($p in $procs) {
  $key = ''
  if ($p.CommandLine -match 'data[\\\\/]([-0-9a-fA-F]{8,})') { $key = $matches[1] }
  $wins = [WinTiler]::Find([uint32]$p.ProcessId)
  foreach ($w in $wins) { $items += [pscustomobject]@{ Key = $key; Hwnd = $w } }
}
$items = $items | Sort-Object Key
$n = $items.Count
if ($n -eq 0) { exit 0 }

$cols = [Math]::Ceiling([Math]::Sqrt($n))
$rows = [Math]::Ceiling($n / $cols)
$cellW = [Math]::Floor($wa.Width / $cols)
$cellH = [Math]::Floor($wa.Height / $rows)

# Vượt sức chứa: giữ ô ở min, phần dư cascade.
$overflow = $false
if ($cellW -lt $MinW -or $cellH -lt $MinH) {
  $cellW = [Math]::Max($cellW, $MinW)
  $cellH = [Math]::Max($cellH, $MinH)
  $overflow = $true
}

$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$flags = $SWP_NOZORDER -bor $SWP_NOACTIVATE
$i = 0
foreach ($it in $items) {
  $col = $i % $cols
  $row = [Math]::Floor($i / $cols)
  if ($overflow) {
    $x = $wa.X + ($col * $Cascade)
    $y = $wa.Y + ($row * $Cascade)
    $w = $MinW
    $h = $MinH
  } else {
    $x = $wa.X + ($col * $cellW)
    $y = $wa.Y + ($row * $cellH)
    $w = $cellW - $Gap
    $h = $cellH - $Gap
  }
  [WinTiler]::ShowWindow($it.Hwnd, 9) | Out-Null   # SW_RESTORE (gỡ maximize/minimize)
  [WinTiler]::SetWindowPos($it.Hwnd, [IntPtr]::Zero, [int]$x, [int]$y, [int]$w, [int]$h, $flags) | Out-Null
  $i++
}
`;

function runPowerShell(): Promise<void> {
  return new Promise((resolve) => {
    // -EncodedCommand nhận base64 UTF16-LE — tránh mọi rắc rối escape/quote khi
    // nhét cả khối script (có dấu ", $, xuống dòng) qua tham số dòng lệnh.
    const b64 = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      log.warn(`không chạy được powershell: ${err.message}`);
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0 && stderr.trim()) {
        log.warn(`tile lỗi (code ${code}): ${stderr.trim().split('\n')[0]}`);
      }
      resolve();
    });
  });
}

/** Sắp xếp lại ngay lập tức mọi cửa sổ Camoufox thành lưới. No-op ngoài Windows.
 *  Không bao giờ throw — lỗi chỉ log warn. */
export async function tileNow(): Promise<void> {
  if (!IS_WINDOWS) return;
  await runPowerShell();
}

let timer: NodeJS.Timeout | null = null;
let trailing: NodeJS.Timeout | null = null;

/** Lên lịch tile với debounce ~800ms để gom burst khi mở batch nhiều profile.
 *  Chạy thêm 1 lần trễ (1.2s sau) để bắt cửa sổ Camoufox xuất hiện muộn sau khi
 *  open() đã trả về. No-op ngoài Windows. */
export function scheduleTile(): void {
  if (!IS_WINDOWS) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void tileNow();
    // Cửa sổ đôi khi hiện trễ vài trăm ms sau khi context sẵn sàng — quét lại
    // một lần nữa để bắt trọn.
    if (trailing) clearTimeout(trailing);
    trailing = setTimeout(() => {
      trailing = null;
      void tileNow();
    }, 1200);
  }, 800);
}
