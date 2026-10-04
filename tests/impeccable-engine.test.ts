import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectDesignAntiPatterns,
  readDesignContext,
  initDesignContext,
  runImpeccableDetect,
} from '../src/main/agent/impeccable-engine';

describe('impeccable-engine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('detectDesignAntiPatterns', () => {
    it('detects generic purple-to-blue AI SaaS gradient', () => {
      const code = `<div className="bg-gradient-to-r from-purple-600 to-blue-500 p-4">Header</div>`;
      const findings = detectDesignAntiPatterns(code);
      expect(findings).toHaveLength(1);
      expect(findings[0].rule).toBe('ai-slop-gradient');
      expect(findings[0].severity).toBe('warning');
    });

    it('detects low-contrast gray text on light background', () => {
      const code = `<span className="text-gray-400 bg-gray-100">Subtitle</span>`;
      const findings = detectDesignAntiPatterns(code);
      expect(findings).toHaveLength(1);
      expect(findings[0].rule).toBe('low-contrast-muted');
      expect(findings[0].severity).toBe('error');
    });

    it('detects deeply nested cards', () => {
      const code = `
        <Card>
          <CardHeader>Parent</CardHeader>
          <Card>
            <CardBody>
              <Card>
                <p>Inner content</p>
              </Card>
            </CardBody>
          </Card>
        </Card>
      `;
      const findings = detectDesignAntiPatterns(code);
      expect(findings.some((f) => f.rule === 'deeply-nested-cards')).toBe(true);
    });

    it('honors line-level ignore comments', () => {
      const code = `<div className="bg-gradient-to-r from-purple-600 to-blue-500">Header</div> // impeccable-disable-line ai-slop-gradient`;
      const findings = detectDesignAntiPatterns(code);
      expect(findings).toHaveLength(0);
    });

    it('honors file-level ignore comments', () => {
      const code = `/* impeccable-disable-file */\n<div className="bg-gradient-to-r from-purple-600 to-blue-500">Header</div>`;
      const findings = detectDesignAntiPatterns(code);
      expect(findings).toHaveLength(0);
    });

    it('passes clean UI without findings', () => {
      const code = `
        <div className="bg-surface text-text-primary p-6 border border-border rounded-lg">
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-text-muted mt-1">Overview of recent activity</p>
        </div>
      `;
      const findings = detectDesignAntiPatterns(code);
      expect(findings).toHaveLength(0);
    });
  });

  describe('design context persistence', () => {
    it('reads design context when files are absent', () => {
      const ctx = readDesignContext(tmpDir);
      expect(ctx.hasProductTruth).toBe(false);
      expect(ctx.hasDesignSystem).toBe(false);
    });

    it('scaffolds standard PRODUCT.md and DESIGN.md files', () => {
      const { created } = initDesignContext(tmpDir, 'AcmeApp');
      expect(created).toEqual(['PRODUCT.md', 'DESIGN.md']);

      const ctx = readDesignContext(tmpDir);
      expect(ctx.hasProductTruth).toBe(true);
      expect(ctx.hasDesignSystem).toBe(true);
      expect(ctx.productTruthContent).toContain('AcmeApp — Product Truth');
      expect(ctx.designSystemContent).toContain('AcmeApp — Design System');
    });

    it('does not overwrite existing files during init', () => {
      fs.writeFileSync(path.join(tmpDir, 'PRODUCT.md'), '# Custom Truth', 'utf-8');
      const { created } = initDesignContext(tmpDir, 'AcmeApp');
      expect(created).toEqual(['DESIGN.md']); // Only DESIGN.md created

      const ctx = readDesignContext(tmpDir);
      expect(ctx.productTruthContent).toBe('# Custom Truth');
    });
  });

  describe('runImpeccableDetect fallback', () => {
    it('gracefully scans file using in-memory engine when launcher is offline/absent', async () => {
      const testFile = path.join(tmpDir, 'BadComponent.tsx');
      fs.writeFileSync(
        testFile,
        `<button className="bg-gradient-to-r from-purple-500 to-blue-600">Click</button>`,
        'utf-8'
      );

      const findings = await runImpeccableDetect(testFile, tmpDir);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0].rule).toBe('ai-slop-gradient');
    });

    it('returns empty array for nonexistent target', async () => {
      const findings = await runImpeccableDetect('nonexistent.tsx', tmpDir);
      expect(findings).toEqual([]);
    });
  });
});
