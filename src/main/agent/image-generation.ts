/**
 * @module main/agent/image-generation
 *
 * Image-GENERATION transport for OpenAI-compatible providers. This module is
 * deliberately INDEPENDENT from the chat/completions path: it never reuses a
 * chat URL builder, and it normalizes any configured base URL back to the API
 * root before appending /images/generations. That is what prevents the old
 * 404 on /v1/images/generation/chat/completions.
 *
 * Two provider shapes are handled by the SAME transport:
 *  - synchronous (OpenAI, most relays): the create call returns the bytes
 *    (b64_json) or a CDN URL directly;
 *  - asynchronous job (xKiro and other gateways): the create call returns a job
 *    id, we poll GET <root>/images/generations/{id} until the job succeeds,
 *    then download the CDN URL.
 *
 * Everything network-facing is injectable so tests never touch the network.
 */

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Fallback API root when a provider pins no base URL (native OpenAI). */
export const DEFAULT_OPENAI_IMAGE_BASE_URL = 'https://api.openai.com/v1';

/** How often an asynchronous image job is polled. */
export const IMAGE_GENERATION_POLL_INTERVAL_MS = 2_500;
/** Hard ceiling on the whole create -> poll -> fetch cycle. */
export const IMAGE_GENERATION_POLL_TIMEOUT_MS = 60_000;

export interface ImageGenerationRequest {
  provider: string;
  model: string;
  prompt: string;
  apiKey: string;
  baseUrl?: string;
  size?: string;
  quality?: string;
}

export interface ImageGenerationBytes {
  base64: string;
  mimeType: ImageMimeType;
  model: string;
  provider: string;
}

export type ImageGenerationTransport = (
  request: ImageGenerationRequest
) => Promise<ImageGenerationBytes>;

export interface OpenAiImageTransportOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Detect an image MIME type from magic bytes - never trust the extension. */
export function detectImageMimeType(buffer: Buffer): ImageMimeType | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') {
    return 'image/gif';
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

const CHAT_ENDPOINT_SUFFIXES = ['/chat/completions', '/completions', '/responses', '/messages'];
const IMAGE_ENDPOINT_SUFFIX = /\/images\/(?:generations?|generate)(?:\/[^/]+)?$/i;

/**
 * Normalize ANY configured base URL to the API root that hosts
 * /images/generations. Handles every shape a user may have pasted:
 *   https://api.xkiro.com/v1                        -> https://api.xkiro.com/v1
 *   https://api.xkiro.com/v1/images/generations     -> https://api.xkiro.com/v1
 *   https://api.xkiro.com/v1/images/generation      -> https://api.xkiro.com/v1
 *   https://api.xkiro.com/v1/images/generation/{id} -> https://api.xkiro.com/v1
 *   https://api.xkiro.com/v1/chat/completions       -> https://api.xkiro.com/v1
 * A chat endpoint is NEVER kept, which is the whole point of this module.
 */
export function imageApiRoot(baseUrl?: string): string {
  let url = (baseUrl && baseUrl.trim()) || DEFAULT_OPENAI_IMAGE_BASE_URL;
  url = url.replace(/\/+$/, '');
  // Drop a pasted job template such as .../images/generation/{id}
  url = url.replace(/\/\{[^/}]*\}$/, '');
  const lowered = url.toLowerCase();
  for (const suffix of CHAT_ENDPOINT_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      url = url.slice(0, url.length - suffix.length);
      break;
    }
  }
  const imageMatch = IMAGE_ENDPOINT_SUFFIX.exec(url);
  if (imageMatch) url = url.slice(0, imageMatch.index);
  url = url.replace(/\/+$/, '');
  return url || DEFAULT_OPENAI_IMAGE_BASE_URL;
}

/** POST target for image creation. Never a chat URL. */
export function buildImageGenerationsUrl(baseUrl?: string): string {
  return imageApiRoot(baseUrl) + '/images/generations';
}

