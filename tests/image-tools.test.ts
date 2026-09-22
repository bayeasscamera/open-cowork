import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

vi.mock('../src/main/config/config-store', () => ({
  configStore: { getAll: vi.fn(), getConfigSetProjectedConfig: vi.fn() },
}));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  buildImageTools,
  detectImageMimeType,
  estimateImageCostUsd,
  formatCostEstimateUsd,
  protocolForProvider,
  readWorkspaceImage,
  resolveConfinedReadPath,
  resolveConfinedWritePath,
  sanitizeImageFilename,
  supportsImageGeneration,
  toProviderConfig,
  type GenerationRequest,
  type ImageConfigSource,
  type VisionRequest,
} from '../src/main/agent/image-tools';

// A real 1x1 PNG so mime detection (magic bytes) is exercised for real.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const dirs: string[] = [];
let workspace = '';
let outside = '';

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-image-tools-'));
  dirs.push(dir);
  return dir;
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error('missing tool: ' + name);
  return found;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join(String.fromCharCode(10));
}

function imagesOf(result: unknown): Array<{ data: string; mimeType: string }> {
  const details = (result as { details?: { openCoworkImages?: Array<{ data: string; mimeType: string }> } })
    .details;
  return details?.openCoworkImages ?? [];
}

function detailsOf(result: unknown): Record<string, unknown> {
  return ((result as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  workspace = makeWorkspace();
  outside = makeWorkspace();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('image mime detection', () => {
  it('detects PNG, JPEG, GIF and WebP from magic bytes', () => {
    expect(detectImageMimeType(PNG_1X1)).toBe('image/png');
    expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg');
    expect(detectImageMimeType(Buffer.from('GIF89a1234'))).toBe('image/gif');
    expect(detectImageMimeType(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
  });

  it('refuses anything that is not a real image, whatever the extension says', () => {
    expect(detectImageMimeType(Buffer.from('this is not an image'))).toBeNull();
    expect(detectImageMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe('filename sanitizing', () => {
  it('strips directory traversal and unsafe characters', () => {
    expect(sanitizeImageFilename('../../evil.png', 'image/png')).toBe('evil.png');
    expect(sanitizeImageFilename('My Sunset!!.jpeg', 'image/png')).toBe('my-sunset.png');
    expect(sanitizeImageFilename('', 'image/png')).toBe('image.png');
  });
});

describe('cost estimate', () => {
  it('returns an approximate per-image price for known models', () => {
    expect(estimateImageCostUsd('gpt-image-1')).toBeCloseTo(0.042, 5);
    expect(estimateImageCostUsd('openai/gpt-image-1')).toBeCloseTo(0.042, 5);
    expect(estimateImageCostUsd('gemini-2.5-flash-image')).toBeCloseTo(0.039, 5);
  });

  it('scales with OpenAI quality and larger sizes', () => {
    const low = estimateImageCostUsd('gpt-image-1', { quality: 'low' });
    const high = estimateImageCostUsd('gpt-image-1', { quality: 'high' });
    expect(low).toBeDefined();
    expect(high).toBeDefined();
    expect(high as number).toBeGreaterThan(low as number);
    const large = estimateImageCostUsd('gpt-image-1', { size: '1536x1024' });
    expect(large as number).toBeGreaterThan(0.042);
  });

  it('returns undefined for an unknown model instead of inventing a number', () => {
    expect(estimateImageCostUsd('some-local-image-model')).toBeUndefined();
    expect(formatCostEstimateUsd(0.042)).toBe('~$0.042');
  });
});

describe('provider resolution', () => {
  it('maps providers to the protocol they speak', () => {
    expect(protocolForProvider('anthropic')).toBe('anthropic');
    expect(protocolForProvider('gemini')).toBe('gemini');
    expect(protocolForProvider('openai')).toBe('openai');
    expect(protocolForProvider('openrouter')).toBe('openai');
    expect(protocolForProvider('custom', 'gemini')).toBe('gemini');
    expect(protocolForProvider('unknown-provider')).toBeNull();
  });

  it('knows which routes can actually create images', () => {
    expect(
      supportsImageGeneration({ provider: 'openai', protocol: 'openai', model: 'gpt-image-1', apiKey: 'k' })
    ).toBe(true);
    expect(
      supportsImageGeneration({
        provider: 'gemini',
        protocol: 'gemini',
        model: 'gemini-2.5-flash-image',
        apiKey: 'k',
      })
    ).toBe(true);
    expect(
      supportsImageGeneration({ provider: 'anthropic', protocol: 'anthropic', model: 'claude', apiKey: 'k' })
    ).toBe(false);
    expect(
      supportsImageGeneration({ provider: 'ollama', protocol: 'openai', model: 'x', apiKey: '' })
    ).toBe(false);
  });

  it('drops an empty model so callers can report a configuration error', () => {
    expect(toProviderConfig({ provider: 'openai', model: '  ', apiKey: 'k' })).toBeNull();
  });
});

function imageConfig(overrides: Partial<ImageConfigSource> = {}): ImageConfigSource {
  return { provider: 'openai', model: 'dall-e-2', apiKey: 'test-key', ...overrides };
}

async function runTool(tool: ToolDefinition, params: Record<string, unknown>): Promise<unknown> {
  const execute = tool.execute as unknown as (
    id: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
  return execute('call-1', params);
}

describe('workspace confinement', () => {
  it('accepts a file inside the workspace', () => {
    writeFileSync(join(workspace, 'photo.png'), PNG_1X1);
    const resolved = resolveConfinedReadPath(workspace, 'photo.png');
    expect(existsSync(resolved)).toBe(true);
  });

  it('refuses a relative path that escapes the workspace', () => {
    writeFileSync(join(outside, 'secret.png'), PNG_1X1);
    expect(() => resolveConfinedReadPath(workspace, '../' + join(outside, 'secret.png'))).toThrow(
      /outside the workspace|escapes the workspace/
    );
    const escape = join(workspace, '..', 'secret.png');
    expect(() => resolveConfinedReadPath(workspace, escape)).toThrow(/outside the workspace/);
  });

  it('refuses an absolute path outside the workspace even when the file exists', () => {
    writeFileSync(join(outside, 'secret.png'), PNG_1X1);
    expect(() => resolveConfinedReadPath(workspace, join(outside, 'secret.png'))).toThrow(
      /outside the workspace/
    );
  });

  it('refuses a symlink that points out of the workspace', () => {
    if (process.platform === 'win32') return;
    writeFileSync(join(outside, 'secret.png'), PNG_1X1);
    symlinkSync(join(outside, 'secret.png'), join(workspace, 'link.png'));
    expect(() => resolveConfinedReadPath(workspace, 'link.png')).toThrow(/escapes the workspace/);
  });

  it('refuses a write path that escapes the workspace', () => {
    expect(() => resolveConfinedWritePath(workspace, '../escape.png')).toThrow(/outside the workspace/);
    expect(existsSync(join(outside, 'escape.png'))).toBe(false);
  });

  it('rejects a non-image file whatever its extension', async () => {
    writeFileSync(join(workspace, 'fake.png'), 'definitely not an image');
    await expect(readWorkspaceImage(workspace, 'fake.png')).rejects.toThrow(/unsupported image format/);
  });
});

describe('analyze_image (vision read)', () => {
  it('reads a workspace image, sends it to the configured vision model and returns the analysis inline', async () => {
    writeFileSync(join(workspace, 'photo.png'), PNG_1X1);
    const visionCalls: VisionRequest[] = [];
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-vision',
        cwd: workspace,
        getAppConfig: () => imageConfig({ model: 'gpt-4o' }),
        vision: async (request) => {
          visionCalls.push(request);
          return 'A 1x1 red square.';
        },
      }),
      'analyze_image'
    );

    const result = await runTool(tool, { path: 'photo.png', question: 'What colour is it?' });
    expect(textOf(result)).toContain('A 1x1 red square.');
    expect(textOf(result)).toContain('photo.png');
    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0].prompt).toBe('What colour is it?');
    expect(visionCalls[0].mimeType).toBe('image/png');
    expect(visionCalls[0].base64).toBe(PNG_1X1.toString('base64'));
    expect(visionCalls[0].config.model).toBe('gpt-4o');

    // The image rides back for inline chat rendering, not as a file path.
    const images = imagesOf(result);
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/png');
    expect(images[0].data).toBe(PNG_1X1.toString('base64'));
    expect(detailsOf(result).path).toBe('photo.png');
  });

  it('uses the dedicated images ConfigSet when one is pinned', async () => {
    writeFileSync(join(workspace, 'photo.png'), PNG_1X1);
    let seen: VisionRequest['config'] | undefined;
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-pinned',
        cwd: workspace,
        getAppConfig: () =>
          imageConfig({ model: 'gpt-4o', imageGeneration: { configSetId: 'img-set' } }),
        projectConfigSet: (setId) =>
          setId === 'img-set'
            ? { provider: 'gemini', model: 'gemini-2.5-flash-image', apiKey: 'gemini-key' }
            : undefined,
        vision: async (request) => {
          seen = request.config;
          return 'ok';
        },
      }),
      'analyze_image'
    );

    await runTool(tool, { path: 'photo.png' });
    expect(seen?.protocol).toBe('gemini');
    expect(seen?.model).toBe('gemini-2.5-flash-image');
    expect(seen?.apiKey).toBe('gemini-key');
  });

  it('never calls the vision model for a path outside the workspace', async () => {
    writeFileSync(join(outside, 'secret.png'), PNG_1X1);
    const vision = vi.fn(async () => 'should not run');
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-confined',
        cwd: workspace,
        getAppConfig: () => imageConfig(),
        vision,
      }),
      'analyze_image'
    );

    const result = await runTool(tool, { path: join(outside, 'secret.png') });
    expect(textOf(result)).toContain('analyze_image failed');
    expect(textOf(result)).toContain('workspace');
    expect(vision).not.toHaveBeenCalled();
    expect(imagesOf(result)).toHaveLength(0);
  });

  it('refuses a symlinked file that leaves the workspace', async () => {
    if (process.platform === 'win32') return;
    writeFileSync(join(outside, 'secret.png'), PNG_1X1);
    symlinkSync(join(outside, 'secret.png'), join(workspace, 'link.png'));
    const vision = vi.fn(async () => 'should not run');
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-symlink',
        cwd: workspace,
        getAppConfig: () => imageConfig(),
        vision,
      }),
      'analyze_image'
    );

    const result = await runTool(tool, { path: 'link.png' });
    expect(textOf(result)).toContain('analyze_image failed');
    expect(vision).not.toHaveBeenCalled();
  });
});

