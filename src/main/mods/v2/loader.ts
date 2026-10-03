/**
 * Loads a mod's code into the main process.
 *
 * ## Execution model (a decision, not an oversight)
 *
 * A mod runs INSIDE Cowork's main process with the same access Cowork has: Node,
 * Electron, filesystem, network, database. The owner of this app chose that
 * deliberately, matching Claude Code. No separate process, no capability
 * sandbox — an in-process sandbox that a mod can trivially step around would be
 * worse than none, because it would look like a boundary.
 *
 * What is NOT unenforced:
 *  - Nothing loads without an approval whose PINNED HASH matches the current
 *    bytes (`approval-store.ts`). That is the real control.
 *  - The manifest is validated strictly before any code runs.
 *  - `capabilities` is declared, not enforced. It is shown to the user at
 *    install time so they know what the mod claims; a mod that uses more than it
 *    declares is a defect in the mod, and the honest response is to show the
 *    code, not to pretend a check exists.
 *  - Anything a mod does through `ctx.tools.invoke` re-enters `invokeTool()`, so
 *    permissions, the path guard and risk assessment still apply. Anything a mod
 *    does by importing `node:fs` itself bypasses all of that.
 *
 * Two honest limits, also stated in the user-facing guide:
 *  - A synchronous infinite loop in a mod cannot be interrupted from this
 *    process. The watchdog (safe-mode.ts) is the only recovery.
 *  - Installing a mod is trusting its code. The approval screen exists to make
 *    that a decision rather than a surprise.
 */

import { promises as fs } from 'fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { log, logWarn } from '../../utils/logger';
import type { CoworkModV2, ModManifest } from '@cowork/mod-api';
import { ModApprovalStore } from './approval-store';
import { fingerprintPlugin } from './plugin-hash';
import { validateModManifest } from './manifest-schema';
import { buildModContext, type ModContextDeps } from './mod-context';
import { ModEventBus } from './event-bus';

/**
 * How a module is brought into the process.
 *
 * Injected rather than hard-coded so the mechanism can be exercised for real in
 * tests without depending on how the main bundle happens to be built. The main
 * process is CJS (`package.json` has no `"type": "module"`), so `require` is the
 * natural loader; `createRequire` gives the same capability under vitest's ESM.
 */
export type ModuleImporter = (absolutePath: string) => Promise<Record<string, unknown>>;

/**
 * Anchor the require on an absolute path. Any absolute anchor works — the
 * requested module path is itself absolute — so cwd is a safe default and keeps
 * this testable without `__filename` (absent under ESM) or `import.meta.url`
 * (unreliable in a CJS bundle).
 */
export function createNodeImporter(anchorDir: string = process.cwd()): ModuleImporter {
  const requireFn = createRequire(path.join(anchorDir, '__cowork_mod_loader__.js'));
  return async (absolutePath: string) => requireFn(absolutePath) as Record<string, unknown>;
}

export interface LoadedPlugin {
  readonly manifest: ModManifest;
  readonly mod: CoworkModV2;
  readonly rootDir: string;
  readonly hash: string;
}

export type LoadOutcome =
  | { readonly status: 'loaded'; readonly plugin: LoadedPlugin }
  /** Valid manifest, but the user has not approved this exact code. */
  | { readonly status: 'needs-approval'; readonly manifest: ModManifest; readonly rootDir: string; readonly hash: string; readonly reason: string; readonly firstApproval: boolean }
  | { readonly status: 'invalid-manifest'; readonly rootDir: string; readonly errors: readonly { path: string; message: string }[] }
  | { readonly status: 'error'; readonly rootDir: string; readonly message: string };

export interface ModLoaderDeps extends ModContextDeps {
  readonly approvals: ModApprovalStore;
  readonly importModule: ModuleImporter;
}

export class ModLoader {
  constructor(private readonly deps: ModLoaderDeps) {}

