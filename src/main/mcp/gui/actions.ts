import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

import { writeMCPLog } from '../mcp-logger.js';
import { type CallToolResult } from '@modelcontextprotocol/server';
import {
  PLATFORM,
  SCREENSHOTS_DIR,
  screenshotRequestCounts,
  toRegionKey,
  getReusableScreenshot,
  updateScreenshotCache,
} from './state.js';
import {
  getDisplayConfiguration,
  convertToGlobalCoordinates,
  convertCliclickToCocoaCoordinates,
} from './display-coords.js';
import {
  executeCliclick,
  executeAppleScript,
  executePython,
  executeCommandSafe,
  resolveCliclickPath,
  normalizeModifierKeys,
  formatCliclickCoords,
  macReadClipboardBytes,
  macWriteClipboardBytes,
} from './exec.js';
import {
  windowsPerformClick,
  windowsPerformType,
  windowsPerformKeyPress,
  windowsPerformScroll,
  windowsPerformDrag,
  windowsTakeScreenshot,
  windowsGetMousePosition,
  windowsMoveMouse,
} from './windows-ops.js';
import {
  addClickToHistory,
  ensureAppContextRestored,
  currentAppName,
  clickHistory,
} from './click-history.js';

export async function performMacMouseMoveViaQuartz(
  globalX: number,
  globalY: number,
  modifiers: string[]
): Promise<void> {
  const { cocoaX, cocoaY } = await convertCliclickToCocoaCoordinates(globalX, globalY);
  const modsJson = JSON.stringify(normalizeModifierKeys(modifiers));
  const script = `
import Quartz, json
mods = json.loads(${JSON.stringify(modsJson)})
flag_map = {
  "cmd": Quartz.kCGEventFlagMaskCommand,
  "ctrl": Quartz.kCGEventFlagMaskControl,
  "shift": Quartz.kCGEventFlagMaskShift,
  "alt": Quartz.kCGEventFlagMaskAlternate,
}
flags = 0
for m in mods:
  flags |= flag_map.get(m, 0)
event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${cocoaX}, ${cocoaY}), Quartz.kCGMouseButtonLeft)
if flags:
  Quartz.CGEventSetFlags(event, flags)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
  `.trim();
  await executePython(script, 5000);
}

export async function performMacClickViaQuartz(
  globalX: number,
  globalY: number,
  clickType: 'single' | 'double' | 'right' | 'triple',
  modifiers: string[]
): Promise<void> {
  const { cocoaX, cocoaY } = await convertCliclickToCocoaCoordinates(globalX, globalY);
  const modsJson = JSON.stringify(normalizeModifierKeys(modifiers));
  const clickCount = clickType === 'double' ? 2 : clickType === 'triple' ? 3 : 1;
  const isRight = clickType === 'right';
  const script = `
import Quartz, json, time
mods = json.loads(${JSON.stringify(modsJson)})
flag_map = {
  "cmd": Quartz.kCGEventFlagMaskCommand,
  "ctrl": Quartz.kCGEventFlagMaskControl,
  "shift": Quartz.kCGEventFlagMaskShift,
  "alt": Quartz.kCGEventFlagMaskAlternate,
}
flags = 0
for m in mods:
  flags |= flag_map.get(m, 0)
button = Quartz.kCGMouseButtonRight if ${isRight ? 'True' : 'False'} else Quartz.kCGMouseButtonLeft
down_event = Quartz.kCGEventRightMouseDown if ${isRight ? 'True' : 'False'} else Quartz.kCGEventLeftMouseDown
up_event = Quartz.kCGEventRightMouseUp if ${isRight ? 'True' : 'False'} else Quartz.kCGEventLeftMouseUp
def post(evt_type, click_state):
  ev = Quartz.CGEventCreateMouseEvent(None, evt_type, (${cocoaX}, ${cocoaY}), button)
  Quartz.CGEventSetIntegerValueField(ev, Quartz.kCGMouseEventClickState, click_state)
  if flags:
    Quartz.CGEventSetFlags(ev, flags)
  Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
for i in range(${clickCount}):
  state = i + 1 if ${clickCount} > 1 else 1
  post(down_event, state)
  post(up_event, state)
  if ${clickCount} > 1:
    time.sleep(0.05)
  `.trim();
  await executePython(script, 8000);
}

