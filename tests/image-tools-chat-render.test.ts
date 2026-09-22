import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

// The main-side image tools pull the persisted config store; stub it so the
// renderer render below runs without Electron.
vi.mock('../src/main/config/config-store', () => ({
  configStore: { getAll: vi.fn(), getConfigSetProjectedConfig: vi.fn() },
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { buildImageTools } from '../src/main/agent/image-tools';
import { normalizeToolExecutionResultForUi } from '../src/main/agent/tool-result-utils';
import { ToolUseBlock } from '../src/renderer/components/message/ToolUseBlock';
import { MessageCard } from '../src/renderer/components/MessageCard';
import type { ContentBlock, Message, ToolResultContent, ToolUseContent } from '../src/shared/types';

// A real 1x1 PNG — the exact bytes a provider would hand back.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const dirs: string[] = [];
let workspace = '';

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error('missing tool: ' + name);
  return found;
}

async function runTool(tool: ToolDefinition, params: Record<string, unknown>): Promise<unknown> {
  const execute = tool.execute as unknown as (
    id: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  return execute('call-1', params);
}

function appConfig(model: string) {
  return {
    provider: 'openai',
    model,
    apiKey: 'test-key',
    imageGeneration: { configSetId: '', costConfirmThresholdUsd: 1 },
  };
}

/**
 * Render a tool result through the REAL chat path: the raw tool result goes
 * through the production normalizer (tool-result-utils) into the same
 * ToolResultContent the runner sends, then the actual ToolUseBlock renders it.
 * This is the proof that the image is visual in the chat, not a file path.
 */
function renderToolInChat(
  name: string,
  input: Record<string, unknown>,
  rawResult: unknown
): string {
  const normalized = normalizeToolExecutionResultForUi(rawResult);
  const use: ToolUseContent = { type: 'tool_use', id: 'call-1', name, input };
  const result: ToolResultContent = {
    type: 'tool_result',
    toolUseId: 'call-1',
    content: normalized.content,
    images: normalized.images,
  };
  const allBlocks: ContentBlock[] = [use, result];
  return renderToStaticMarkup(React.createElement(ToolUseBlock, { block: use, allBlocks }));
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'cowork-chat-render-'));
  dirs.push(workspace);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('generated images appear VISUALLY in the chat', () => {
  it('carries the provider bytes through the normalizer into an <img> data: URI', async () => {
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-generate',
        cwd: workspace,
        getAppConfig: () => appConfig('dall-e-2'),
        generate: async () => ({
          base64: PNG_BASE64,
          mimeType: 'image/png' as const,
          model: 'dall-e-2',
          provider: 'openai',
        }),
      }),
      'generate_image'
    );

    const raw = await runTool(tool, { prompt: 'A red cube' });
    const html = renderToolInChat('generate_image', { prompt: 'A red cube' }, raw);

    expect(html).toContain('<img');
    expect(html).toContain('data:image/png;base64,' + PNG_BASE64);
  });

  it('renders through the real chat message card (ChatView -> MessageCard)', async () => {
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-card',
        cwd: workspace,
        getAppConfig: () => appConfig('dall-e-2'),
        generate: async () => ({
          base64: PNG_BASE64,
          mimeType: 'image/png' as const,
          model: 'dall-e-2',
          provider: 'openai',
        }),
      }),
      'generate_image'
    );

    const raw = await runTool(tool, { prompt: 'A red cube' });
    const normalized = normalizeToolExecutionResultForUi(raw);
    const message: Message = {
      id: 'm1',
      sessionId: 's-card',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call-1', name: 'generate_image', input: { prompt: 'A red cube' } },
        {
          type: 'tool_result',
          toolUseId: 'call-1',
          content: normalized.content,
          images: normalized.images,
        },
      ],
      timestamp: Date.now(),
    };

    const html = renderToStaticMarkup(React.createElement(MessageCard, { message }));
    expect(html).toContain('<img');
    expect(html).toContain('data:image/png;base64,' + PNG_BASE64);
  });
});

describe('analysed images appear VISUALLY in the chat', () => {
  it('shows the analysed workspace image inline next to the model answer', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(workspace, 'photo.png'), Buffer.from(PNG_BASE64, 'base64'));

    const tool = toolByName(
      buildImageTools({
        sessionId: 's-vision',
        cwd: workspace,
        getAppConfig: () => appConfig('gpt-4o'),
        vision: async () => 'A 1x1 red square.',
      }),
      'analyze_image'
    );

    const raw = await runTool(tool, { path: 'photo.png' });
    const html = renderToolInChat('analyze_image', { path: 'photo.png' }, raw);

    expect(html).toContain('data:image/png;base64,' + PNG_BASE64);
  });
});
