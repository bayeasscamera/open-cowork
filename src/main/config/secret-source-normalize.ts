/**
 * @module main/config/secret-source-normalize
 *
 * Defensive normalization for the persisted `secretSources` map.
 *
 * The map is read from an encrypted store that may have been written by an
 * older build, hand-edited, or corrupted. Normalizing on every read keeps a
 * malformed entry from reaching the resolver, and — importantly — never
 * invents a source: an entry that does not survive validation is dropped, not
 * defaulted, so a bad file can never silently downgrade a ConfigSet's
 * credentials.
 */
import {
  isValidSecretReference,
  SECRET_SOURCE_PRECEDENCE,
  type SecretSourceConfig,
  type SecretSourceDriver,
  type SecretSourceKind,
  type SecretSourceMap,
} from '../../shared/secret-source';

function isSourceKind(value: unknown): value is SecretSourceKind {
  return (
    typeof value === 'string' && (SECRET_SOURCE_PRECEDENCE as readonly string[]).includes(value)
  );
}

function isDriver(value: unknown): value is SecretSourceDriver {
  return value === 'cli';
}

function normalizeEntry(raw: unknown): SecretSourceConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (!isSourceKind(candidate.kind)) return null;
  if (candidate.kind === 'local') return null; // `local` is the absence of a source
  const driver: SecretSourceDriver = isDriver(candidate.driver) ? candidate.driver : 'cli';
  const reference = typeof candidate.reference === 'string' ? candidate.reference.trim() : '';
  if (!reference) return null;
  if (!isValidSecretReference(candidate.kind, reference)) return null;
  return { kind: candidate.kind, driver, reference };
}

/**
 * Coerce an arbitrary stored value into a valid map.
 *
 * Also collapses duplicates for one ConfigSet down to a single entry using the
 * shared precedence, so the resolver always has one unambiguous answer. The
 * dropped kinds stay visible to callers through `findConflictingSecretSources`
 * before this collapse is applied, which is what Settings warns with.
 */
export function normalizeSecretSourceMap(raw: unknown): SecretSourceMap | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  const result: SecretSourceMap = {};
  let sawValidEntry = false;

  for (const [configSetId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!configSetId) continue;
    // A legacy shape stored several entries for the same ConfigSet as an array.
    const candidates = Array.isArray(value) ? value : [value];
    const valid = candidates
      .map(normalizeEntry)
      .filter((entry): entry is SecretSourceConfig => entry !== null);
    if (valid.length === 0) continue;

    for (const kind of SECRET_SOURCE_PRECEDENCE) {
      const winner = valid.find((entry) => entry.kind === kind);
      if (winner) {
        result[configSetId] = winner;
        sawValidEntry = true;
        break;
      }
    }
  }

  return sawValidEntry ? result : undefined;
}