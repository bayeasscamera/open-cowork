import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GrantStore, requestAccess } from '../src/main/machine-access/grant-store';

describe('GrantStore', () => {
  it('only the user can create a grant; the agent can only request', () => {
    const store = new GrantStore(null);
    expect(() => store.addGrant({ path: '/tmp', access: 'read', scope: 'session' }, 'agent')).toThrow(
      /only be created by the user/i
    );
    const req = requestAccess('/tmp/factures', 'need invoices');
    expect(req.wantedPath).toBe('/tmp/factures');
    expect(store.list()).toHaveLength(0);
    const grant = store.addGrant({ path: '/tmp', access: 'read', scope: 'session' }, 'user');
    expect(store.list()).toHaveLength(1);
    expect(grant.path).toBeTruthy();
  });

  it('grants cover sub-folders, honour write level and expiry, revoke immediately', () => {
    const store = new GrantStore(null);
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-grant-')));
    try {
      store.addGrant({ path: dir, access: 'read', scope: 'project' }, 'user', 1000);
      expect(store.covers(path.join(dir, 'sub', 'f.txt'), false, 'darwin', 1001)).toBe(true);
      expect(store.covers(path.join(dir, 'f.txt'), true, 'darwin', 1001)).toBe(false);
      const id = store.list(1001)[0]?.id ?? '';
      expect(store.revokeGrant(id)).toBe(true);
      expect(store.covers(path.join(dir, 'f.txt'), false, 'darwin', 1001)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expired grants stop covering', () => {
    const store = new GrantStore(null);
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-grant-exp-')));
    try {
      store.addGrant({ path: dir, access: 'read-write', scope: 'session', expiresAt: 2000 }, 'user', 1000);
      expect(store.covers(path.join(dir, 'f'), false, 'darwin', 1500)).toBe(true);
      expect(store.covers(path.join(dir, 'f'), false, 'darwin', 2500)).toBe(false);
      expect(store.list(2500)).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('autonomy defaults to ask-always and validates levels', () => {
    const store = new GrantStore(null);
    expect(store.getAutonomy('p1')).toBe('ask-always');
    store.setAutonomy('p1', 'allow-all');
    expect(store.getAutonomy('p1')).toBe('allow-all');
    expect(() => store.setAutonomy('p1', 'god-mode' as never)).toThrow(/unknown autonomy/i);
  });
});
