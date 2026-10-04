/**
 * @module main/agent/impeccable-engine
 *
 * Robust helper and deterministic fallback engine for the Impeccable design system.
 * Features:
 * - Scaffolding and persistence of durable product truth (PRODUCT.md) and design systems (DESIGN.md)
 * - Deterministic pure TypeScript anti-pattern detector (offline / sandbox fallback without requiring the Rust binary)
 * - Execution bridge for the Impeccable CLI launcher with bounded timeouts and graceful degradation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { log, logWarn } from '../utils/logger';

export interface DesignFinding {
  rule: string;
  severity: 'error' | 'warning' | 'advisory';
  message: string;
  line?: number;
  sample?: string;
}

export interface DesignContext {
  hasProductTruth: boolean;
  hasDesignSystem: boolean;
  productTruthContent?: string;
  designSystemContent?: string;
}

export const DETERMINISTIC_DESIGN_RULES = [
  {
    id: 'ai-slop-gradient',
    severity: 'warning' as const,
    pattern: /(?:bg-gradient-to-[a-z]+|linear-gradient\([^)]+\)).*?(?:from-purple-\d+\s+to-blue-\d+|from-indigo-\d+\s+to-purple-\d+|#8B5CF6.*?#3B82F6)/i,
    message: 'Generic purple-to-blue AI SaaS gradient detected. Choose a purposeful color palette aligned with the brand.',
  },
  {
    id: 'overused-inter-font',
    severity: 'advisory' as const,
    pattern: /font-family:\s*['"]?Inter['"]?/i,
    message: 'Default Inter font detected without custom typographic hierarchy. Consider distinctive typography.',
  },
  {
    id: 'deeply-nested-cards',
    severity: 'warning' as const,
    pattern: /(?:<Card[\s\S]*?<Card[\s\S]*?<Card|<div[^>]*class="[^"]*card[^"]*"[\s\S]*?<div[^>]*class="[^"]*card[^"]*"[\s\S]*?<div[^>]*class="[^"]*card[^"]*")/i,
    message: 'Deeply nested card hierarchy (cards inside cards inside cards). Flatten the structure with dividers or white space.',
  },
  {
    id: 'low-contrast-muted',
    severity: 'error' as const,
    pattern: /text-gray-400\s+(?:bg-gray-100|bg-slate-100|bg-zinc-100)/i,
    message: 'Unreadable low-contrast text (gray-400 on light gray background). Ensure WCAG AA contrast ratio.',
  },
  {
    id: 'unbounded-table',
    severity: 'warning' as const,
    pattern: /<table(?![\s\S]*?overflow-x-auto)/i,
    message: 'Table element without responsive horizontal overflow containment.',
  },
  {
    id: 'neon-glow-effect',
    severity: 'advisory' as const,
    pattern: /box-shadow:\s*0\s+0\s+(?:1[5-9]|[2-9]\d)px\s+rgba\(\s*(?:147|168|59)/i,
    message: 'Generic neon glow effect detected. Prefer subtle elevation or clean border boundaries.',
  },
];

/**
 * Deterministically scans code or text for AI-generated design tells and anti-patterns.
 * Runs completely in memory, zero dependencies, <1ms.
 */
