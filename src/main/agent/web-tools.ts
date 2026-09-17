/**
 * @module main/agent/web-tools
 *
 * Native web_search / web_fetch tools for the agent runtime.
 *
 * web_search providers, in priority order:
 *  1. Tavily  (optional — TAVILY_API_KEY or config.tavilyApiKey)
 *  2. Brave   (optional — BRAVE_API_KEY  or config.braveApiKey)
 *  3. DuckDuckGo HTML endpoint (default, no API key required)
 *
 * web_fetch downloads a URL and returns cleaned plain text (HTML stripped,
 * scripts/styles removed, basic SSRF protection against private targets).
 *
 * Pure helpers (parsing, provider resolution, URL safety) are exported for tests.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { log, logWarn } from '../utils/logger';

const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 2_000_000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_CHARS = 20_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OpenCowork/1.0';

export interface WebSearchConfig {
  tavilyApiKey?: string;
  braveApiKey?: string;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchProviderId = 'tavily' | 'brave' | 'duckduckgo';

export function resolveWebSearchProvider(
  config: WebSearchConfig,
  env: Record<string, string | undefined> = process.env
): { provider: WebSearchProviderId; apiKey: string } {
  const tavilyKey = config.tavilyApiKey?.trim() || env.TAVILY_API_KEY?.trim() || '';
  if (tavilyKey) return { provider: 'tavily', apiKey: tavilyKey };
  const braveKey = config.braveApiKey?.trim() || env.BRAVE_API_KEY?.trim() || '';
  if (braveKey) return { provider: 'brave', apiKey: braveKey };
  return { provider: 'duckduckgo', apiKey: '' };
}

/**
 * Blocklist of hosts/IP patterns that must never be fetched (SSRF protection).
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^\[?fd/i,
  /\.local$/i,
  /^metadata\.google\.internal$/i,
];

export function assertSafeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http/https URLs are supported, got: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  const host = url.hostname;
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error(`Refusing to fetch private/internal host: ${host}`);
    }
  }
  return url;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x0?27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const parsed = Number(code);
      return Number.isFinite(parsed) && parsed > 0 && parsed < 0x110000
        ? String.fromCodePoint(parsed)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const parsed = parseInt(code, 16);
      return Number.isFinite(parsed) && parsed > 0 && parsed < 0x110000
        ? String.fromCodePoint(parsed)
        : '';
    });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function decodeDuckDuckGoRedirect(href: string): string {
  const match = /[?&]uddg=([^&]+)/.exec(href);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      // fall through to raw href
    }
  }
  if (href.startsWith('//')) return `https:${href}`;
  return href;
}

/**
 * Parse the DuckDuckGo HTML (html.duckduckgo.com/html/) results page.
 * Exported for unit tests.
 */
export function parseDuckDuckGoResults(html: string): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const links: Array<{ url: string; title: string }> = [];
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    links.push({
      url: decodeDuckDuckGoRedirect(linkMatch[1]),
      title: decodeHtmlEntities(stripTags(linkMatch[2])).trim(),
    });
  }

  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(decodeHtmlEntities(stripTags(snippetMatch[1])).replace(/\s+/g, ' ').trim());
  }

  for (let i = 0; i < links.length; i += 1) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || '',
    });
  }
  return results;
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<WebSearchResultItem[]> {
  const response = await timedFetch(
    'https://html.duckduckgo.com/html/',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({ q: query }).toString(),
    },
    SEARCH_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  }
  const html = await response.text();
  return parseDuckDuckGoResults(html).slice(0, maxResults);
}

async function searchBrave(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<WebSearchResultItem[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(Math.max(maxResults, 1), 20)));
  const response = await timedFetch(
    url.toString(),
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
        'User-Agent': USER_AGENT,
      },
    },
    SEARCH_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`Brave Search returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results || [])
    .filter((item) => item.url)
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title || item.url || '',
      url: item.url as string,
      snippet: item.description || '',
    }));
}

async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<WebSearchResultItem[]> {
  const response = await timedFetch(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
    },
    SEARCH_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`Tavily returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results || [])
    .filter((item) => item.url)
    .slice(0, maxResults)
    .map((item) => ({
      title: item.title || (item.url as string),
      url: item.url as string,
      snippet: item.content || '',
    }));
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert an HTML page into readable plain text.
 * Exported for unit tests.
 */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '');
  // Block-level elements become line breaks
  text = text.replace(
    /<\/?(p|div|section|article|header|footer|main|nav|ul|ol|li|tr|table|h[1-6]|blockquote|pre|br|hr)[^>]*>/gi,
    '\n'
  );
  text = stripTags(text);
  text = decodeHtmlEntities(text);
  // Collapse whitespace: trim lines, drop 3+ consecutive blank lines
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return '';
  return decodeHtmlEntities(stripTags(match[1])).replace(/\s+/g, ' ').trim();
}

export interface FetchPageResult {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  text: string;
  truncated: boolean;
}

