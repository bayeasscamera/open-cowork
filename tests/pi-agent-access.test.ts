import { describe, it, expect } from 'vitest';
import { getPiAgentInternals, getPiSessionSteering } from '../src/main/agent/pi-agent-access';

describe('pi-agent-access', () => {
  it('returns null when the session exposes no usable agent', () => {
    expect(getPiAgentInternals(null)).toBeNull();
    expect(getPiAgentInternals(undefined)).toBeNull();
    expect(getPiAgentInternals({})).toBeNull();
    expect(getPiAgentInternals({ agent: 'not-an-object' })).toBeNull();
  });

  it('returns the private agent object when present', () => {
    const agent = { beforeToolCall: () => undefined, afterToolCall: undefined };
    expect(getPiAgentInternals({ agent })).toBe(agent);
  });

  it('reads the optional private steering method without throwing', () => {
    const fn = () => Promise.resolve();
    expect(getPiSessionSteering({ sendUserMessage: fn }).sendUserMessage).toBe(fn);
    expect(getPiSessionSteering({}).sendUserMessage).toBeUndefined();
  });
});
