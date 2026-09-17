import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeUrl,
  buildWebTools,
  htmlToText,
  parseDuckDuckGoResults,
  resolveWebSearchProvider,
} from '../src/main/agent/web-tools';

const DDG_HTML = `
<html><body>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&amp;rut=abc">First &amp; only</a>
  <a class="result__snippet" href="#">A <b>snippet</b> about &quot;things&quot;</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="https://direct.example.org/page">Direct link</a>
  <a class="result__snippet" href="#">Second snippet</a>
</div>
</body></html>`;

describe('resolveWebSearchProvider', () => {
  it('prefers tavily when its key is configured', () => {
    const result = resolveWebSearchProvider(
      { tavilyApiKey: 'tvly-1', braveApiKey: 'brave-1' },
      {}
    );
    expect(result.provider).toBe('tavily');
    expect(result.apiKey).toBe('tvly-1');
  });

  it('falls back to brave when tavily is absent', () => {
    const result = resolveWebSearchProvider({ braveApiKey: 'brave-1' }, {});
    expect(result.provider).toBe('brave');
  });

  it('reads keys from environment when config is empty', () => {
    const result = resolveWebSearchProvider({}, { BRAVE_API_KEY: 'env-brave' });
    expect(result.provider).toBe('brave');
    expect(result.apiKey).toBe('env-brave');
  });

  it('defaults to duckduckgo without any key', () => {
    const result = resolveWebSearchProvider({}, {});
    expect(result.provider).toBe('duckduckgo');
    expect(result.apiKey).toBe('');
  });

  it('prefers config key over environment key for the same provider', () => {
    const result = resolveWebSearchProvider({ tavilyApiKey: 'cfg' }, { TAVILY_API_KEY: 'env' });
    expect(result.apiKey).toBe('cfg');
  });
});

describe('assertSafeUrl', () => {
  it('accepts public http/https URLs', () => {
    expect(assertSafeUrl('https://example.com/page?q=1').hostname).toBe('example.com');
    expect(assertSafeUrl('http://example.com').protocol).toBe('http:');
  });

  it('rejects non-http protocols', () => {
    expect(() => assertSafeUrl('ftp://example.com')).toThrow('http/https');
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow('http/https');
  });

  it('rejects private and loopback targets (SSRF protection)', () => {
    expect(() => assertSafeUrl('http://localhost/x')).toThrow(/private\/internal/);
    expect(() => assertSafeUrl('http://127.0.0.1:8080/x')).toThrow(/private\/internal/);
    expect(() => assertSafeUrl('http://192.168.1.10/x')).toThrow(/private\/internal/);
    expect(() => assertSafeUrl('http://10.0.0.1/x')).toThrow(/private\/internal/);
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data')).toThrow(
      /private\/internal/
    );
    expect(() => assertSafeUrl('http://myserver.local/x')).toThrow(/private\/internal/);
  });

  it('rejects URLs with embedded credentials and malformed URLs', () => {
    expect(() => assertSafeUrl('https://user:pass@example.com')).toThrow('credentials');
    expect(() => assertSafeUrl('not a url')).toThrow('Invalid URL');
  });
});

describe('parseDuckDuckGoResults', () => {
  it('extracts titles, decoded redirect URLs and snippets', () => {
    const results = parseDuckDuckGoResults(DDG_HTML);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('First & only');
    expect(results[0].url).toBe('https://example.com/article');
    expect(results[0].snippet).toBe('A snippet about "things"');
  });

  it('keeps non-redirect hrefs as-is', () => {
    const results = parseDuckDuckGoResults(DDG_HTML);
    expect(results[1].url).toBe('https://direct.example.org/page');
    expect(results[1].title).toBe('Direct link');
  });

  it('returns an empty array for pages without results', () => {
    expect(parseDuckDuckGoResults('<html><body>No results</body></html>')).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('removes script, style and comments', () => {
    const html =
      '<html><head><style>p{color:red}</style></head><body><!-- hidden --><script>evil()</script><p>Hello</p></body></html>';
    expect(htmlToText(html)).toBe('Hello');
  });

  it('converts block elements to line breaks and decodes entities', () => {
    const html = '<div>Line&nbsp;one</div><p>A &amp; B &lt;tag&gt;</p><li>item</li>';
    const text = htmlToText(html);
    expect(text).toContain('Line one');
    expect(text).toContain('A & B <tag>');
    expect(text).toContain('item');
    expect(text).not.toContain('<p>');
  });

  it('collapses runs of blank lines', () => {
    const text = htmlToText('<div>a</div><div></div><div></div><div></div><div>b</div>');
    expect(text).toBe('a\n\nb');
  });
});

describe('buildWebTools execute', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('web_search uses DuckDuckGo and formats results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tools = buildWebTools();
    const search = tools.find((tool) => tool.name === 'web_search');
    expect(search).toBeDefined();

    const result = await search!.execute('call-1', { query: 'test query' }, undefined as never, undefined as never, undefined as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://html.duckduckgo.com/html/',
      expect.objectContaining({ method: 'POST' })
    );
    expect(text).toContain('provider: duckduckgo');
    expect(text).toContain('https://example.com/article');
    expect(text).toContain('Direct link');
  });

  it('web_search returns an error message instead of throwing on HTTP failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('blocked', { status: 403 })) as unknown as typeof fetch;

    const tools = buildWebTools();
    const search = tools.find((tool) => tool.name === 'web_search')!;
    const result = await search.execute('call-1', { query: 'q' }, undefined as never, undefined as never, undefined as never);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('web_search failed');
    expect(text).toContain('403');
  });

  it('web_fetch refuses private hosts without performing any request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tools = buildWebTools();
    const fetchTool = tools.find((tool) => tool.name === 'web_fetch')!;
    const result = await fetchTool.execute(
      'call-1',
      { url: 'http://169.254.169.254/meta' },
      undefined as never,
      undefined as never,
      undefined as never
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toContain('web_fetch failed');
    expect(text).toContain('private/internal');
  });

  it('web_fetch strips HTML and reports the final URL and title', async () => {
    const page =
      '<html><head><title>My Page</title></head><body><script>x()</script><h1>Welcome</h1><p>Body &amp; content</p></body></html>';
    const finalUrl = 'https://example.com/final';
    const response = new Response(page, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    Object.defineProperty(response, 'url', { value: finalUrl });
    globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    const tools = buildWebTools();
    const fetchTool = tools.find((tool) => tool.name === 'web_fetch')!;
    const result = await fetchTool.execute(
      'call-1',
      { url: 'https://example.com' },
      undefined as never,
      undefined as never,
      undefined as never
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Title: My Page');
    expect(text).toContain(`URL: ${finalUrl}`);
    expect(text).toContain('Welcome');
    expect(text).toContain('Body & content');
    expect(text).not.toContain('x()');
  });

  it('web_fetch truncates long content at max_chars', async () => {
    const response = new Response('x'.repeat(3000), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    const tools = buildWebTools();
    const fetchTool = tools.find((tool) => tool.name === 'web_fetch')!;
    const result = await fetchTool.execute(
      'call-1',
      { url: 'https://example.com/big', max_chars: 1000 },
      undefined as never,
      undefined as never,
      undefined as never
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('[Content truncated at 1000 characters]');
  });
});