/** GET target used to poll an asynchronous image job. */
export function buildImageJobUrl(baseUrl: string | undefined, jobId: string): string {
  return buildImageGenerationsUrl(baseUrl) + '/' + encodeURIComponent(jobId);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const JOB_ID_KEYS = ['id', 'job_id', 'jobId', 'task_id', 'taskId', 'request_id', 'generation_id'];
const STATUS_KEYS = ['status', 'state', 'job_status', 'jobStatus'];

/** Job id of an asynchronous create response, if any. */
export function extractJobId(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  for (const key of JOB_ID_KEYS) {
    const direct = firstString(record[key]);
    if (direct) return direct;
  }
  // Nested shapes: { data: { id } }, { result: { id } }, { job: { id } }
  for (const nestedKey of ['data', 'result', 'job', 'response']) {
    const nested = asRecord(record[nestedKey]);
    if (!nested) continue;
    for (const key of JOB_ID_KEYS) {
      const direct = firstString(nested[key]);
      if (direct) return direct;
    }
  }
  return null;
}

/** Normalized job status of a create or poll response, if any. */
export function extractJobStatus(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  for (const key of STATUS_KEYS) {
    const direct = firstString(record[key]);
    if (direct) return direct.toLowerCase();
  }
  for (const nestedKey of ['data', 'result', 'job']) {
    const nested = asRecord(record[nestedKey]);
    if (!nested) continue;
    for (const key of STATUS_KEYS) {
      const direct = firstString(nested[key]);
      if (direct) return direct.toLowerCase();
    }
  }
  return null;
}

const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'completed', 'complete', 'done', 'finished']);
const FAILURE_STATUSES = new Set(['failed', 'failure', 'error', 'canceled', 'cancelled', 'rejected']);

export function isImageJobSuccess(status: string | null): boolean {
  return status !== null && SUCCESS_STATUSES.has(status);
}

export function isImageJobFailure(status: string | null): boolean {
  return status !== null && FAILURE_STATUSES.has(status);
}

const BASE64_KEYS = ['b64_json', 'b64', 'base64', 'image_base64', 'imageBase64', 'image_bytes'];
const URL_KEYS = ['url', 'image_url', 'imageUrl', 'output_url', 'outputUrl', 'image'];

/** Bounded deep search for the first base64 image payload. */
function deepFindString(payload: unknown, keys: string[], depth = 0): string | null {
  if (depth > 5 || payload === null || payload === undefined) return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = deepFindString(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(payload);
  if (!record) return null;
  for (const key of keys) {
    const found = firstString(record[key]);
    if (found) return found;
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const found = deepFindString(value, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Base64 image bytes carried directly by a response, if any. */
export function extractImageBase64(payload: unknown): string | null {
  return deepFindString(payload, BASE64_KEYS);
}

/** CDN URL of the generated image, if any. */
export function extractImageUrl(payload: unknown): string | null {
  const candidate = deepFindString(payload, URL_KEYS);
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate) || candidate.startsWith('data:image/')) return candidate;
  return null;
}

/** Human-readable provider error carried by a failed job, if any. */
export function extractJobError(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  const error = record.error;
  const fromError = asRecord(error);
  const message =
    (fromError && (firstString(fromError.message) || firstString(fromError.detail))) ||
    firstString(error) ||
    firstString(record.message) ||
    firstString(record.detail);
  if (message) return message;
  const nested = asRecord(record.data);
  if (nested) return extractJobError(nested);
  return null;
}

function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim() ? ' - ' + text.trim().slice(0, 300) : '';
    throw new Error(label + ' failed: HTTP ' + response.status + detail);
  }
  if (!text.trim()) throw new Error(label + ' returned an empty response');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(label + ' returned invalid JSON');
  }
}

