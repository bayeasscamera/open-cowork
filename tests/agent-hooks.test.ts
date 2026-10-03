/**
 * Tests for the tool-call hooks extracted from CoworkAgentRunner: the
 * permission gate and the local mods pre/post hooks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPiAgentInternals: vi.fn(),
  runPreToolUse: vi.fn(),
  runPostToolUse: vi.fn(),
  recordSkillUseIfApplicable: vi.fn(),
  decidePermissionWithDetail: vi.fn(),
  describeDenyRefusal: vi.fn(
    (toolName: string, rule: { tool: string; pattern?: string }) =>
      `Tool '${toolName}' is blocked by your deny rule (tool '${rule.tool}'${rule.pattern ? ` matching '${rule.pattern}'` : ''}).`
  ),
  rememberAlwaysAllow: vi.fn(),
}));

vi.mock('../src/main/agent/pi-agent-access', () => ({
  getPiAgentInternals: mocks.getPiAgentInternals,
}));
vi.mock('../src/main/mods/mods-runtime', () => ({
  getModsRegistry: () => ({
    runPreToolUse: mocks.runPreToolUse,
    runPostToolUse: mocks.runPostToolUse,
  }),
}));
vi.mock('../src/main/mods/skill-doctor', () => ({
  recordSkillUseIfApplicable: mocks.recordSkillUseIfApplicable,
}));
vi.mock('../src/main/config/permission-rules-store', () => ({
  decidePermissionWithDetail: mocks.decidePermissionWithDetail,
  describeDenyRefusal: mocks.describeDenyRefusal,
  rememberAlwaysAllow: mocks.rememberAlwaysAllow,
}));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { log, logWarn, logError } from '../src/main/utils/logger';
import { installPermissionHook, installModsHooks } from '../src/main/agent/agent-hooks';
import { ModsRuntime, setModsRuntimeForTest } from '../src/main/mods/v2/runtime';

type Hook = (ctx: unknown, signal?: AbortSignal) => Promise<unknown>;

let beforeHook: Hook | undefined;
let afterHook: Hook | undefined;
let agent: {
  _beforeToolCall?: Hook;
  setBeforeToolCall: ReturnType<typeof vi.fn>;
  setAfterToolCall: ReturnType<typeof vi.fn>;
};

const makeAgent = (originalBefore?: Hook) => {
  const created = {
    _beforeToolCall: originalBefore,
    setBeforeToolCall: vi.fn((fn: Hook) => {
      beforeHook = fn;
    }),
    setAfterToolCall: vi.fn((fn: Hook) => {
      afterHook = fn;
    }),
  };
  agent = created;
  return created;
};

const ctx = { toolCall: { id: 'tool-1', name: 'Read' }, args: { path: '/tmp/x' } };

const permissionOptions = (requestPermission?: ReturnType<typeof vi.fn>) => ({
  piSession: {} as never,
  sessionId: 'session-1',
  requestPermission,
  getToolDisplayName: (name: string) => `nice-${name}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  beforeHook = undefined;
  afterHook = undefined;
  makeAgent();
  mocks.getPiAgentInternals.mockReturnValue(agent);
  mocks.decidePermissionWithDetail.mockReturnValue({
    decision: 'allow',
    matchedDenyRule: null,
    overriddenBypass: null,
  });
  mocks.runPreToolUse.mockReturnValue({ block: false });
  mocks.runPostToolUse.mockImplementation(
    (_call: unknown, result: { content: string }) => result.content
  );
});

describe('installPermissionHook', () => {
  it('skips installation when no permission callback is provided', () => {
    installPermissionHook(permissionOptions(undefined));

    expect(log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] No requestPermission callback — skipping permission hook'
    );
    expect(mocks.getPiAgentInternals).not.toHaveBeenCalled();
  });

  it('warns and skips when the agent internals are unavailable', () => {
    mocks.getPiAgentInternals.mockReturnValue(null);

    installPermissionHook(permissionOptions(vi.fn()));

    expect(logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Cannot access agent.setBeforeToolCall — skipping permission hook'
    );
  });

  it('blocks a denied tool without consulting the SDK hook', async () => {
    const sdkHook = vi.fn(async () => 'sdk');
    mocks.getPiAgentInternals.mockReturnValue(makeAgent(sdkHook));
    mocks.decidePermissionWithDetail.mockReturnValue({
      decision: 'deny',
      matchedDenyRule: { tool: 'read', action: 'deny' },
      overriddenBypass: null,
    });

    installPermissionHook(permissionOptions(vi.fn()));
    const result = await beforeHook?.(ctx);

    expect(result).toEqual({
      block: true,
      reason: "Tool 'nice-Read' is blocked by your deny rule (tool 'read').",
    });
    expect(sdkHook).not.toHaveBeenCalled();
  });

  it('hands the agent the deny rule explanation so it can adapt', async () => {
    mocks.getPiAgentInternals.mockReturnValue(makeAgent(vi.fn()));
    mocks.decidePermissionWithDetail.mockReturnValue({
      decision: 'deny',
      matchedDenyRule: { tool: 'bash', pattern: '*.env*', action: 'deny' },
      overriddenBypass: 'autoApprove',
    });

    installPermissionHook(permissionOptions(vi.fn()));
    const result = await beforeHook?.(ctx);

    expect(mocks.describeDenyRefusal).toHaveBeenCalledWith('nice-Read', {
      tool: 'bash',
      pattern: '*.env*',
      action: 'deny',
    });
    expect(result).toEqual({
      block: true,
      reason: "Tool 'nice-Read' is blocked by your deny rule (tool 'bash' matching '*.env*').",
    });
  });

  it('delegates to the SDK hook when the decision allows the call', async () => {
    const sdkHook = vi.fn(async () => 'sdk-result');
    mocks.getPiAgentInternals.mockReturnValue(makeAgent(sdkHook));

    installPermissionHook(permissionOptions(vi.fn()));
    const result = await beforeHook?.(ctx);

    expect(result).toBe('sdk-result');
    expect(sdkHook).toHaveBeenCalledWith(ctx, undefined);
  });

  it('asks the renderer and proceeds when the user allows', async () => {
    const requestPermission = vi.fn(async () => 'allow' as const);
    installPermissionHook(permissionOptions(requestPermission));
    mocks.decidePermissionWithDetail.mockReturnValue({
      decision: 'ask',
      matchedDenyRule: null,
      overriddenBypass: null,
    });

    const result = await beforeHook?.(ctx);

    expect(requestPermission).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('tool-1-perm-'),
      'nice-Read',
      { path: '/tmp/x' }
    );
    expect(result).toBeUndefined();
  });

  it('blocks when the user denies', async () => {
    mocks.decidePermissionWithDetail.mockReturnValue({
      decision: 'ask',
      matchedDenyRule: null,
      overriddenBypass: null,
    });
    installPermissionHook(permissionOptions(vi.fn(async () => 'deny' as const)));

    const result = await beforeHook?.(ctx);

    expect(result).toEqual({ block: true, reason: "User denied permission for 'nice-Read'." });
  });

  it('remembers always-allow decisions with the canonical tool name', async () => {
    mocks.decidePermissionWithDetail.mockReturnValue({
      decision: 'ask',
      matchedDenyRule: null,
      overriddenBypass: null,
    });
    installPermissionHook(permissionOptions(vi.fn(async () => 'allow_always' as const)));

    await beforeHook?.(ctx);

    expect(mocks.rememberAlwaysAllow).toHaveBeenCalledWith('session-1', 'Read');
  });

  it('fails closed when the permission request throws', async () => {
    mocks.decidePermissionWithDetail.mockReturnValue({
      decision: 'ask',
      matchedDenyRule: null,
      overriddenBypass: null,
    });
    installPermissionHook(
      permissionOptions(
        vi.fn(async () => {
          throw new Error('ipc down');
        })
      )
    );

    const result = await beforeHook?.(ctx);

    expect(result).toEqual({
      block: true,
      reason: "Permission request failed for 'nice-Read'; tool not executed.",
    });
    expect(logError).toHaveBeenCalled();
  });
});

describe('installModsHooks', () => {
  it('warns and skips when the agent cannot take an after-tool hook', () => {
    mocks.getPiAgentInternals.mockReturnValue({ setBeforeToolCall: vi.fn() });

    installModsHooks({} as never, 'session-1');

    expect(logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Cannot access agent.setAfterToolCall — mods post-hook skipped'
    );
  });

  it('does NOT run mod pre-hooks here — the shared gate owns them', async () => {
    // This slot used to run `onPreToolUse` and then delegate to the permission
    // hook, which ran it AGAIN through the gate. Every SDK-dispatched tool call
    // therefore executed mod pre-hooks twice. Refusal now happens in exactly one
    // place (runToolGate -> runModsPre), on both the hook path and run_code.
    mocks.runPreToolUse.mockReturnValue({ block: true, reason: 'secrets' });

    installModsHooks({} as never, 'session-1');
    const result = await beforeHook?.(ctx);

    expect(mocks.runPreToolUse).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('records skill use and chains to the previous pre-hook', async () => {
    const originalBefore = vi.fn(async () => 'original');
    mocks.getPiAgentInternals.mockReturnValue(makeAgent(originalBefore));

    installModsHooks({} as never, 'session-1');
    const result = await beforeHook?.(ctx);

    expect(mocks.recordSkillUseIfApplicable).toHaveBeenCalledWith('Read', { path: '/tmp/x' });
    expect(result).toBe('original');
  });

  it('rewrites the tool result text in the post-hook', async () => {
    // Post-hooks have no gate stage — the result does not exist when the gate
    // runs — so they stay on the SDK's after-tool-call slot, now served by the
    // v2 runtime instead of the v1 registry.
    const runtime = new ModsRuntime({ tools: { invoke: async () => ({ content: '' }) } });
    setModsRuntimeForTest(runtime);

    installModsHooks({} as never, 'session-1');
    const result = await afterHook?.({
      toolCall: { id: 'tool-1', name: 'Read' },
      args: { path: '/tmp/x' },
      result: { content: [{ type: 'text', text: `${'ghp_'}${'A'.repeat(36)}` }] },
    });

    // The built-in security-redactor is live in the runtime, so a real secret is
    // masked by the REAL implementation rather than by a mocked return value.
    // The token is assembled from parts: a well-formed literal in a test file is
    // indistinguishable from a leak, and GitHub push protection blocks on that.
    const fakeToken = `${'ghp_'}${'A'.repeat(36)}`;
    expect(result).toBeDefined();
    const rewritten = JSON.stringify(result);
    expect(rewritten).not.toContain(fakeToken);
    expect(rewritten).toMatch(/REDACTED/);
    setModsRuntimeForTest(null);
  });

  it('leaves the tool result untouched when no mod rewrites it', async () => {
    setModsRuntimeForTest(null);
    installModsHooks({} as never, 'session-1');
    const result = await afterHook?.({
      toolCall: { id: 'tool-1', name: 'Read' },
      args: {},
      result: { content: [{ type: 'text', text: 'same' }] },
    });

    expect(result).toBeUndefined();
  });
});
