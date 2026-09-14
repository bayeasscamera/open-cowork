import { writeMCPLog } from '../mcp-logger.js';
import { PLATFORM, type DisplayConfiguration, type DisplayInfo } from './state.js';
import { executeCommandSafe } from './exec.js';

// ============================================================================
// Windows-specific Helper Functions
// ============================================================================

/**
 * Execute PowerShell command (Windows only)
 * Uses -WindowStyle Hidden to prevent focus theft from target windows
 */
export async function executePowerShell(
  script: string,
  timeout: number = 30000
): Promise<{ stdout: string; stderr: string }> {
  if (PLATFORM !== 'win32') {
    throw new Error('PowerShell is only available on Windows.');
  }

  // Escape the script for PowerShell command line
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  // Use -WindowStyle Hidden to prevent PowerShell window from stealing focus
  const psArgs = [
    '-WindowStyle',
    'Hidden',
    '-NonInteractive',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedScript,
  ];

  writeMCPLog(
    `[executePowerShell] Executing script (length: ${script.length})`,
    'PowerShell Command'
  );

  const result = await executeCommandSafe('powershell', psArgs, { timeout });

  writeMCPLog(
    `[executePowerShell] Command completed. stdout length: ${result.stdout.length}`,
    'PowerShell Result'
  );

  return result;
}

/**
 * Windows: Take screenshot using .NET with DPI awareness
 */
export async function windowsTakeScreenshot(
  outputPath: string,
  displayIndex?: number,
  region?: { x: number; y: number; width: number; height: number }
): Promise<void> {
  let script: string;

  // Common DPI-aware setup code
  const dpiAwareSetup = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Enable DPI awareness to get actual physical screen dimensions
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiHelper {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    
    [DllImport("gdi32.dll")]
    public static extern int GetDeviceCaps(IntPtr hdc, int nIndex);
    
    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);
    
    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
}
"@

# Make process DPI-aware
[DpiHelper]::SetProcessDPIAware() | Out-Null

# Get actual screen dimensions using GetSystemMetrics
# SM_CXSCREEN = 0, SM_CYSCREEN = 1 (primary screen)
# SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79 (virtual screen)
`;

  if (region) {
    // Capture specific region
    script = `${dpiAwareSetup}

$x = ${region.x}
$y = ${region.y}
$width = ${region.width}
$height = ${region.height}

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, [System.Drawing.Size]::new($width, $height))
$bitmap.Save("${outputPath.replace(/\\/g, '\\\\')}")
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "SUCCESS"
`;
  } else if (displayIndex !== undefined) {
    // Capture specific display with DPI awareness
    script = `${dpiAwareSetup}

$targetIndex = ${displayIndex}

# Get physical screen dimensions
if ($targetIndex -eq 0) {
    # Primary screen - use GetSystemMetrics for accurate physical dimensions
    $physWidth = [DpiHelper]::GetSystemMetrics(0)   # SM_CXSCREEN
    $physHeight = [DpiHelper]::GetSystemMetrics(1)  # SM_CYSCREEN
    $physX = 0
    $physY = 0
} else {
    # For non-primary displays, use virtual screen metrics
    # This is a simplified approach - may need refinement for multi-monitor setups
    $screens = [System.Windows.Forms.Screen]::AllScreens
    if ($targetIndex -ge $screens.Length) {
        Write-Error "Display index $targetIndex not found. Available: 0-$($screens.Length - 1)"
        exit 1
    }
    $screen = $screens[$targetIndex]
    
    # Get DPI scaling factor
    $hdc = [DpiHelper]::GetDC([IntPtr]::Zero)
    $dpiX = [DpiHelper]::GetDeviceCaps($hdc, 88)  # LOGPIXELSX
    [DpiHelper]::ReleaseDC([IntPtr]::Zero, $hdc) | Out-Null
    $scaleFactor = $dpiX / 96.0
    
    # Scale the bounds to physical pixels
    $physX = [int]($screen.Bounds.X * $scaleFactor)
    $physY = [int]($screen.Bounds.Y * $scaleFactor)
    $physWidth = [int]($screen.Bounds.Width * $scaleFactor)
    $physHeight = [int]($screen.Bounds.Height * $scaleFactor)
}

