import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultResourceLoader } from '@mariozechner/pi-coding-agent';

describe('AGENTS.md native support (SDK resource loader)', () => {
  it('discovers and loads AGENTS.md from the project root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-agents-md-'));
    try {
      writeFileSync(
        join(dir, 'AGENTS.md'),
        '# Conventions projet test\nToujours répondre en français.'
      );
      // pi-coding-agent 0.73 made `agentDir` required (it lost its internal
      // `?? getAgentDir()` fallback). The loader reads skills from there; this
      // test only exercises AGENTS.md discovery, so pointing it at the temp
      // project dir keeps the fixture self-contained.
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir });
      await loader.reload();
      const agentsFiles = loader.getAgentsFiles().agentsFiles;
      expect(agentsFiles.some((f) => f.content.includes('Conventions projet test'))).toBe(true);
      // getAppendSystemPrompt() stays empty: the SDK injects agentsFiles into
      // the system prompt inside createAgentSession, not via append parts.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
