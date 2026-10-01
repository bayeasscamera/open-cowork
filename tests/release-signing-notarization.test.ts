import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

/**
 * The release pipeline's signing and notarization chain.
 *
 * `scripts/notarize.js` shipped in the repo for a long time while
 * `electron-builder.yml` never referenced it, so no release was ever
 * notarized: the app was unsigned, and every launch on any machine other than
 * the developer's required a right-click → Open. Both halves of that chain are
 * silent by construction (electron-builder skips `afterSign` when nothing was
 * signed; the hook itself skipped when credentials were missing), which is
 * exactly why nothing caught it. These tests pin the wiring and the fail-loud
 * behaviour so a future edit cannot quietly restore the broken state.
 */
describe('macOS release signing + notarization chain', () => {
  const builderConfig = fs.readFileSync(
    path.resolve(process.cwd(), 'electron-builder.yml'),
    'utf8'
  );
  const releaseWorkflow = fs.readFileSync(
    path.resolve(process.cwd(), '.github/workflows/release.yml'),
    'utf8'
  );

  describe('electron-builder wiring', () => {
    it('registers the notarize hook as the afterSign hook', () => {
      expect(builderConfig).toMatch(/^afterSign:\s*\.\/scripts\/notarize\.js\s*$/m);
    });

    it('notarizes after signing, which runs after packing', () => {
      // Ordering matters: afterSign must come after afterPack, and the DMG
      // compression must come last so it packages the stapled ticket.
      const afterPack = builderConfig.indexOf('afterPack:');
      const afterSign = builderConfig.indexOf('afterSign:');
      const afterArtifacts = builderConfig.indexOf('afterAllArtifactBuild:');

      expect(afterPack).toBeGreaterThan(-1);
      expect(afterSign).toBeGreaterThan(afterPack);
      expect(afterArtifacts).toBeGreaterThan(afterSign);
    });

    it('targets a DMG on macOS (the artifact users actually download)', () => {
      // `dir` alone would package an .app that never reaches a user, and a
      // notarized-but-unbuilt DMG would not fix the Gatekeeper prompt.
      expect(builderConfig).toMatch(/^mac:[\s\S]*?dmg/m);
    });

    it('keeps the hardened runtime and entitlements notarization requires', () => {
      // Apple rejects notarization of an app that is not hardened-runtime
      // signed, so dropping either of these silently invalidates the chain.
      expect(builderConfig).toContain('hardenedRuntime: true');
      expect(builderConfig).toContain('entitlements: resources/entitlements.mac.plist');
    });
  });

  describe('release workflow', () => {
    it('no longer forces unsigned builds', () => {
      expect(releaseWorkflow).not.toContain('CSC_IDENTITY_AUTO_DISCOVERY');
    });

    it('passes signing and notarization credentials to the builder', () => {
      expect(releaseWorkflow).toContain('CSC_LINK:');
      expect(releaseWorkflow).toContain('APPLE_API_KEY:');
      expect(releaseWorkflow).toContain('APPLE_API_KEY_ID:');
      expect(releaseWorkflow).toContain('APPLE_API_ISSUER:');
    });

    it('marks the job as a release build so a skipped notarization fails it', () => {
      expect(releaseWorkflow).toContain("RELEASE_BUILD: 'true'");
    });
  });

  describe('notarize hook behaviour', () => {
    const savedEnv = { ...process.env };

    function loadHook() {
      // Drop the module cache so each case re-reads the process environment.
      vi.resetModules();
      return require_('../scripts/notarize.js').default as (context: unknown) => Promise<void>;
    }

    const darwinContext = {
      electronPlatformName: 'darwin',
      appOutDir: '/tmp/out',
      packager: { appInfo: { productFilename: 'Open Cowork' } },
    };

    beforeEach(() => {
      for (const key of [
        'APPLE_ID',
        'APPLE_ID_PASSWORD',
        'APPLE_TEAM_ID',
        'APPLE_API_KEY',
        'APPLE_API_KEY_ID',
        'APPLE_API_ISSUER',
        'CI',
        'RELEASE_BUILD',
      ]) {
        delete process.env[key];
      }
    });

    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it('does nothing on non-macOS platforms', async () => {
      const hook = loadHook();
      await expect(
        hook({ ...darwinContext, electronPlatformName: 'win32' })
      ).resolves.toBeUndefined();
    });

    it('skips quietly on a local dev build with no credentials', async () => {
      const hook = loadHook();
      // Local `npm run build` has no Apple account; failing here would block
      // every contributor without a paid membership.
      await expect(hook(darwinContext)).resolves.toBeUndefined();
    });

    it('fails the build when a release is attempted without credentials', async () => {
      process.env.RELEASE_BUILD = 'true';
      const hook = loadHook();
      // The failure mode this prevents: a "successful" release that users
      // cannot open without a right-click → Open.
      await expect(hook(darwinContext)).rejects.toThrow(/mandatory/i);
    });

    it('does not attempt notarization with a partial API-key credential set', async () => {
      process.env.APPLE_API_KEY = '/tmp/Auth_ABC.p8';
      process.env.APPLE_API_KEY_ID = 'T9GPZ92M7K';
      // APPLE_API_ISSUER deliberately missing — an incomplete set must not be
      // mistaken for a usable one.
      const hook = loadHook();
      await expect(hook(darwinContext)).resolves.toBeUndefined();
    });
  });
});