$bitmap = New-Object System.Drawing.Bitmap($physWidth, $physHeight)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($physX, $physY, 0, 0, [System.Drawing.Size]::new($physWidth, $physHeight))
$bitmap.Save("${outputPath.replace(/\\/g, '\\\\')}")
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "SUCCESS"
`;
  } else {
    // Capture primary screen when no displayIndex specified (NOT virtual screen)
    // This ensures coordinate system consistency
    script = `${dpiAwareSetup}

# Get primary screen dimensions using GetSystemMetrics
$physWidth = [DpiHelper]::GetSystemMetrics(0)   # SM_CXSCREEN
$physHeight = [DpiHelper]::GetSystemMetrics(1)  # SM_CYSCREEN
$physX = 0
$physY = 0

$bitmap = New-Object System.Drawing.Bitmap($physWidth, $physHeight)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($physX, $physY, 0, 0, [System.Drawing.Size]::new($physWidth, $physHeight))
$bitmap.Save("${outputPath.replace(/\\/g, '\\\\')}")
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "SUCCESS"
`;
  }

  const result = await executePowerShell(script);

  if (!result.stdout.includes('SUCCESS')) {
    throw new Error(`Screenshot failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * Windows: Get display configuration with DPI awareness
 */
export async function windowsGetDisplayConfiguration(): Promise<DisplayConfiguration> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms

# Get DPI scaling factor
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiInfo {
    [DllImport("gdi32.dll")]
    public static extern int GetDeviceCaps(IntPtr hdc, int nIndex);
    
    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);
    
    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
}
"@

# Make process DPI-aware
[DpiInfo]::SetProcessDPIAware() | Out-Null

# Get DPI scaling factor (default DPI is 96)
$hdc = [DpiInfo]::GetDC([IntPtr]::Zero)
$dpiX = [DpiInfo]::GetDeviceCaps($hdc, 88)  # LOGPIXELSX
[DpiInfo]::ReleaseDC([IntPtr]::Zero, $hdc) | Out-Null
$scaleFactor = $dpiX / 96.0

$screens = [System.Windows.Forms.Screen]::AllScreens
$result = @()
$index = 0

foreach ($screen in $screens) {
    # For primary monitor, get physical dimensions
    if ($screen.Primary) {
        $physWidth = [DpiInfo]::GetSystemMetrics(0)   # SM_CXSCREEN
        $physHeight = [DpiInfo]::GetSystemMetrics(1)  # SM_CYSCREEN
    } else {
        # Scale logical dimensions to physical for non-primary
        $physWidth = [int]($screen.Bounds.Width * $scaleFactor)
        $physHeight = [int]($screen.Bounds.Height * $scaleFactor)
    }
    
    $info = @{
        index = $index
        name = $screen.DeviceName
        isMain = $screen.Primary
        width = $physWidth
        height = $physHeight
        originX = [int]($screen.Bounds.X * $scaleFactor)
        originY = [int]($screen.Bounds.Y * $scaleFactor)
        scaleFactor = $scaleFactor
    }
    $result += $info
    $index++
}

