import { describe, expect, it, vi } from 'vitest';
import {
  AllowedApps,
  EmergencyStop,
  GuiRateLimiter,
  macPermissionStates,
  planGuiBatch,
  wouldTypePassword,
} from '../src/main/machine-access/machine-control';

vi.mock('../src/main/machine-access/command-runner', () => ({
  killGroup: vi.fn(() => undefined),
}));

describe('machine control', () => {
  it('starts with no allowed applications', () => {
    const apps = new AllowedApps();
    expect(apps.size).toBe(0);
    expect(apps.isAllowed('Safari')).toBe(false);
    apps.addByUser('Safari');
    expect(apps.isAllowed('safari')).toBe(true);
    expect(apps.remove('Safari')).toBe(true);
    expect(apps.size).toBe(0);
  });

  it('refuses GUI batches for unallowed apps and rate limits the allowed one', () => {
    const apps = new AllowedApps(['Safari']);
    const limiter = new GuiRateLimiter(3);
    const batch = { app: 'Safari', actions: [{ kind: 'click' as const, x: 1, y: 2 }] };
    expect(planGuiBatch(batch, apps, limiter).ok).toBe(true);
    const denied = planGuiBatch({ app: 'Terminal', actions: batch.actions }, apps, limiter);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/not in the allowed list/);
    // Rate cap: 3 actions allowed, then refused.
    expect(planGuiBatch({ app: 'Safari', actions: batch.actions }, apps, limiter).ok).toBe(true);
    expect(planGuiBatch({ app: 'Safari', actions: batch.actions }, apps, limiter).ok).toBe(true);
    const capped = planGuiBatch({ app: 'Safari', actions: batch.actions }, apps, limiter);
    expect(capped.ok).toBe(false);
    expect(capped.reason).toMatch(/rate limit/);
  });

  it('never types password-like input', () => {
    const secret = { app: 'Safari', actions: [{ kind: 'type' as const, text: 'my-password-1234' }] };
    expect(wouldTypePassword(secret)).toBe(true);
    const apps = new AllowedApps(['Safari']);
    const plan = planGuiBatch(secret, apps, new GuiRateLimiter());
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/user must type/i);
  });

  it('describes the batch without leaking the secret', () => {
    const apps = new AllowedApps(['Safari']);
    const plan = planGuiBatch(
      { app: 'Safari', actions: [{ kind: 'type', text: 'password-abcdefgh' }] },
      apps,
      new GuiRateLimiter()
    );
    expect(plan.description).not.toContain('abcdefgh');
  });

  it('emergency stop aborts controllers and kills processes without the agent loop', () => {
    const stop = new EmergencyStop();
    const c1 = new AbortController();
    const c2 = new AbortController();
    stop.register(c1);
    stop.register(c2);
    stop.registerProcess(4242);
    stop.registerProcess(undefined);
    const result = stop.stop();
    expect(result).toEqual({ controllers: 2, processes: 1 });
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(stop.isActive).toBe(true);
    expect(stop.machineBusy(true, 0)).toBe(true);
    stop.resume();
    expect(stop.isActive).toBe(false);
    expect(stop.machineBusy(false, 0)).toBe(false);
  });

  it('permission states are reported, not bypassed', () => {
    const states = process.platform === 'darwin' ? macPermissionStates() : [];
    for (const state of states) {
      expect(state.explanation.length).toBeGreaterThan(10);
      expect(state.settingsUrl).toBeTruthy();
    }
  });
});