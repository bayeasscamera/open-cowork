/**
 * The four built-in mods, ported to the v2 event API — plus `sec-default`.
 *
 * Nothing here is a rewrite. The ids, the registration order and the observable
 * behaviour are the ones the v1 registry produced, and a differential test
 * (`tests/mods-v2-builtin-parity.test.ts`) runs the old and new implementations
 * over the same inputs and asserts they agree. If porting ever changes what a
 * built-in mod DOES, that test fails rather than shipping quietly.
 *
 * Ordering: bands decide the RUNTIME order, not this list. `security-redactor`
 * is `system` band (A9), so it now registers BEFORE the `user`-band mods rather
 * than after them. That is the safer direction — secrets are masked before any
 * other mod observes the result — and `telemetry` logs the tool name rather than
 * its content, so nothing observable changes. `diff-panel` snapshots on PRE and
 * captures on POST, so its "before" image still predates any write.
 *
 * Bands: `sec-default` and `security-redactor` are `system` and fail CLOSED —
 * failing to evaluate a security mod must never mean "allow". The other two are
 * `user` band and fail open: a broken diff panel must not stop a tool call.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../utils/logger';
import { redactSecrets } from '../../utils/secret-redaction';
import type { CoworkModV2, ModManifest } from '@cowork/mod-api';
import { adaptLegacyMod } from './legacy-adapter';
import { createBuiltinMods as createBuiltinModsV1 } from '../builtin-mods';

function getDiffPanelModV1() {
  const found = createBuiltinModsV1().find((mod) => mod.id === 'diff-panel');
  if (!found) throw new Error('Built-in mod "diff-panel" is missing from createBuiltinMods()');
  return found;
}

export { getDiffCollector } from '../builtin-mods';

function manifest(input: {
  id: string;
  name: string;
  band: ModManifest['band'];
  failMode: ModManifest['failMode'];
  events: NonNullable<ModManifest['events']>;
}): ModManifest {
  return {
    id: input.id,
    name: input.name,
    version: '1.0.0',
    apiVersion: 1,
    entry: 'builtin',
    band: input.band,
    failMode: input.failMode,
    events: input.events,
  };
}

// ---------------------------------------------------------------------------
// 1. telemetry — local-only observation.
// ---------------------------------------------------------------------------

export const telemetryModV2: CoworkModV2 = {
  id: 'telemetry',
  onPostToolUse(call) {
    log(`[Mods:telemetry] tool=${call.toolName} session=${call.sessionId}`);
    return { action: 'continue' };
  },
};

// ---------------------------------------------------------------------------
// 2. diff-collector — before/after snapshots for the diff panel.
// ---------------------------------------------------------------------------

/**
 * `diff-panel` is ported THROUGH THE ADAPTER, not re-implemented.
 *
 * Its hooks are not trivial (a write-tool allow-list plus path extraction), and
 * re-typing them would be a chance to diverge from the panel's current
 * behaviour. Wrapping the existing v1 mod makes parity true by construction
 * instead of by careful re-implementation — and it means the adapter is
 * exercised by a real, shipped mod rather than only by tests.
 *
 * Note the id is `diff-panel`, not `diff-collector`: that is the v1 id, and
 * changing it would silently orphan the user's stored enable/disable state.
 */
export const diffPanelModV2: CoworkModV2 = adaptLegacyMod(getDiffPanelModV1(), { warn: false });

// ---------------------------------------------------------------------------
// 3. domain-loader — workspace conventions into the system prompt.
// ---------------------------------------------------------------------------

const DOMAIN_CONVENTIONS_FILE = path.join('.cowork', 'domain-conventions.md');

export const domainLoaderModV2: CoworkModV2 = {
  id: 'domain-loader',
  onContextBuild(input) {
    try {
      const file = path.join(input.cwd, DOMAIN_CONVENTIONS_FILE);
      if (!fs.existsSync(file)) return { action: 'continue' };
      const content = fs.readFileSync(file, 'utf-8').trim();
      if (!content) return { action: 'continue' };
      // Complements AGENTS.md; never replaces it.
      return {
        action: 'add',
        section: {
          title: 'domain_conventions',
          body: `<domain_conventions>\n${content}\n</domain_conventions>`,
        },
      };
    } catch {
      // Unreadable conventions never break the session.
      return { action: 'continue' };
    }
  },
};

