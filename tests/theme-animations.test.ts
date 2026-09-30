import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf-8');

const collectSources = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
};

/**
 * `animate-in`, `fade-in`, `zoom-in-95` and friends come from
 * `tailwindcss-animate`, which is NOT installed here — every one of those
 * classes is a silent no-op. The theme's own `fade-in` / `scale-in`
 * animations provide the same visuals and actually run.
 */
describe('real theme animations replace the no-op tailwindcss-animate classes', () => {
  it('does not depend on tailwindcss-animate', () => {
    const pkg = read('package.json');
    expect(pkg).not.toContain('tailwindcss-animate');
  });

  it('defines the fade and scale animations in the theme', () => {
    const tailwind = read('tailwind.config.js');
    expect(tailwind).toContain("'fade-in'");
    expect(tailwind).toContain("'scale-in'");
    expect(tailwind).toContain('fadeIn');
    expect(tailwind).toContain('scaleIn');
  });

  it('animates the artifact modal backdrop and card', () => {
    const modal = read('src/renderer/components/ArtifactModal.tsx');
    expect(modal).toContain('animate-fade-in');
    expect(modal).toContain('animate-scale-in');
  });

  it('animates the popover menus with the scale-in utility', () => {
    for (const file of [
      'src/renderer/components/Sidebar.tsx',
      'src/renderer/components/ChatView.tsx',
      'src/renderer/components/WelcomeView.tsx',
    ] as const) {
      expect(read(file)).toContain('animate-scale-in');
    }
  });

  it('leaves no silent no-op animation class anywhere in the renderer', () => {
    // Bare `fade-in` counts only when NOT prefixed by `animate-`.
    const noOpClass = /(?<![\w-])animate-in(?![\w-])|(?<![\w-])zoom-in-95(?![\w-])|(?<![\w-])fade-in(?![\w-])/;
    const offenders = collectSources(join(root, 'src/renderer')).filter((file) =>
      noOpClass.test(readFileSync(file, 'utf-8'))
    );
    expect(offenders).toEqual([]);
  });

  it('neutralizes animations under prefers-reduced-motion', () => {
    const globals = read('src/renderer/styles/globals.css');
    expect(globals).toContain('prefers-reduced-motion');
    expect(globals).toContain('animation-duration: 0.01ms !important');
  });
});
