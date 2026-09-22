import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolUseBlock } from '../src/renderer/components/message/ToolUseBlock';
import { shouldAutoExpandToolResult } from '../src/renderer/utils/tool-result-summary';
import type { ContentBlock, ToolResultContent, ToolUseContent } from '../src/shared/types';

// A real 1x1 PNG: the same bytes the tool would return from the provider.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function toolUse(name: string, input: Record<string, unknown>): ToolUseContent {
  return { type: 'tool_use', id: 'call-1', name, input };
}

function toolResult(content: string, withImage: boolean): ToolResultContent {
  return {
    type: 'tool_result',
    toolUseId: 'call-1',
    content,
    ...(withImage ? { images: [{ data: PNG_BASE64, mimeType: 'image/png' }] } : {}),
  };
}

function render(name: string, content: string, withImage: boolean): string {
  const use = toolUse(name, { prompt: 'A red cube', path: 'photo.png' });
  const result = toolResult(content, withImage);
  const allBlocks: ContentBlock[] = [use, result];
  return renderToStaticMarkup(
    React.createElement(ToolUseBlock, { block: use, allBlocks })
  );
}

describe('image tool results are rendered VISUALLY in the chat', () => {
  it('renders a generated image as an <img> with a data: URI, not just a file path', () => {
    const html = render('generate_image', 'Generated 1 image with gpt-image-1.\nPath: generated-images/red-cube.png', true);
    expect(html).toContain('<img');
    expect(html).toContain('data:image/png;base64,' + PNG_BASE64);
  });

  it('renders an analysed image inline as well', () => {
    const html = render('analyze_image', 'A red square on white.', true);
    expect(html).toContain('<img');
    expect(html).toContain('data:image/png;base64,' + PNG_BASE64);
  });

  it('leaves an ordinary tool result collapsed, so the picture only appears for image tools', () => {
    const html = render('bash', 'ls -la', true);
    expect(html).not.toContain('data:image/png;base64,' + PNG_BASE64);
  });
});

describe('shouldAutoExpandToolResult', () => {
  it('auto-expands only the two image-deliverable tools', () => {
    expect(shouldAutoExpandToolResult('generate_image', true)).toBe(true);
    expect(shouldAutoExpandToolResult('analyze_image', true)).toBe(true);
    expect(shouldAutoExpandToolResult('bash', true)).toBe(false);
    expect(shouldAutoExpandToolResult('screen_capture', true)).toBe(false);
    expect(shouldAutoExpandToolResult('generate_image', false)).toBe(false);
    expect(shouldAutoExpandToolResult(undefined, true)).toBe(false);
  });
});

describe('the images settings expose ANY provider', () => {
  it('offers an any-provider source with provider, protocol, base URL, key and model fields', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/components/settings/SettingsImages.tsx'),
      'utf8'
    );
    expect(source).toContain("sourceCustom");
    expect(source).toContain('PROVIDER_OPTIONS');
    expect(source).toContain('api.images.providerLabel');
    expect(source).toContain('api.images.protocolLabel');
    expect(source).toContain('api.images.baseUrlLabel');
    expect(source).toContain('api.images.apiKeyLabel');
    expect(source).toContain('api.images.modelLabel');
  });

  it('has every new string translated in en, fr and zh', () => {
    const keys = [
      'sourceLabel',
      'sourceInherit',
      'sourceConfigSet',
      'sourceCustom',
      'providerLabel',
      'protocolLabel',
      'baseUrlLabel',
      'apiKeyLabel',
      'apiKeyPlaceholder',
      'modelLabel',
      'modelPlaceholder',
      'providerHint',
    ];
    for (const locale of ['en', 'fr', 'zh']) {
      const json = JSON.parse(
        readFileSync(join(process.cwd(), 'src/renderer/i18n/locales', locale + '.json'), 'utf8')
      ) as { api: { images: Record<string, string> } };
      for (const key of keys) {
        expect(json.api.images[key], locale + '.' + key).toBeTruthy();
      }
    }
  });
});

describe('the agent runtime actually exposes the image tools', () => {
  it('registers analyze_image + generate_image as native custom tools', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/agent/agent-runner.ts'),
      'utf8'
    );
    expect(source).toContain("import { buildImageTools } from './image-tools'");
    expect(source).toContain('buildImageTools({ sessionId: session.id, cwd: effectiveCwd })');
    expect(source).toContain('...imageTools');
  });
});
