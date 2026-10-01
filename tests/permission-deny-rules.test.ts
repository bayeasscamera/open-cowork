/**
 * Chantier 5 — explicit refusal (/deny) rules.
 *
 * Proofs:
 *  1. A deny rule blocks even under Full Access (auto-approve) and even when
 *     the session granted "always allow" — the guardrail is persistent.
 *  2. The refusal carries the rule's explanation: the agent is told what was
 *     refused and instructed to adapt, not to stall or retry silently.
 *  3. Non-deny behavior is unchanged (allow/ask/defaults).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  setPermissionRules,
  setAutoApproveAll,
  decidePermission,
  decidePermissionWithDetail,
  describeDenyRefusal,
  rememberAlwaysAllow,
  forgetSessionPermissions,
} from '../src/main/config/permission-rules-store';

beforeEach(() => {
  setAutoApproveAll(false);
  forgetSessionPermissions('s1');
  setPermissionRules([
    { tool: 'read', action: 'allow' },
    { tool: 'bash', action: 'ask' },
  ]);
});

describe('deny beats convenience bypasses', () => {
  it('blocks a .env-touching command even in Full Access mode', () => {
    setPermissionRules([
      { tool: 'bash', pattern: '*.env*', action: 'deny' },
      { tool: 'bash', action: 'ask' },
    ]);
    setAutoApproveAll(true);
    const detail = decidePermissionWithDetail('s1', 'bash', { command: 'cat .env' });
    expect(detail.decision).toBe('deny');
    expect(detail.matchedDenyRule).toMatchObject({ tool: 'bash', pattern: '*.env*' });
    expect(detail.overriddenBypass).toBe('autoApprove');
    expect(decidePermission('s1', 'bash', { command: 'cat .env' })).toBe('deny');
  });

  it('blocks even when the session granted always-allow', () => {
    setPermissionRules([{ tool: 'bash', pattern: '*rm -rf*', action: 'deny' }]);
    rememberAlwaysAllow('s1', 'bash');
    const detail = decidePermissionWithDetail('s1', 'bash', { command: 'rm -rf /tmp/x' });
    expect(detail.decision).toBe('deny');
    expect(detail.overriddenBypass).toBe('sessionAllow');
  });

  it('does not block inputs outside the pattern', () => {
    setPermissionRules([{ tool: 'bash', pattern: '*.env*', action: 'deny' }]);
    setAutoApproveAll(true);
    // Outside the deny pattern, Full Access still allows.
    expect(decidePermission('s1', 'bash', { command: 'ls -la' })).toBe('allow');
  });

  it('a pattern-less deny rule blocks every input for that tool', () => {
    setPermissionRules([{ tool: 'write', action: 'deny' }]);
    setAutoApproveAll(true);
    expect(decidePermission('s1', 'write', { path: 'notes.txt' })).toBe('deny');
  });
});

describe('refusal explanation for the agent', () => {
  it('names the rule and tells the agent to adapt, not stall', () => {
    const text = describeDenyRefusal('bash', { tool: 'bash', pattern: '*.env*', action: 'deny' });
    expect(text).toContain('bash');
    expect(text).toContain('*.env*');
    expect(text).toContain('deny rule');
    expect(text).toMatch(/adapt/i);
    expect(text).toMatch(/do not retry|not.*retry/i);
    expect(text).toMatch(/silently/i);
  });
});

describe('non-deny behavior unchanged', () => {
  it('Full Access still allows tools with no deny rule', () => {
    setAutoApproveAll(true);
    expect(decidePermission('s1', 'read', { path: 'a.txt' })).toBe('allow');
  });

  it('unknown tools still ask by default', () => {
    expect(decidePermission('s1', 'mystery-tool', {})).toBe('ask');
  });

  it('ask rules still ask', () => {
    expect(decidePermission('s1', 'bash', { command: 'ls' })).toBe('ask');
  });

  it('detail reports no rule and no override on the allow path', () => {
    setAutoApproveAll(true);
    const detail = decidePermissionWithDetail('s1', 'read', {});
    expect(detail).toEqual({ decision: 'allow', matchedDenyRule: null, overriddenBypass: null });
  });
});