export async function performMacDragViaQuartz(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  modifiers: string[]
): Promise<void> {
  const from = await convertCliclickToCocoaCoordinates(fromX, fromY);
  const to = await convertCliclickToCocoaCoordinates(toX, toY);
  const modsJson = JSON.stringify(normalizeModifierKeys(modifiers));
  const script = `
import Quartz, json, time
mods = json.loads(${JSON.stringify(modsJson)})
flag_map = {
  "cmd": Quartz.kCGEventFlagMaskCommand,
  "ctrl": Quartz.kCGEventFlagMaskControl,
  "shift": Quartz.kCGEventFlagMaskShift,
  "alt": Quartz.kCGEventFlagMaskAlternate,
}
flags = 0
for m in mods:
  flags |= flag_map.get(m, 0)
def post(evt_type, x, y):
  ev = Quartz.CGEventCreateMouseEvent(None, evt_type, (x, y), Quartz.kCGMouseButtonLeft)
  if flags:
    Quartz.CGEventSetFlags(ev, flags)
  Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
post(Quartz.kCGEventLeftMouseDown, ${from.cocoaX}, ${from.cocoaY})
post(Quartz.kCGEventLeftMouseDragged, ${to.cocoaX}, ${to.cocoaY})
post(Quartz.kCGEventLeftMouseUp, ${to.cocoaX}, ${to.cocoaY})
  `.trim();
  await executePython(script, 8000);
}


export async function performClick(
  x: number,
  y: number,
  displayIndex: number = 0,
  clickType: 'single' | 'double' | 'right' | 'triple' = 'single',
  modifiers: string[] = []
): Promise<string> {
  writeMCPLog(
    `[performClick] Input coordinates: x=${x}, y=${y}, displayIndex=${displayIndex}, clickType=${clickType}`,
    'Click Operation'
  );

  // If server restarted, in-memory click history/app context is empty. Try to restore last app context
  // so click history persistence + screenshot annotation remain stable without requiring an explicit init_app retry.
  if (!currentAppName && clickHistory.length === 0) {
    await ensureAppContextRestored();
  }

  const localX = x;
  let localY = y;

  // Dock auto-hide on macOS can swallow the first click near the bottom edge.
  // Pre-hovering briefly improves click reliability for dock/app-switch actions.
  if (PLATFORM === 'darwin') {
    const config = await getDisplayConfiguration();
    const targetDisplay = config.displays.find((d) => d.index === displayIndex);
    const dockZoneHeight = 140;
    const nearBottomDockZone = Boolean(
      targetDisplay && localY >= Math.max(0, targetDisplay.height - dockZoneHeight)
    );

    if (targetDisplay && localY >= targetDisplay.height - 2) {
      localY = Math.max(0, targetDisplay.height - 24);
      writeMCPLog(
        `[performClick] Adjusted edge click Y from ${y} to ${localY} for dock reliability on display ${displayIndex}`,
        'Click Operation'
      );
    }

    if (nearBottomDockZone) {
      await moveMouse(localX, localY, displayIndex);
      await new Promise((resolve) => setTimeout(resolve, 150));
      writeMCPLog(
        `[performClick] Pre-hovered in dock zone before click at (${localX}, ${localY})`,
        'Click Operation'
      );
    }
  }

  const { globalX, globalY } = await convertToGlobalCoordinates(localX, localY, displayIndex);

  writeMCPLog(
    `[performClick] Global coordinates: globalX=${globalX}, globalY=${globalY}`,
    'Click Operation'
  );

  // Windows implementation
  if (PLATFORM === 'win32') {
    await windowsPerformClick(globalX, globalY, clickType, modifiers);
    await addClickToHistory(localX, localY, displayIndex, clickType);
    return `Performed ${clickType} click at (${localX}, ${localY}) on display ${displayIndex} (global: ${globalX}, ${globalY})`;
  }

  // macOS implementation using cliclick
  const normalizedModifiers = normalizeModifierKeys(modifiers);
  const cliclickPath = await resolveCliclickPath();

  if (!cliclickPath) {
    // 无 cliclick 时，使用 Quartz 事件作为降级方案
    await performMacClickViaQuartz(globalX, globalY, clickType, normalizedModifiers);
    await addClickToHistory(localX, localY, displayIndex, clickType);
    return `Performed ${clickType} click at (${localX}, ${localY}) on display ${displayIndex} (global: ${globalX}, ${globalY})`;
  }

  // Build cliclick command
  let command = '';

  // Add modifiers (if any)
  const cliclickModifiers = normalizedModifiers.join(',');

  // Build click command based on type
  // Use formatCliclickCoords to handle negative coordinates (displays to left/above main)
  const coords = formatCliclickCoords(globalX, globalY);
  switch (clickType) {
    case 'double':
      command = `dc:${coords}`;
      break;
    case 'right':
      command = `rc:${coords}`;
      break;
    case 'triple':
      command = `tc:${coords}`;
      break;
    case 'single':
    default:
      command = `c:${coords}`;
      break;
  }

  // Add modifier key handling
  if (cliclickModifiers) {
    // Hold modifier keys, click, release
    command = `kd:${cliclickModifiers} ${command} ku:${cliclickModifiers}`;
  }

  await executeCliclick(command);

  // Add to click history after successful click (now async with persistence)
  await addClickToHistory(localX, localY, displayIndex, clickType);

  return `Performed ${clickType} click at (${localX}, ${localY}) on display ${displayIndex} (global: ${globalX}, ${globalY})`;
}

