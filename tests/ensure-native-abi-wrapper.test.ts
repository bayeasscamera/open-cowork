import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const wrapper = readFileSync(resolve(root, 'scripts/ensure-native-abi.js'), 'utf8');

describe('ensure-native-abi test wrapper', () => {
  it('routes npm test and coverage through the wrapper, keeps an escape hatch', () => {
    expect(pkg.scripts.test).toBe('node scripts/ensure-native-abi.js');
    expect(pkg.scripts['test:coverage']).toBe('node scripts/ensure-native-abi.js run --coverage');
    expect(pkg.scripts['test:raw']).toBe('vitest');
  });

  it('is a no-op pass-through when Node can already load the binary', () => {
    const main = wrapper.match(/function main\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(main).toContain('if (initial.loadOk)');
    // pass-through branch must NOT schedule a restore
    const passThrough = main.slice(main.indexOf('if (initial.loadOk)'), main.indexOf('if (initial.loadOk)') + 120);
    expect(passThrough).toContain('runTests(vitestArgs, null)');
  });

  it('restores the previous ABI in a finally block so failures cannot leak state', () => {
    const runTests = wrapper.match(/function runTests\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(runTests).toContain('} finally {');
    const finallyIndex = runTests.indexOf('} finally {');
    expect(finallyIndex).toBeGreaterThan(-1);
    expect(runTests.slice(finallyIndex)).toContain('restoreAbi(restoreTo)');
  });

  it('caches built binaries per ABI to avoid recompiling on every switch', () => {
    expect(wrapper).toContain('.cowork-abi-cache');
    expect(wrapper).toContain('copyBinaryTo');
  });

  it('rebuilds the Electron target with node-gyp using electron headers', () => {
    expect(wrapper).toContain('--runtime=electron');
    expect(wrapper).toContain('--dist-url=https://electronjs.org/headers');
    expect(wrapper).toContain('--release');
  });

  it('saves a pre-switch backup and restores it on failure paths', () => {
    expect(wrapper).toContain('preswitch-backup');
    const main = wrapper.match(/function main\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    // Backup must be taken before any binary replacement.
    const backupIndex = main.indexOf('savePreSwitchBackup()');
    const firstCopy = main.indexOf('fs.copyFileSync(nodeCached, BUILD_PATH)');
    expect(backupIndex).toBeGreaterThan(-1);
    expect(firstCopy).toBeGreaterThan(backupIndex);
    // Both failure paths must restore the pre-switch binary.
    expect(main).toContain('restorePreSwitchBackup();\n    return 1;');
    // The sentinel is only cleared after tests and restore both completed.
    const clearIndex = main.indexOf('clearPreSwitchBackup()');
    expect(clearIndex).toBeGreaterThan(main.indexOf('runTests(vitestArgs, previousAbi)'));
  });

  it('pre-push gate runs the wrapper and checks its exit code (no silent pipes)', () => {
    const hook = readFileSync(resolve(root, '.husky/pre-push'), 'utf8');
    expect(hook).toContain('node scripts/ensure-native-abi.js run');
    expect(hook).not.toContain('tail -30');
  });
});