async function fetchPage(rawUrl: string, maxChars: number): Promise<FetchPageResult> {
  const url = assertSafeUrl(rawUrl);
  const response = await timedFetch(
    url.toString(),
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
      },
      redirect: 'follow',
    },
    FETCH_TIMEOUT_MS
  );

  const contentType = response.headers.get('content-type') || '';
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_FETCH_BYTES) {
    throw new Error(
      `Response too large (${Math.round(contentLength / 1024)} KB, limit ${MAX_FETCH_BYTES / 1024} KB)`
    );
  }

  const buffer = await response.arrayBuffer();
  const slice = buffer.byteLength > MAX_FETCH_BYTES ? buffer.slice(0, MAX_FETCH_BYTES) : buffer;
  const body = new TextDecoder('utf-8', { fatal: false }).decode(slice);

  let title = '';
  let text: string;
  if (contentType.includes('html') || /^\s*<(!doctype|html)/i.test(body)) {
    title = extractTitle(body);
    text = htmlToText(body);
  } else {
    text = body;
  }

  const truncated = text.length > maxChars;
  if (truncated) {
    text = `${text.slice(0, maxChars)}\n\n[Content truncated at ${maxChars} characters]`;
  }

  return {
    url: url.toString(),
    finalUrl: response.url || url.toString(),
    status: response.status,
    title,
    text,
    truncated,
  };
}

function formatSearchResults(items: WebSearchResultItem[], provider: WebSearchProviderId): string {
  if (items.length === 0) {
    return 'No results found.';
  }
  const lines = items.map((item, index) => {
    const parts = [`${index + 1}. ${item.title}`, `   URL: ${item.url}`];
    if (item.snippet) {
      parts.push(`   ${item.snippet.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    return parts.join('\n');
  });
  return `Search results (provider: ${provider}):\n\n${lines.join('\n\n')}`;
}

/**
 * Build the native web tools for the agent SDK.
 * @param config optional API keys for the premium search providers
 */
export function buildWebTools(config: WebSearchConfig = {}): ToolDefinition[] {
  const searchWebTool: ToolDefinition<TSchema, unknown> = {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web for current information. Returns a list of results with title, URL and snippet. ' +
      'Uses Tavily or Brave if an API key is configured, otherwise falls back to DuckDuckGo (no key required). ' +
      'Use web_fetch to read the full content of a result.',
    parameters: Type.Object({
      query: Type.String({ description: 'The search query' }),
      max_results: Type.Optional(
        Type.Number({ description: 'Maximum number of results to return (default 8, max 20)' })
      ),
    }),
    async execute(_toolCallId, params) {
      const args = params as { query: string; max_results?: number };
      const maxResults = Math.min(Math.max(Math.round(args.max_results ?? DEFAULT_MAX_RESULTS), 1), 20);
      try {
        const { provider, apiKey } = resolveWebSearchProvider(config);
        let items: WebSearchResultItem[];
        if (provider === 'tavily') {
          items = await searchTavily(args.query, maxResults, apiKey);
        } else if (provider === 'brave') {
          items = await searchBrave(args.query, maxResults, apiKey);
        } else {
          items = await searchDuckDuckGo(args.query, maxResults);
        }
        return {
          content: [{ type: 'text' as const, text: formatSearchResults(items, provider) }],
          details: {},
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn('[WebTools] web_search failed:', message);
        return {
          content: [
            {
              type: 'text' as const,
              text: `web_search failed: ${message}. Try rephrasing the query or use web_fetch on a known URL.`,
            },
          ],
          details: {},
        };
      }
    },
  };

  const fetchWebTool: ToolDefinition<TSchema, unknown> = {
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch a web page or API endpoint and return its content as cleaned plain text (HTML, scripts and ' +
      'styles removed). Works with http/https URLs only. Use after web_search to read a result in full, ' +
      'or directly when you already know the URL.',
    parameters: Type.Object({
      url: Type.String({ description: 'The http/https URL to fetch' }),
      max_chars: Type.Optional(
        Type.Number({ description: 'Maximum number of characters to return (default 20000)' })
      ),
    }),
    async execute(_toolCallId, params) {
      const args = params as { url: string; max_chars?: number };
      try {
        const maxChars = Math.min(
          Math.max(Math.round(args.max_chars ?? DEFAULT_MAX_CHARS), 500),
          100_000
        );
        const result = await fetchPage(args.url, maxChars);
        const header = [
          result.title ? `Title: ${result.title}` : '',
          `URL: ${result.finalUrl}`,
          `Status: ${result.status}`,
          result.truncated ? '(content truncated)' : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [{ type: 'text' as const, text: `${header}\n\n${result.text}` }],
          details: {},
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn('[WebTools] web_fetch failed:', message);
        return {
          content: [{ type: 'text' as const, text: `web_fetch failed: ${message}` }],
          details: {},
        };
      }
    },
  };

  log('[WebTools] Registered native web_search + web_fetch tools');
  return [searchWebTool, fetchWebTool];
}