/**
 * Perform keyboard input
 */
export async function performType(
  text: string,
  pressEnter: boolean = false,
  inputMethod: 'auto' | 'keystroke' | 'paste' = 'auto',
  preserveClipboard: boolean = true
): Promise<string> {
  // Windows implementation
  if (PLATFORM === 'win32') {
    writeMCPLog(
      `[performType] Windows: Typing text. text length: ${text.length}`,
      'Type Operation'
    );
    await windowsPerformType(text, pressEnter);
    return `Typed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"${pressEnter ? ' and pressed Enter' : ''}`;
  }

  // macOS implementation
  // eslint-disable-next-line no-control-regex
  const hasNonAscii = /[^\x00-\x7F]/.test(text);
  const usePaste = inputMethod === 'paste' || (inputMethod === 'auto' && hasNonAscii);

  // Clipboard-paste method is much more reliable for Unicode/CJK (e.g. Chinese)
  if (usePaste) {
    writeMCPLog(
      `[performType] Typing via clipboard paste (unicode-safe). text length: ${text.length}, preserveClipboard=${preserveClipboard}`,
      'Type Operation'
    );

    // Snapshot current clipboard bytes so we can restore it after paste (best-effort).
    let previousClipboardBytes: Buffer | null = null;
    if (preserveClipboard) {
      try {
        previousClipboardBytes = await macReadClipboardBytes(2000);
      } catch {
        // If pbpaste fails (non-text clipboard, permissions, etc.), skip restore
        previousClipboardBytes = null;
      }
    }

    // Set clipboard to the target text (as bytes) without requiring Python.
    await macWriteClipboardBytes(Buffer.from(text, 'utf-8'), 5000);

    // Paste (Cmd+V)
    await performKeyPress('v', ['cmd']);

    // Optionally press Enter
    if (pressEnter) {
      await executeAppleScript('tell application "System Events" to key code 36');
    }

    // Restore previous clipboard if we captured it (best-effort).
    // Limit size to avoid excessive memory / IPC overhead.
    if (
      preserveClipboard &&
      previousClipboardBytes &&
      previousClipboardBytes.length <= 10 * 1024 * 1024
    ) {
      try {
        await macWriteClipboardBytes(previousClipboardBytes, 5000);
      } catch {
        // Best-effort restore
      }
    }

    return `Typed (paste): "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"${pressEnter ? ' and pressed Enter' : ''}`;
  }

  // Default: AppleScript keystroke for ASCII text
  const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const appleScript = `tell application "System Events" to keystroke "${escapedText}"`;

  writeMCPLog(
    `[performType] Typing via AppleScript keystroke. text length: ${text.length}, inputMethod=${inputMethod}`,
    'Type Operation'
  );
  await executeAppleScript(appleScript);

  if (pressEnter) {
    await executeAppleScript('tell application "System Events" to key code 36');
  }

  return `Typed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"${pressEnter ? ' and pressed Enter' : ''}`;
}

/**
 * Press a key or key combination
 */