async function downloadImage(
  fetchImpl: typeof fetch,
  url: string
): Promise<{ base64: string; mimeType: ImageMimeType }> {
  const response = await fetchImpl(url, { method: 'GET' });
  if (!response.ok) throw new Error('image download failed: HTTP ' + response.status);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) throw new Error('image download returned no bytes');
  return { base64: buffer.toString('base64'), mimeType: detectImageMimeType(buffer) ?? 'image/png' };
}

/**
 * Build the OpenAI-compatible image-generation transport. Injectable fetch,
 * sleep, clock and poll bounds keep the async contract fully unit-testable.
 */
export function createOpenAiImageTransport(
  options: OpenAiImageTransportOptions = {}
): ImageGenerationTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = options.pollIntervalMs ?? IMAGE_GENERATION_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? IMAGE_GENERATION_POLL_TIMEOUT_MS;

  const authHeaders = (apiKey: string): Record<string, string> => ({
    Accept: 'application/json',
    ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
  });

  const finishWithBase64 = (
    raw: string,
    request: ImageGenerationRequest
  ): ImageGenerationBytes => {
    const base64 = stripDataUrlPrefix(raw);
    const buffer = Buffer.from(base64, 'base64');
    return {
      base64: buffer.toString('base64'),
      mimeType: detectImageMimeType(buffer) ?? 'image/png',
      model: request.model,
      provider: request.provider,
    };
  };

  return async (request: ImageGenerationRequest): Promise<ImageGenerationBytes> => {
    const createUrl = buildImageGenerationsUrl(request.baseUrl);
    const createResponse = await fetchImpl(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(request.apiKey) },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        n: 1,
        // A default size keeps gateways that require it (xKiro) working while
        // staying a valid size for native OpenAI models.
        size: request.size || '1024x1024',
        ...(request.quality ? { quality: request.quality } : {}),
      }),
    });
    const created = await readJson(createResponse, 'image generation request');

    const createdStatus = extractJobStatus(created);
    if (isImageJobFailure(createdStatus)) {
      throw new Error(
        'image generation rejected (' + createdStatus + ')' +
          (extractJobError(created) ? ': ' + extractJobError(created) : '')
      );
    }
    const directBase64 = extractImageBase64(created);
    if (directBase64) return finishWithBase64(directBase64, request);
    const directUrl = extractImageUrl(created);
    if (directUrl && !createdStatus) {
      const downloaded = await downloadImage(fetchImpl, directUrl);
      return { ...downloaded, model: request.model, provider: request.provider };
    }

    const jobId = extractJobId(created);
    if (!jobId) {
      throw new Error(
        'image generation response contained neither image data nor a job id' +
          (extractJobError(created) ? ': ' + extractJobError(created) : '')
      );
    }

    const jobUrl = buildImageJobUrl(request.baseUrl, jobId);
    const deadline = now() + pollTimeoutMs;
    let lastStatus = createdStatus ?? 'queued';
    while (now() < deadline) {
      await sleep(pollIntervalMs);
      const polled = await readJson(
        await fetchImpl(jobUrl, { method: 'GET', headers: authHeaders(request.apiKey) }),
        'image job poll'
      );
      lastStatus = extractJobStatus(polled) ?? lastStatus;
      if (isImageJobFailure(lastStatus)) {
        throw new Error(
          'image job ' + jobId + ' failed (' + lastStatus + ')' +
            (extractJobError(polled) ? ': ' + extractJobError(polled) : '')
        );
      }
      if (isImageJobSuccess(lastStatus)) {
        const polledBase64 = extractImageBase64(polled);
        if (polledBase64) return finishWithBase64(polledBase64, request);
        const polledUrl = extractImageUrl(polled);
        if (!polledUrl) {
          throw new Error('image job ' + jobId + ' succeeded but returned no image URL');
        }
        const downloaded = await downloadImage(fetchImpl, polledUrl);
        return { ...downloaded, model: request.model, provider: request.provider };
      }
    }
    throw new Error(
      'image job ' + jobId + ' did not finish within ' + Math.round(pollTimeoutMs / 1000) +
        's (last status: ' + lastStatus + ')'
    );
  };
}
