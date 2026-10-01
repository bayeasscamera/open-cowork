/**
 * afterSign hook for electron-builder.
 *
 * Notarizes the macOS .app bundle so it passes Gatekeeper on end-user machines.
 * Until a staple is attached, every launch on any machine other than the
 * developer's requires a right-click → Open, and macOS refuses outright on
 * machines where quarantine applies.
 *
 * NOTE: electron-builder does not emit `afterSign` when no signing happened
 * (see app-builder-lib `platformPackager` — "skipping afterSign hook as no
 * signing occurred"). A release must therefore also provide a signing identity;
 * notarization is only the second half of the chain, not a substitute for it.
 *
 * Credentials — App Store Connect API key (preferred, non-expiring):
 *   APPLE_API_KEY        – path to the .p8 key file
 *   APPLE_API_KEY_ID     – key id (e.g. T9GPZ92M7K)
 *   APPLE_API_ISSUER     – issuer UUID
 *
 * Credentials — Apple ID (fallback):
 *   APPLE_ID             – Apple ID email
 *   APPLE_ID_PASSWORD    – app-specific password (NOT your Apple ID password)
 *   APPLE_TEAM_ID        – 10-char team identifier from developer.apple.com
 *
 * If no complete credential set is present the script skips, so local dev
 * builds still work. In CI the skip is turned into a hard failure: a release
 * that quietly ships unnotarized is exactly the failure this hook exists to
 * prevent, and silence is what hid the missing wiring in the first place.
 */
const { notarize } = require('@electron/notarize');

/** True when running in a release pipeline that must not ship unnotarized. */
function isCiRelease() {
  return process.env.CI === 'true' || process.env.RELEASE_BUILD === 'true';
}

/**
 * Build the credential set from the environment, or `null` when none is
 * complete. API-key credentials win when present.
 * @returns {import('@electron/notarize').NotarizeOptions | null}
 */
function resolveNotarizeOptions(appPath) {
  const base = { appBundleId: 'com.opencowork.app', appPath };

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return {
      ...base,
      appleApiKey: APPLE_API_KEY,
      appleApiKeyId: APPLE_API_KEY_ID,
      appleApiIssuer: APPLE_API_ISSUER,
    };
  }

  const { APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (APPLE_ID && APPLE_ID_PASSWORD && APPLE_TEAM_ID) {
    return { ...base, appleId: APPLE_ID, appleIdPassword: APPLE_ID_PASSWORD, teamId: APPLE_TEAM_ID };
  }

  return null;
}

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const options = resolveNotarizeOptions(appPath);

  if (!options) {
    const message =
      '[notarize] Skipping — set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, ' +
      'or APPLE_ID + APPLE_ID_PASSWORD + APPLE_TEAM_ID.';
    if (isCiRelease()) {
      // Fail the release rather than publish a build Gatekeeper will block.
      throw new Error(`${message} Notarization is mandatory for release builds.`);
    }
    console.log(`${message} (local dev build, skipping is fine)`);
    return;
  }

  console.log(`[notarize] Notarizing ${options.appBundleId} at ${appPath} ...`);

  try {
    await notarize(options);
  } catch (error) {
    // A failed notarization must not be mistaken for a successful build: the
    // DMG would still be produced, just unopenable on other machines.
    throw new Error(
      `[notarize] FAILED for ${appPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log('[notarize] Done — ticket stapled to the app bundle.');
};
