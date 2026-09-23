/**
 * @module main/agent/image-tools
 *
 * Native image READ (vision) and GENERATION tools for the agent runtime.
 *
 * Transport: vision reuses what the app already has — a base64 data URL /
 * inline part sent to a provider SDK that is already a dependency
 * (@anthropic-ai/sdk, @google/genai, openai), the same shape mcp/gui/vision.ts
 * uses. Generation does NOT reuse the chat SDK: it goes through
 * ./image-generation, which builds /images/generations from the API root
 * (never a chat URL) and handles synchronous and asynchronous (job + poll)
 * providers alike. Results ride on an openCoworkImages detail, which the
 * existing normalizer (agent/tool-result-utils.ts) turns into
 * ToolResultContent.images and ChatView renders inline.
 *
 * Confinement: every read goes through resolveConfinedReadPath() and every
 * write through resolveConfinedWritePath(); both resolve symlinks (realpath)
 * before checking containment, so a link inside the workspace cannot point out
 * of it.
 *
 * Cost: image models are billed PER IMAGE, not per token. estimateImageCostUsd
 * returns an approximate list price for known models; when it is at or above
 * the configured threshold, generate_image refuses once and asks for an
 * explicit acknowledgement instead of silently spending money.
 *
 * Pure helpers (mime detection, confinement, cost estimate, filename
 * sanitizing) are exported for tests; the two provider transports are
 * injectable so tests never touch the network.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Type, type TSchema } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import OpenAI from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { isPathWithinRoot } from '../tools/path-containment';
import { configStore } from '../config/config-store';
import { log, logWarn } from '../utils/logger';
import {
  createOpenAiImageTransport,
  detectImageMimeType,
  type ImageMimeType,
} from './image-generation';

// Re-exported so existing importers (and tests) keep a single entry point.
export { detectImageMimeType };
export type { ImageMimeType };

/** Image protocols we can talk to. Anthropic has no image-generation model. */
type ImageProtocol = 'anthropic' | 'openai' | 'gemini';