describe('generate_image', () => {
  it('generates an image, writes it inside the workspace and exposes it for inline display', async () => {
    const generateRequests: GenerationRequest[] = [];
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-generate',
        cwd: workspace,
        getAppConfig: () =>
          imageConfig({
            model: 'dall-e-2',
            imageGeneration: { configSetId: '', costConfirmThresholdUsd: 1 },
          }),
        generate: async (request) => {
          generateRequests.push(request);
          return {
            base64: PNG_1X1.toString('base64'),
            mimeType: 'image/png',
            model: 'dall-e-2',
            provider: 'openai',
          };
        },
      }),
      'generate_image'
    );

    const result = await runTool(tool, { prompt: 'A red cube', filename: 'Red Cube' });
    const savedPath = join(workspace, 'generated-images', 'red-cube.png');
    expect(textOf(result)).toContain('generated-images/red-cube.png');
    expect(existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath).equals(PNG_1X1)).toBe(true);
    expect(generateRequests).toHaveLength(1);
    expect(generateRequests[0].prompt).toBe('A red cube');

    const images = imagesOf(result);
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/png');
    expect(images[0].data).toBe(PNG_1X1.toString('base64'));
    expect(detailsOf(result).path).toBe('generated-images/red-cube.png');
  });

  it('never writes outside the workspace even when asked to', async () => {
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-escape',
        cwd: workspace,
        getAppConfig: () =>
          imageConfig({
            model: 'dall-e-2',
            imageGeneration: { configSetId: '', costConfirmThresholdUsd: 1 },
          }),
        generate: async () => ({
          base64: PNG_1X1.toString('base64'),
          mimeType: 'image/png',
          model: 'dall-e-2',
          provider: 'openai',
        }),
      }),
      'generate_image'
    );

    const result = await runTool(tool, { prompt: 'x', filename: '../../escape' });
    expect(textOf(result)).toContain('generated-images/escape.png');
    expect(existsSync(join(workspace, 'generated-images', 'escape.png'))).toBe(true);
    expect(existsSync(join(outside, 'escape.png'))).toBe(false);
    expect(existsSync(join(workspace, '..', 'escape.png'))).toBe(false);
  });

  it('pauses for an explicit cost acknowledgement above the threshold, then generates once confirmed', async () => {
    const generate = vi.fn(async () => ({
      base64: PNG_1X1.toString('base64'),
      mimeType: 'image/png' as const,
      model: 'gpt-image-1.5',
      provider: 'openai',
    }));
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-cost',
        cwd: workspace,
        // gpt-image-1.5 is ~$0.06/image, above the default $0.05 threshold.
        getAppConfig: () => imageConfig({ model: 'gpt-image-1.5' }),
        generate,
      }),
      'generate_image'
    );

    const paused = await runTool(tool, { prompt: 'an expensive picture' });
    expect(textOf(paused)).toContain('generate_image paused');
    expect(textOf(paused)).toContain('acknowledgeCost=true');
    expect(detailsOf(paused).costConfirmationRequired).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, 'generated-images'))).toBe(false);

    const confirmed = await runTool(tool, {
      prompt: 'an expensive picture',
      acknowledgeCost: true,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(textOf(confirmed)).toContain('Estimated cost:');
    expect(textOf(confirmed)).toContain('generated-images/');
    expect(imagesOf(confirmed)).toHaveLength(1);
  });

  it('explains that Anthropic cannot generate images instead of calling a transport', async () => {
    const generate = vi.fn();
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-anthropic',
        cwd: workspace,
        getAppConfig: () => imageConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
        generate,
      }),
      'generate_image'
    );

    const result = await runTool(tool, { prompt: 'x' });
    expect(textOf(result)).toContain('cannot generate images');
    expect(generate).not.toHaveBeenCalled();
  });

  it('reports a missing prompt without calling any transport', async () => {
    const generate = vi.fn();
    const tool = toolByName(
      buildImageTools({
        sessionId: 's-empty',
        cwd: workspace,
        getAppConfig: () => imageConfig(),
        generate,
      }),
      'generate_image'
    );
    const result = await runTool(tool, {});
    expect(textOf(result)).toContain('"prompt" is required');
    expect(generate).not.toHaveBeenCalled();
  });
});
