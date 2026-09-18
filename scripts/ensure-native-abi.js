/**
 * Ensure the better-sqlite3 native binary matches the Node ABI before
 * running Vitest, then restore the previous (Electron) ABI afterwards.
 *
 * Why: the postinstall script rebuilds better-sqlite3 for Electron so the
 * desktop app can open the database, but Vitest runs on plain Node — so
 * native-module-backed test files fail locally with a NODE_MODULE_VERSION
 * mismatch. CI dodges this via `npm ci --ignore-scripts` + node rebuild;
 * this wrapper gives local developers the same guarantee in both states.
 *
 * Usage:  node scripts/ensure-native-abi.js [vitest args...]
 * Wired to:  npm test / npm run test:coverage
 *
 * Every produced binary is cached under node_modules/.cowork-abi-cache so
 * the (slow) node-gyp compiles happen once per ABI; later switches are plain
 * file copies. Never blocks an app launch: it only runs for tests.
 */

'use strict';

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PKG_DIR = path.join(ROOT, "node_modules", "better-sqlite3");
const NATIVE_FILE = "better_sqlite3.node";
const BUILD_PATH = path.join(PKG_DIR, "build", "Release", NATIVE_FILE);
const CACHE_DIR = path.join(ROOT, "node_modules", ".cowork-abi-cache");
// Crash sentinel: a verbatim copy of the binary taken before any switch. If
// the process is interrupted mid-switch (Ctrl-C, kill, power loss), the next
// run restores from this file instead of leaving an unusable binary behind.
const BACKUP_PATH = path.join(CACHE_DIR, NATIVE_FILE + ".preswitch-backup");

function savePreSwitchBackup() {
  try {
    if (!fs.existsSync(BUILD_PATH)) return;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.copyFileSync(BUILD_PATH, BACKUP_PATH);
  } catch {
    /* backup is a safety net only — never block the test run */
  }
}

function restorePreSwitchBackup() {
  try {
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, BUILD_PATH);
      console.log("[ensure-native-abi] restored pre-switch binary backup");
    }
  } catch {
    /* best effort */
  }
}

function clearPreSwitchBackup() {
  try {
    if (fs.existsSync(BACKUP_PATH)) fs.unlinkSync(BACKUP_PATH);
  } catch {
    /* best effort */
  }
}

/**
 * Probe the current binary from plain Node.
 *   { loadOk: true, abi: <nodeAbi> }            → loadable here (Node ABI)
 *   { loadOk: false, abi: <num|null>, err }     → ABI mismatch (number from
 *     the dlopen error message) or a hard load failure.
 */
function probeAbi() {
  const script = 'try { const D = require("better-sqlite3"); new D(":memory:"); console.log("OK:" + process.versions.modules); } catch (e) { const msg = String((e && e.message) || e); const m = msg.match(/using\\s+NODE_MODULE_VERSION (\\d+)/); console.log("X:" + (m ? m[1] : "-") + ":" + msg.split("\\n")[0]); }';
  const res = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
  const line = String(res.stdout || "").trim().split("\n").pop() || "";
  if (line.startsWith("OK:")) {
    return { loadOk: true, abi: Number(line.slice(3)), err: null };
  }
  const parts = line.startsWith("X:") ? line.slice(2).split(":") : [];
  const abi = parts[0] && parts[0] !== "-" ? Number(parts[0]) : null;
  return { loadOk: false, abi: Number.isInteger(abi) ? abi : null, err: parts.slice(1).join(":") || "probe failed" };
}

function copyBinaryTo(targetAbi, fromPath) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const dest = path.join(CACHE_DIR, NATIVE_FILE + "." + targetAbi);
  fs.copyFileSync(fromPath, dest);
  return dest;
}

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

function buildNodeAbi() {
  // Fast path: official prebuilt for this runtime.
  const prebuilt = runTool("prebuild-install/package.json", "bin.js", ["-r", "node"], "prebuild-install");
  if (prebuilt && probeAbi().loadOk) return true;
  return runTool("node-gyp/package.json", "bin/node-gyp.js", ["rebuild", "--release"], "node-gyp");
}

function buildElectronAbi(electronVersion, expectedAbi) {
  runTool(
    "prebuild-install/package.json",
    "bin.js",
    ["-r", "electron", "-v", electronVersion, "--force"],
    "prebuild-install"
  );
  if (probeAbi().abi === expectedAbi) return true;
  return runTool("node-gyp/package.json", "bin/node-gyp.js", [
    "rebuild", "--release",
    "--runtime=electron",
    "--target=" + electronVersion,
    "--dist-url=https://electronjs.org/headers",
  ], "node-gyp");
}