export async function performKeyPress(key: string, modifiers: string[] = []): Promise<string> {
  // Log input parameters for debugging
  writeMCPLog(
    `[performKeyPress] Input: key="${key}", modifiers=${JSON.stringify(modifiers)}`,
    'Key Press Debug'
  );

  // Windows implementation
  if (PLATFORM === 'win32') {
    await windowsPerformKeyPress(key, modifiers);
    const modifierStr = modifiers.length > 0 ? `${modifiers.join('+')}+` : '';
    return `Pressed: ${modifierStr}${key}`;
  }

  // macOS implementation
  // Map common key names to cliclick key codes
  const keyMap: Record<string, string> = {
    enter: 'return',
    return: 'return',
    tab: 'tab',
    escape: 'esc',
    esc: 'esc',
    space: 'space',
    delete: 'delete',
    backspace: 'delete',
    up: 'arrow-up',
    down: 'arrow-down',
    left: 'arrow-left',
    right: 'arrow-right',
    home: 'home',
    end: 'end',
    pageup: 'page-up',
    pagedown: 'page-down',
    f1: 'f1',
    f2: 'f2',
    f3: 'f3',
    f4: 'f4',
    f5: 'f5',
    f6: 'f6',
    f7: 'f7',
    f8: 'f8',
    f9: 'f9',
    f10: 'f10',
    f11: 'f11',
    f12: 'f12',
  };

  // Map characters to AppleScript key codes (for reliable modifier+key combinations)
  const keyCodeMap: Record<string, number> = {
    a: 0,
    b: 11,
    c: 8,
    d: 2,
    e: 14,
    f: 3,
    g: 5,
    h: 4,
    i: 34,
    j: 38,
    k: 40,
    l: 37,
    m: 46,
    n: 45,
    o: 31,
    p: 35,
    q: 12,
    r: 15,
    s: 1,
    t: 17,
    u: 32,
    v: 9,
    w: 13,
    x: 7,
    y: 16,
    z: 6,
    '0': 29,
    '1': 18,
    '2': 19,
    '3': 20,
    '4': 21,
    '5': 23,
    '6': 22,
    '7': 26,
    '8': 28,
    '9': 25,
    ' ': 49, // space
  };

  const specialKeyCodeMap: Record<string, number> = {
    enter: 36,
    return: 36,
    tab: 48,
    escape: 53,
    esc: 53,
    space: 49,
    delete: 51,
    backspace: 51,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
    home: 115,
    end: 119,
    pageup: 116,
    pagedown: 121,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
  };

  const keyLower = key.toLowerCase();
  const cliclickKey = keyMap[keyLower];

  // Handle modifiers
  const cliclickModifiers = normalizeModifierKeys(modifiers);

  writeMCPLog(
    `[performKeyPress] Mapped modifiers: ${JSON.stringify(cliclickModifiers)}`,
    'Key Press Debug'
  );
  const hasCliclick = Boolean(await resolveCliclickPath());

  let command = '';
  let resultMessage = '';

  // For special keys that have key codes, prefer AppleScript key code method
  // because it's more reliable across different applications (e.g., WeChat, browsers)
  // cliclick's kp: command doesn't work correctly in some apps
  const specialKeyCode = specialKeyCodeMap[keyLower];

  if (specialKeyCode !== undefined) {
    // Use AppleScript key code for special keys (enter, tab, escape, arrows, etc.)
    // This is more reliable than cliclick for apps like WeChat
    const modifierFlags: string[] = [];
    if (cliclickModifiers.includes('cmd')) modifierFlags.push('command down');
    if (cliclickModifiers.includes('ctrl')) modifierFlags.push('control down');
    if (cliclickModifiers.includes('shift')) modifierFlags.push('shift down');
    if (cliclickModifiers.includes('alt')) modifierFlags.push('option down');
    const usingClause = modifierFlags.length > 0 ? ` using {${modifierFlags.join(', ')}}` : '';
    const appleScript = `tell application "System Events" to key code ${specialKeyCode}${usingClause}`;
    writeMCPLog(
      `[performKeyPress] Using AppleScript key code ${specialKeyCode} for "${key}"`,
      'Key Press'
    );
    await executeAppleScript(appleScript);
    const modifierStr = modifiers.join('+');
    resultMessage = `Pressed: ${modifierStr ? `${modifierStr}+` : ''}${key}`;
  } else if (cliclickKey && hasCliclick) {
    // For other mapped keys that cliclick supports but don't have AppleScript key codes
    if (cliclickModifiers.length > 0) {
      command = `kd:${cliclickModifiers.join(',')} kp:${cliclickKey} ku:${cliclickModifiers.join(',')}`;
    } else {
      command = `kp:${cliclickKey}`;
    }
    await executeCliclick(command);
  } else if (!cliclickKey) {
    // For single characters, cliclick's kp: doesn't work, use t: command instead
    if (key.length === 1) {
      const escapedKey = key.replace(/"/g, '\\"');

      if (cliclickModifiers.length > 0) {
        // For modifier+char combinations, use AppleScript key code for reliability
        // This is especially important for system shortcuts like Ctrl+C
        const keyCode = keyCodeMap[keyLower];

        if (keyCode !== undefined) {
          // Use key code method for reliable modifier combinations
          const modifierFlags: string[] = [];
          if (cliclickModifiers.includes('cmd')) modifierFlags.push('command down');
          if (cliclickModifiers.includes('ctrl')) modifierFlags.push('control down');
          if (cliclickModifiers.includes('shift')) modifierFlags.push('shift down');
          if (cliclickModifiers.includes('alt')) modifierFlags.push('option down');

          const usingClause =
            modifierFlags.length > 0 ? ` using {${modifierFlags.join(', ')}}` : '';
          const appleScript = `tell application "System Events" to key code ${keyCode}${usingClause}`;

          writeMCPLog(
            `[performKeyPress] Using key code ${keyCode} for ${key} with modifiers: ${modifierFlags.join(', ')}`,
            'Key Press'
          );
          await executeAppleScript(appleScript);
          const modifierStr = modifiers.join('+');
          resultMessage = `Pressed: ${modifierStr}+${key} (using key code)`;
        } else {
          // Fallback to keystroke for characters not in keyCodeMap
          const modifierFlags: string[] = [];
          if (cliclickModifiers.includes('cmd')) modifierFlags.push('command down');
          if (cliclickModifiers.includes('ctrl')) modifierFlags.push('control down');
          if (cliclickModifiers.includes('shift')) modifierFlags.push('shift down');
          if (cliclickModifiers.includes('alt')) modifierFlags.push('option down');

          const usingClause =
            modifierFlags.length > 0 ? ` using {${modifierFlags.join(', ')}}` : '';
          const appleScript = `tell application "System Events" to keystroke "${escapedKey}"${usingClause}`;

          await executeAppleScript(appleScript);
          const modifierStr = modifiers.join('+');
          resultMessage = `Pressed: ${modifierStr}+${key} (using keystroke)`;
        }
      } else {
        // No modifiers
        if (hasCliclick) {
          command = `t:"${escapedKey}"`;
          await executeCliclick(command);
        } else {
          const appleScript = `tell application "System Events" to keystroke "${escapedKey}"`;
          await executeAppleScript(appleScript);
          resultMessage = `Pressed: ${key} (using keystroke)`;
        }
      }
    } else {
      // Multi-character key name not in keyMap - this is an error
      throw new Error(
        `Unknown key: "${key}". ` +
          `Supported special keys: ${Object.keys(keyMap).join(', ')}, ` +
          `or single characters (a-z, 0-9, etc.) for typing text.`
      );
    }
  }

  if (resultMessage) {
    return resultMessage;
  }

  const modifierStr = modifiers.length > 0 ? `${modifiers.join('+')}+` : '';
  return `Pressed: ${modifierStr}${key}`;
}

/**
 * Perform scroll operation
 */
export async function performScroll(
  x: number,
  y: number,
  displayIndex: number = 0,
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number = 3
): Promise<string> {
  const { globalX, globalY } = await convertToGlobalCoordinates(x, y, displayIndex);

  // Windows implementation
  if (PLATFORM === 'win32') {
    await windowsPerformScroll(globalX, globalY, direction, amount);
    return `Scrolled ${direction} by ${amount} at (${x}, ${y}) on display ${displayIndex}`;
  }

  // macOS implementation
  // First move to the position
  // Use formatCliclickCoords to handle negative coordinates (displays to left/above main)
  const coords = formatCliclickCoords(globalX, globalY);
  const moveCommand = `m:${coords}`;
  const hasCliclick = Boolean(await resolveCliclickPath());

  // cliclick doesn't directly support scrolling, but we can use AppleScript
  // via osascript for more reliable scrolling
  if (hasCliclick) {
    await executeCliclick(moveCommand);
  } else {
    await performMacMouseMoveViaQuartz(globalX, globalY, []);
  }

  // Use Python with pyobjc for scrolling via CGEventCreateScrollWheelEvent
  // This is the most reliable method for programmatic scrolling on macOS
  const scrollY = direction === 'up' ? amount : direction === 'down' ? -amount : 0;
  const scrollX = direction === 'left' ? amount : direction === 'right' ? -amount : 0;

  const scrollScript = `
import Quartz
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, ${scrollY}, ${scrollX})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
  `
    .trim()
    .replace(/\n/g, '; ');

  try {
    await executePython(scrollScript, 5000);
  } catch {
    // Fallback: try using AppleScript with key simulation
    // This is a rough approximation for systems without pyobjc
    const keyCode =
      direction === 'up'
        ? '126'
        : direction === 'down'
          ? '125'
          : direction === 'left'
            ? '123'
            : '124';
    const repeatCount = Math.min(amount, 10);

    for (let i = 0; i < repeatCount; i++) {
      try {
        await executeAppleScript(`tell application "System Events" to key code ${keyCode}`);
      } catch {
        break;
      }
    }
    console.warn('Python scroll failed, using key-based approximation');
  }

  return `Scrolled ${direction} by ${amount} at (${x}, ${y}) on display ${displayIndex}`;
}

/**
 * Perform drag operation
 */
export async function performDrag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  displayIndex: number = 0
): Promise<string> {
  const fromCoords = await convertToGlobalCoordinates(fromX, fromY, displayIndex);
  const toCoords = await convertToGlobalCoordinates(toX, toY, displayIndex);

  // Windows implementation
  if (PLATFORM === 'win32') {
    await windowsPerformDrag(
      fromCoords.globalX,
      fromCoords.globalY,
      toCoords.globalX,
      toCoords.globalY
    );
    return `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY}) on display ${displayIndex}`;
  }

  // macOS implementation
  // cliclick drag command: dd: (drag down/start) then du: (drag up/end)
  // Use formatCliclickCoords to handle negative coordinates (displays to left/above main)
  const fromCoordsStr = formatCliclickCoords(fromCoords.globalX, fromCoords.globalY);
  const toCoordsStr = formatCliclickCoords(toCoords.globalX, toCoords.globalY);
  const command = `dd:${fromCoordsStr} du:${toCoordsStr}`;
  const hasCliclick = Boolean(await resolveCliclickPath());

  if (hasCliclick) {
    await executeCliclick(command);
  } else {
    await performMacDragViaQuartz(
      fromCoords.globalX,
      fromCoords.globalY,
      toCoords.globalX,
      toCoords.globalY,
      []
    );
  }

  return `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY}) on display ${displayIndex}`;
}

