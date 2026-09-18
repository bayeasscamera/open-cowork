/**
 * URL classification for window navigation.
 *
 * Decides whether a navigation target must stay inside the app window or is
 * handed to the external opener, and extracts local file paths from raw
 * file:// links or allowed-origin app URLs so they can be revealed in the OS
 * file manager instead of being loaded.
 */
import {
  localPathFromAppUrlPathname,
  localPathFromFileUrl,
} from '../../shared/local-file-path';

const LOCAL_PROTOCOLS = new Set<string>(['file:', 'devtools:']);

export class NavigationUrlPolicy {
  private readonly allowedOrigins = new Set<string>();

  constructor(devServerUrl?: string) {
    if (devServerUrl) {
      try {
        this.allowedOrigins.add(new URL(devServerUrl).origin);
      } catch {
        // Ignore an invalid dev server address.
      }
    }
  }

  /** True when the URL must not load inside the app window. */
  isExternalUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (LOCAL_PROTOCOLS.has(parsed.protocol)) {
        return false;
      }
      if (this.allowedOrigins.has(parsed.origin)) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /** Local filesystem path when the URL is a reveal target, otherwise null. */
  extractLocalPath(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'file:') {
        return localPathFromFileUrl(url);
      }
      if (!this.allowedOrigins.has(parsed.origin)) {
        return null;
      }
      return localPathFromAppUrlPathname(parsed.pathname || '');
    } catch {
      return null;
    }
  }
}