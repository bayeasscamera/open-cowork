/**
 * @module shared/health-report
 *
 * Whole-app diagnostic model. The per-provider connection probe already exists
 * (dns -> tcp -> tls -> auth -> model); what was missing is a single page that
 * answers "why is the app not working?" for everything ELSE: credentials of the
 * ConfigSet that is actually in effect, workspace, sandbox, storage and the
 * native tools the workflow features depend on.
 *
 * The classifier is pure and locale-free: it receives plain facts collected by
 * the main process and returns statuses plus the facts worth displaying. Every
 * user-facing sentence lives in the i18n bundles, so this module stays testable
 * and translatable.
 */

/** ok = nothing to do; warn = degraded but usable; fail = blocks the feature. */
export type HealthStatus = 'ok' | 'warn' | 'fail';

export type HealthCheckId =
  | 'credentials'
  | 'model'
  | 'workspace'
  | 'sandbox'
  | 'storage'
  | 'native-tools';

export interface HealthCheck {
  id: HealthCheckId;
  status: HealthStatus;
  /** Already-formatted, locale-independent fact (a name, a path, a version). */
  detail?: string;
}

/** Raw facts the main process can observe. */
export interface HealthFacts {
  /** The ConfigSet that is actually in effect has usable credentials. */
  credentialsUsable: boolean;
  provider: string;
  model: string;
  /** Display name of the ConfigSet in effect (falls back to its id). */
  configSetName: string;
  /** Session working directory (null when the session has none yet). */
  workingDir: string | null;
  /** Whether that directory still exists on disk. */
  workingDirExists: boolean;
  sandboxEnabled: boolean;
  /** Backend actually available; null means the sandbox cannot isolate. */
  sandboxBackend: 'wsl' | 'lima' | null;
  /** The app config + database directory is writable. */
  storageWritable: boolean;
  storagePath: string | null;
  /** git powers worktree isolation; null means it could not be probed. */
  gitVersion: string | null;
}

export interface HealthReport {
  status: HealthStatus;
  generatedAt: number;
  checks: HealthCheck[];
  /** The facts behind the report, so the page can show concrete values. */
  facts: HealthFacts;
}

/** Worst status wins: a single fail makes the whole report fail. */
export function overallHealthStatus(checks: readonly HealthCheck[]): HealthStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}

/**
 * Classify the collected facts into an ordered check list. The order is the
 * order of diagnosis: credentials and model first (they block everything),
 * then workspace, sandbox, storage and tooling.
 */
export function buildHealthChecks(facts: HealthFacts): HealthCheck[] {
  const checks: HealthCheck[] = [];

  checks.push(
    facts.credentialsUsable
      ? { id: 'credentials', status: 'ok', detail: facts.configSetName || facts.provider }
      : {
          id: 'credentials',
          status: 'fail',
          detail: facts.configSetName || facts.provider,
        }
  );

  checks.push(
    facts.model.trim()
      ? { id: 'model', status: 'ok', detail: facts.model }
      : { id: 'model', status: 'fail' }
  );

  if (!facts.workingDir) {
    checks.push({ id: 'workspace', status: 'warn' });
  } else if (!facts.workingDirExists) {
    checks.push({ id: 'workspace', status: 'fail', detail: facts.workingDir });
  } else {
    checks.push({ id: 'workspace', status: 'ok', detail: facts.workingDir });
  }

  if (!facts.sandboxEnabled) {
    checks.push({ id: 'sandbox', status: 'ok' });
  } else if (!facts.sandboxBackend) {
    // Enabled but unavailable: the run continues on the host, unisolated.
    checks.push({ id: 'sandbox', status: 'warn' });
  } else {
    checks.push({ id: 'sandbox', status: 'ok', detail: facts.sandboxBackend });
  }

  checks.push(
    facts.storageWritable
      ? { id: 'storage', status: 'ok', detail: facts.storagePath ?? undefined }
      : { id: 'storage', status: 'fail', detail: facts.storagePath ?? undefined }
  );

  checks.push(
    facts.gitVersion
      ? { id: 'native-tools', status: 'ok', detail: facts.gitVersion }
      : { id: 'native-tools', status: 'warn' }
  );

  return checks;
}

export function buildHealthReport(facts: HealthFacts, now: number = Date.now()): HealthReport {
  const checks = buildHealthChecks(facts);
  return { status: overallHealthStatus(checks), generatedAt: now, checks, facts };
}