/** Only the config fields image work needs — keeps the tools unit-testable. */
export interface ImageConfigSource {
  provider: string;
  customProtocol?: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  imageGeneration?: {
    configSetId: string;
    modelId?: string;
    costConfirmThresholdUsd?: number;
    /** Explicit provider override — any provider, independent of ConfigSets. */
    provider?: string;
    customProtocol?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
}

interface ImageProviderConfig {
  provider: string;
  protocol: ImageProtocol;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface VisionRequest {
  config: ImageProviderConfig;
  mimeType: ImageMimeType;
  base64: string;
  prompt: string;
}

export interface GenerationRequest {
  config: ImageProviderConfig;
  prompt: string;
  size?: string;
  aspectRatio?: string;
  quality?: string;
}

interface GenerationResult {
  base64: string;
  mimeType: ImageMimeType;
  /** The model that actually produced the bytes. */
  model: string;
  provider: string;
}

type VisionTransport = (request: VisionRequest) => Promise<string>;
type GenerationTransport = (request: GenerationRequest) => Promise<GenerationResult>;

interface ImageToolsDeps {
  sessionId: string;
  cwd: string;
  /** Full app config; defaults to the persisted config store. */
  getAppConfig?: () => ImageConfigSource;
  /** Project a pinned ConfigSet into a full config; defaults to the store. */
  projectConfigSet?: (setId: string, modelId?: string) => ImageConfigSource | undefined;
  /** Model transports (tests inject fakes; no network in unit tests). */
  vision?: VisionTransport;
  generate?: GenerationTransport;
  readFile?: (absPath: string) => Promise<Buffer>;
  writeFile?: (absPath: string, data: Buffer) => Promise<void>;
  now?: () => number;
}

/** Hard cap on a workspace image we are willing to base64 into a request. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const VISION_TIMEOUT_MS = 60_000;
const GENERATION_TIMEOUT_MS = 180_000;
/** Sub-directory of the workspace where generated images are written. */
const GENERATED_IMAGE_DIR = 'generated-images';
const DEFAULT_COST_CONFIRM_THRESHOLD_USD = 0.05;

const DEFAULT_VISION_PROMPT =
  'Describe this image precisely and factually. Report any text, numbers, labels, UI state, errors or anomalies you can read, then summarise what it shows.';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const MIME_EXTENSION: Record<ImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Turn any user/provider string into a safe single-segment file basename. */
export function sanitizeImageFilename(name: string, mimeType: ImageMimeType): string {
  const withoutDirs = path.basename(name.replace(/\\/g, '/'));
  const withoutExt = withoutDirs.replace(/\.[a-z0-9]{1,5}$/i, '');
  const slug = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 60);
  return slug ? slug + '.' + MIME_EXTENSION[mimeType] : 'image.' + MIME_EXTENSION[mimeType];
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

/** Canonical workspace root (symlinks resolved) used for every containment check. */
function workspaceRealRoot(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Resolve a READ path inside the workspace. Rejects (a) paths that lexically
 * escape the workspace, (b) symlinks whose real target escapes it, and
 * (c) anything that is not a regular file.
 */
export function resolveConfinedReadPath(cwd: string, candidate: string): string {
  const root = workspaceRealRoot(cwd);
  const target = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);
  if (!isPathWithinRoot(target, root, isWindows())) {
    throw new Error('path is outside the workspace: ' + candidate);
  }
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw new Error('image not found in the workspace: ' + candidate);
  }
  if (!isPathWithinRoot(real, root, isWindows())) {
    throw new Error('path escapes the workspace through a link: ' + candidate);
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) {
    throw new Error('not a file: ' + candidate);
  }
  return real;
}

/**
 * Resolve a WRITE path inside the workspace. The parent directory is created
 * first, then its realpath is checked, so a pre-existing symlinked directory
 * cannot redirect the write outside the workspace.
 */
export function resolveConfinedWritePath(cwd: string, relativePath: string): string {
  const root = workspaceRealRoot(cwd);
  const target = path.resolve(root, relativePath);
  if (!isPathWithinRoot(target, root, isWindows())) {
    throw new Error('output path is outside the workspace: ' + relativePath);
  }
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const realDir = fs.realpathSync(dir);
  if (!isPathWithinRoot(realDir, root, isWindows())) {
    throw new Error('output directory escapes the workspace: ' + relativePath);
  }
  return path.join(realDir, path.basename(target));
}

/**
 * Workspace-relative, forward-slashed path for display/tool output.
 *
 * Measured against the REAL workspace root: confinement resolves symlinks
 * (macOS /tmp is a link to /private/tmp), so comparing against the raw cwd
 * would produce a bogus "../../.." path.
 */
function toWorkspaceRelative(cwd: string, absPath: string): string {
  const rel = path.relative(workspaceRealRoot(cwd), absPath) || path.basename(absPath);
  return rel.split(path.sep).join('/');
}

interface ReadWorkspaceImageResult {
  absPath: string;
  relativePath: string;
  mimeType: ImageMimeType;
  bytes: number;
  base64: string;
}

/** Read + validate an image strictly inside the workspace. */
export async function readWorkspaceImage(
  cwd: string,
  candidate: string,
  readFile: (absPath: string) => Promise<Buffer> = (p) => fs.promises.readFile(p)
): Promise<ReadWorkspaceImageResult> {
  const absPath = resolveConfinedReadPath(cwd, candidate);
  const buffer = await readFile(absPath);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      'image is too large (' + buffer.byteLength + ' bytes, limit ' + MAX_IMAGE_BYTES + ')'
    );
  }
  const mimeType = detectImageMimeType(buffer);
  if (!mimeType) {
    throw new Error('unsupported image format (expected PNG, JPEG, GIF or WebP)');
  }
  return {
    absPath,
    relativePath: toWorkspaceRelative(cwd, absPath),
    mimeType,
    bytes: buffer.byteLength,
    base64: buffer.toString('base64'),
  };
}

// ---------------------------------------------------------------------------
// Provider / cost resolution
// ---------------------------------------------------------------------------

/**
 * Map ANY provider id to the wire protocol we speak to it.
 *
 * 'anthropic'/'gemini' are first-party; 'custom' follows its declared protocol
 * (defaulting to OpenAI-compatible, the safe modern default); every other id
 * — openai, openrouter, ollama, and third-party vendors (Groq, Mistral,
 * Together, DeepSeek, xAI, …) — resolves to the OpenAI wire protocol, which is
 * the de-facto standard. The provider itself rejects a model it does not host.
 */
export function protocolForProvider(
  provider: string,
  customProtocol?: string
): ImageProtocol | null {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'anthropic') return 'anthropic';
  if (normalized === 'gemini' || normalized === 'google') return 'gemini';
  if (normalized === 'custom') {
    if (customProtocol === 'gemini') return 'gemini';
    if (customProtocol === 'openai') return 'openai';
    // Historical default for a custom endpoint that declares no protocol.
    return 'anthropic';
  }
  return 'openai';
}