/**
 * Take a screenshot
 */
export async function takeScreenshot(
  outputPath?: string,
  displayIndex?: number,
  region?: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const timestamp = Date.now();
  const defaultPath = path.join(SCREENSHOTS_DIR, `screenshot_${timestamp}.png`);
  const finalPath = outputPath || defaultPath;

  // Ensure the directory exists
  const dir = path.dirname(finalPath);
  await fs.mkdir(dir, { recursive: true });

  // Windows implementation
  if (PLATFORM === 'win32') {
    // Convert region coordinates to global if needed
    let globalRegion = region;
    if (region && displayIndex !== undefined) {
      const { globalX, globalY } = await convertToGlobalCoordinates(
        region.x,
        region.y,
        displayIndex
      );
      globalRegion = { x: globalX, y: globalY, width: region.width, height: region.height };
    }

    await windowsTakeScreenshot(finalPath, displayIndex, globalRegion);

    // Verify the file was created
    try {
      await fs.access(finalPath);
      const stats = await fs.stat(finalPath);
      return JSON.stringify({
        success: true,
        path: finalPath,
        size: stats.size,
        displayIndex: displayIndex ?? 'all',
        timestamp: new Date().toISOString(),
      });
    } catch {
      throw new Error(`Screenshot file was not created at ${finalPath}`);
    }
  }

  // macOS implementation
  // Use absolute path because packaged apps may have a limited PATH.
  const screencaptureArgs: string[] = ['-C', '-x'];

  // If specific display requested
  if (displayIndex !== undefined) {
    const config = await getDisplayConfiguration();
    const display = config.displays.find((d) => d.index === displayIndex);

    if (!display) {
      throw new Error(`Display index ${displayIndex} not found.`);
    }

    // -D: capture specific display (1-indexed for screencapture)
    screencaptureArgs.push('-D', String(displayIndex + 1));
  }

  // If region specified
  if (region) {
    const { globalX, globalY } =
      displayIndex !== undefined
        ? await convertToGlobalCoordinates(region.x, region.y, displayIndex)
        : { globalX: region.x, globalY: region.y };

    // -R: capture specific region (x,y,width,height)
    screencaptureArgs.push('-R', `${globalX},${globalY},${region.width},${region.height}`);
  }

  screencaptureArgs.push(finalPath);

  try {
    await executeCommandSafe('/usr/sbin/screencapture', screencaptureArgs);
  } catch (error: unknown) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const hint =
      '\n\nmacOS 权限提示 / Permissions:\n' +
      '- System Settings → Privacy & Security → Screen Recording：允许 Open Cowork\n' +
      '- 重新启动应用后再试 / Restart the app and try again\n';
    throw new Error(`${baseMessage}${hint}`);
  }

  // Verify the file was created
  try {
    await fs.access(finalPath);

    // Get file info
    const stats = await fs.stat(finalPath);

    return JSON.stringify({
      success: true,
      path: finalPath,
      size: stats.size,
      displayIndex: displayIndex ?? 'all',
      timestamp: new Date().toISOString(),
    });
  } catch {
    throw new Error(`Screenshot file was not created at ${finalPath}`);
  }
}

