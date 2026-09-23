/**
 * beforeSessionRun aggregation of the creation-time session context signature.
 *
 * The runner relies on the manager propagating (and not silently dropping) the
 * signature an extension contributes, so a missed wiring fails here rather than
 * as a mysterious per-turn cold start.
 */

import { describe, expect, it } from 'vitest';
import { AgentRuntimeExtensionManager } from '../src/main/extensions/agent-runtime-extension-manager';
import type { BeforeSessionRunContext } from '../src/main/extensions/agent-runtime-extension';

const context = {
  session: { id: 'sess-1' },
  prompt: 'hello',
  existingMessages: [],
  isColdStart: true,
} as unknown as BeforeSessionRunContext;

describe('AgentRuntimeExtensionManager.beforeSessionRun — session context signature', () => {
  it('defaults to undefined and keeps refreshSession false when no extension contributes', async () => {
    const manager = new AgentRuntimeExtensionManager([{ name: 'empty' }]);

    const result = await manager.beforeSessionRun(context);

    expect(result.sessionContextSignature).toBeUndefined();
    expect(result.refreshSession).toBe(false);
  });

  it('propagates a signature contributed by an extension', async () => {
    const manager = new AgentRuntimeExtensionManager([
      { name: 'signature', beforeSessionRun: async () => ({ sessionContextSignature: 'abc' }) },
    ]);

    expect((await manager.beforeSessionRun(context)).sessionContextSignature).toBe('abc');
  });

  it('keeps the last non-undefined signature when several extensions contribute', async () => {
    const manager = new AgentRuntimeExtensionManager([
      { name: 'first', beforeSessionRun: async () => ({ sessionContextSignature: 'first' }) },
      { name: 'second', beforeSessionRun: async () => ({ sessionContextSignature: 'second' }) },
      { name: 'silent', beforeSessionRun: async () => ({}) },
    ]);

    expect((await manager.beforeSessionRun(context)).sessionContextSignature).toBe('second');
  });

  it('does not let a later extension that omits the signature erase an earlier one', async () => {
    const manager = new AgentRuntimeExtensionManager([
      { name: 'first', beforeSessionRun: async () => ({ sessionContextSignature: 'first' }) },
      { name: 'silent', beforeSessionRun: async () => ({ systemContext: 'block' }) },
    ]);

    const result = await manager.beforeSessionRun(context);

    expect(result.sessionContextSignature).toBe('first');
    expect(result.systemContext).toBe('block');
  });
});