export function toProviderConfig(source: ImageConfigSource): ImageProviderConfig | null {
  const protocol = protocolForProvider(source.provider, source.customProtocol);
  const model = source.model?.trim();
  if (!protocol || !model) return null;
  return {
    provider: source.provider,
    protocol,
    model,
    apiKey: source.apiKey || '',
    baseUrl: source.baseUrl?.trim() || undefined,
  };
}

/** Whether this route can CREATE images (Anthropic and Ollama cannot). */
export function supportsImageGeneration(config: ImageProviderConfig): boolean {
  if (config.provider === 'ollama') return false;
  return config.protocol === 'openai' || config.protocol === 'gemini';
}

/** Strip an "openai/" style prefix and casing so pricing lookup is stable. */
function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase().split('/').pop() || '';
}

/**
 * Approximate published list prices in USD per image. These are ESTIMATES that
 * change with the vendors' pricing; they exist to warn a user before spending,
 * never to bill. An unknown model returns undefined (the caller then says the
 * cost is unknown instead of inventing a number).
 */
const IMAGE_MODEL_BASE_USD: Record<string, number> = {
  'gpt-image-1': 0.042,
  'gpt-image-1-mini': 0.011,
  'gpt-image-1.5': 0.06,
  'dall-e-3': 0.04,
  'dall-e-2': 0.02,
  'gemini-2.5-flash-image': 0.039,
  'gemini-2.5-flash-image-preview': 0.039,
  'gemini-2.0-flash-preview-image-generation': 0.039,
  'gemini-3-pro-image-preview': 0.14,
  'imagen-4.0-generate-001': 0.04,
  'imagen-4.0-fast-generate-001': 0.02,
  'imagen-4.0-ultra-generate-001': 0.06,
  'imagen-3.0-generate-002': 0.04,
};

const OPENAI_QUALITY_MULTIPLIER: Record<string, number> = { low: 0.25, medium: 1, high: 4 };

export function estimateImageCostUsd(
  model: string,
  options: { quality?: string; size?: string } = {}
): number | undefined {
  const key = normalizeModelKey(model);
  const base = IMAGE_MODEL_BASE_USD[key];
  if (base === undefined) return undefined;
  let usd = base;
  const isOpenAiImage = key.startsWith('gpt-image') || key.startsWith('dall-e');
  if (isOpenAiImage) {
    const quality = options.quality?.toLowerCase();
    const multiplier = quality ? OPENAI_QUALITY_MULTIPLIER[quality] : undefined;
    if (multiplier !== undefined) usd *= multiplier;
    if (options.size && options.size !== '1024x1024' && options.size !== 'auto') {
      usd *= 1.5;
    }
  }
  return Math.round(usd * 10000) / 10000;
}

export function formatCostEstimateUsd(usd: number): string {
  return '~$' + usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// SDK transports (injectable so tests never hit the network)
// ---------------------------------------------------------------------------

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')),
      timeoutMs
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function normalizeMimeType(value: string | undefined): ImageMimeType | null {
  if (!value) return null;
  const lowered = value.toLowerCase().trim();
  if (
    lowered === 'image/png' ||
    lowered === 'image/jpeg' ||
    lowered === 'image/gif' ||
    lowered === 'image/webp'
  ) {
    return lowered;
  }
  if (lowered === 'image/jpg') return 'image/jpeg';
  return null;
}

async function callVisionWithSdk(request: VisionRequest): Promise<string> {
  const { config } = request;
  return withTimeout(
    (async () => {
      if (config.protocol === 'gemini') {
        const ai = new GoogleGenAI({
          apiKey: config.apiKey,
          httpOptions: config.baseUrl ? { baseUrl: config.baseUrl } : undefined,
        });
        const response = await ai.models.generateContent({
          model: config.model,
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: request.mimeType, data: request.base64 } },
                { text: request.prompt },
              ],
            },
          ],
        });
        return (response.text ?? '').trim();
      }

      if (config.protocol === 'anthropic') {
        const client = new Anthropic({
          apiKey: config.apiKey,
          baseURL: config.baseUrl || undefined,
        });
        const message = await client.messages.create({
          model: config.model,
          max_tokens: 2048,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: request.mimeType,
                    data: request.base64,
                  },
                },
                { type: 'text', text: request.prompt },
              ],
            },
          ],
        });
        return message.content
          .filter((block) => block.type === 'text')
          .map((block) => (block as { text: string }).text)
          .join(String.fromCharCode(10))
          .trim();
      }

      const client = new OpenAI({
        apiKey: config.apiKey || 'ollama',
        baseURL: config.baseUrl || undefined,
      });
      const completion = await client.chat.completions.create({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: request.prompt },
              {
                type: 'image_url',
                image_url: { url: 'data:' + request.mimeType + ';base64,' + request.base64 },
              },
            ],
          },
        ],
      });
      return (completion.choices[0]?.message?.content ?? '').trim();
    })(),
    VISION_TIMEOUT_MS,
    'analyze_image'
  );
}

