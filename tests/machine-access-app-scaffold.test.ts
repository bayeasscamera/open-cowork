import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectDeclaredPort,
  findFreePort,
  isPortFree,
  scaffoldApp,
  suspiciousPackage,
  validateAppName,
} from '../src/main/machine-access/app-scaffold';
import { GrantStore } from '../src/main/machine-access/grant-store';

describe('app scaffolding', () => {
  let granted: string;
  let grants: GrantStore;

  beforeEach(() => {
    granted = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-app-')));
    grants = new GrantStore(null);
    grants.addGrant({ path: granted, access: 'read-write', scope: 'session' }, 'user');
  });
  afterEach(() => {
    fs.rmSync(granted, { recursive: true, force: true });
  });

  const io = {
    writeFile: (p: string, c: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c);
    },
    mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
  };

  it('creates a project inside the granted folder only', () => {
    const res = scaffoldApp(
      { kind: 'node-http', name: 'my-app', grantedRoot: granted, grants: grants.list(), autonomy: 'allow-all' },
      io.writeFile,
      io.mkdir
    );
    expect(res.ok).toBe(true);
    expect(res.projectDir?.startsWith(granted)).toBe(true);
    expect(fs.existsSync(path.join(res.projectDir ?? '', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(res.projectDir ?? '', 'server.js'))).toBe(true);
  });

  it('refuses to escape the granted folder with a crafted name', () => {
    const res = scaffoldApp(
      { kind: 'node-http', name: '../../escape', grantedRoot: granted, grants: grants.list(), autonomy: 'allow-all' },
      io.writeFile,
      io.mkdir
    );
    expect(res.ok).toBe(false);
    // Rejected either by name validation or by path confinement.
    expect(res.error).toMatch(/invalid|refused/i);
    expect(fs.existsSync(path.join(path.dirname(granted), 'escape'))).toBe(false);
  });

  it('validates names per platform', () => {
    expect(() => validateAppName('')).toThrow();
    expect(() => validateAppName('a/b')).toThrow();
    expect(() => validateAppName('CON', 'win32')).toThrow();
    expect(validateAppName('my-app')).toBe('my-app');
  });

  it('detects declared ports and finds a free one', async () => {
    expect(detectDeclaredPort(['PORT: 8080'])).toBe(8080);
    expect(detectDeclaredPort(['nothing here'])).toBeUndefined();
    const port = await findFreePort(45000);
    expect(await isPortFree(port)).toBe(true);
  });

  it('flags typo-suspicious package names without blocking known ones', () => {
    expect(suspiciousPackage('expres')).toMatch(/typo/);
    expect(suspiciousPackage('express')).toBeNull();
    expect(suspiciousPackage('!@#$')).toMatch(/unusual/);
  });
});