export function detectDesignAntiPatterns(content: string, _filename?: string): DesignFinding[] {
  const findings: DesignFinding[] = [];
  const lines = content.split('\n');

  // Check file-level ignore
  if (content.includes('impeccable-disable *') || content.includes('impeccable-disable-file')) {
    return [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check line-level ignore
    if (line.includes('impeccable-disable-line') || line.includes('impeccable-disable-next-line')) {
      continue;
    }
    if (i > 0 && lines[i - 1].includes('impeccable-disable-next-line')) {
      continue;
    }

    for (const rule of DETERMINISTIC_DESIGN_RULES) {
      if (line.includes(`impeccable-disable ${rule.id}`)) continue;

      if (rule.pattern.test(line)) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          message: rule.message,
          line: i + 1,
          sample: line.trim().slice(0, 100),
        });
      }
    }
  }

  // Multi-line patterns (e.g. nested cards)
  for (const rule of DETERMINISTIC_DESIGN_RULES) {
    if (rule.pattern.multiline || rule.pattern.flags.includes('m') || rule.id === 'deeply-nested-cards') {
      if (rule.pattern.test(content) && !content.includes(`impeccable-disable ${rule.id}`)) {
        if (!findings.some((f) => f.rule === rule.id)) {
          findings.push({
            rule: rule.id,
            severity: rule.severity,
            message: rule.message,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Checks and reads durable design context in the workspace (PRODUCT.md and DESIGN.md).
 */
export function readDesignContext(workspaceDir: string): DesignContext {
  const productPath = path.join(workspaceDir, 'PRODUCT.md');
  const designPath = path.join(workspaceDir, 'DESIGN.md');

  const hasProduct = fs.existsSync(productPath);
  const hasDesign = fs.existsSync(designPath);

  let productTruthContent: string | undefined;
  let designSystemContent: string | undefined;

  if (hasProduct) {
    try {
      productTruthContent = fs.readFileSync(productPath, 'utf-8');
    } catch (err) {
      logWarn('[ImpeccableEngine] Could not read PRODUCT.md:', err);
    }
  }

  if (hasDesign) {
    try {
      designSystemContent = fs.readFileSync(designPath, 'utf-8');
    } catch (err) {
      logWarn('[ImpeccableEngine] Could not read DESIGN.md:', err);
    }
  }

  return {
    hasProductTruth: hasProduct,
    hasDesignSystem: hasDesign,
    productTruthContent,
    designSystemContent,
  };
}

/**
 * Scaffolds standard PRODUCT.md and DESIGN.md templates if missing in workspace.
 */
export function initDesignContext(workspaceDir: string, productName = 'Project'): { created: string[] } {
  const created: string[] = [];
  const productPath = path.join(workspaceDir, 'PRODUCT.md');
  const designPath = path.join(workspaceDir, 'DESIGN.md');

  if (!fs.existsSync(productPath)) {
    const template = `# ${productName} — Product Truth

## Audience & Purpose
- Target user: 
- Core problem solved: 
- Key value proposition: 

## Voice & Tone
- Expert, decisive, reliable.
- Avoid hollow superlatives and filler text.

## Constraints & Requirements
- Operating platforms: Web, Desktop
- Performance: First paint < 1s, interactive < 2s
`;
    fs.writeFileSync(productPath, template, 'utf-8');
    created.push('PRODUCT.md');
  }

  if (!fs.existsSync(designPath)) {
    const template = `# ${productName} — Design System & Visual Direction

## Visual Direction
- Theme: Clean, high-density productivity
- Contrast: WCAG AA compliant

## Color Palette Tokens
- Background: Surface tokens (dark/light)
- Accents: High-intent action colors (no generic gradients)
- Borders: Subtle structural separators

## Typography
- Scale: 12px (caption), 14px (body), 16px (subhead), 20px (heading), 24px (title)
- Weight: Regular (400), Medium (500), Semibold (600)
`;
    fs.writeFileSync(designPath, template, 'utf-8');
    created.push('DESIGN.md');
  }

  return { created };
}

/**
 * Runs the Impeccable CLI detector with an automatic timeout and fallback to the in-memory detector.
 */
export async function runImpeccableDetect(
  targetPath: string,
  workspaceDir: string,
  timeoutMs = 5000
): Promise<DesignFinding[]> {
  const resolvedTarget = path.isAbsolute(targetPath) ? targetPath : path.join(workspaceDir, targetPath);

  // If target file doesn't exist, return empty
  if (!fs.existsSync(resolvedTarget)) {
    return [];
  }

  // Path to the bundled launcher
  const launcherPath = path.join(process.cwd(), '.claude', 'skills', 'impeccable', 'scripts', 'impeccable');

  if (fs.existsSync(launcherPath)) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const proc = execFile(
          launcherPath,
          ['detect', '--json', resolvedTarget],
          { cwd: workspaceDir, timeout: timeoutMs },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          }
        );
        proc.on('error', reject);
      });

      const parsed = JSON.parse(output || '[]') as DesignFinding[];
      return parsed;
    } catch {
      // Launcher failed (offline / no binary / permissions) -> gracefully use in-memory detector
      log('[ImpeccableEngine] Launcher unavailable, using in-memory deterministic fallback');
    }
  }

  // Fallback to in-memory scanner
  try {
    const stat = fs.statSync(resolvedTarget);
    if (stat.isFile()) {
      const content = fs.readFileSync(resolvedTarget, 'utf-8');
      return detectDesignAntiPatterns(content, path.basename(resolvedTarget));
    }
  } catch (err) {
    logWarn('[ImpeccableEngine] Error reading file for detection:', err);
  }

  return [];
}