# Force output as array even if single element (wrap in @())
ConvertTo-Json -InputObject @($result) -Compress
`;

  const result = await executePowerShell(script);
  let displays: DisplayInfo[];
  try {
    displays = JSON.parse(result.stdout.trim());
  } catch {
    writeMCPLog(
      '[GUI] Failed to parse Windows display configuration JSON',
      'Display Detection Error'
    );
    throw new Error('Failed to parse Windows display configuration');
  }

  // Ensure displays is an array (PowerShell may return single object instead of array)
  if (!Array.isArray(displays)) {
    displays = [displays];
  }

  // Sort by index
  displays.sort((a, b) => a.index - b.index);

  // Find main display
  const mainDisplay = displays.find((d) => d.isMain) || displays[0];
  const mainDisplayIndex = mainDisplay?.index || 0;

  // Calculate total dimensions
  let totalWidth = 0;
  let totalHeight = 0;

  for (const display of displays) {
    const right = display.originX + display.width;
    const bottom = display.originY + display.height;
    if (right > totalWidth) totalWidth = right;
    if (bottom > totalHeight) totalHeight = bottom;
  }

  return {
    displays,
    totalWidth,
    totalHeight,
    mainDisplayIndex,
  };
}

/**
 * Windows: Perform mouse click using SendInput API
 */
export async function windowsPerformClick(
  globalX: number,
  globalY: number,
  clickType: 'single' | 'double' | 'right' | 'triple' = 'single',
  modifiers: string[] = []
): Promise<void> {
  // Build modifier key virtual key codes
  const modKeyCodes: number[] = [];
  for (const mod of modifiers) {
    const modLower = mod.toLowerCase();
    // Virtual key codes: Ctrl=0x11, Shift=0x10, Alt=0x12
    if (modLower === 'ctrl' || modLower === 'control') {
      modKeyCodes.push(0x11);
    } else if (modLower === 'shift') {
      modKeyCodes.push(0x10);
    } else if (modLower === 'alt' || modLower === 'option') {
      modKeyCodes.push(0x12);
    } else if (modLower === 'cmd' || modLower === 'command') {
      // Map Cmd to Ctrl on Windows
      modKeyCodes.push(0x11);
    }
  }

  // Determine mouse flags for SendInput
  // MOUSEEVENTF_LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010
  let clickCount = 1;
  let downFlag = '0x0002';
  let upFlag = '0x0004';
  if (clickType === 'right') {
    downFlag = '0x0008';
    upFlag = '0x0010';
  } else if (clickType === 'double') {
    clickCount = 2;
  } else if (clickType === 'triple') {
    clickCount = 3;
  }

  // Build modifier press/release PowerShell code using SendInput for keyboard
  const modDownCode = modKeyCodes
    .map(
      (vk) =>
        `$ki = New-Object WinClick+INPUT; $ki.type = 1; $ki.ki = New-Object WinClick+KEYBDINPUT; $ki.ki.wVk = ${vk}; $ki.ki.dwFlags = 0; [WinClick]::SendInput(1, @($ki), $inputSize) | Out-Null`
    )
    .join('\n');
  const modUpCode = modKeyCodes
    .map(
      (vk) =>
        `$ki = New-Object WinClick+INPUT; $ki.type = 1; $ki.ki = New-Object WinClick+KEYBDINPUT; $ki.ki.wVk = ${vk}; $ki.ki.dwFlags = 2; [WinClick]::SendInput(1, @($ki), $inputSize) | Out-Null`
    )
    .join('\n');

  // Build click sequence
  let clickCode = '';
  for (let i = 0; i < clickCount; i++) {
    if (i > 0) clickCode += 'Start-Sleep -Milliseconds 50\n';
    clickCode += `
$mi = New-Object WinClick+INPUT; $mi.type = 0; $mi.mi = New-Object WinClick+MOUSEINPUT; $mi.mi.dwFlags = ${downFlag}; [WinClick]::SendInput(1, @($mi), $inputSize) | Out-Null
$mi2 = New-Object WinClick+INPUT; $mi2.type = 0; $mi2.mi = New-Object WinClick+MOUSEINPUT; $mi2.mi.dwFlags = ${upFlag}; [WinClick]::SendInput(1, @($mi2), $inputSize) | Out-Null
`;
  }

  const script = `
Add-Type -AssemblyName System.Windows.Forms

$code = @"
using System;
using System.Runtime.InteropServices;

public class WinClick {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public int mouseData;
        public int dwFlags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public short wVk;
        public short wScan;
        public int dwFlags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT {
        [FieldOffset(0)] public int type;
        [FieldOffset(4)] public MOUSEINPUT mi;
        [FieldOffset(4)] public KEYBDINPUT ki;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
"@

Add-Type -TypeDefinition $code -Language CSharp

# Set DPI awareness for accurate cursor positioning
[WinClick]::SetProcessDPIAware() | Out-Null

$inputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinClick+INPUT])

# Set cursor position
[WinClick]::SetCursorPos(${globalX}, ${globalY})
Start-Sleep -Milliseconds 100

# Press modifier keys
${modDownCode}

# Perform click(s)
${clickCode}

# Release modifier keys
${modUpCode}

Write-Output "SUCCESS"
`;

  const result = await executePowerShell(script);

  if (!result.stdout.includes('SUCCESS')) {
    throw new Error(`Click failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * Windows: Perform keyboard input using clipboard paste
 * Simplified version that just sends Ctrl+V to the currently focused control
 * The click operation should have already focused the target control
 */
