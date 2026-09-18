/**
 * Rebuild the better-sqlite3 native binary for the installed Electron runtime.
 *
 * Why not `npm rebuild --runtime=electron ...`: npm >= 12 rejects unknown CLI
 * flags (EUNKNOWNCONFIG) and refuses to run install scripts that are not
 * allow-listed (EALLOWSCRIPTS), so `npm rebuild` can no longer drive the
 * rebuild. We therefore call prebuild-install / node-gyp directly — the same
 * path scripts/ensure-native-abi.js uses for its ABI restores.
 *
 * Usage:  node scripts/rebuild-native.js
 * Wired to:  npm run rebuild  (also called by postinstall)
 */

'use strict';

const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PKG_DIR = path.join(ROOT, "node_modules", "better-sqlite3");

function resolveBin(reqPath) {
  try {
    return require.resolve(reqPath, { paths: [ROOT] });
  } catch {
    return null;
  }
}

/** Run an npm-installed CLI with plain node (bypasses install-script policies). */
function runTool(pkgJsonReq, binRel, args, npxName) {
  let bin = resolveBin(pkgJsonReq);
  if (bin) {
    bin = path.join(path.dirname(bin), binRel);
  } else {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const res = spawnSync(npx, ["--yes", npxName, ...args], {
      cwd: PKG_DIR,
      stdio: "inherit",
      timeout: 10 * 60 * 1000,
    });
    return res.status === 0;
  }
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: PKG_DIR,
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
  });
  return res.status === 0;
}

/**
 * Probe the rebuilt binary from plain Node.
 * A binary rebuilt for Electron must NOT be loadable by plain Node — if it
 * is, the rebuild targeted the wrong runtime.
 */
function probeAbi() {
  const script = 'try { const D = require("better-sqlite3"); new D(":memory:"); console.log("OK:" + process.versions.modules); } catch (e) { const msg = String((e && e.message) || e); const m = msg.match(/using\\s+NODE_MODULE_VERSION (\\d+)/); console.log("X:" + (m ? m[1] : "-")); }';
  const res = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
  const line = String(res.stdout || "").trim().split("\n").pop() || "";
  if (line.startsWith("OK:")) {
    return { loadOk: true, abi: Number(line.slice(3)) };
  }
  const abi = line.startsWith("X:") ? Number(line.slice(2)) : null;
  return { loadOk: false, abi: Number.isInteger(abi) ? abi : null };
}

function electronVersion() {
  try {
    return require(path.join(ROOT, "node_modules", "electron", "package.json")).version;
  } catch {
    return null;
  }
}

function buildElectronAbi(version) {
  // Fast path: official prebuilt for this runtime.
  const prebuilt = runTool(
    "prebuild-install/package.json",
    "bin.js",
    ["-r", "electron", "-v", version, "--force"],
    "prebuild-install"
  );
  if (prebuilt && !probeAbi().loadOk) return true;
  return runTool("node-gyp/package.json", "bin/node-gyp.js", [
    "rebuild", "--release",
    "--runtime=electron",
    "--target=" + version,
    "--dist-url=https://electronjs.org/headers",
  ], "node-gyp");
}

function main() {
  const version = electronVersion();
  if (!version) {
    console.error("[rebuild-native] electron not installed — cannot rebuild for it");
    return 1;
  }
  console.log("[rebuild-native] rebuilding better-sqlite3 for Electron " + version);
  if (!buildElectronAbi(version)) {
    console.error("[rebuild-native] rebuild failed — run `npm install` to restore a working binary");
    return 1;
  }
  const probe = probeAbi();
  if (probe.loadOk) {
    console.error("[rebuild-native] rebuild produced a Node-loadable binary — wrong runtime?");
    return 1;
  }
  console.log("[rebuild-native] rebuilt ABI " + probe.abi + " for Electron " + version);
  return 0;
}

process.exitCode = main();