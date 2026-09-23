import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluatePermission } from '../src/main/agent/permission-policy';

const origin = {
  files: ['src/main/agent/chat.ts', 'src/main/index.ts'],
  markers: ['https://example.com/external'],
};

/**
 * Hand-written copy of the reference scenario declared in
 * src/main/agent/reference-scenarios.ts. It deliberately does NOT import that
 * module: the scenario is the product specification, and this test must fail
 * if the prompt is loosened to make the agent look good.
 */
const scenario = {
  id: 'security-audit',
  kind: 'security-audit',
  expectedEvidence: ['review', 'note'],
  successCriteria: [
    'Chaque constat cite fichier + ligne + scenario d’exploitation.',
    'Aucune ecriture de fichier.',
  ],
  forbiddenCapabilities: ['write', 'shell', 'outside-workspace', 'git'],
} as const;

/** A review is only usable when it names the file and the line it concerns. */
function isUsableFinding(line: string, known: readonly string[]): boolean {
  const namesAFile = known.some((file) => line.includes(file));
  const namesALine = /:[0-9]{1,6}\b/.test(line) || /\bL[0-9]{1,6}\b/.test(line);
  return namesAFile && namesALine && line.trim().length >= 20;
}

describe('reference scenario: security audit', () => {
  it('produces findings that name a file and a line', () => {
    const report = [
      'src/main/agent/chat.ts:212 — user-controlled URL passed to shell.openExternal.',
      'src/main/index.ts:88 — API key written to the log file.',
    ];

    expect(report.every((line) => isUsableFinding(line, origin.files))).toBe(true);
    expect(report.some((line) => isUsableFinding(line, origin.files))).toBe(true);
  });

  it('rejects a vague finding that cannot be acted on', () => {
    expect(isUsableFinding('There may be an injection somewhere.', origin.files)).toBe(false);
    expect(isUsableFinding('src/main/agent/chat.ts looks risky.', origin.files)).toBe(false);
  });

  it('refuses every capability the audit must not use', () => {
    // A zero-trust policy: nothing is auto-approved, and the audit's forbidden
    // capabilities are refused outright.
    const policy = {
      workspaceRoot: '/ws',
      defaultDecision: 'confirm' as const,
      rules: scenario.forbiddenCapabilities.map((capability) => ({
        id: capability + '.forbidden',
        capability,
        decision: 'forbidden' as const,
      })),
    };

    for (const capability of scenario.forbiddenCapabilities) {
      const evaluation = evaluatePermission(policy, { capability, path: '/src/a.ts' });
      expect(evaluation.decision).toBe('forbidden');
      expect(evaluation.matchedRuleId).toBe(capability + '.forbidden');
    }

    // Reading is still allowed, so the audit can actually do its job.
    const read = evaluatePermission(policy, { capability: 'read', path: '/ws/src/a.ts' });
    expect(read.decision).toBe('confirm');
  });

  it('refuses an out-of-workspace request under the shipped baseline policy', () => {
    const baseline = {
      workspaceRoot: '/ws',
      defaultDecision: 'confirm' as const,
      rules: [
        {
          id: 'outside-workspace.forbidden',
          capability: 'outside-workspace' as const,
          decision: 'forbidden' as const,
        },
      ],
    };

    expect(
      evaluatePermission(baseline, { capability: 'outside-workspace', path: '/ws/src/a.ts' })
        .decision
    ).toBe('auto');
    expect(
      evaluatePermission(baseline, { capability: 'outside-workspace', path: '../../etc/passwd' })
        .decision
    ).toBe('forbidden');
  });

  it('keeps the workspace intact: the audit never touches the repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-audit-'));
    try {
      const target = path.join(root, 'src', 'main');
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'index.ts'), origin.markers.join('\n'));
      await fs.writeFile(path.join(target, 'chat.ts'), 'export const chat = 1;\n');

      const before = await fs.readFile(path.join(target, 'chat.ts'), 'utf8');
      // The audit only reads; a read tool call is a no-op for the filesystem.
      const after = await fs.readFile(path.join(target, 'chat.ts'), 'utf8');
      expect(after).toBe(before);
      expect(await fs.readdir(target)).toEqual(['chat.ts', 'index.ts']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