/**
 * Clean up screenshot files older than 1 hour to prevent disk accumulation.
 */
export function cleanupOldScreenshots(): void {
  const maxAge = 60 * 60 * 1000; // 1 hour
  const now = Date.now();
  try {
    for (const file of fsSync.readdirSync(SCREENSHOTS_DIR)) {
      const filePath = path.join(SCREENSHOTS_DIR, file);
      try {
        const stat = fsSync.statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          fsSync.unlinkSync(filePath);
          writeMCPLog(`[Screenshot Cleanup] Deleted old screenshot: ${file}`, 'Screenshot Cleanup');
        }
      } catch {
        // Ignore errors for individual files
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

/**
 * Take a screenshot and return it with base64 image data for display in the response
 */
export async function takeScreenshotForDisplay(
  displayIndex?: number,
  region?: { x: number; y: number; width: number; height: number },
  reason?: string,
  forceRefresh?: boolean
  // annotateClicks?: boolean
): Promise<CallToolResult> {
  // Clean up old screenshots to prevent disk accumulation
  cleanupOldScreenshots();

  const normalizedDisplayIndex = displayIndex ?? 0;
  const regionKey = toRegionKey(region);
  const requestKey = `${normalizedDisplayIndex}:${regionKey}`;
  const requestCount = (screenshotRequestCounts.get(requestKey) || 0) + 1;
  screenshotRequestCounts.set(requestKey, requestCount);
  const reusable = forceRefresh ? null : getReusableScreenshot(normalizedDisplayIndex, regionKey);
  if (reusable) {
    const reusedMetadata: Record<string, unknown> = {
      success: true,
      path: reusable.path,
      displayIndex: reusable.displayIndex,
      displayInfo: reusable.displayInfo,
      timestamp: new Date(reusable.capturedAt).toISOString(),
      reused: true,
      duplicateCallCount: requestCount,
    };
    if (requestCount > 1) {
      reusedMetadata.nextStepHint =
        'Screenshot already captured recently. Please use this screenshot to interpret/verify, and avoid repeated screenshot_for_display calls unless user explicitly asks to refresh.';
    }
    if (reason) {
      reusedMetadata.reason = reason;
    }
    if (region) {
      reusedMetadata.region = region;
    }
    writeMCPLog(
      `[takeScreenshotForDisplay] Reusing screenshot captured ${Date.now() - reusable.capturedAt}ms ago: ${reusable.path} (duplicateCallCount=${requestCount})`,
      'Screenshot Reuse'
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(reusedMetadata, null, 2),
        },
        {
          type: 'image',
          data: reusable.base64Image,
          mimeType: 'image/png',
        },
      ],
    };
  }

  const timestamp = Date.now();
  const tempPath = path.join(SCREENSHOTS_DIR, `screenshot_display_${timestamp}.png`);

  // Take the screenshot first
  await takeScreenshot(tempPath, displayIndex, region);

  const finalPath = tempPath;

  // Read the screenshot file and convert to base64
  const imageBuffer = await fs.readFile(finalPath);
  const base64Image = imageBuffer.toString('base64');

  // Get display information
  const config = await getDisplayConfiguration();
  const display =
    config.displays.find((d) => d.index === normalizedDisplayIndex) || config.displays[0];

  // Build response metadata
  const metadata: Record<string, unknown> = {
    success: true,
    path: finalPath,
    displayIndex: normalizedDisplayIndex,
    displayInfo: {
      width: display.width,
      height: display.height,
      scaleFactor: display.scaleFactor,
    },
    timestamp: new Date().toISOString(),
    // annotated: annotateClicks && currentAppName ? true : false,
  };

  if (reason) {
    metadata.reason = reason;
  }

  if (forceRefresh) {
    metadata.forceRefresh = true;
  }

  if (region) {
    metadata.region = region;
  }

  const disableImageOutput = process.env.OPEN_COWORK_DISABLE_IMAGE_TOOL_OUTPUT === '1';
  if (disableImageOutput) {
    metadata.imageOmitted = true;
    metadata.omitReason = 'provider_does_not_support_image';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(metadata, null, 2),
        },
      ],
    };
  }

  updateScreenshotCache({
    displayIndex: normalizedDisplayIndex,
    regionKey,
    path: finalPath,
    base64Image,
    capturedAt: Date.now(),
    displayInfo: {
      width: display.width,
      height: display.height,
      scaleFactor: display.scaleFactor,
    },
  });

  // Return MCP response with both text and image content
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(metadata, null, 2),
      },
      {
        type: 'image',
        data: base64Image,
        mimeType: 'image/png',
      },
    ],
  };
}

