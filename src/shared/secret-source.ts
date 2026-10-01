/**
 * @module shared/secret-source
 *
 * Types and pure helpers for pluggable secret storage.
 *
 * Cowork's default source is `local`: the key lives in the encrypted
 * electron-store (AES-256-CBC under a per-installation key held by the OS
 * keyring via Electron safeStorage). The external sources never write the
 * secret locally — they store a REFERENCE (an `op://` URI or a Bitwarden item
 * id) in that same field, and the real value is resolved at the moment it is
 * needed, through the manager's own CLI.
 *
 * This module is intentionally dependency-free (no electron, no child_process)
 * so both the main process and the renderer can import it, and so the pure
 * validation logic is directly unit-testable.
 */

/** Where a ConfigSet's API key comes from. `local` keeps the historical behavior. */
export type SecretSourceKind = 'local' | 'bitwarden' | '1password';

/**
 * How an external source should be reached. Both managers ship a CLI; the
 * `api` variants exist so a future HTTP adapter can be slotted in without
 * changing the ConfigSet shape. Only `cli` is implemented today.
 */
export type SecretSourceDriver = 'cli';

/** Everything needed to resolve one ConfigSet's key from an external vault. */
export interface SecretSourceConfig {
  kind: SecretSourceKind;
  driver: SecretSourceDriver;
  /**
   * Opaque reference to the secret, interpreted by the source:
   *  - bitwarden: an item id or item name (`bw get password <ref>`)
   *  - 1password: a full `op://vault/item/field` secret reference
   */
  reference: string;
}

/**
 * Per-ConfigSet selection. Keyed by ConfigSet id in the app config.
 *
 * An entry may be explicitly `undefined`, which is how the UI clears a
 * selection back to the local source without having to rebuild the map.
 * Consumers must therefore narrow with `entry?.kind` rather than assuming a
 * key is always present.
 */
export type SecretSourceMap = Record<string, SecretSourceConfig | undefined>;

/** Result of probing the manager CLI, used to drive the Settings UI. */
export interface SecretSourceProbe {
  /** True when the CLI binary was found on PATH and answered `--version`. */
  installed: boolean;
  /** True when the CLI is present AND its vault is usable right now. */
  unlocked: boolean;
  /** Human-readable reason when `installed` or `unlocked` is false. */
  detail?: string;
  /** CLI version string when detected. */
  version?: string;
}

/** Why a resolution failed. Drives the message shown in Settings. */
export type SecretResolutionErrorCode =
  | 'cli-missing'
  | 'vault-locked'
  | 'not-found'
  | 'invalid-reference'
  | 'timeout'
  | 'unknown';

export interface SecretResolutionError {
  code: SecretResolutionErrorCode;
  /** Safe to show in the UI: never contains the secret itself. */
  message: string;
}

export type SecretResolutionResult =
  | { ok: true; value: string }
  | { ok: false; error: SecretResolutionError };

/** Ordered precedence when the same key name is defined in several sources. */
export const SECRET_SOURCE_PRECEDENCE: readonly SecretSourceKind[] = [
  'bitwarden',
  '1password',
  'local',
] as const;

/**
 * True when a stored value is an external reference rather than a literal key.
 * A literal key never starts with either manager's scheme prefix, so this stays
 * a cheap, allocation-free check on the hot path.
 */
export function isExternalSecretReference(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('op://') || trimmed.startsWith('bw://');
}

/**
 * Validate a `op://` secret reference. The path must name a vault, an item and
 * a field; anything shorter cannot address a single value.
 */
export function isValidOnePasswordReference(reference: string): boolean {
  const trimmed = reference.trim();
  if (!trimmed.startsWith('op://')) return false;
  const segments = trimmed.slice('op://'.length).split('/');
  // vault/item/field, with optional nested sections and/or query string.
  return segments.length >= 3 && segments.every((segment) => segment.length > 0);
}

/**
 * A Bitwarden reference is an item id (GUID) or an item name. Names are
 * deliberately permissive — `bw` itself does the real lookup and reports a
 * clear error when the name matches nothing.
 */
export function isValidBitwardenReference(reference: string): boolean {
  const trimmed = reference.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('bw://')) return false;
  return true;
}

/** Validate a reference against the source that will interpret it. */
export function isValidSecretReference(kind: SecretSourceKind, reference: string): boolean {
  if (kind === 'bitwarden') return isValidBitwardenReference(reference);
  if (kind === '1password') return isValidOnePasswordReference(reference);
  return reference.trim().length > 0;
}

/** The reference prefix each manager uses, for placeholder text and validation. */
export function referenceHint(kind: SecretSourceKind): string {
  switch (kind) {
    case 'bitwarden':
      return 'Item ID or name';
    case '1password':
      return 'op://vault/item/field';
    default:
      return '';
  }
}

/**
 * A ConfigSet is in external mode when it declares a source other than `local`.
 * Used by the Settings UI to swap the API key input for a reference input.
 */
export function hasExternalSecretSource(config: SecretSourceConfig | undefined): boolean {
  return Boolean(config && config.kind !== 'local' && config.reference.trim());
}

/**
 * Pick the winning source for a ConfigSet when several are declared.
 *
 * Precedence is explicit (`SECRET_SOURCE_PRECEDENCE`): a manager vault beats
 * the local encrypted store, because the whole point of configuring one is to
 * stop persisting the key locally. Within a single kind, the first entry wins,
 * keeping resolution deterministic across restarts.
 */
export function pickPrecedenceWinner(
  candidates: readonly SecretSourceConfig[]
): SecretSourceConfig | undefined {
  for (const kind of SECRET_SOURCE_PRECEDENCE) {
    const match = candidates.find(
      (candidate) => candidate.kind === kind && candidate.reference.trim().length > 0
    );
    if (match) return match;
  }
  return undefined;
}

/**
 * Report every ConfigSet that declares the same key through more than one
 * source, so Settings can warn that one of them is being ignored.
 *
 * Returns ConfigSet ids, de-duplicated — a set listed three times yields one
 * entry, not three warnings.
 */
export function findConflictingSecretSources(
  map: SecretSourceMap | undefined
): Array<{ configSetId: string; kinds: SecretSourceKind[]; winner: SecretSourceKind }> {
  if (!map) return [];
  const conflicts: Array<{ configSetId: string; kinds: SecretSourceKind[]; winner: SecretSourceKind }> =
    [];
  for (const [configSetId, entries] of Object.entries(map)) {
    if (!entries) continue;
    const list = Array.isArray(entries) ? entries : [entries];
    const kinds = Array.from(
      new Set(
        list
          .filter((entry) => entry && entry.kind !== 'local' && entry.reference.trim())
          .map((entry) => entry.kind)
      )
    );
    if (kinds.length > 1) {
      const winner = pickPrecedenceWinner(list.filter((entry) => entry.reference.trim()));
      if (winner) {
        conflicts.push({ configSetId, kinds, winner: winner.kind });
      }
    }
  }
  return conflicts;
}
