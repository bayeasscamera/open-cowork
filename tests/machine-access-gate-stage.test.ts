/**
 * The machine-access gate stage, exercised through the SHARED pipeline
 * (`runToolGate`), because sharing it is the property that matters: the SDK
 * hook and the run_code bridge run the same code, so a dangerous action
 * cannot be reached by arriving through the path that skips the hook.
 *
 * The service is injected rather than built from Electron, so these tests
 * exercise the real decision logic on a real temporary workspace.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolDefinition, ToolContext } from '../src/main/tools/registry';
import { runToolGate, type ToolGateDeps } from '../src/main/tools/pipeline';

// The runtime reads Electron; the gate only needs the service identity.
const serviceRef = { current: null as { autonomy: string } | null };

vi.mock('../src/main/machine-access/runtime', () => ({
  peekMachineAccessService: () => serviceRef.current,
}));

import { assessMachineAccessCall } from '../src/main/agent/machine-access-gate';

const TOOL: ToolDefinition = {
  name: 'fs_trash',
  description: 'trash a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } } as never,
  risk: 'write',
  execute: async () => ({ content: 'done' }),
};

const CTX: ToolContext = { sessionId: 's1', cwd: '/tmp' };

describe('machine-access gate stage', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-gate-')));
    serviceRef.current = { autonomy: 'ask-always' };
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    serviceRef.current = null;
  });

  const call = (
    args: Record<string, unknown>,
    deps: Partial<Parameters<typeof assessMachineAccessCall>[1]> & {
      autonomy?: string;
      requestPermission?: ReturnType<typeof vi.fn>;
    } = {}
  ) => {
    const { autonomy, ...gateDeps } = deps;
    if (autonomy) serviceRef.current = { autonomy };
    return assessMachineAccessCall({ toolName: 'fs_trash', args, cwd: workspace }, {
      sessionId: 's1',
      ...gateDeps,
    });
  };

  it('does nothing when machine access is not wired (isolated mode)', async () => {
    serviceRef.current = null;
    const r = await call({ path: '/etc/passwd' });
    expect(r.blocked).toBe(false);
  });

  it('ignores tools it does not govern', async () => {
    const r = await assessMachineAccessCall(
      { toolName: 'git_status', args: {}, cwd: workspace },
      { sessionId: 's1' }
    );
    expect(r.blocked).toBe(false);
  });

  it('asks on every action under ask-always, and blocks when refused', async () => {
    const requestPermission = vi.fn().mockResolvedValue('deny');
    const r = await call({ path: path.join(workspace, 'a.txt') }, { requestPermission });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/refused/i);
  });

  it('asks again when "always approve" is offered for a dangerous action', async () => {
    // First answer is a standing approval, which must NOT cover a dangerous
    // action the user has not seen yet.
    const requestPermission = vi
      .fn()
      .mockResolvedValueOnce('allow_always')
      .mockResolvedValueOnce('deny');
    const r = await call({ path: '/etc/hosts' }, { requestPermission });
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(r.blocked).toBe(true);
  });

  it('never groups a dangerous action into an ordinary approval', async () => {
    const requestPermission = vi.fn().mockResolvedValue('deny');
    const r = await call({ path: '/etc/hosts' }, { requestPermission, autonomy: 'allow-all' });
    expect(r.blocked).toBe(true);
    const payload = requestPermission.mock.calls[0]?.[3] as {
      machineAccess?: { level: string; sensitive: boolean };
    };
    expect(payload.machineAccess?.level).toBe('dangereux');
    expect(payload.machineAccess?.sensitive).toBe(true);
  });

  it('asks for a sensitive zone even when the action itself is ordinary', async () => {
    const requestPermission = vi.fn().mockResolvedValue('allow');
    const r = await call({ path: '/etc/hosts' }, { requestPermission, autonomy: 'allow-all' });
    expect(r.blocked).toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('lets an ordinary action through under an extended autonomy level', async () => {
    const requestPermission = vi.fn().mockResolvedValue('allow');
    const r = await call(
      { path: path.join(workspace, 'a.txt') },
      { requestPermission, autonomy: 'extended-trust' }
    );
    expect(r.blocked).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('treats an untrusted origin as suspect and names the source', async () => {
    const requestPermission = vi.fn().mockResolvedValue('allow');
    await call({ path: path.join(workspace, 'a.txt') }, {
      requestPermission,
      autonomy: 'allow-all',
      origin: { kind: 'file-content', label: 'notes.txt' },
    });
    const payload = requestPermission.mock.calls[0]?.[3] as {
      machineAccess?: { level: string; origin: string };
    };
    expect(payload.machineAccess?.level).toBe('suspect');
    expect(payload.machineAccess?.origin).toContain('notes.txt');
  });

  it('fails CLOSED for a dangerous action when no prompt can be shown', async () => {
    const r = await call({ path: '/etc/hosts' }, { autonomy: 'allow-all' });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/no user prompt available/i);
  });

  it('sanitizes the description it shows the user', async () => {
    const requestPermission = vi.fn().mockResolvedValue('allow');
    await call({ path: path.join(workspace, 'a\u200b.txt') }, { requestPermission });
    const payload = requestPermission.mock.calls[0]?.[3] as { description?: string };
    expect(payload.description).not.toContain('\u200b');
  });
});

describe('machine access runs inside the shared pipeline', () => {
  const baseDeps = (): ToolGateDeps => ({
    decidePermission: () => ({ allowed: true }),
    assessMachineAccess: (input) =>
      assessMachineAccessCall(
        { toolName: input.toolName, args: input.args, cwd: input.cwd },
        { sessionId: input.sessionId }
      ),
  });

  beforeEach(() => {
    serviceRef.current = { autonomy: 'ask-always' };
  });
  afterEach(() => {
    serviceRef.current = null;
  });

  it('blocks at the machineAccess stage when refused', async () => {
    const decision = await runToolGate(
      TOOL,
      { path: '/etc/hosts' },
      CTX,
      baseDeps()
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.stage).toBe('machineAccess');
      // Fails closed rather than running unapproved.
      expect(decision.reason).toMatch(/no user prompt available/i);
    }
  });

  it('runs after the mods rewrite and before the path guard', async () => {
    const order: string[] = [];
    const deps: ToolGateDeps = {
      decidePermission: () => {
        order.push('permission');
        return { allowed: true };
      },
      assessMachineAccess: () => {
        order.push('machineAccess');
        return { blocked: false };
      },
      extractPath: () => '/tmp/x',
      checkPath: () => {
        order.push('pathGuard');
        return { allowed: true };
      },
      runModsPre: () => {
        order.push('mods');
        return { blocked: false };
      },
    };
    await runToolGate(TOOL, { path: '/tmp/x' }, CTX, deps);
    // Machine access assesses the FINAL arguments: mods run first so a mod cannot
    // launder a dangerous path past the risk check by rewriting it afterwards.
    expect(order).toEqual(['mods', 'permission', 'machineAccess', 'pathGuard']);
  });

  it('a permission refusal short-circuits before a second dialog', async () => {
    const assessMachineAccess = vi.fn();
    const decision = await runToolGate(TOOL, { path: '/etc/hosts' }, CTX, {
      decidePermission: () => ({ allowed: false, reason: 'denied by rule' }),
      assessMachineAccess,
    });
    expect(decision.allowed).toBe(false);
    expect(assessMachineAccess).not.toHaveBeenCalled();
  });

  it('is skipped when not supplied, preserving previous behaviour', async () => {
    const decision = await runToolGate(TOOL, { path: '/etc/hosts' }, CTX, {
      decidePermission: () => ({ allowed: true }),
    });
    expect(decision.allowed).toBe(true);
  });
});