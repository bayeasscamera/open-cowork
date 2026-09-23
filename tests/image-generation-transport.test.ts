import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENAI_IMAGE_BASE_URL,
  buildImageGenerationsUrl,
  buildImageJobUrl,
  createOpenAiImageTransport,
  detectImageMimeType,
  extractImageBase64,
  extractImageUrl,
  extractJobError,
  extractJobId,
  extractJobStatus,
  imageApiRoot,
  isImageJobFailure,
  isImageJobSuccess,
  type ImageGenerationRequest,
} from '../src/main/agent/image-generation';

// A real 1x1 PNG so mime detection (magic bytes) is exercised for real.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PNG_B64 = PNG_1X1.toString('base64');

const REQUEST: ImageGenerationRequest = {
  provider: 'xkiro',
  model: 'flux-pro',
  prompt: 'A white lighthouse on wet black rocks at dawn.',
  apiKey: 'test-key',
  baseUrl: 'https://api.xkiro.com/v1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

describe('imageApiRoot', () => {
  it('falls back to the native OpenAI root when none is configured', () => {
    expect(imageApiRoot(undefined)).toBe(DEFAULT_OPENAI_IMAGE_BASE_URL);
    expect(imageApiRoot('   ')).toBe(DEFAULT_OPENAI_IMAGE_BASE_URL);
  });

  it('keeps a clean API root and strips trailing slashes', () => {
    expect(imageApiRoot('https://api.xkiro.com/v1')).toBe('https://api.xkiro.com/v1');
    expect(imageApiRoot('https://api.xkiro.com/v1/')).toBe('https://api.xkiro.com/v1');
  });

  it('normalizes every pasted image endpoint back to the root', () => {
    const root = 'https://api.xkiro.com/v1';
    expect(imageApiRoot(root + '/images/generations')).toBe(root);
    expect(imageApiRoot(root + '/images/generation')).toBe(root);
    expect(imageApiRoot(root + '/images/generate')).toBe(root);
    expect(imageApiRoot(root + '/images/generation/{id}')).toBe(root);
    expect(imageApiRoot(root + '/images/generations/job-123')).toBe(root);
  });

  it('NEVER keeps a chat endpoint — this is the old 404 bug', () => {
    const root = 'https://api.xkiro.com/v1';
    expect(imageApiRoot(root + '/chat/completions')).toBe(root);
    expect(imageApiRoot(root + '/completions')).toBe(root);
    expect(imageApiRoot(root + '/responses')).toBe(root);
    expect(imageApiRoot(root + '/messages')).toBe(root);
  });
});

describe('URL contract', () => {
  it('always builds POST <root>/images/generations, never a chat URL', () => {
    const hostileBases = [
      'https://api.xkiro.com/v1/chat/completions',
      'https://api.xkiro.com/v1/images/generation',
      'https://api.xkiro.com/v1/images/generation/{id}',
      'https://api.xkiro.com/v1/',
      undefined,
    ];
    for (const base of hostileBases) {
      const url = buildImageGenerationsUrl(base);
      expect(url.endsWith('/images/generations')).toBe(true);
      expect(url).not.toContain('/chat/completions');
      expect(url).not.toContain('/images/generation/');
      expect(url).not.toContain('{id}');
    }
  });

  it('builds an encoded job poll URL under the generations endpoint', () => {
    expect(buildImageJobUrl('https://api.xkiro.com/v1', 'job/1')).toBe(
      'https://api.xkiro.com/v1/images/generations/job%2F1'
    );
  });
});

describe('response extractors', () => {
  it('reads job ids from flat and nested shapes', () => {
    expect(extractJobId({ id: 'a' })).toBe('a');
    expect(extractJobId({ job_id: 'b' })).toBe('b');
    expect(extractJobId({ data: { task_id: 'c' } })).toBe('c');
    expect(extractJobId({ result: { generation_id: 'd' } })).toBe('d');
    expect(extractJobId({ nothing: true })).toBeNull();
  });

  it('normalizes statuses and classifies them', () => {
    expect(extractJobStatus({ status: 'SUCCEEDED' })).toBe('succeeded');
    expect(extractJobStatus({ data: { state: 'Processing' } })).toBe('processing');
    expect(isImageJobSuccess('succeeded')).toBe(true);
    expect(isImageJobSuccess('completed')).toBe(true);
    expect(isImageJobFailure('failed')).toBe(true);
    expect(isImageJobFailure('queued')).toBe(false);
    expect(isImageJobFailure(null)).toBe(false);
  });

  it('finds base64 bytes and http/data URLs, and ignores non-URLs', () => {
    expect(extractImageBase64({ data: [{ b64_json: PNG_B64 }] })).toBe(PNG_B64);
    expect(extractImageUrl({ data: [{ url: 'https://cdn.example/a.png' }] })).toBe(
      'https://cdn.example/a.png'
    );
    expect(extractImageUrl({ url: 'data:image/png;base64,' + PNG_B64 })).toContain('data:image/png');
    expect(extractImageUrl({ url: 'not-a-url' })).toBeNull();
  });

  it('reads provider error messages', () => {
    expect(extractJobError({ error: { message: 'boom' } })).toBe('boom');
    expect(extractJobError({ error: 'plain' })).toBe('plain');
    expect(extractJobError({ data: { detail: 'nested' } })).toBe('nested');
  });
});

describe('createOpenAiImageTransport', () => {
  it('returns bytes from a synchronous b64 response', async () => {
    const { calls, impl } = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
    const transport = createOpenAiImageTransport({ fetchImpl: impl });
    const result = await transport(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.xkiro.com/v1/images/generations');
    expect(calls[0].init?.method).toBe('POST');
    const body = bodyOf(calls[0].init);
    expect(body.model).toBe('flux-pro');
    expect(body.prompt).toBe(REQUEST.prompt);
    expect(body.n).toBe(1);
    expect(body.size).toBe('1024x1024');
    expect(result.mimeType).toBe('image/png');
    expect(result.base64).toBe(PNG_B64);
    expect(result.model).toBe('flux-pro');
    expect(result.provider).toBe('xkiro');
  });

  it('sends the bearer token and an explicit size/quality when provided', async () => {
    const { calls, impl } = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
    const transport = createOpenAiImageTransport({ fetchImpl: impl });
    await transport({ ...REQUEST, size: '1536x1024', quality: 'high' });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    const body = bodyOf(calls[0].init);
    expect(body.size).toBe('1536x1024');
    expect(body.quality).toBe('high');
  });

  it('downloads a synchronous CDN URL', async () => {
    const { calls, impl } = recordingFetch((url) => {
      if (url === 'https://cdn.example/out.png') {
        return new Response(PNG_1X1, { status: 200 });
      }
      return jsonResponse({ data: [{ url: 'https://cdn.example/out.png' }] });
    });
    const transport = createOpenAiImageTransport({ fetchImpl: impl });
    const result = await transport(REQUEST);

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.xkiro.com/v1/images/generations',
      'https://cdn.example/out.png',
    ]);
    expect(result.mimeType).toBe('image/png');
    expect(result.base64).toBe(PNG_B64);
  });

  it('polls an asynchronous job until it succeeds, then downloads the URL', async () => {
    let polls = 0;
    const { calls, impl } = recordingFetch((url) => {
      if (url === 'https://cdn.example/job.png') return new Response(PNG_1X1, { status: 200 });
      if (url.endsWith('/images/generations')) {
        return jsonResponse({ id: 'job-1', status: 'queued' });
      }
      polls += 1;
      if (polls < 2) return jsonResponse({ id: 'job-1', status: 'processing' });
      return jsonResponse({
        id: 'job-1',
        status: 'succeeded',
        result: { data: [{ url: 'https://cdn.example/job.png' }] },
      });
    });
    const transport = createOpenAiImageTransport({
      fetchImpl: impl,
      sleep: async () => undefined,
      now: () => 0,
    });
    const result = await transport(REQUEST);

    expect(calls[0].url).toBe('https://api.xkiro.com/v1/images/generations');
    expect(calls[1].url).toBe('https://api.xkiro.com/v1/images/generations/job-1');
    expect(calls[1].init?.method).toBe('GET');
    expect(polls).toBe(2);
    expect(calls[calls.length - 1].url).toBe('https://cdn.example/job.png');
    expect(result.base64).toBe(PNG_B64);
  });

  it('accepts base64 delivered by a succeeded job', async () => {
    const { impl } = recordingFetch((url) =>
      url.endsWith('/images/generations')
        ? jsonResponse({ id: 'job-2', status: 'queued' })
        : jsonResponse({ id: 'job-2', status: 'succeeded', b64_json: PNG_B64 })
    );
    const transport = createOpenAiImageTransport({
      fetchImpl: impl,
      sleep: async () => undefined,
      now: () => 0,
    });
    const result = await transport(REQUEST);
    expect(result.base64).toBe(PNG_B64);
    expect(result.mimeType).toBe('image/png');
  });

  it('fails fast when the create call is rejected', async () => {
    const { impl } = recordingFetch(() => jsonResponse({ error: { message: 'bad key' } }, 401));
    const transport = createOpenAiImageTransport({ fetchImpl: impl });
    await expect(transport(REQUEST)).rejects.toThrow(/HTTP 401.*bad key/);
  });

  it('fails when the create response has neither image nor job id', async () => {
    const { impl } = recordingFetch(() => jsonResponse({ status: 'ok' }));
    const transport = createOpenAiImageTransport({ fetchImpl: impl });
    await expect(transport(REQUEST)).rejects.toThrow(/neither image data nor a job id/);
  });

  it('reports a failed job from the poll', async () => {
    const { impl } = recordingFetch((url) =>
      url.endsWith('/images/generations')
        ? jsonResponse({ id: 'job-3', status: 'queued' })
        : jsonResponse({ id: 'job-3', status: 'failed', error: { message: 'gpu on fire' } })
    );
    const transport = createOpenAiImageTransport({
      fetchImpl: impl,
      sleep: async () => undefined,
      now: () => 0,
    });
    await expect(transport(REQUEST)).rejects.toThrow(/job-3 failed \(failed\).*gpu on fire/);
  });

  it('times out when the job never finishes', async () => {
    let clock = 0;
    const { impl } = recordingFetch((url) =>
      url.endsWith('/images/generations')
        ? jsonResponse({ id: 'job-4', status: 'queued' })
        : jsonResponse({ id: 'job-4', status: 'processing' })
    );
    const transport = createOpenAiImageTransport({
      fetchImpl: impl,
      sleep: async () => undefined,
      now: () => {
        clock += 600;
        return clock;
      },
      pollTimeoutMs: 1000,
      pollIntervalMs: 10,
    });
    await expect(transport(REQUEST)).rejects.toThrow(/did not finish within 1s.*processing/);
  });

  it('never posts to a chat endpoint even when the base URL is one', async () => {
    const { calls, impl } = recordingFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
    const transport = createOpenAiImageTransport({ fetchImpl: impl });
    await transport({ ...REQUEST, baseUrl: 'https://api.xkiro.com/v1/chat/completions' });
    expect(calls[0].url).toBe('https://api.xkiro.com/v1/images/generations');
  });

  it('exposes the shared mime detector', () => {
    expect(detectImageMimeType(PNG_1X1)).toBe('image/png');
    expect(detectImageMimeType(Buffer.from('not an image'))).toBeNull();
  });
});
