/**
 * Rebuild the better-sqlite3 native binary for the installed Electron runtime.
 *
 * Why not `npm rebuild --runtime=electron ...`: npm >= 12 rejects unknown CLI
 * flags (EUNKNOWNCONFIG) and refuses to run install scripts that are not
 * allow-listed (EALLOWSCRIPTS), so `npm rebuild` can no longer drive the
 * rebuild. We therefore call prebuild-install / node-gyp directly — the same
 * path scripts/ensure-native-abi.js uses for its ABI restores.
 *
 * better-sqlite3 >= 13 is built on Node-API (`NAPI_VERSION=10` in its
 * binding.gyp, `node-addon-api` in include_dirs), so ONE binary serves both
 * Node and Electron — there is no Electron-specific ABI to build. Verified by
 * loading the shipped prebuild inside Electron 44 (ABI 149) and Node 22
 * (ABI 127): both open a database and round-trip a row.
 *
 * That changes what a successful run looks like. The old script treated "the
 * binary loads from plain Node" as proof of the wrong runtime and failed; for a
 * Node-API module it is the expected outcome. It also means the build output is
 * often never read: `lib/binding.js` prefers `prebuilds/<platform>-<arch>.node`
 * over `build/Release/`, and `lib/<platform>-<arch>.js` hardcodes the prebuild
 * with no fallback at all. So when a prebuild for this host exists, compiling
 * is work whose result the loader ignores — we stop before it.
 *
 * Usage:  node scripts/rebuild-native.js
 * Wired to:  npm run rebuild  (also called by postinstall)
 */

'use strict';

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PKG_DIR = path.join(ROOT, "node_modules", "better-sqlite3");

/**
 * The prebuilt binding this host would actually load, mirroring the loader's
 * own resolution in `lib/binding.js` (platform/arch support list, and the
 * musl-specific name on Linux). Null when the host has no prebuild.
 */
function hostPrebuildPath() {
  let platform = process.platform;
  if (platform === "linux") {
    try {
      if (!process.report.getReport().header.glibcVersionRuntime) {
        platform = "linuxmusl";
      }
    } catch {
      /* no report available — assume glibc */
    }
  }
  if (!["linux", "linuxmusl", "darwin", "win32"].includes(platform)) return null;
  if (!["x64", "arm64"].includes(process.arch)) return null;
  const candidate = path.join(PKG_DIR, "prebuilds", platform + "-" + process.arch + ".node");
  return fs.existsSync(candidate) ? candidate : null;
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
  // Node-API: one binary, both runtimes. When the package ships a prebuild for
  // this host, the loader prefers it and ignores anything node-gyp writes to
  // build/Release/ — so a rebuild would be a no-op that only costs time.
  const prebuild = hostPrebuildPath();
  if (prebuild) {
    console.log(
      "[rebuild-native] Node-API prebuild present (" +
        path.relative(ROOT, prebuild) +
        ") — no Electron-specific rebuild needed"
    );
    return 0;
  }

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
  // A Node-API binary is expected to load from plain Node as well — that is no
  // longer a sign of the wrong runtime, only failing to load is. See the header.
  const probe = probeAbi();
  if (!probe.loadOk) {
    console.error("[rebuild-native] rebuilt binary does not load: " + probe.err);
    return 1;
  }
  console.log(
    "[rebuild-native] rebuilt Node-API binary (ABI " + probe.abi + ") for Electron " + version
  );
  return 0;
}

process.exitCode = main();