import { shell } from 'electron';
import { logWarn } from './logger';

export function validateExternalUrl(input: unknown, allowMailto = true): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  try {
    const url = new URL(input);
    if (url.protocol === 'mailto:' && allowMailto) {
      // Attachment parameters must be removed at the main-process trust boundary.
      for (const key of [...url.searchParams.keys()]) {
        if (['attach', 'attachment'].includes(key.toLowerCase())) url.searchParams.delete(key);
      }
    } else if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export async function safeOpenExternal(input: unknown, allowMailto = true): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = validateExternalUrl(input, allowMailto);
    if (!url) return false;
    await Promise.race([
      shell.openExternal(url),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('External URL opening timed out')), 5000);
      }),
    ]);
    return true;
  } catch {
    // Provider errors can contain authorization URLs and must not be logged verbatim.
    logWarn('[shell.openExternal] Failed to open external URL');
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
