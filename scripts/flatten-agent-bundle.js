#!/usr/bin/env node
/**
 * Flattens a per-platform VM agent bundle produced by tsc.
 *
 * The vm-agent sources live one level above the entry points, so tsc emits
 * `entryDir/index.js` inside the output directory and preserves the source's
 * `../` relative requires. The bundle contract for consumers (wsl-bridge,
 * lima-bridge, preflight, electron-builder) is `dist-<agent>/index.js` at the
 * root, where sibling modules are emitted flat — so we move the entry up and
 * rewrite its `require("../x")` to `require("./x")`.
 *
 * Usage: node scripts/flatten-agent-bundle.js <outDir> <entryDir>
 */
const fs = require('fs');
const path = require('path');

const [outDir, entryDir] = process.argv.slice(2);
if (!outDir || !entryDir) {
  console.error('Usage: node scripts/flatten-agent-bundle.js <outDir> <entryDir>');
  process.exit(1);
}

const emittedEntry = path.join(outDir, entryDir, 'index.js');
const targetEntry = path.join(outDir, 'index.js');

if (!fs.existsSync(emittedEntry)) {
  console.error(`flatten-agent-bundle: entry not found: ${emittedEntry}`);
  process.exit(1);
}

// ../agent -> ./agent (all sibling modules are emitted flat in outDir)
const source = fs.readFileSync(emittedEntry, 'utf8');
const rewritten = source.replace(/require\("\.\.\//g, 'require("./');
fs.writeFileSync(targetEntry, rewritten);
fs.rmSync(path.join(outDir, entryDir), { recursive: true, force: true });
console.log(`flatten-agent-bundle: ${path.join(entryDir, 'index.js')} -> ${path.join(outDir, 'index.js')}`);
