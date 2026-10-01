import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Installer artifacts must never reach git. Each macOS DMG is ~313MB, so one
 * accidental `git add` inflates every clone in the project. `release/` covers
 * electron-builder's default output directory; the type-based rules cover a
 * build run with a custom `directories.output` or a hand-copied artifact.
 */
describe('gitignore — build artifacts', () => {
  const root = process.cwd();
  const gitignore = fs.readFileSync(path.resolve(root, '.gitignore'), 'utf8');

  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  /** Paths git considers ignored; check-ignore prints one match per argument. */
  function ignoredPaths(...paths: string[]): string[] {
    return execFileSync('git', ['check-ignore', '--no-index', ...paths], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  }

  it('ignores DMGs and other installer artifacts by type', () => {
    for (const pattern of ['*.dmg', '*.dmg.blockmap', '*.pkg', '*.exe', '*.msi', '*.AppImage']) {
      expect(gitignore).toContain(pattern);
    }
  });

  it('ignores DMGs produced outside the default release directory', () => {
    expect(ignoredPaths('out/custom-build.dmg')).toEqual(['out/custom-build.dmg']);
  });

  it('ignores the electron-builder output directory itself', () => {
    expect(ignoredPaths('release/anything.dmg')).toEqual(['release/anything.dmg']);
  });

  it('does not newly ignore any file that is already tracked', () => {
    // A new rule that matches a tracked file would make it behave as deleted
    // in future checkouts — silent data loss for whoever clones next.
    const offenders = execFileSync(
      'git',
      ['ls-files', '-z', '--', '*.dmg', '*.pkg', '*.exe', '*.msi', '*.AppImage', '*.zip', '*.app'],
      { cwd: root, encoding: 'utf8' }
    )
      .split('\0')
      .filter(Boolean);

    expect(offenders).toEqual([]);
    expect(tracked.length).toBeGreaterThan(0);
  });

  it('never tracks an installer artifact today', () => {
    const artifacts = tracked.filter((file) =>
      /\.(dmg|pkg|exe|msi|appimage|zip|app)$/i.test(file)
    );
    expect(artifacts).toEqual([]);
  });
});