export async function windowsPerformType(text: string, pressEnter: boolean = false): Promise<void> {
  // Escape text for PowerShell
  const escapedText = text.replace(/"/g, '`"').replace(/\$/g, '`$').replace(/`/g, '``');

  const script = `
Add-Type -AssemblyName System.Windows.Forms

$signature = @"
[DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
"@

Add-Type -MemberDefinition $signature -Name Win32 -Namespace User32

# Save original clipboard content
$originalClip = $null
try {
    $originalClip = [System.Windows.Forms.Clipboard]::GetText()
} catch {}

# Set the text to clipboard
[System.Windows.Forms.Clipboard]::SetText("${escapedText}")

# Small delay to ensure clipboard is set
Start-Sleep -Milliseconds 50

# Send Ctrl+V to paste to whatever control is currently focused
# VK_CONTROL = 0x11, VK_V = 0x56
# KEYEVENTF_KEYDOWN = 0, KEYEVENTF_KEYUP = 2
[User32.Win32]::keybd_event(0x11, 0, 0, 0)  # Ctrl down
Start-Sleep -Milliseconds 30
[User32.Win32]::keybd_event(0x56, 0, 0, 0)  # V down
Start-Sleep -Milliseconds 30
[User32.Win32]::keybd_event(0x56, 0, 2, 0)  # V up
Start-Sleep -Milliseconds 30
[User32.Win32]::keybd_event(0x11, 0, 2, 0)  # Ctrl up

Start-Sleep -Milliseconds 50

${
  pressEnter
    ? `
# Send Enter key
# VK_RETURN = 0x0D
Start-Sleep -Milliseconds 50
[User32.Win32]::keybd_event(0x0D, 0, 0, 0)  # Enter down
Start-Sleep -Milliseconds 30
[User32.Win32]::keybd_event(0x0D, 0, 2, 0)  # Enter up
`
    : ''
}

# Restore original clipboard if possible
if ($originalClip) {
    Start-Sleep -Milliseconds 100
    try {
        [System.Windows.Forms.Clipboard]::SetText($originalClip)
    } catch {}
}

Write-Output "SUCCESS"
`;

  const result = await executePowerShell(script);

  if (!result.stdout.includes('SUCCESS')) {
    throw new Error(`Type failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * Windows: Press a key or key combination using keybd_event (more reliable)
 */
export async function windowsPerformKeyPress(key: string, modifiers: string[] = []): Promise<void> {
  // Map key names to virtual key codes
  const vkMap: Record<string, number> = {
    enter: 0x0d,
    return: 0x0d,
    tab: 0x09,
    escape: 0x1b,
    esc: 0x1b,
    space: 0x20,
    delete: 0x2e,
    del: 0x2e,
    backspace: 0x08,
    up: 0x26,
    down: 0x28,
    left: 0x25,
    right: 0x27,
    home: 0x24,
    end: 0x23,
    pageup: 0x21,
    pgup: 0x21,
    pagedown: 0x22,
    pgdn: 0x22,
    insert: 0x2d,
    f1: 0x70,
    f2: 0x71,
    f3: 0x72,
    f4: 0x73,
    f5: 0x74,
    f6: 0x75,
    f7: 0x76,
    f8: 0x77,
    f9: 0x78,
    f10: 0x79,
    f11: 0x7a,
    f12: 0x7b,
    // Letters
    a: 0x41,
    b: 0x42,
    c: 0x43,
    d: 0x44,
    e: 0x45,
    f: 0x46,
    g: 0x47,
    h: 0x48,
    i: 0x49,
    j: 0x4a,
    k: 0x4b,
    l: 0x4c,
    m: 0x4d,
    n: 0x4e,
    o: 0x4f,
    p: 0x50,
    q: 0x51,
    r: 0x52,
    s: 0x53,
    t: 0x54,
    u: 0x55,
    v: 0x56,
    w: 0x57,
    x: 0x58,
    y: 0x59,
    z: 0x5a,
    // Numbers
    '0': 0x30,
    '1': 0x31,
    '2': 0x32,
    '3': 0x33,
    '4': 0x34,
    '5': 0x35,
    '6': 0x36,
    '7': 0x37,
    '8': 0x38,
    '9': 0x39,
  };

  const keyLower = key.toLowerCase();
  const vkCode = vkMap[keyLower];

  if (vkCode === undefined) {
    throw new Error(`Unknown key: ${key}`);
  }

  // Map modifier names to virtual key codes
  const modifierCodes: number[] = [];
  for (const mod of modifiers) {
    const modLower = mod.toLowerCase();
    if (modLower === 'ctrl' || modLower === 'control') {
      modifierCodes.push(0x11); // VK_CONTROL
    } else if (modLower === 'shift') {
      modifierCodes.push(0x10); // VK_SHIFT
    } else if (modLower === 'alt' || modLower === 'option') {
      modifierCodes.push(0x12); // VK_MENU (Alt)
    } else if (modLower === 'cmd' || modLower === 'command') {
      modifierCodes.push(0x11); // Map Cmd to Ctrl on Windows
    }
  }

  // Build PowerShell script
  const modDownScript = modifierCodes
    .map((code) => `[User32.Win32]::keybd_event(${code}, 0, 0, 0)`)
    .join('\n');

  const modUpScript = modifierCodes
    .slice()
    .reverse()
    .map((code) => `[User32.Win32]::keybd_event(${code}, 0, 2, 0)`)
    .join('\n');

  const script = `
$signature = @"
[DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
"@

Add-Type -MemberDefinition $signature -Name Win32 -Namespace User32

# Press modifier keys
${modDownScript}

# Press and release the main key
[User32.Win32]::keybd_event(${vkCode}, 0, 0, 0)
Start-Sleep -Milliseconds 50
[User32.Win32]::keybd_event(${vkCode}, 0, 2, 0)

# Release modifier keys
${modUpScript}

Write-Output "SUCCESS"
`;

  const result = await executePowerShell(script);

  if (!result.stdout.includes('SUCCESS')) {
    throw new Error(`Key press failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * Windows: Perform scroll operation
 */
export async function windowsPerformScroll(
  globalX: number,
  globalY: number,
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number = 3
): Promise<void> {
  // WHEEL_DELTA is 120, amount is number of notches
  const wheelDelta = direction === 'up' ? 120 * amount : direction === 'down' ? -120 * amount : 0;
  const hWheelDelta =
    direction === 'left' ? -120 * amount : direction === 'right' ? 120 * amount : 0;

  // Use SendInput API instead of deprecated mouse_event for better compatibility
  // with modern applications (e.g. WeChat, Electron apps)
  const isHorizontal = hWheelDelta !== 0;
  const delta = isHorizontal ? hWheelDelta : wheelDelta;
  // MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x01000
  const mouseFlag = isHorizontal ? '0x01000' : '0x0800';

  const script = `
Add-Type -AssemblyName System.Windows.Forms

$code = @"
using System;
using System.Runtime.InteropServices;

public class WinScroll {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public int mouseData;
        public int dwFlags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public short wVk;
        public short wScan;
        public int dwFlags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT {
        [FieldOffset(0)] public int type;
        [FieldOffset(4)] public MOUSEINPUT mi;
        [FieldOffset(4)] public KEYBDINPUT ki;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
"@

Add-Type -TypeDefinition $code -Language CSharp

try {
    # Set DPI awareness
    [WinScroll]::SetProcessDPIAware() | Out-Null

    # Move cursor to target position
    [WinScroll]::SetCursorPos(${globalX}, ${globalY})
    Start-Sleep -Milliseconds 100

    # Activate the window under cursor so it receives scroll events
    $pt = New-Object WinScroll+POINT
    $pt.X = ${globalX}
    $pt.Y = ${globalY}
    $hwnd = [WinScroll]::WindowFromPoint($pt)
    if ($hwnd -ne [IntPtr]::Zero) {
        # Get the top-level parent window (GA_ROOT = 2)
        $rootHwnd = [WinScroll]::GetAncestor($hwnd, 2)
        if ($rootHwnd -ne [IntPtr]::Zero) {
            [WinScroll]::SetForegroundWindow($rootHwnd) | Out-Null
        } else {
            [WinScroll]::SetForegroundWindow($hwnd) | Out-Null
        }
        Start-Sleep -Milliseconds 50
    }

    # Re-position cursor after window activation (activation may shift focus)
    [WinScroll]::SetCursorPos(${globalX}, ${globalY})
    Start-Sleep -Milliseconds 50

    # Build and send scroll input using SendInput
    $inputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinScroll+INPUT])
    $input = New-Object WinScroll+INPUT
    $input.type = 0  # INPUT_MOUSE
    $input.mi = New-Object WinScroll+MOUSEINPUT
    $input.mi.dx = 0
    $input.mi.dy = 0
    $input.mi.mouseData = ${delta}
    $input.mi.dwFlags = ${mouseFlag}
    $input.mi.time = 0
    $input.mi.dwExtraInfo = [IntPtr]::Zero

    $inputs = @($input)
    $result = [WinScroll]::SendInput(1, $inputs, $inputSize)

    if ($result -eq 1) {
        Write-Output "SUCCESS"
    } else {
        $lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Output "FAILED: SendInput returned $result, LastError=$lastErr, inputSize=$inputSize"
    }
} catch {
    Write-Output "ERROR: $_"
    exit 1
}
`;

  const result = await executePowerShell(script);

  if (!result.stdout.includes('SUCCESS')) {
    throw new Error(`Scroll failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * Windows: Get mouse position
 */
export async function windowsGetMousePosition(): Promise<{ globalX: number; globalY: number }> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$pos = [System.Windows.Forms.Cursor]::Position
Write-Output "$($pos.X),$($pos.Y)"
`;

  const result = await executePowerShell(script);
  const match = result.stdout.trim().match(/(\d+),(\d+)/);

  if (!match) {
    throw new Error(`Failed to parse mouse position: ${result.stdout}`);
  }

  return {
    globalX: parseInt(match[1]),
    globalY: parseInt(match[2]),
  };
}

/**
 * Windows: Move mouse to position
 */
export async function windowsMoveMouse(globalX: number, globalY: number): Promise<void> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms

$signature = @"
[DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")]
public static extern bool SetCursorPos(int X, int Y);
"@

Add-Type -MemberDefinition $signature -Name SetCursorPos -Namespace Win32Functions

# Set DPI awareness
[Win32Functions.SetCursorPos]::SetProcessDPIAware() | Out-Null

[Win32Functions.SetCursorPos]::SetCursorPos(${globalX}, ${globalY})
Write-Output "SUCCESS"
`;

  const result = await executePowerShell(script);

  if (!result.stdout.includes('SUCCESS')) {
    throw new Error(`Move mouse failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * Windows: Perform drag operation
 */
export async function windowsPerformDrag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): Promise<void> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms

$code = @"
using System;
using System.Runtime.InteropServices;

public class WinDrag {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public int mouseData;
        public int dwFlags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public int type;
        public MOUSEINPUT mi;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
"@

Add-Type -TypeDefinition $code -Language CSharp

# Set DPI awareness
[WinDrag]::SetProcessDPIAware() | Out-Null

$inputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinDrag+INPUT])

# Move to start position
[WinDrag]::SetCursorPos(${fromX}, ${fromY})
Start-Sleep -Milliseconds 100

# Press left button (MOUSEEVENTF_LEFTDOWN = 0x0002)
$mi = New-Object WinDrag+INPUT; $mi.type = 0; $mi.mi = New-Object WinDrag+MOUSEINPUT; $mi.mi.dwFlags = 0x0002
[WinDrag]::SendInput(1, @($mi), $inputSize) | Out-Null
Start-Sleep -Milliseconds 50

# Move to end position
[WinDrag]::SetCursorPos(${toX}, ${toY})
Start-Sleep -Milliseconds 50

# Release left button (MOUSEEVENTF_LEFTUP = 0x0004)
$mi2 = New-Object WinDrag+INPUT; $mi2.type = 0; $mi2.mi = New-Object WinDrag+MOUSEINPUT; $mi2.mi.dwFlags = 0x0004
[WinDrag]::SendInput(1, @($mi2), $inputSize) | Out-Null

Write-Output "SUCCESS"
`;

  const result = await executePowerShell(script);

  if (!result.stdout.includes('SUCCESS')) {
    throw new Error(`Drag failed: ${result.stderr || result.stdout}`);
  }
}

// ============================================================================
// Display Information Functions
// ============================================================================
