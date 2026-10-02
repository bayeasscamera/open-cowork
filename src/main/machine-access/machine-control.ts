/**
 * @module main/machine-access/machine-control
 *
 * Visible, bounded machine control (spec 8):
 * - system permission state (macOS Accessibility / Screen Recording /
 *   Automation, Windows equivalents) reported, never bypassed;
 * - a permanent "Cowork is controlling the machine" indicator;
 * - an emergency stop that works independently of the agent loop;
 * - GUI actions batched and confirmed, rate-limited, never filling passwords.
 */

import { killGroup } from './command-runner';

export type SystemPermission = 'accessibility' | 'screen-recording' | 'automation';

export interface PermissionState {
  permission: SystemPermission;
  granted: boolean;
  /** Where the user grants it. */
  settingsUrl?: string;
  explanation: string;
}

export function macPermissionStates(): PermissionState[] {
  if (process.platform !== 'darwin') return [];
  return [
    {
      permission: 'accessibility',
      granted: false,
      settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      explanation:
        'Accessibility lets Cowork click and type on your behalf. Requested, never circumvented.',
    },
    {
      permission: 'screen-recording',
      granted: false,
      settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      explanation: 'Screen recording is required to see the screen when you ask for a screenshot.',
    },
    {
      permission: 'automation',
      granted: false,
      settingsUrl: 'x-apple.preferences:com.apple.preference.security?Privacy_Automation',
      explanation: 'Automation lets Cowork drive other applications (AppleScript).',
    },
  ];
}

/** Only applications the user explicitly allowed may be opened or driven. */
export class AllowedApps {
  private allowed = new Set<string>();
  constructor(initial: string[] = []) {
    for (const name of initial) this.allowed.add(name.toLowerCase());
  }
  /** User-only, like grants: there is no agent-facing "allow" entry point. */
  addByUser(name: string): void {
    this.allowed.add(name.trim().toLowerCase());
  }
  remove(name: string): boolean {
    return this.allowed.delete(name.trim().toLowerCase());
  }
  isAllowed(name: string): boolean {
    return this.allowed.has(name.trim().toLowerCase());
  }
  list(): string[] {
    return [...this.allowed].sort();
  }
  get size(): number {
    return this.allowed.size;
  }
}

export type GuiAction =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string; modifiers?: string[] }
  | { kind: 'screenshot' };

export interface GuiBatch {
  app: string;
  actions: GuiAction[];
}

/** A password field is never typed into: the user does it themselves. */
export function wouldTypePassword(batch: GuiBatch): boolean {
  return batch.actions.some((a) => a.kind === 'type' && looksLikeSecret(a.text));
}

function looksLikeSecret(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  return /password|passwd|secret|token|api[-_ ]?key|-----BEGIN/i.test(t) || /^[A-Za-z0-9+/]{24,}={0,2}$/.test(t);
}

export interface GuiPlan {
  ok: boolean;
  reason?: string;
  description: string;
}

/** Human-readable batch description shown on the confirmation card. */
export function describeGuiBatch(batch: GuiBatch): string {
  const parts = batch.actions.map((a) => {
    switch (a.kind) {
      case 'click':
        return `click at (${a.x}, ${a.y})`;
      case 'type':
        return `type "${redactIfSecret(a.text)}"`;
      case 'key':
        return `press ${[...(a.modifiers ?? []), a.key].join('+')}`;
      case 'screenshot':
        return 'take a screenshot';
      default:
        return 'unknown action';
    }
  });
  return `In "${batch.app}": ${parts.join(', ')}`;
}

function redactIfSecret(text: string): string {
  return looksLikeSecret(text) ? '[secret — not shown]' : text;
}

export class GuiRateLimiter {
  private timestamps: number[] = [];
  constructor(private readonly maxPerMinute = 30) {}
  /** Returns false when the batch would exceed the per-minute cap. */
  allow(count: number, now = Date.now()): boolean {
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length + count > this.maxPerMinute) return false;
    for (let i = 0; i < count; i += 1) this.timestamps.push(now);
    return true;
  }
}

export function planGuiBatch(
  batch: GuiBatch,
  apps: AllowedApps,
  limiter: GuiRateLimiter,
  now = Date.now()
): GuiPlan {
  const description = describeGuiBatch(batch);
  if (!apps.isAllowed(batch.app)) {
    return { ok: false, description, reason: `Application '${batch.app}' is not in the allowed list.` };
  }
  if (batch.actions.length === 0) {
    return { ok: false, description, reason: 'Empty GUI batch.' };
  }
  if (batch.actions.length > 20) {
    return { ok: false, description, reason: 'GUI batch too large; split it into smaller confirmations.' };
  }
  if (wouldTypePassword(batch)) {
    return { ok: false, description, reason: 'Password-like input: the user must type it themselves.' };
  }
  if (!limiter.allow(batch.actions.length, now)) {
    return { ok: false, description, reason: 'GUI action rate limit reached; wait before continuing.' };
  }
  return { ok: true, description };
}

/**
 * Emergency stop. Lives in the main process and depends on NOTHING from the
 * agent loop, so it works even when the agent is stuck: it aborts every
 * registered signal and kills every registered process group.
 */
export class EmergencyStop {
  private controllers = new Set<AbortController>();
  private pids = new Set<number>();
  private active = false;

  register(controller: AbortController): () => void {
    this.controllers.add(controller);
    return () => this.controllers.delete(controller);
  }

  registerProcess(pid: number | undefined): void {
    if (pid) this.pids.add(pid);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Returns what was stopped, so the UI can state it honestly. */
  stop(): { controllers: number; processes: number } {
    this.active = true;
    const controllers = this.controllers.size;
    for (const controller of this.controllers) {
      try {
        controller.abort();
      } catch {
        /* keep stopping the rest */
      }
    }
    this.controllers.clear();
    const processes = this.pids.size;
    for (const pid of this.pids) killGroup(pid);
    this.pids.clear();
    return { controllers, processes };
  }

  /** Called when control starts again after a stop. */
  resume(): void {
    this.active = false;
  }

  /** True while Cowork controls the machine — drives the permanent indicator. */
  machineBusy(guiActive: boolean, jobsRunning: number): boolean {
    return guiActive || jobsRunning > 0;
  }
}

let sharedStop: EmergencyStop | null = null;
export function getEmergencyStop(): EmergencyStop {
  if (!sharedStop) sharedStop = new EmergencyStop();
  return sharedStop;
}