function electronVersion() {
  try {
    return require(path.join(ROOT, "node_modules", "electron", "package.json")).version;
  } catch {
    return null;
  }
}

function restoreAbi(targetAbi) {
  const cached = path.join(CACHE_DIR, NATIVE_FILE + "." + targetAbi);
  if (fs.existsSync(cached)) {
    fs.copyFileSync(cached, BUILD_PATH);
    console.log("[ensure-native-abi] restored cached ABI " + targetAbi + " binary");
    return;
  }
  const version = electronVersion();
  if (!version) {
    console.warn("[ensure-native-abi] electron not installed — cannot restore ABI " + targetAbi);
    return;
  }
  console.log("[ensure-native-abi] rebuilding Electron ABI " + targetAbi + " (electron " + version + ") — once, then cached");
  if (!buildElectronAbi(version, targetAbi)) {
    console.warn("[ensure-native-abi] Electron rebuild failed — run `npm run rebuild` before launching the app");
    return;
  }
  const after = probeAbi();
  if (!after.loadOk && after.abi !== targetAbi) {
    console.warn("[ensure-native-abi] post-restore probe unexpected: " + JSON.stringify(after));
    return;
  }
  try {
    copyBinaryTo(targetAbi, BUILD_PATH);
  } catch {
    /* cache is an optimization only */
  }
}

function resolveVitestBin() {
  // The vitest package exports map may hide ./vitest.mjs — go through the
  // package.json (publicly resolved) and follow its bin field.
  const pkgJson = resolveBin("vitest/package.json");
  if (!pkgJson) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
    const rel = typeof meta.bin === "string" ? meta.bin : meta.bin && meta.bin.vitest;
    if (!rel) return null;
    return path.join(path.dirname(pkgJson), rel.replace(/^\.\//, ""));
  } catch {
    return null;
  }
}

function runTests(args, restoreTo) {
  const vitestBin = resolveVitestBin();
  if (!vitestBin) {
    console.error("[ensure-native-abi] vitest not found (run npm install first)");
    if (restoreTo !== null) {
      try {
        restoreAbi(restoreTo);
      } catch (error) {
        console.warn("[ensure-native-abi] restore failed:", error);
      }
    }
    return 1;
  }
  let status = 1;
  try {
    const res = spawnSync(process.execPath, [vitestBin, ...args], {
      cwd: ROOT,
      stdio: "inherit",
    });
    status = typeof res.status === "number" ? res.status : 1;
  } finally {
    if (restoreTo !== null) {
      try {
        restoreAbi(restoreTo);
      } catch (error) {
        console.warn("[ensure-native-abi] restore failed:", error);
      }
    }
  }
  return status;
}

function main() {
  const vitestArgs = process.argv.slice(2);
  const initial = probeAbi();

  // Nothing to do when Node can already load the binary (CI, or a previous
  // aborted restore): run tests, leave the ABI untouched.
  if (initial.loadOk) {
    return runTests(vitestArgs, null);
  }

  if (initial.abi === null) {
    console.error("[ensure-native-abi] better-sqlite3 fails to load for a non-ABI reason:");
    console.error("  " + initial.err);
    console.error("Try: npm rebuild better-sqlite3");
    return 1;
  }

  const previousAbi = initial.abi; // typically the Electron ABI
  if (!electronVersion()) {
    console.error("[ensure-native-abi] electron missing; refusing to switch ABI (no restore path)");
    return 1;
  }
  console.log("[ensure-native-abi] current binary ABI " + previousAbi + " — switching to Node ABI " + process.versions.modules);

  savePreSwitchBackup();

  const nodeCached = path.join(CACHE_DIR, NATIVE_FILE + "." + process.versions.modules);
  if (fs.existsSync(nodeCached)) {
    fs.copyFileSync(nodeCached, BUILD_PATH);
  } else if (!buildNodeAbi()) {
    console.error("[ensure-native-abi] could not build better-sqlite3 for the Node ABI");
    restorePreSwitchBackup();
    return 1;
  }
  if (!probeAbi().loadOk) {
    console.error("[ensure-native-abi] Node-ABI build did not produce a loadable binary");
    restorePreSwitchBackup();
    return 1;
  }
  try {
    copyBinaryTo(process.versions.modules, BUILD_PATH);
  } catch {
    /* cache is an optimization only */
  }

  const status = runTests(vitestArgs, previousAbi);
  clearPreSwitchBackup();
  return status;
}

process.exitCode = main();
