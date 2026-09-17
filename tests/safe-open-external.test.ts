import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeOpenExternal, validateExternalUrl } from '../src/main/utils/safe-open-external';

const mocks = vi.hoisted(() => ({ open: vi.fn(), warn: vi.fn() }));
vi.mock('electron', () => ({ shell: { openExternal: mocks.open } }));
vi.mock('../src/main/utils/logger', () => ({ logWarn: mocks.warn }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('external URL boundary', () => {
  it.each(['https://example.com/path?q=1', 'http://localhost:8080/', 'mailto:user@example.com'])(
    'opens allowed URL %s',
    async (url) => {
      expect(await safeOpenExternal(url)).toBe(true);
      expect(mocks.open).toHaveBeenCalledWith(url);
    }
  );

  it.each([
    undefined,
    null,
    {},
    42,
    '',
    'not a URL',
    '/relative',
    'file:///tmp/test',
    'javascript:void(0)',
    'data:text/plain,test',
    'custom:launch',
    'ftp://example.com',
  ])('rejects invalid or disallowed input %j without opening', async (input) => {
    expect(await safeOpenExternal(input)).toBe(false);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('removes case-insensitive and encoded mail attachment parameters while retaining subject', async () => {
    await safeOpenExternal(
      'mailto:user@example.com?attach=a&ATTACH=b&%61ttachment=c&subject=Hello'
    );
    expect(mocks.open).toHaveBeenCalledWith('mailto:user@example.com?subject=Hello');
  });

  it('keeps OAuth limited to HTTP and HTTPS without changing authorization parameters', async () => {
    expect(await safeOpenExternal('mailto:user@example.com', false)).toBe(false);
    const url =
      'https://auth.example.com/authorize?state=opaque&redirect_uri=http%3A%2F%2Flocalhost';
    expect(await safeOpenExternal(url, false)).toBe(true);
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('normalizes the URL before handing it to the OS', () => {
    expect(validateExternalUrl('HTTPS://EXAMPLE.COM')).toBe('https://example.com/');
  });

  it('contains opener rejection without logging the URL or error details', async () => {
    mocks.open.mockRejectedValue(new Error('https://example.com/?token=secret'));
    expect(await safeOpenExternal('https://example.com/?token=secret')).toBe(false);
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      '[shell.openExternal] Failed to open external URL'
    );
  });

  it('contains synchronous opener failures', async () => {
    mocks.open.mockImplementation(() => {
      throw new Error('OS failure');
    });
    expect(await safeOpenExternal('https://example.com')).toBe(false);
  });

  it('bounds opening time and handles late rejection', async () => {
    vi.useFakeTimers();
    let rejectOpening: (reason: Error) => void = () => {};
    mocks.open.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectOpening = reject;
        })
    );
    const result = safeOpenExternal('https://example.com');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe(false);
    rejectOpening(new Error('late failure'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
