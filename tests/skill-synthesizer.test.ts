import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillSynthesizer } from '../src/main/skills/skill-synthesizer';
import * as sdkOneShot from '../src/main/agent/sdk-one-shot';
import type { Message } from '../src/shared/types';

describe('SkillSynthesizer', () => {
  let tmpDir: string;
  let synthesizer: SkillSynthesizer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-synth-test-'));
    synthesizer = new SkillSynthesizer(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('skips evaluation for trivial short messages without tools', async () => {
    const messages: Message[] = [
      {
        id: '1',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        timestamp: Date.now(),
      },
      {
        id: '2',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi! How can I help?' }],
        timestamp: Date.now(),
      },
    ];

    const result = await synthesizer.evaluateAndSynthesize('hello', messages, false);
    expect(result).toBeNull();
  });

  it('synthesizes and persists a skill when LLM judges it worthy', async () => {
    const messages: Message[] = [
      {
        id: '1',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'text', text: 'Deploy to Cloud Run with custom secrets' }],
        timestamp: Date.now(),
      },
      {
        id: '2',
        sessionId: 's1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'bash',
            input: { command: 'gcloud run deploy' },
          },
          {
            type: 'text',
            text: 'Successfully configured service and secrets',
          },
        ],
        timestamp: Date.now(),
      },
    ];

    vi.spyOn(sdkOneShot, 'runPiAiOneShot').mockResolvedValueOnce({
      text: JSON.stringify({
        shouldCreateSkill: true,
        reasoning: 'Complex deployment procedure requiring specific flags',
        name: 'gcloud-run-deploy',
        description: 'Deploy services to Cloud Run with custom secrets',
        content: '---\nname: gcloud-run-deploy\ndescription: Deploy services\n---\n# Cloud Run Deploy',
      }),
      hasThinking: false,
      durationMs: 100,
    });

    const result = await synthesizer.evaluateAndSynthesize(
      'Deploy to Cloud Run with custom secrets',
      messages,
      false
    );

    expect(result).not.toBeNull();
    expect(result?.created).toBe(true);
    expect(result?.name).toBe('gcloud-run-deploy');
    expect(fs.existsSync(result!.skillPath)).toBe(true);

    const savedContent = fs.readFileSync(result!.skillPath, 'utf-8');
    expect(savedContent).toContain('gcloud-run-deploy');
  });
});