/**
 * Get current mouse position
 */
export async function getMousePosition(): Promise<{ x: number; y: number; displayIndex: number }> {
  let globalX: number;
  let globalY: number;

  // Windows implementation
  if (PLATFORM === 'win32') {
    const pos = await windowsGetMousePosition();
    globalX = pos.globalX;
    globalY = pos.globalY;
  } else {
    // macOS implementation
    const result = await executeCliclick('p');
    // Output format: "x,y" — coordinates may be negative for displays to the left of / above main
    const match = result.stdout.trim().match(/(-?\d+),(-?\d+)/);

    if (!match) {
      throw new Error(`Failed to parse mouse position: ${result.stdout}`);
    }

    globalX = parseInt(match[1]);
    globalY = parseInt(match[2]);
  }

  // Find which display this position is on
  const config = await getDisplayConfiguration();
  let foundDisplay = config.displays[0];

  for (const display of config.displays) {
    if (
      globalX >= display.originX &&
      globalX < display.originX + display.width &&
      globalY >= display.originY &&
      globalY < display.originY + display.height
    ) {
      foundDisplay = display;
      break;
    }
  }

  // Convert to display-local coordinates
  const localX = globalX - foundDisplay.originX;
  const localY = globalY - foundDisplay.originY;

  return {
    x: localX,
    y: localY,
    displayIndex: foundDisplay.index,
  };
}

