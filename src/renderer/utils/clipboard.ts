/**
 * Best-effort clipboard copy that never throws.
 *
 * Why the fallback exists: `navigator.clipboard.writeText()` rejects when the
 * window lost focus, the permission was denied, or the app runs over `file://`
 * with `sandbox: true` — all common in this Electron renderer. Without a
 * fallback the copy is silently lost while the UI already shows "Copied".
 *
 * Strategy: async Clipboard API first, then the legacy `execCommand('copy')`
 * via a hidden textarea (synchronous, works under `file://`). Returns true on
 * success, false otherwise — callers must only show success when it is true.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    if (typeof document === 'undefined') return false;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    // execCommand returns false when the command is unsupported/disabled.
    const succeeded = document.execCommand('copy');
    document.body.removeChild(textarea);
    return succeeded;
  } catch {
    return false;
  }
}