async function callGenerationWithSdk(request: GenerationRequest): Promise<GenerationResult> {
  const { config } = request;
  if (!supportsImageGeneration(config)) {
    throw new Error(
      config.provider + ' cannot generate images; configure an OpenAI or Gemini images ConfigSet'
    );
  }
  return withTimeout(
    (async () => {
      if (config.protocol === 'gemini') {
        const ai = new GoogleGenAI({
          apiKey: config.apiKey,
          httpOptions: config.baseUrl ? { baseUrl: config.baseUrl } : undefined,
        });
        // Imagen exposes a dedicated endpoint; Gemini image models (Nano Banana)
        // return the image as an inline part of a normal generateContent reply.
        if (normalizeModelKey(config.model).startsWith('imagen')) {
          const response = await ai.models.generateImages({
            model: config.model,
            prompt: request.prompt,
            config: {
              numberOfImages: 1,
              ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
            },
          });
          const image = response.generatedImages?.[0]?.image;
          const data = image?.imageBytes;
          if (!data) throw new Error('Gemini returned no image bytes');
          return {
            base64: data,
            mimeType: normalizeMimeType(image?.mimeType) ?? 'image/png',
            model: config.model,
            provider: config.provider,
          };
        }
        const response = await ai.models.generateContent({
          model: config.model,
          contents: request.prompt,
          config: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(request.aspectRatio ? { imageConfig: { aspectRatio: request.aspectRatio } } : {}),
          },
        });
        const parts = response.candidates?.[0]?.content?.parts ?? [];
        const imagePart = parts.find((part) => part.inlineData?.data);
        const data = imagePart?.inlineData?.data;
        if (!data) throw new Error('Gemini returned no image part');
        return {
          base64: data,
          mimeType:
            normalizeMimeType(imagePart?.inlineData?.mimeType) ?? 'image/png',
          model: config.model,
          provider: config.provider,
        };
      }

      // OpenAI-compatible generation goes through the dedicated image
      // transport: it derives /images/generations from the API ROOT (never a
      // chat URL) and handles both synchronous responses and asynchronous
      // create -> poll -> download jobs (xKiro and similar gateways).
      const transport = createOpenAiImageTransport();
      const generated = await transport({
        provider: config.provider,
        model: config.model,
        prompt: request.prompt,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        size: request.size,
        quality: request.quality,
      });
      return {
        base64: generated.base64,
        mimeType: generated.mimeType,
        model: config.model,
        provider: config.provider,
      };
    })(),
    GENERATION_TIMEOUT_MS,
    'generate_image'
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ErrorToolResult {
  content: { type: 'text'; text: string }[];
  details: Record<string, unknown>;
}

function errorText(message: string): ErrorToolResult {
  return { content: [{ type: 'text' as const, text: message }], details: { error: message } };
}

const NL = String.fromCharCode(10);

/**
 * Build the two native image tools for one agent session.
 *
 * analyze_image sends the workspace image to the configured vision model and
 * returns its textual analysis; the image itself rides along in
 * details.openCoworkImages so the chat renders it inline without paying for a
 * second vision pass through the main model.
 *
 * generate_image writes the generated bytes into
 * <workspace>/generated-images/ (confined) and exposes them the same way.
 */
export function buildImageTools(deps: ImageToolsDeps): ToolDefinition[] {
  const getAppConfig = deps.getAppConfig ?? (() => configStore.getAll());
  const projectConfigSet =
    deps.projectConfigSet ??
    ((setId, modelId) => configStore.getConfigSetProjectedConfig(setId, modelId));
  const vision = deps.vision ?? callVisionWithSdk;
  const generate = deps.generate ?? callGenerationWithSdk;
  const readFile = deps.readFile ?? ((absPath: string) => fs.promises.readFile(absPath));
  const writeFile =
    deps.writeFile ?? ((absPath: string, data: Buffer) => fs.promises.writeFile(absPath, data));
  const now = deps.now ?? (() => Date.now());

  const resolveProvider = (): ImageProviderConfig | null => {
    const app = getAppConfig();
    const pinned = app.imageGeneration;

    // 1. Explicit provider + model — ANY provider, with its own credentials,
    //    no ConfigSet required. Highest precedence.
    const explicitModel = pinned?.model?.trim();
    if (pinned?.provider && explicitModel) {
      const sameAsActive = pinned.provider === app.provider;
      const explicit = toProviderConfig({
        provider: pinned.provider,
        customProtocol: pinned.customProtocol,
        model: explicitModel,
        // Only borrow the active key/URL when it is the SAME provider; using
        // another provider's key against a different endpoint would be wrong.
        apiKey: pinned.apiKey?.trim() || (sameAsActive ? app.apiKey : '') || '',
        baseUrl: pinned.baseUrl?.trim() || (sameAsActive ? app.baseUrl : undefined),
      });
      if (explicit) return explicit;
    }

    // 2. Pinned ConfigSet.
    if (pinned?.configSetId) {
      const projected = projectConfigSet(pinned.configSetId, pinned.modelId);
      const fromSet = projected ? toProviderConfig(projected) : null;
      if (fromSet) return fromSet;
    }

    // 3. Active profile (zero-config default).
    return toProviderConfig(app);
  };

  const analyzeImageTool: ToolDefinition<TSchema, unknown> = {
    name: 'analyze_image',
    label: 'Analyze Image (vision)',
    description:
      'Read an image file inside the session workspace and analyse it with the configured vision model ' +
      '(the dedicated images ConfigSet, or the active profile). Returns a factual description/answer and ' +
      'displays the image inline in the chat. The path must stay inside the workspace. Costs one vision ' +
      'request (no image generation).',
    parameters: Type.Object({
      path: Type.String({
        description:
          'Workspace-relative (or workspace-contained absolute) path to a PNG/JPEG/GIF/WebP file.',
      }),
      question: Type.Optional(
        Type.String({
          description:
            'What to extract from the image (e.g. "read the error message", "list the table rows"). Defaults to a general description.',
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const args = params as { path?: string; question?: string };
      if (!args.path?.trim()) {
        return errorText('analyze_image failed: "path" is required.');
      }
      try {
        const image = await readWorkspaceImage(deps.cwd, args.path.trim(), readFile);
        const provider = resolveProvider();
        if (!provider) {
          return errorText(
            'analyze_image failed: no image model configured. Set a model in Settings, API, Images.'
          );
        }
        const question = args.question?.trim() || DEFAULT_VISION_PROMPT;
        const analysis = await vision({
          config: provider,
          mimeType: image.mimeType,
          base64: image.base64,
          prompt: question,
        });
        const body = analysis || '(the vision model returned no text)';
        return {
          content: [
            {
              type: 'text' as const,
              text:
                body +
                NL + NL +
                '[analysed ' +
                image.relativePath +
                ' with ' +
                provider.model +
                ' - ' +
                image.mimeType +
                ', ' +
                image.bytes +
                ' bytes]',
            },
          ],
          details: {
            path: image.relativePath,
            mimeType: image.mimeType,
            bytes: image.bytes,
            model: provider.model,
            provider: provider.provider,
            openCoworkImages: [{ data: image.base64, mimeType: image.mimeType }],
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn('[ImageTools] analyze_image failed:', message);
        return errorText('analyze_image failed: ' + message);
      }
    },
  };

  const generateImageTool: ToolDefinition<TSchema, unknown> = {
    name: 'generate_image',
    label: 'Generate Image',
    description:
      'Generate an image from a text prompt with the configured image model (OpenAI gpt-image / DALL-E or ' +
      'Gemini Imagen / Nano Banana), save it under <workspace>/generated-images/ and display it inline in ' +
      'the chat. Billed PER IMAGE, not per token: the tool reports an approximate cost and, above the ' +
      'configured threshold, requires acknowledgeCost=true (after user approval) before spending. Anthropic ' +
      'models cannot generate images.',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'What to draw. Be specific about subject, style and composition.',
      }),
      filename: Type.Optional(
        Type.String({
          description: 'Optional base name for the saved file (sanitized, no directories).',
        })
      ),
      size: Type.Optional(
        Type.Union(
          [
            Type.Literal('auto'),
            Type.Literal('1024x1024'),
            Type.Literal('1536x1024'),
            Type.Literal('1024x1536'),
          ],
          { description: 'OpenAI image size. Ignored by Gemini models.' }
        )
      ),
      aspectRatio: Type.Optional(
        Type.String({
          description: 'Gemini aspect ratio, e.g. "1:1", "16:9", "9:16", "3:4".',
        })
      ),
      quality: Type.Optional(
        Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], {
          description: 'OpenAI image quality. Higher quality costs more per image.',
        })
      ),
      acknowledgeCost: Type.Optional(
        Type.Boolean({
          description:
            'Set true only after the user accepted the estimated per-image cost reported by a previous call.',
        })
      ),
    }),
    async execute(_toolCallId, params) {
      const args = params as {
        prompt?: string;
        filename?: string;
        size?: string;
        aspectRatio?: string;
        quality?: string;
        acknowledgeCost?: boolean;
      };
      if (!args.prompt?.trim()) {
        return errorText('generate_image failed: "prompt" is required.');
      }
      try {
        const provider = resolveProvider();
        if (!provider) {
          return errorText(
            'generate_image failed: no image model configured. Set a model in Settings, API, Images.'
          );
        }
        if (!supportsImageGeneration(provider)) {
          return errorText(
            'generate_image failed: ' +
              provider.provider +
              ' cannot generate images. Configure an OpenAI (gpt-image) or Gemini (Imagen / Nano Banana) images ConfigSet.'
          );
        }

        const app = getAppConfig();
        const threshold =
          app.imageGeneration?.costConfirmThresholdUsd ?? DEFAULT_COST_CONFIRM_THRESHOLD_USD;
        const estimatedCostUsd = estimateImageCostUsd(provider.model, {
          quality: args.quality,
          size: args.size,
        });
        if (
          estimatedCostUsd !== undefined &&
          estimatedCostUsd >= threshold &&
          args.acknowledgeCost !== true
        ) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  'generate_image paused: ' +
                  provider.model +
                  ' costs about ' +
                  formatCostEstimateUsd(estimatedCostUsd) +
                  ' per image (threshold ' +
                  formatCostEstimateUsd(threshold) +
                  '). Nothing was generated and no cost was incurred. Confirm with the user, then call ' +
                  'generate_image again with acknowledgeCost=true.',
              },
            ],
            details: {
              costConfirmationRequired: true,
              estimatedCostUsd,
              model: provider.model,
              provider: provider.provider,
            },
          };
        }

        const result = await generate({
          config: provider,
          prompt: args.prompt.trim(),
          size: args.size,
          aspectRatio: args.aspectRatio?.trim(),
          quality: args.quality,
        });
        const buffer = Buffer.from(result.base64, 'base64');
        if (buffer.byteLength === 0) {
          return errorText('generate_image failed: the provider returned an empty image.');
        }
        const mimeType =
          normalizeMimeType(result.mimeType) ?? detectImageMimeType(buffer) ?? 'image/png';
        const baseName = args.filename?.trim()
          ? sanitizeImageFilename(args.filename.trim(), mimeType)
          : now() +
            '-' +
            sanitizeImageFilename(args.prompt.trim().slice(0, 40) || 'image', mimeType);
        const relativePath = GENERATED_IMAGE_DIR + '/' + baseName;
        const absPath = resolveConfinedWritePath(deps.cwd, relativePath);
        await writeFile(absPath, buffer);

        const shownPath = toWorkspaceRelative(deps.cwd, absPath);
        const costLine =
          estimatedCostUsd !== undefined
            ? 'Estimated cost: ' + formatCostEstimateUsd(estimatedCostUsd) + ' (approximate list price).'
            : 'Estimated cost: unknown for this model - check your provider dashboard.';
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'Generated 1 image with ' +
                result.model +
                ' (' +
                result.provider +
                ').' + NL +
                'Path: ' + shownPath + NL +
                'Size: ' + buffer.byteLength + ' bytes (' + mimeType + ')' + NL +
                costLine,
            },
          ],
          details: {
            path: shownPath,
            mimeType,
            bytes: buffer.byteLength,
            model: result.model,
            provider: result.provider,
            estimatedCostUsd,
            openCoworkImages: [{ data: buffer.toString('base64'), mimeType }],
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn('[ImageTools] generate_image failed:', message);
        return errorText('generate_image failed: ' + message);
      }
    },
  };

  log(
    '[ImageTools] Registered analyze_image + generate_image for session',
    deps.sessionId,
    'workspace:',
    deps.cwd
  );
  return [analyzeImageTool, generateImageTool];
}
