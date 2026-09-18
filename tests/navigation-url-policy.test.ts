import { describe, expect, it } from 'vitest';
import { NavigationUrlPolicy } from '../src/main/utils/navigation-url-policy';

describe('NavigationUrlPolicy', () => {
  describe('isExternalUrl', () => {
    it('classifies http and https URLs outside the app as external', () => {
      const policy = new NavigationUrlPolicy();
      expect(policy.isExternalUrl('https://example.com/page')).toBe(true);
      expect(policy.isExternalUrl('http://localhost:9999/')).toBe(true);
    });

    it('treats file: and devtools: targets as in-window navigation', () => {
      const policy = new NavigationUrlPolicy();
      expect(policy.isExternalUrl('file:///tmp/report.md')).toBe(false);
      expect(policy.isExternalUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
    });

    it('treats unparseable URLs as external so they fail closed', () => {
      const policy = new NavigationUrlPolicy();
      expect(policy.isExternalUrl('not a url')).toBe(true);
      expect(policy.isExternalUrl('')).toBe(true);
    });

    it('keeps the dev server origin inside the window when configured', () => {
      const policy = new NavigationUrlPolicy('http://localhost:5173/');
      expect(policy.isExternalUrl('http://localhost:5173/src/main.tsx')).toBe(false);
      expect(policy.isExternalUrl('http://localhost:3000/')).toBe(true);
    });

    it('ignores an invalid dev server address instead of throwing', () => {
      const policy = new NavigationUrlPolicy('not a url');
      expect(policy.isExternalUrl('https://example.com/')).toBe(true);
    });
  });

  describe('extractLocalPath', () => {
    it('extracts local paths from raw file:// links', () => {
      const policy = new NavigationUrlPolicy();
      expect(policy.extractLocalPath('file:///tmp/report.md')).toBe('/tmp/report.md');
    });

    it('extracts paths from allowed-origin app URLs only', () => {
      const policy = new NavigationUrlPolicy('http://localhost:5173/');
      expect(policy.extractLocalPath('http://localhost:5173/Users/baye/notes.md')).toBe(
        '/Users/baye/notes.md'
      );
      expect(policy.extractLocalPath('http://localhost:3000/Users/baye/notes.md')).toBeNull();
    });

    it('returns null for external, empty, or invalid URLs', () => {
      const policy = new NavigationUrlPolicy();
      expect(policy.extractLocalPath('https://example.com/file.md')).toBeNull();
      expect(policy.extractLocalPath('not a url')).toBeNull();
      expect(policy.extractLocalPath('')).toBeNull();
    });
  });
});