  /**
   * Read and validate a plugin directory WITHOUT executing anything.
   *
   * The install screen needs this: it must show the manifest, the declared
   * capabilities and the hash before asking the user to approve code that has
   * not run yet. Executing first and showing the result afterwards would defeat
   * the point of an approval screen.
   */
  async inspect(rootDir: string): Promise<LoadOutcome> {
    const manifestPath = path.join(rootDir, 'mod.json');
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf-8');
    } catch (error) {
      return {
        status: 'error',
        rootDir,
        message: `Cannot read mod.json: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        status: 'invalid-manifest',
        rootDir,
        errors: [{ path: '(root)', message: `mod.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }

    const validated = validateModManifest(parsed);
    if (!validated.ok) {
      return { status: 'invalid-manifest', rootDir, errors: validated.errors };
    }

    const fingerprint = await fingerprintPlugin(rootDir);
    if (fingerprint.fileCount === 0) {
      return {
        status: 'invalid-manifest',
        rootDir,
        errors: [{ path: 'entry', message: 'The plugin directory contains no readable file to fingerprint.' }],
      };
    }

    return {
      status: 'needs-approval',
      manifest: validated.manifest,
      rootDir,
      hash: fingerprint.hash,
      firstApproval: true,
      reason: 'Not installed and approved yet.',
    };
  }

  /**
   * Load and register a plugin, but only if its bytes match an approval.
   *
   * Order is deliberate: manifest → fingerprint → approval → import. Nothing is
   * executed before the approval check passes, and the fingerprint is computed
   * from disk immediately before the import so a file swapped between the
   * inspection screen and this call cannot slip through.
   */
  async load(rootDir: string, bus: ModEventBus): Promise<LoadOutcome> {
    const inspected = await this.inspect(rootDir);
    if (inspected.status !== 'needs-approval') return inspected;

    const { manifest, hash } = inspected;
    const decision = this.deps.approvals.check({
      modId: manifest.id,
      currentHash: hash,
      sourcePath: rootDir,
    });

    if (!decision.allowed) {
      return {
        status: 'needs-approval',
        manifest,
        rootDir,
        hash,
        reason: decision.reason ?? 'Not approved.',
        firstApproval: decision.firstApproval,
      };
    }

    const entryPath = path.join(rootDir, manifest.entry);
    try {
      // Defence in depth: the manifest schema already refused traversal, but the
      // join happens here, so the containment check is repeated where it counts.
      const relative = path.relative(rootDir, entryPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return {
          status: 'error',
          rootDir,
          message: 'The mod entry resolves outside its plugin directory.',
        };
      }

      const moduleExports = await this.deps.importModule(entryPath);
      const exported = moduleExports.default ?? moduleExports;
      const mod =
        typeof exported === 'function'
          ? (await (exported as (ctx: unknown) => Promise<unknown>)(buildModContext(manifest, this.deps)))
          : exported;

      if (!mod || typeof mod !== 'object') {
        return {
          status: 'error',
          rootDir,
          message: 'The mod entry did not export an object or an activate() function.',
        };
      }

      const candidate = mod as CoworkModV2;
      if (candidate.id !== manifest.id) {
        return {
          status: 'error',
          rootDir,
          message: `The mod code declares id "${String(candidate.id)}" but its manifest says "${manifest.id}". Refusing to load: a mismatch is what a tampered plugin looks like.`,
        };
      }

      const ctx = buildModContext(manifest, this.deps);
      const maybeActivatable = candidate as unknown as { activate?: (ctx: unknown) => CoworkModV2 | void };
      const activated =
        typeof maybeActivatable.activate === 'function'
          ? maybeActivatable.activate(ctx) ?? candidate
          : candidate;

      bus.register(manifest, activated, ctx);
      const plugin: LoadedPlugin = { manifest, mod: activated, rootDir, hash };
      log(`[Mods] Loaded "${manifest.id}" v${manifest.version} from ${rootDir}`);
      return { status: 'loaded', plugin };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWarn(`[Mods] Failed to load plugin at ${rootDir}: ${message}`);
      return { status: 'error', rootDir, message };
    }
  }
}