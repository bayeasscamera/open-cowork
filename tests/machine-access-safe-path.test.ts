import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSafePath, reverifySafePath } from '../src/main/machine-access/safe-path';

describe('resolveSafePath', () => {
  let workspace: string;
  const home = fs.realpathSync(os.tmpdir());

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-safe-')));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const opts = () => ({ workspaceRoot: workspace, homeDir: home, platform: 'darwin' as const });

  it('resolves inside the workspace', () => {
    const r = resolveSafePath('a/b.txt', opts());
    expect(r.ok).toBe(true);
    expect(r.realPath).toContain(workspace);
    expect(r.sensitive).toBe(false);
  });

  it('blocks .. traversal outside the workspace', () => {
    const r = resolveSafePath(path.join(workspace, '..', '..', 'etc', 'x'), opts());
    // Either blocked by grant check or flagged sensitive — never silently ok outside.
    if (r.ok) expect(r.sensitive).toBe(true);
    else expect(r.error).toBeDefined();
  });

  it('refuses an outgoing symlink', () => {
    if (process.platform === 'win32') return;
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-safe-out-')));
    try {
      fs.symlinkSync(outside, path.join(workspace, 'evil'));
      const r = resolveSafePath(path.join(workspace, 'evil', 'f.txt'), opts());
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/outside granted/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('honours a read-write grant for writes', () => {
    const ext = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-grant-')));
    try {
      const grants = [
        { id: 'g1', path: ext, access: 'read-write' as const, scope: 'session' as const, createdAt: 1 },
      ];
      // Use a non-sensitive granted dir (tmp, not /etc).
      const ok = resolveSafePath(path.join(ext, 'f.txt'), {
        ...opts(),
        grants,
        needsWrite: true,
      });
      expect(ok.ok).toBe(true);
      const readOnly = resolveSafePath(path.join(ext, 'f.txt'), {
        ...opts(),
        grants: [{ id: 'g2', path: ext, access: 'read' as const, scope: 'session' as const, createdAt: 1 }],
        needsWrite: true,
      });
      expect(readOnly.ok).toBe(false);
    } finally {
      fs.rmSync(ext, { recursive: true, force: true });
    }
  });

  it('expires grants', () => {
    const ext = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-exp-')));
    try {
      const r = resolveSafePath(path.join(ext, 'f.txt'), {
        ...opts(),
        grants: [
          { id: 'g', path: ext, access: 'read-write' as const, scope: 'session' as const, createdAt: 1, expiresAt: 2 },
        ],
        now: 10,
      });
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(ext, { recursive: true, force: true });
    }
  });

  it('flags sensitive zones without blocking (non-disablable approval)', () => {
    const r = resolveSafePath('/etc/passwd', { ...opts(), autonomy: 'allow-all' });
    expect(r.sensitive).toBe(true);
  });

  it('rejects device names, UNC and overlong paths', () => {
    expect(resolveSafePath('C:\\NUL', { ...opts(), platform: 'win32' }).ok).toBe(false);
    expect(resolveSafePath('\\\\srv\\share\\f', { ...opts(), platform: 'win32' }).ok).toBe(false);
    expect(resolveSafePath('x'.repeat(5000), opts()).ok).toBe(false);
    expect(resolveSafePath(`${'y'.repeat(300)}.txt`, opts()).ok).toBe(false);
  });

  it('reverify detects a link swapped after the check (TOCTOU)', () => {
    if (process.platform === 'win32') return;
    const targetA = path.join(workspace, 'real-a');
    const targetB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-toc-')));
    fs.mkdirSync(targetA, { recursive: true });
    const link = path.join(workspace, 'flip');
    fs.symlinkSync(targetA, link);
    const first = resolveSafePath(link, opts());
    expect(first.ok).toBe(true);
    fs.unlinkSync(link);
    fs.symlinkSync(targetB, link);
    try {
      expect(reverifySafePath(first.realPath ?? '', { ...opts(), input: link })).toBe(false);
    } finally {
      fs.rmSync(targetB, { recursive: true, force: true });
    }
  });
});
