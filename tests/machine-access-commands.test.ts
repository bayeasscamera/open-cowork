import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assessCommand,
  classifyLevel,
  runCommand,
  scrubEnv,
  DEFAULT_COMMAND_LIMITS,
} from '../src/main/machine-access/command-runner';
import { GrantStore } from '../src/main/machine-access/grant-store';

describe('command runner', () => {
  let workspace: string;
  let grants: GrantStore;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-cmd-')));
    grants = new GrantStore(null);
    grants.addGrant({ path: workspace, access: 'read-write', scope: 'session' }, 'user');
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const base = () => ({
    workspaceRoot: workspace,
    grants: grants.list(),
    autonomy: 'ask-always' as const,
  });

  it('classifies levels', () => {
    expect(classifyLevel('ls -la')).toBe('lecture');
    expect(classifyLevel('rm -r x')).toBe('ecriture');
    expect(classifyLevel('npm run dev')).toBe('execution');
    expect(classifyLevel('curl http://x')).toBe('reseau');
    expect(classifyLevel('mkfs /dev/sda')).toBe('dangereux');
  });

  it('requires approval for every level under ask-always, and for dangerous even under allow-all', () => {
    expect(assessCommand({ ...base(), command: 'ls' }, { kind: 'user-message' }).approvalRequired).toBe(true);
    const allowAll = assessCommand(
      { ...base(), autonomy: 'allow-all', command: 'sudo rm -rf /' },
      { kind: 'user-message' }
    );
    expect(allowAll.level).toBe('dangereux');
    expect(allowAll.approvalRequired).toBe(true);
    expect(allowAll.why).toMatch(/sudo|deletion/i);
  });

  it('free reads need no approval under read-free, writes still do', () => {
    const read = assessCommand(
      { ...base(), autonomy: 'read-free', command: 'ls -la' },
      { kind: 'user-message' }
    );
    expect(read.approvalRequired).toBe(false);
    const write = assessCommand(
      { ...base(), autonomy: 'read-free', command: 'rm x' },
      { kind: 'user-message' }
    );
    expect(write.approvalRequired).toBe(true);
  });

  it('flags commands coming from untrusted content', () => {
    const fromFile = assessCommand(
      { ...base(), autonomy: 'allow-all', command: 'rm -rf build' },
      { kind: 'file-content', label: 'notes.txt' }
    );
    expect(fromFile.level).toBe('suspect');
    expect(fromFile.approvalRequiredDetails?.origin).toContain('notes.txt');
  });

  it('refuses a cwd outside granted folders', () => {
    const outcome = assessCommand(
      { ...base(), command: 'ls', cwd: '/etc' },
      { kind: 'user-message' }
    );
    expect(outcome.approvalRequired).toBe(true);
  });

  it('scrubs secrets from the environment', () => {
    process.env['COWORK_FAKE_KEY'] = 'super-secret';
    const env = scrubEnv();
    expect(env['COWORK_FAKE_KEY']).toBeUndefined();
    expect(Object.keys(env).every((k) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(k))).toBe(true);
    expect(env['PATH']).toBeTruthy();
    delete process.env['COWORK_FAKE_KEY'];
  });

  it('runs an ordinary command and caps output', async () => {
    const outcome = assessCommand({ ...base(), command: 'echo ok' }, { kind: 'user-message' });
    const res = await runCommand({ ...base(), command: 'echo ok' }, { kind: 'user-message' }, outcome);
    expect(res.stdout).toContain('ok');
    expect(res.exitCode).toBe(0);

    const big = 'yes x | head -c 200000';
    const bigOutcome = assessCommand({ ...base(), command: big }, { kind: 'user-message' });
    const capped = await runCommand(
      { ...base(), command: big, limits: { maxOutputBytes: 2048 } },
      { kind: 'user-message' },
      bigOutcome
    );
    expect(capped.truncated).toBe(true);
    expect(capped.stdout.length).toBeLessThanOrEqual(2048 + 200);
  });

  it('kills the process group on timeout', async () => {
    const command = 'sleep 5';
    const outcome = assessCommand({ ...base(), command }, { kind: 'user-message' });
    const res = await runCommand(
      { ...base(), command, limits: { timeoutMs: 300 } },
      { kind: 'user-message' },
      outcome
    );
    expect(res.timedOut).toBe(true);
    expect(res.durationMs).toBeLessThan(3000);
  });

  it('exposes tunable limits with sane defaults', () => {
    expect(DEFAULT_COMMAND_LIMITS.timeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_COMMAND_LIMITS.maxOutputBytes).toBeGreaterThan(0);
  });
});