/**
 * Move mouse to position
 */
export async function moveMouse(x: number, y: number, displayIndex: number = 0): Promise<string> {
  const { globalX, globalY } = await convertToGlobalCoordinates(x, y, displayIndex);

  // Windows implementation
  if (PLATFORM === 'win32') {
    await windowsMoveMouse(globalX, globalY);
    return `Moved mouse to (${x}, ${y}) on display ${displayIndex}`;
  }

  // macOS implementation
  // Use formatCliclickCoords to handle negative coordinates (displays to left/above main)
  const hasCliclick = Boolean(await resolveCliclickPath());
  if (hasCliclick) {
    const coords = formatCliclickCoords(globalX, globalY);
    await executeCliclick(`m:${coords}`);
  } else {
    await performMacMouseMoveViaQuartz(globalX, globalY, []);
  }

  return `Moved mouse to (${x}, ${y}) on display ${displayIndex}`;
}

/**
 * Wait for a specified duration
 */
export async function performWait(duration: number, reason?: string): Promise<string> {
  const startTime = Date.now();

  writeMCPLog(
    `[performWait] Waiting for ${duration}ms${reason ? `: ${reason}` : ''}`,
    'Wait Operation'
  );

  await new Promise((resolve) => setTimeout(resolve, duration));

  const actualDuration = Date.now() - startTime;
  writeMCPLog(
    `[performWait] Wait completed. Actual duration: ${actualDuration}ms`,
    'Wait Operation'
  );

  return `Waited for ${actualDuration}ms${reason ? ` (${reason})` : ''}`;
}

// ============================================================================
// Vision-based GUI Operations
// ============================================================================

/**
 * Call vision API to analyze images with timeout and retry
 */