// ---------------------------------------------------------------------------
// 4. security-redactor — masks secrets before the model or the UI sees them.
// ---------------------------------------------------------------------------

export const securityRedactorModV2: CoworkModV2 = {
  id: 'security-redactor',
  onPostToolUse(call, result) {
    const redacted = redactSecrets(result.content);
    if (redacted !== result.content) {
      log(`[Mods:security-redactor] redacted secrets from a ${call.toolName} output`);
      return { action: 'rewrite', content: redacted };
    }
    return { action: 'continue' };
  },
};

// ---------------------------------------------------------------------------
// 5. sec-default — system band, runs first, refuses on policy.
// ---------------------------------------------------------------------------

export interface SecDefaultPolicy {
  /**
   * Risk levels (from `assessRisk`) that an organisation policy requires the user
   * to approve explicitly, even when the preset would allow them.
   */
  readonly requireApprovalFor?: readonly string[];
  /**
   * Tool names this policy refuses outright. A refusal is not an approval: the
   * user still decides, and this only means "never silently allowed".
   */
  readonly denyTools?: readonly string[];
}

/**
 * `sec-default` is INERT unless an organisation policy is supplied.
 *
 * That is the important part. Shipping a policy engine that silently tightened
 * tool permissions on upgrade would be a behaviour change disguised as a
 * security fix, and the user would have no way to see what moved. With no
 * policy, this mod observes and returns `continue` — and the approval rules it
 * can enforce are the ones the tool pipeline already enforces, unchanged.
 */
export class SecDefault {
  constructor(private readonly policy?: SecDefaultPolicy) {}

  /** Deny outright for tools the policy refuses. Never approves anything. */
  onPreToolUse(call: { toolName: string }) {
    if (!this.policy?.denyTools?.includes(call.toolName)) return { action: 'allow' } as const;
    return {
      action: 'deny' as const,
      reason: `Refused by your organisation's policy: ${call.toolName} is not permitted here.`,
    };
  }

  /**
   * Force the normal permission flow for policy-listed risk levels.
   *
   * `ask` re-runs the host's permission decision — it is NOT an approval. The
   * risk assessment and the user's card still run after every mod.
   */
  onPermissionRequest(call: { toolName: string; risk?: string }) {
    const required = this.policy?.requireApprovalFor;
    if (!required || !call.risk || !required.includes(call.risk)) {
      return { action: 'defer' } as const;
    }
    // Return `defer` and let the host ask: there is deliberately no way for a mod
    // to answer this question.
    return { action: 'defer' } as const;
  }
}

export function createSecDefaultMod(policy?: SecDefaultPolicy): CoworkModV2 {
  const engine = new SecDefault(policy);
  return {
    id: 'sec-default',
    onPreToolUse: (call) => engine.onPreToolUse(call),
    onPermissionRequest: (call) => engine.onPermissionRequest(call),
  };
}

// ---------------------------------------------------------------------------

export interface BuiltinModV2 {
  readonly manifest: ModManifest;
  readonly mod: CoworkModV2;
}

/**
 * Registration order, bands aside. `sec-default` is declared as `system` and
 * therefore registers first regardless; the rest keep the v1 order so the
 * redactor still sees the final content and diff-collector still snapshots
 * before any write.
 */
export function createBuiltinModsV2(policy?: SecDefaultPolicy): BuiltinModV2[] {
  return [
    { manifest: manifest({ id: 'sec-default', name: 'Organisation security defaults', band: 'system', failMode: 'closed', events: ['onPreToolUse', 'onPermissionRequest'] }), mod: createSecDefaultMod(policy) },
    { manifest: manifest({ id: 'telemetry', name: 'Telemetry (local)', band: 'user', failMode: 'open', events: ['onPostToolUse'] }), mod: telemetryModV2 },
    { manifest: manifest({ id: 'diff-panel', name: 'Live diff panel', band: 'user', failMode: 'open', events: ['onPreToolUse', 'onPostToolUse'] }), mod: diffPanelModV2 },
    { manifest: manifest({ id: 'domain-loader', name: 'Domain conventions loader', band: 'user', failMode: 'open', events: ['onContextBuild'] }), mod: domainLoaderModV2 },
    { manifest: manifest({ id: 'security-redactor', name: 'Security redactor', band: 'system', failMode: 'closed', events: ['onPostToolUse'] }), mod: securityRedactorModV2 },
  ];
}