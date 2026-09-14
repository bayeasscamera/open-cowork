import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { writeMCPLog } from '../mcp-logger.js';
import {
  PLATFORM,
  SCREENSHOTS_DIR,
  OPENAI_PLATFORM_BASE_URL,
  toRegionKey,
  getReusableScreenshot,
  updateScreenshotCache,
  type DockItemInfo,
  type ClickHistoryEntry,
} from './state.js';
import { getDisplayConfiguration } from './display-coords.js';
import {
  executePython,
  executeCommandSafe,
  executeJXAScript,
  getFrontmostMacApplicationName,
} from './exec.js';
import {
  takeScreenshot,
  performClick,
  performType,
  moveMouse,
  performKeyPress,
} from './actions.js';
import {
  ensureAppContextRestored,
  inferExpectedAppAliasesFromText,
  isLikelyAppLaunchVerification,
  appNameMatchesAliases,
  getClickHistoryForDisplay,
  saveLatestClickToHistory,
  isDescriptionDockRelated,
  scoreDockItemAgainstDescription,
  currentAppName,
  clickHistory,
  lastClickEntry,
} from './click-history.js';

export async function getMacDockItemsViaAccessibility(): Promise<DockItemInfo[]> {
  if (PLATFORM !== 'darwin') return [];

  const jxaScript = [
    'const se = Application("System Events");',
    'const dock = se.processes.byName("Dock");',
    'const items = dock.lists[0].uiElements();',
    'const out = [];',
    'for (let i = 0; i < items.length; i++) {',
    '  try {',
    '    const n = String(items[i].name());',
    '    const p = items[i].position();',
    '    const s = items[i].size();',
    '    if (!n || n === "missing value" || n === "null") continue;',
    '    out.push({name:n, x:Number(p[0]), y:Number(p[1]), width:Number(s[0]), height:Number(s[1])});',
    '  } catch (e) {}',
    '}',
    'JSON.stringify(out);',
  ].join(' ');

  const { stdout } = await executeJXAScript(jxaScript, 10000);

  let parsed: DockItemInfo[];
  try {
    parsed = JSON.parse(stdout.trim()) as DockItemInfo[];
  } catch {
    writeMCPLog('[GUI] Failed to parse dock items JSON', 'DockItems Error');
    parsed = [];
  }
  return parsed.filter(
    (item) =>
      item &&
      typeof item.name === 'string' &&
      typeof item.x === 'number' &&
      typeof item.y === 'number' &&
      typeof item.width === 'number' &&
      typeof item.height === 'number' &&
      item.width > 0 &&
      item.height > 0
  );
}

export async function tryLocateElementInDockByAccessibility(
  elementDescription: string,
  displayIndex?: number
): Promise<{
  x: number;
  y: number;
  confidence: number;
  displayIndex: number;
  reasoning?: string;
} | null> {
  if (!isDescriptionDockRelated(elementDescription)) {
    return null;
  }

  const dockItems = await getMacDockItemsViaAccessibility();
  if (dockItems.length === 0) {
    return null;
  }

  let bestItem: DockItemInfo | null = null;
  let bestScore = 0;

  for (const item of dockItems) {
    const score = scoreDockItemAgainstDescription(item.name, elementDescription);
    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  if (!bestItem || bestScore < 120) {
    writeMCPLog(
      `[dock-accessibility] No reliable Dock match for "${elementDescription}". Best score: ${bestScore}`,
      'Dock Locate'
    );
    return null;
  }

  const centerGlobalX = Math.round(bestItem.x + bestItem.width / 2);
  const centerGlobalY = Math.round(bestItem.y + bestItem.height / 2);
  const config = await getDisplayConfiguration();

  let targetDisplay = config.displays.find(
    (d) =>
      centerGlobalX >= d.originX &&
      centerGlobalX <= d.originX + d.width &&
      centerGlobalY >= d.originY &&
      centerGlobalY <= d.originY + d.height
  );

  if (!targetDisplay) {
    targetDisplay =
      displayIndex !== undefined
        ? config.displays.find((d) => d.index === displayIndex)
        : config.displays.find((d) => d.isMain);
  }

  if (!targetDisplay) {
    return null;
  }

  const localX = Math.round(centerGlobalX - targetDisplay.originX);
  const localY = Math.round(centerGlobalY - targetDisplay.originY);

  writeMCPLog(
    `[dock-accessibility] Matched "${bestItem.name}" for "${elementDescription}" at global (${centerGlobalX}, ${centerGlobalY}), local (${localX}, ${localY}), display ${targetDisplay.index}, score=${bestScore}`,
    'Dock Locate'
  );

  return {
    x: localX,
    y: localY,
    confidence: Math.min(99, bestScore),
    displayIndex: targetDisplay.index,
    reasoning: `Matched Dock item "${bestItem.name}" via macOS Accessibility.`,
  };
}


/**
 * Call vision API to analyze images with timeout and retry
 */
export async function callVisionAPI(
  base64Image: string,
  prompt: string,
  maxTokens: number = 2048,
  functionName?: string
): Promise<string> {
  const MAX_RETRIES = 3;
  const TIMEOUT_MS = 90000; // 45 seconds

  const logPrefix = functionName ? `[callVisionAPI:${functionName}]` : '[callVisionAPI]';
  let compatibilityFallbackUsed = false;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      writeMCPLog(
        `${logPrefix} Attempt ${attempt}/${MAX_RETRIES} - Starting API call`,
        'API Request'
      );

      const result = await callVisionAPIWithTimeout(
        base64Image,
        prompt,
        maxTokens,
        functionName,
        TIMEOUT_MS
      );

      writeMCPLog(`${logPrefix} Attempt ${attempt}/${MAX_RETRIES} - Success`, 'API Request');
      return result;
    } catch (error: unknown) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const errorMessage = String(error instanceof Error ? error.message : error || '');

      // Deterministic request-shape errors should fail fast instead of wasting retries.
      if (isVisionRequestShapeError(errorMessage)) {
        if (!compatibilityFallbackUsed) {
          compatibilityFallbackUsed = true;
          writeMCPLog(
            `${logPrefix} Attempt ${attempt}/${MAX_RETRIES} - Request-shape error detected, running one compatibility fallback: ${errorMessage}`,
            'API Request Error'
          );
          try {
            const compatResult = await callVisionAPIWithTimeout(
              base64Image,
              prompt,
              maxTokens,
              functionName,
              TIMEOUT_MS,
              true,
              errorMessage
            );
            writeMCPLog(`${logPrefix} Compatibility fallback succeeded`, 'API Request');
            return compatResult;
          } catch (compatError: unknown) {
            const compatMessage = String(
              compatError instanceof Error ? compatError.message : compatError || ''
            );
            writeMCPLog(
              `${logPrefix} Compatibility fallback failed: ${compatMessage}`,
              'API Request Error'
            );
            throw new Error(compatMessage || errorMessage);
          }
        }
        writeMCPLog(
          `${logPrefix} Attempt ${attempt}/${MAX_RETRIES} - Deterministic error, stop retry: ${errorMessage}`,
          'API Request Error'
        );
        throw new Error(errorMessage);
      }

      if (errorMessage.includes('timeout')) {
        writeMCPLog(
          `${logPrefix} Attempt ${attempt}/${MAX_RETRIES} - Timeout after ${TIMEOUT_MS}ms`,
          'API Request Error'
        );
      } else {
        writeMCPLog(
          `${logPrefix} Attempt ${attempt}/${MAX_RETRIES} - Error: ${errorMessage}`,
          'API Request Error'
        );
      }

      if (isLastAttempt) {
        writeMCPLog(`${logPrefix} All ${MAX_RETRIES} attempts failed`, 'API Request Failed');
        throw new Error(`Vision API failed after ${MAX_RETRIES} attempts: ${errorMessage}`);
      }

      // Wait before retry (exponential backoff: 1s, 2s, 4s)
      const waitTime = Math.pow(2, attempt - 1) * 1000;
      writeMCPLog(`${logPrefix} Waiting ${waitTime}ms before retry...`, 'API Request Retry');
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  throw new Error('Vision API failed: Maximum retries exceeded');
}

export function isVisionRequestShapeError(errorMessage: string): boolean {
  if (!errorMessage) {
    return false;
  }
  return (
    errorMessage.includes('Unsupported parameter') ||
    errorMessage.includes('Instructions are required') ||
    errorMessage.includes('Stream must be set to true')
  );
}

export function getBaseUrlHost(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return '(unset)';
  }
  try {
    return new URL(baseUrl).host || '(unknown)';
  } catch {
    return '(invalid-url)';
  }
}

export function buildVisionRuntimeSummary(
  functionName: string | undefined,
  anthropicApiKey: string | undefined,
  openAIApiKey: string | undefined,
  baseUrl: string | undefined,
  model: string,
  isOpenAICompatible: boolean,
  compatibilityMode: boolean
): Record<string, unknown> {
  return {
    functionName: functionName || '(unknown)',
    hasAnthropicApiKey: Boolean(anthropicApiKey),
    hasOpenAIApiKey: Boolean(openAIApiKey),
    hasAnyApiKey: Boolean(anthropicApiKey || openAIApiKey),
    baseUrlHost: getBaseUrlHost(baseUrl),
    model,
    isOpenAICompatible,
    compatibilityMode,
  };
}

export function pickVisionApiKey(
  selectedRoute: 'openai-chat-completions' | 'anthropic-messages',
  anthropicApiKey: string | undefined,
  openAIApiKey: string | undefined,
  isOpenRouter: boolean
): string | undefined {
  if (selectedRoute === 'anthropic-messages') {
    return anthropicApiKey;
  }
  // OpenRouter historically reuses Anthropic-style key env vars.
  if (isOpenRouter) {
    return anthropicApiKey || openAIApiKey;
  }
  return openAIApiKey;
}

/**
 * Call vision API with timeout
 */
export async function callVisionAPIWithTimeout(
  base64Image: string,
  prompt: string,
  maxTokens: number,
  functionName: string | undefined,
  timeoutMs: number,
  compatibilityMode: boolean = false,
  previousErrorMessage?: string
): Promise<string> {
  // Get API configuration from environment (supports Anthropic/OpenRouter/OpenAI-compatible)
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const openAIApiKey = process.env.OPENAI_API_KEY;
  const openAIBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  const openAIModel = process.env.OPENAI_MODEL?.trim();
  const anthropicModel =
    process.env.CLAUDE_MODEL?.trim() || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim();
  // NOTE: OPENAI_API_KEY may be auto-hydrated for MCP subprocess compatibility.
  // Route inference must rely on semantic OpenAI hints (base/model), not key presence.
  const hasOpenAIConfig = Boolean(openAIBaseUrl || openAIModel);
  const baseUrl = openAIBaseUrl || anthropicBaseUrl;
  const model = openAIModel || anthropicModel || 'claude-sonnet-4-6';

  // Check if using OpenRouter
  const isOpenRouter =
    !!baseUrl && (baseUrl.includes('openrouter.ai') || baseUrl.includes('openrouter'));

  // Check if model/config is OpenAI-compatible (Gemini, GPT, etc.)
  const isOpenAICompatible =
    hasOpenAIConfig ||
    model.includes('gemini') ||
    model.includes('gpt-') ||
    model.includes('openai/') ||
    isOpenRouter ||
    (baseUrl ? baseUrl.includes('api.openai.com') : false);

  const runtimeSummary = buildVisionRuntimeSummary(
    functionName,
    anthropicApiKey,
    openAIApiKey,
    baseUrl,
    model,
    isOpenAICompatible,
    compatibilityMode
  );
  writeMCPLog(JSON.stringify(runtimeSummary), 'Vision Runtime');

  const selectedRoute = isOpenAICompatible ? 'openai-chat-completions' : 'anthropic-messages';
  writeMCPLog(
    `[Vision Routing] function=${functionName || '(unknown)'} route=${selectedRoute} host=${getBaseUrlHost(baseUrl)} model=${model}${previousErrorMessage ? ` previousError=${previousErrorMessage}` : ''}`,
    'Vision Routing'
  );

  const selectedApiKey = pickVisionApiKey(
    selectedRoute,
    anthropicApiKey,
    openAIApiKey,
    isOpenRouter
  );
  if (!selectedApiKey) {
    if (selectedRoute === 'anthropic-messages') {
      throw new Error(
        'Anthropic API key not configured. Please set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.'
      );
    }
    throw new Error('OpenAI API key not configured for vision route. Please set OPENAI_API_KEY.');
  }

  if (isOpenAICompatible) {
    // Use OpenAI-compatible API format (for Gemini, GPT, etc. via OpenRouter)
    const openAIBaseUrl = baseUrl || OPENAI_PLATFORM_BASE_URL;
    const openAIUrl = openAIBaseUrl.endsWith('/v1')
      ? `${openAIBaseUrl}/chat/completions`
      : `${openAIBaseUrl}/v1/chat/completions`;

    // Use Node.js built-in https module for better compatibility
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const https = require('https');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('http');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const url = require('url');

    const urlObj = new url.URL(openAIUrl);
    const isHttps = urlObj.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const requestBodyObj: Record<string, unknown> = {
      model: model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
      max_tokens: maxTokens,
    };

    const requestBody = JSON.stringify(requestBodyObj);

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${selectedApiKey}`,
      'Content-Length': Buffer.byteLength(requestBody),
    };

    if (isOpenRouter) {
      headers['HTTP-Referer'] = 'https://github.com/OpenCoworkAI/open-cowork';
      headers['X-Title'] = 'Open Cowork';
    }

    return new Promise<string>((resolve, reject) => {
      // eslint-disable-next-line prefer-const
      let timeoutId: ReturnType<typeof setTimeout>;
      let isResolved = false;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: headers,
        timeout: timeoutMs,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = httpModule.request(options, (res: any) => {
        let data = '';

        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });

        res.on('end', () => {
          if (isResolved) return;
          clearTimeout(timeoutId);

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              writeMCPLog(
                `[callVisionAPIWithTimeout] Response received, length: ${data.length}`,
                'API Response'
              );
              const jsonData = JSON.parse(data);
              const responseContent = jsonData.choices[0]?.message?.content || '';

              // Log the response
              const logLabel = functionName
                ? `Vision API Response [${functionName}]`
                : 'Vision API Response';
              writeMCPLog(responseContent, logLabel);

              isResolved = true;
              resolve(responseContent);
            } catch (e: unknown) {
              isResolved = true;
              reject(
                new Error(
                  `Failed to parse API response: ${e instanceof Error ? e.message : String(e)}`
                )
              );
            }
          } else {
            isResolved = true;
            reject(
              new Error(`API request failed: ${res.statusCode} ${res.statusMessage} - ${data}`)
            );
          }
        });
      });

      // Set timeout
      timeoutId = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          req.destroy();
          reject(new Error(`API request timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      req.on('error', (error: Error) => {
        if (isResolved) return;
        clearTimeout(timeoutId);
        isResolved = true;
        reject(new Error(`API request error: ${error.message}`));
      });

      req.on('timeout', () => {
        if (isResolved) return;
        clearTimeout(timeoutId);
        isResolved = true;
        req.destroy();
        reject(new Error(`API request timeout after ${timeoutMs}ms`));
      });

      req.write(requestBody);
      req.end();
    });
  } else {
    // Use Anthropic API format
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropicRouteBaseUrl = anthropicBaseUrl || baseUrl;
    const anthropicRouteModel = anthropicModel || model;
    const anthropic = new Anthropic({
      apiKey: selectedApiKey,
      baseURL: anthropicRouteBaseUrl,
      timeout: timeoutMs,
    });

    // Wrap the API call with timeout promise
    const apiCallPromise = anthropic.messages.create({
      model: anthropicRouteModel,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`API request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const message = await Promise.race([apiCallPromise, timeoutPromise]);

      const responseContent = message.content[0].type === 'text' ? message.content[0].text : '';

      // Log the response
      const logLabel = functionName
        ? `Vision API Response [${functionName}]`
        : 'Vision API Response';
      writeMCPLog(responseContent, logLabel);
      writeMCPLog(
        `[callVisionAPIWithTimeout] Response received, length: ${responseContent.length}`,
        'API Response'
      );

      return responseContent;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('timeout')) {
        throw new Error(`API request timeout after ${timeoutMs}ms`);
      }
      throw error;
    }
  }
}

/**
 * Annotate screenshot with click history markers
 * Returns path to annotated image and click history info
 */
export async function annotateScreenshotWithClickHistory(
  screenshotPath: string,
  displayIndex: number
): Promise<{ annotatedPath: string; clickHistoryInfo: string }> {
  // If server restarted, restore last app context so click history markers are available.
  if (!currentAppName && clickHistory.length === 0) {
    await ensureAppContextRestored();
  }

  // Debug: Log the full click history array
  writeMCPLog(
    `[annotateScreenshot] Total clicks in history: ${clickHistory.length}`,
    'Click History Debug'
  );
  writeMCPLog(
    `[annotateScreenshot] Full click history: ${JSON.stringify(clickHistory)}`,
    'Click History Debug'
  );
  writeMCPLog(
    `[annotateScreenshot] Requested displayIndex: ${displayIndex}`,
    'Click History Debug'
  );

  const clickHistoryForDisplay = getClickHistoryForDisplay(displayIndex);

  writeMCPLog(
    `[annotateScreenshot] Filtered clicks for display ${displayIndex}: ${clickHistoryForDisplay.length}`,
    'Click History Debug'
  );

  if (clickHistoryForDisplay.length === 0) {
    // No click history, return original path
    return {
      annotatedPath: screenshotPath,
      clickHistoryInfo: 'No previous clicks recorded.',
    };
  }

  // Create annotated image path
  const timestamp = Date.now();
  const basename = path.basename(screenshotPath, '.png');
  const annotatedPath = path.join(
    path.dirname(screenshotPath),
    `${basename}_annotated_${timestamp}.png`
  );

  // Get image dimensions to calculate normalized coordinates
  const imageDims = await getImageDimensions(screenshotPath);

  // Get display configuration to handle Retina scaling
  const config = await getDisplayConfiguration();
  const targetDisplay = config.displays.find((d) => d.index === displayIndex);
  const rawScaleFactor = targetDisplay?.scaleFactor || 1;
  // On Windows, click coordinates are already in physical pixels (DPI-aware pipeline),
  // so no scaling is needed. On macOS, coordinates are logical and need scaleFactor.
  const scaleFactor = PLATFORM === 'win32' ? 1 : rawScaleFactor;

  writeMCPLog(
    `[annotateScreenshot] Image dimensions: ${imageDims.width}x${imageDims.height}, rawScaleFactor: ${rawScaleFactor}, effective: ${scaleFactor}`,
    'Image Info'
  );

  // Find the most recent click (highest timestamp) to display as #0
  const mostRecentClick = clickHistoryForDisplay.reduce(
    (latest, current) => (current.timestamp > latest.timestamp ? current : latest),
    clickHistoryForDisplay[0]
  );

  writeMCPLog(
    `[annotateScreenshot] Most recent click: (${mostRecentClick.x}, ${mostRecentClick.y}) at timestamp ${mostRecentClick.timestamp}`,
    'Click Sorting'
  );

  // Sort remaining clicks by weighted score (successCount * 2 + count), then by timestamp (descending) for same score
  // Exclude the most recent click from this sorting
  const remainingClicks = clickHistoryForDisplay.filter((click) => click !== mostRecentClick);
  const sortedClicks = remainingClicks.sort((a, b) => {
    const scoreA = (a.successCount || 0) * 2 + a.count;
    const scoreB = (b.successCount || 0) * 2 + b.count;

    if (scoreB !== scoreA) {
      return scoreB - scoreA; // Higher weighted score first
    }
    return b.timestamp - a.timestamp; // Newer timestamp first (for same score)
  });

  writeMCPLog(
    `[annotateScreenshot] Sorted ${sortedClicks.length} remaining clicks by weighted score (successCount*2 + count) and recency`,
    'Click Sorting'
  );

  // Filter out overlapping clicks - keep only clicks that are far enough apart
  // Maximum 9 markers to avoid cluttering the screenshot (including the #0 marker)
  const MIN_DISTANCE_PIXELS = 200; // Minimum distance between annotations (in pixels)
  // const MAX_MARKERS = 10; // Maximum number of markers to display (including #0)
  const MAX_MARKERS = 5;
  const filteredClicks: ClickHistoryEntry[] = [];

  // Always add the most recent click as #0
  filteredClicks.push(mostRecentClick);

  // Filter remaining clicks
  for (const entry of sortedClicks) {
    // Stop if we've reached the maximum number of markers
    if (filteredClicks.length >= MAX_MARKERS) {
      writeMCPLog(
        `[annotateScreenshot] Reached maximum of ${MAX_MARKERS} markers, stopping`,
        'Click Filtering'
      );
      break;
    }

    // Convert logical coordinates to pixel coordinates
    const pixelX = entry.x * scaleFactor;
    const pixelY = entry.y * scaleFactor;

    // Check if this click is too close to any already-selected click
    let tooClose = false;
    for (const selected of filteredClicks) {
      const selectedPixelX = selected.x * scaleFactor;
      const selectedPixelY = selected.y * scaleFactor;

      const distance = Math.sqrt(
        Math.pow(pixelX - selectedPixelX, 2) + Math.pow(pixelY - selectedPixelY, 2)
      );

      if (distance < MIN_DISTANCE_PIXELS) {
        tooClose = true;
        writeMCPLog(
          `[annotateScreenshot] Skipping click at (${entry.x}, ${entry.y}) - too close to (${selected.x}, ${selected.y}), distance: ${Math.round(distance)}px`,
          'Click Filtering'
        );
        break;
      }
    }

    if (!tooClose) {
      filteredClicks.push(entry);
    }
  }

  writeMCPLog(
    `[annotateScreenshot] Filtered clicks: ${clickHistoryForDisplay.length} -> ${filteredClicks.length} (removed overlapping, max ${MAX_MARKERS})`,
    'Click Filtering'
  );

  // Renumber the filtered clicks with consecutive indices starting from 0
  // The first click (most recent) gets #0, then #1, #2, #3...
  const uniqueClicks = filteredClicks.map((entry, index) => ({
    ...entry,
    displayIndex_original: entry.displayIndex, // Keep original display index
    displayNumber: index, // New consecutive number for display (0, 1, 2, 3...)
  }));

  writeMCPLog(
    `[annotateScreenshot] Renumbered ${uniqueClicks.length} clicks with consecutive indices 0-${uniqueClicks.length - 1} (most recent click is #0)`,
    'Click Renumbering'
  );

  // Build click history info text with normalized coordinates
  const historyLines = uniqueClicks.map((entry) => {
    // Convert logical coordinates to pixel coordinates for the screenshot
    const pixelX = entry.x * scaleFactor;
    const pixelY = entry.y * scaleFactor;

    // Calculate normalized coordinates (0-1000)
    const normX = Math.round((pixelX / imageDims.width) * 1000);
    const normY = Math.round((pixelY / imageDims.height) * 1000);

    return `  #${entry.displayNumber}: [${normY}, ${normX}] (logical: ${entry.x}, ${entry.y}) - ${entry.operation}`;
  });
  const clickHistoryInfo = `Previous clicks on this display (normalized to 0-1000, sorted by frequency):\n${historyLines.join('\n')}`;

  // Create Python script to annotate image
  // Pass image dimensions and scale factor to Python
  const pythonScript = `
import sys
import json
from PIL import Image, ImageDraw, ImageFont

try:
    # Load image
    img = Image.open(json.loads(${JSON.stringify(JSON.stringify(screenshotPath.replace(/\\/g, '/')))}))
    img_width, img_height = img.size
    scale_factor = ${scaleFactor}
    
    # Create a semi-transparent overlay for drawing
    overlay = Image.new('RGBA', img.size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(overlay)
    
    # Try to use a nice font, fallback to default
    # Platform-specific font paths
    import platform
    font = None
    small_font = None
    
    if platform.system() == 'Windows':
        # Windows fonts
        font_paths = [
            'C:/Windows/Fonts/arial.ttf',
            'C:/Windows/Fonts/segoeui.ttf',
            'C:/Windows/Fonts/tahoma.ttf',
        ]
    else:
        # macOS fonts
        font_paths = [
            '/System/Library/Fonts/Helvetica.ttc',
            '/System/Library/Fonts/SFNSDisplay.ttf',
            '/Library/Fonts/Arial.ttf',
        ]
    
    for font_path in font_paths:
        try:
            font = ImageFont.truetype(font_path, 32)
            small_font = ImageFont.truetype(font_path, 20)
            break
        except:
            continue
    
    if font is None:
        font = ImageFont.load_default()
        small_font = ImageFont.load_default()
    
    # Draw markers for each click
    clicks = ${JSON.stringify(uniqueClicks)}
    
    for click in clicks:
        # Logical coordinates from click history
        logical_x, logical_y = click['x'], click['y']
        display_number = click['displayNumber']  # Use the renumbered consecutive index
        
        # Convert logical coordinates to pixel coordinates for drawing
        pixel_x = int(logical_x * scale_factor)
        pixel_y = int(logical_y * scale_factor)
        
        # Calculate normalized coordinates (0-1000) for display
        norm_x = round((pixel_x / img_width) * 1000)
        norm_y = round((pixel_y / img_height) * 1000)
        
        # Draw circle with semi-transparent fill and bright outline
        radius = 20
        # Semi-transparent yellow fill
        draw.ellipse(
            [(pixel_x - radius, pixel_y - radius), (pixel_x + radius, pixel_y + radius)],
            fill=(255, 255, 0, 60),  # Yellow with 60/255 opacity
            outline=(255, 200, 0, 255),  # Bright orange outline, fully opaque
            width=3
        )
        
        # Draw crosshair (the exact click position) - bright and visible
        cross_size = 12
        draw.line(
            [(pixel_x - cross_size, pixel_y), (pixel_x + cross_size, pixel_y)], 
            fill=(255, 0, 0, 255),  # Bright red, fully opaque
            width=2
        )
        draw.line(
            [(pixel_x, pixel_y - cross_size), (pixel_x, pixel_y + cross_size)], 
            fill=(255, 0, 0, 255),  # Bright red, fully opaque
            width=2
        )
        
        # Draw center dot for extra visibility
        dot_radius = 3
        draw.ellipse(
            [(pixel_x - dot_radius, pixel_y - dot_radius), (pixel_x + dot_radius, pixel_y + dot_radius)],
            fill=(255, 0, 0, 255)  # Bright red dot
        )
        
        # Draw number label with NORMALIZED coordinates (0-1000)
        label = f"#{display_number}"
        coord_label = f"[{norm_y},{norm_x}]"
        
        # Get text bounding boxes
        bbox_num = draw.textbbox((0, 0), label, font=font)
        bbox_coord = draw.textbbox((0, 0), coord_label, font=small_font)
        
        num_width = bbox_num[2] - bbox_num[0]
        num_height = bbox_num[3] - bbox_num[1]
        coord_width = bbox_coord[2] - bbox_coord[0]
        coord_height = bbox_coord[3] - bbox_coord[1]
        
        # Use the wider of the two labels for background width
        max_width = max(num_width, coord_width)
        total_height = num_height + coord_height + 4  # 4px spacing between lines
        
        # Position label above and to the right of the marker
        label_x = pixel_x + radius + 8
        label_y = pixel_y - radius - total_height - 8
        
        # Ensure label stays within image bounds
        if label_x + max_width + 10 > img_width:
            label_x = pixel_x - radius - max_width - 18
        if label_y < 0:
            label_y = pixel_y + radius + 8
        
        # Draw semi-transparent background rectangle with border
        padding = 4
        # Background with transparency
        draw.rectangle(
            [
                (label_x - padding, label_y - padding),
                (label_x + max_width + padding, label_y + total_height + padding)
            ],
            fill=(0, 0, 0, 180),  # Black with 180/255 opacity
            outline=(255, 200, 0, 255),  # Orange border
            width=2
        )
        
        # Draw number text in bright yellow
        draw.text((label_x, label_y), label, fill=(255, 255, 0, 255), font=font)
        
        # Draw normalized coordinate text below the number in white
        coord_y = label_y + num_height + 2
        draw.text((label_x, coord_y), coord_label, fill=(255, 255, 255, 255), font=small_font)
    
    # Convert back to RGB and composite with original image
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    img = Image.alpha_composite(img, overlay)
    img = img.convert('RGB')
    
    # Save annotated image
    img.save('${annotatedPath.replace(/\\/g, '/').replace(/'/g, "\\'")}')
    print('SUCCESS')
    
except Exception as e:
    print(f'ERROR: {str(e)}', file=sys.stderr)
    sys.exit(1)
`.trim();

  try {
    const result = await executePython(pythonScript, 20000);

    if (result.stdout.includes('SUCCESS')) {
      writeMCPLog(
        `[annotateScreenshot] Successfully annotated screenshot with ${clickHistoryForDisplay.length} click markers`,
        'Screenshot Annotation'
      );
      writeMCPLog(
        `[annotateScreenshot] Annotated image saved to: ${annotatedPath}`,
        'Screenshot Annotation'
      );
      return { annotatedPath, clickHistoryInfo };
    } else {
      writeMCPLog(
        `[annotateScreenshot] Python script did not return SUCCESS: ${result.stdout}`,
        'Screenshot Annotation Error'
      );
      throw new Error('Failed to annotate screenshot');
    }
  } catch (error: unknown) {
    writeMCPLog(
      `[annotateScreenshot] Error annotating screenshot: ${error instanceof Error ? error.message : String(error)}`,
      'Screenshot Annotation Error'
    );
    // Fallback: return original path if annotation fails
    return {
      annotatedPath: screenshotPath,
      clickHistoryInfo,
    };
  }
}

/**
 * Analyze screenshot with vision model to locate element
 */
export async function analyzeScreenshotWithVision(
  screenshotPath: string,
  elementDescription: string,
  displayIndex?: number
): Promise<{
  x: number;
  y: number;
  confidence: number;
  displayIndex: number;
  boundingBox?: { left: number; top: number; right: number; bottom: number };
}> {
  try {
    // Get display configuration for coordinate system info
    const config = await getDisplayConfiguration();
    const targetDisplay =
      displayIndex !== undefined
        ? config.displays.find((d) => d.index === displayIndex)
        : config.displays.find((d) => d.isMain);

    if (!targetDisplay) {
      throw new Error(`Display index ${displayIndex} not found`);
    }

    // Annotate screenshot with click history
    const { annotatedPath, clickHistoryInfo } = await annotateScreenshotWithClickHistory(
      screenshotPath,
      targetDisplay.index
    );

    // const annotatedPath = screenshotPath;

    writeMCPLog(
      `[analyzeScreenshotWithVision] Using screenshot: ${annotatedPath}`,
      'Screenshot Selection'
    );
    writeMCPLog(
      `[analyzeScreenshotWithVision] Click history: ${clickHistoryInfo}`,
      'Click History'
    );

    // Read annotated screenshot as base64
    const imageBuffer = await fs.readFile(annotatedPath);
    const base64Image = imageBuffer.toString('base64');

    // Get image dimensions
    const imageDims = await getImageDimensions(annotatedPath);

    const prompt = `给我${elementDescription}的grounding坐标。

**注意**：图片上可能有黄色圆圈标记，这些是之前点击过的位置（仅用于相对位置参考，它们并不一定是正确的点击位置），标记格式为"#序号"和已经归一化之后的"[y,x]"坐标。这些标记不是界面的一部分，请忽略它们，只定位实际的界面元素。

坐标格式：归一化到0-1000，格式为[ymin, xmin, ymax, xmax]

返回JSON（不要markdown）:
{"box_2d": [ymin, xmin, ymax, xmax], "confidence": <0-100>}`;

    writeMCPLog(`[analyzeScreenshotWithVision] Prompt: ${prompt}`);

    const responseText = await callVisionAPI(
      base64Image,
      prompt,
      20000,
      'analyzeScreenshotWithVision'
    );
    writeMCPLog(
      `[analyzeScreenshotWithVision] Raw Response Length: ${responseText.length}`,
      'Response'
    );
    writeMCPLog(
      `[analyzeScreenshotWithVision] Raw Response (first 500 chars): ${responseText.substring(0, 500)}`,
      'Response Preview'
    );

    // Parse the response
    let jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      writeMCPLog(
        `[analyzeScreenshotWithVision] No JSON found with simple regex, trying code block pattern`,
        'Parse Attempt'
      );
      const codeBlockMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (codeBlockMatch) {
        jsonMatch = [codeBlockMatch[1]];
        writeMCPLog(
          `[analyzeScreenshotWithVision] Found JSON in code block, length: ${jsonMatch[0].length}`,
          'Parse Success'
        );
      }
    } else {
      writeMCPLog(
        `[analyzeScreenshotWithVision] Found JSON with simple regex, length: ${jsonMatch[0].length}`,
        'Parse Success'
      );
    }

    if (!jsonMatch) {
      writeMCPLog(
        `[analyzeScreenshotWithVision] Failed to find JSON in response. Full response: ${responseText}`,
        'Parse Error'
      );
      throw new Error('Failed to parse vision model response: No JSON found in response');
    }

    let result;
    try {
      writeMCPLog(
        `[analyzeScreenshotWithVision] Attempting to parse JSON (first 200 chars): ${jsonMatch[0].substring(0, 200)}`,
        'JSON Parse'
      );
      result = JSON.parse(jsonMatch[0]);
      writeMCPLog(`[analyzeScreenshotWithVision] JSON parsed successfully`, 'JSON Parse Success');
    } catch (parseError: unknown) {
      writeMCPLog(
        `[analyzeScreenshotWithVision] JSON parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        'JSON Parse Error'
      );
      writeMCPLog(
        `[analyzeScreenshotWithVision] JSON string that failed to parse: ${jsonMatch[0]}`,
        'JSON Parse Error'
      );
      throw new Error(
        `Failed to parse JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}. JSON string: ${jsonMatch[0].substring(0, 500)}`
      );
    }

    // Validate that box_2d exists and is an array
    if (!result.box_2d || !Array.isArray(result.box_2d) || result.box_2d.length !== 4) {
      writeMCPLog(
        `[analyzeScreenshotWithVision] Invalid box_2d in response: ${JSON.stringify(result)}`,
        'Parse Error'
      );
      throw new Error(
        'Vision response missing or invalid box_2d field. Expected format: [ymin, xmin, ymax, xmax]'
      );
    }

    // Extract normalized coordinates (0-1000 range)
    // Format: [ymin, xmin, ymax, xmax]
    const [ymin_norm, xmin_norm, ymax_norm, xmax_norm] = result.box_2d;

    writeMCPLog(
      `[analyzeScreenshotWithVision] Normalized box (0-1000): [ymin=${ymin_norm}, xmin=${xmin_norm}, ymax=${ymax_norm}, xmax=${xmax_norm}]`,
      'Normalized Coordinates'
    );

    // Convert normalized coordinates (0-1000) to pixel coordinates
    // Image dimensions: imageDims.width x imageDims.height
    const xmin_pixel = Math.round((xmin_norm / 1000) * imageDims.width);
    const ymin_pixel = Math.round((ymin_norm / 1000) * imageDims.height);
    const xmax_pixel = Math.round((xmax_norm / 1000) * imageDims.width);
    const ymax_pixel = Math.round((ymax_norm / 1000) * imageDims.height);

    writeMCPLog(
      `[analyzeScreenshotWithVision] Pixel coordinates: xmin=${xmin_pixel}, ymin=${ymin_pixel}, xmax=${xmax_pixel}, ymax=${ymax_pixel}`,
      'Pixel Coordinates'
    );
    writeMCPLog(
      `[analyzeScreenshotWithVision] Image dimensions: ${imageDims.width}x${imageDims.height}`,
      'Image Info'
    );

    // Calculate center point from bounding box (in pixel space)
    const pixelCenterX = Math.round((xmin_pixel + xmax_pixel) / 2);
    const pixelCenterY = Math.round((ymin_pixel + ymax_pixel) / 2);

    writeMCPLog(
      `[analyzeScreenshotWithVision] Calculated center from bounding box (pixels): x=${pixelCenterX}, y=${pixelCenterY}`,
      'Center Calculation'
    );

    // Convert from pixel coordinates to logical coordinates
    // On macOS Retina displays (scaleFactor=2), screenshots are 2x the logical resolution,
    // and cliclick uses logical coordinates, so we must divide by scaleFactor.
    // On Windows, the entire pipeline (display config, screenshot, SetCursorPos) works in
    // physical pixels (DPI-aware), so no division is needed (effectiveScaleFactor = 1).
    const rawScaleFactor = targetDisplay.scaleFactor || 1;
    const effectiveScaleFactor = PLATFORM === 'win32' ? 1 : rawScaleFactor;
    writeMCPLog(
      `[analyzeScreenshotWithVision] Display scaleFactor: ${rawScaleFactor}, effective (platform=${PLATFORM}): ${effectiveScaleFactor}`,
      'Coordinate Conversion'
    );

    const logicalX = pixelCenterX / effectiveScaleFactor;
    const logicalY = pixelCenterY / effectiveScaleFactor;

    writeMCPLog(
      `[analyzeScreenshotWithVision] Logical coordinates for cliclick: x=${logicalX}, y=${logicalY}`,
      'Coordinate Conversion'
    );

    return {
      x: Math.round(logicalX),
      y: Math.round(logicalY),
      confidence: result.confidence || 0,
      displayIndex: targetDisplay.index,
      boundingBox: {
        left: xmin_pixel,
        top: ymin_pixel,
        right: xmax_pixel,
        bottom: ymax_pixel,
      },
    };
  } catch (error: unknown) {
    throw new Error(
      `Vision analysis failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Mark a point on an image with a visual indicator
 * Creates a copy of the image with a red circle and crosshair at the specified coordinates
 * Optionally draws a bounding box if provided
 * Uses Python PIL/Pillow for cross-platform compatibility
 */
export async function markPointOnImage(
  imagePath: string,
  x: number,
  y: number,
  outputPath?: string,
  boundingBox?: { left: number; top: number; right: number; bottom: number }
): Promise<string> {
  const markedPath = outputPath || imagePath.replace(/\.png$/, '_marked.png');

  try {
    // Build bounding box parameters for Python script
    const bboxParams = boundingBox
      ? `bbox = {"left": ${boundingBox.left}, "top": ${boundingBox.top}, "right": ${boundingBox.right}, "bottom": ${boundingBox.bottom}}`
      : `bbox = None`;

    const pythonScript = `
try:
    from PIL import Image, ImageDraw

    # Load image
    img = Image.open("${imagePath.replace(/\\/g, '\\\\')}")
    draw = ImageDraw.Draw(img)

    # Bounding box (if provided)
    ${bboxParams}

    # Draw bounding box if provided
    if bbox:
        draw.rectangle([bbox["left"], bbox["top"], bbox["right"], bbox["bottom"]], outline='green', width=2)

    # Draw center point markers
    x, y = ${x}, ${y}
    radius = 20
    draw.ellipse([x - radius, y - radius, x + radius, y + radius], outline='red', width=3)

    # Draw crosshair
    draw.line([x - 30, y, x + 30, y], fill='red', width=2)
    draw.line([x, y - 30, x, y + 30], fill='red', width=2)

    # Draw center point
    draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill='red')

    # Save marked image
    img.save("${markedPath.replace(/\\/g, '\\\\')}")
    print(f"Success: Marked image saved to ${markedPath.replace(/\\/g, '\\\\')}")
except ImportError:
    print("Error: PIL/Pillow not installed. Install with: pip install Pillow")
    exit(1)
except Exception as e:
    print(f"Error: {e}")
    exit(1)
    `.trim();

    const result = await executePython(pythonScript, 5000);

    if (result.stdout.includes('Success')) {
      const markInfo = boundingBox
        ? `point (${x}, ${y}) with bounding box [${boundingBox.left}, ${boundingBox.top}, ${boundingBox.right}, ${boundingBox.bottom}]`
        : `point (${x}, ${y})`;
      writeMCPLog(
        `[markPointOnImage] Marked ${markInfo} on image, saved to: ${markedPath}`,
        'Image Marking'
      );
      return markedPath;
    } else {
      throw new Error(result.stdout || result.stderr || 'Unknown error');
    }
  } catch (error: unknown) {
    writeMCPLog(
      `[markPointOnImage] Could not mark image: ${error instanceof Error ? error.message : String(error)}`,
      'Image Marking Warning'
    );
    writeMCPLog(
      `[markPointOnImage] To enable image marking, install Pillow: pip3 install Pillow`,
      'Image Marking Warning'
    );
    return imagePath; // Return original path if marking fails
  }
}

/**
 * Get image dimensions
 */
export async function getImageDimensions(imagePath: string): Promise<{ width: number; height: number }> {
  try {
    // Use sips on macOS to get image dimensions
    const platform = os.platform();

    if (platform === 'darwin') {
      // Use absolute path because packaged apps may have a limited PATH.
      const { stdout } = await executeCommandSafe('/usr/bin/sips', [
        '-g',
        'pixelWidth',
        '-g',
        'pixelHeight',
        imagePath,
      ]);
      const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
      const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);

      if (widthMatch && heightMatch) {
        return {
          width: parseInt(widthMatch[1]),
          height: parseInt(heightMatch[1]),
        };
      }
    }

    // Fallback: read PNG dimensions from file header
    const buffer = await fs.readFile(imagePath);
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      // PNG file
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }

    throw new Error('Could not determine image dimensions');
  } catch (error: unknown) {
    void error; // intentionally empty - fall through to display dimensions fallback
    const config = await getDisplayConfiguration();
    const mainDisplay = config.displays.find((d) => d.isMain) || config.displays[0];
    return { width: mainDisplay.width, height: mainDisplay.height };
  }
}

/**
 * Plan GUI actions based on natural language task description
 * Returns a step-by-step plan for executing the task
 */
export async function planGUIActions(
  taskDescription: string,
  displayIndex?: number
): Promise<{
  steps: Array<{
    step: number;
    action: string;
    element_description: string;
    value?: string;
    reasoning: string;
  }>;
  summary?: string;
}> {
  // Supported on both macOS and Windows
  if (PLATFORM !== 'darwin' && PLATFORM !== 'win32') {
    throw new Error(`GUI action planning is not supported on platform: ${PLATFORM}`);
  }

  // Take screenshot to understand current GUI state
  const screenshotPath = path.join(SCREENSHOTS_DIR, `gui_plan_${Date.now()}.png`);
  await takeScreenshot(screenshotPath, displayIndex);

  // Get image dimensions
  const imageDims = await getImageDimensions(screenshotPath);

  // Read screenshot as base64
  const imageBuffer = await fs.readFile(screenshotPath);
  const base64Image = imageBuffer.toString('base64');

  const prompt = `Analyze this GUI screenshot and create a step-by-step plan to accomplish the following task: "${taskDescription}"

**COORDINATE SYSTEM:**
- Image dimensions: ${imageDims.width}x${imageDims.height} pixels
- Origin (0,0) is at TOP-LEFT corner

**TASK:**
Break down the task "${taskDescription}" into a sequence of GUI operations.

**INSTRUCTIONS:**
1. Analyze the current GUI state shown in the screenshot
2. Identify what elements need to be interacted with
3. Create a step-by-step plan with specific actions
4. For each step, describe the element to interact with and what action to perform
5. Include any text values that need to be entered

**AVAILABLE ACTIONS:**
- click: Single click on an element
- double_click: Double click on an element
- right_click: Right click on an element
- type: Type text into an input field (requires value parameter)
- hover: Move mouse over an element
- key_press: Press a key (requires value parameter with key name)

**RESPONSE FORMAT (JSON only, no markdown):**
{
  "steps": [
    {
      "step": 1,
      "action": "click|double_click|right_click|type|hover|key_press",
      "element_description": "<detailed description of the element to interact with>",
      "value": "<optional: text to type or key to press>",
      "reasoning": "<explanation of why this step is needed>"
    }
  ],
  "summary": "<brief summary of the plan>"
}

Be specific and detailed in element descriptions. For example:
- Instead of "button", use "the red Start button in the top-right corner"
- Instead of "input", use "the text input field labeled 'File Name'"
- Instead of "menu", use "the File menu in the menu bar"`;

  const responseText = await callVisionAPI(base64Image, prompt, 20000, 'planGUIActions');
  writeMCPLog(`[planGUIActions] Raw Response Length: ${responseText.length}`, 'Response');
  writeMCPLog(
    `[planGUIActions] Raw Response (first 500 chars): ${responseText.substring(0, 500)}`,
    'Response Preview'
  );

  // Parse the response
  let jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    writeMCPLog(
      `[planGUIActions] No JSON found with simple regex, trying code block pattern`,
      'Parse Attempt'
    );
    const codeBlockMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (codeBlockMatch) {
      jsonMatch = [codeBlockMatch[1]];
      writeMCPLog(
        `[planGUIActions] Found JSON in code block, length: ${jsonMatch[0].length}`,
        'Parse Success'
      );
    }
  } else {
    writeMCPLog(
      `[planGUIActions] Found JSON with simple regex, length: ${jsonMatch[0].length}`,
      'Parse Success'
    );
  }

  if (!jsonMatch) {
    writeMCPLog(
      `[planGUIActions] Failed to find JSON in response. Full response: ${responseText}`,
      'Parse Error'
    );
    throw new Error('Failed to parse action plan response: No JSON found in response');
  }

  let plan;
  try {
    writeMCPLog(
      `[planGUIActions] Attempting to parse JSON (first 200 chars): ${jsonMatch[0].substring(0, 200)}`,
      'JSON Parse'
    );
    plan = JSON.parse(jsonMatch[0]);
    writeMCPLog(
      `[planGUIActions] JSON parsed successfully. Steps count: ${plan.steps?.length || 0}`,
      'JSON Parse Success'
    );
  } catch (parseError: unknown) {
    writeMCPLog(
      `[planGUIActions] JSON parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      'JSON Parse Error'
    );
    writeMCPLog(
      `[planGUIActions] JSON string that failed to parse: ${jsonMatch[0]}`,
      'JSON Parse Error'
    );
    throw new Error(
      `Failed to parse action plan JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}. JSON string: ${jsonMatch[0].substring(0, 500)}`
    );
  }

  if (!plan.steps || !Array.isArray(plan.steps)) {
    writeMCPLog(
      `[planGUIActions] Invalid plan format. Plan keys: ${Object.keys(plan).join(', ')}, steps type: ${typeof plan.steps}`,
      'Validation Error'
    );
    throw new Error(
      `Invalid action plan format: missing steps array. Plan structure: ${JSON.stringify(plan, null, 2).substring(0, 500)}`
    );
  }

  return plan;
}

/**
 * Locate a GUI element using vision
 */
export async function locateGUIElement(
  elementDescription: string,
  displayIndex?: number
): Promise<{
  x: number;
  y: number;
  confidence: number;
  displayIndex: number;
  reasoning?: string;
  boundingBox?: { left: number; top: number; right: number; bottom: number };
}> {
  // Supported on both macOS and Windows
  if (PLATFORM !== 'darwin' && PLATFORM !== 'win32') {
    throw new Error(`Element location is not supported on platform: ${PLATFORM}`);
  }

  // On macOS, prefer deterministic Dock lookup for Dock-related requests.
  // This avoids visual mis-grounding when multiple similar icons are present.
  if (PLATFORM === 'darwin') {
    try {
      const dockCoords = await tryLocateElementInDockByAccessibility(
        elementDescription,
        displayIndex
      );
      if (dockCoords) {
        return dockCoords;
      }
    } catch (dockError: unknown) {
      writeMCPLog(
        `[locateGUIElement] Dock accessibility lookup failed: ${dockError instanceof Error ? dockError.message : String(dockError)}`,
        'Dock Locate Warning'
      );
    }
  }

  // Take screenshot
  const screenshotPath = path.join(SCREENSHOTS_DIR, `gui_locate_${Date.now()}.png`);
  await takeScreenshot(screenshotPath, displayIndex);

  // Analyze screenshot to find element
  const coords = await analyzeScreenshotWithVision(
    screenshotPath,
    elementDescription,
    displayIndex
  );

  // Mark the located point on the screenshot
  // Note: coords are in logical coordinates, but the screenshot is in pixel coordinates
  // So we need to convert back to pixel coordinates for marking
  try {
    const config = await getDisplayConfiguration();
    const targetDisplay =
      displayIndex !== undefined
        ? config.displays.find((d) => d.index === displayIndex)
        : config.displays.find((d) => d.isMain);

    if (targetDisplay) {
      // On macOS, coords are logical (divided by scaleFactor), so multiply back to get pixels.
      // On Windows, coords are already in physical pixels (no scaleFactor division was applied).
      const rawScaleFactor = targetDisplay.scaleFactor || 1;
      const effectiveScaleFactor = PLATFORM === 'win32' ? 1 : rawScaleFactor;
      const pixelX = coords.x * effectiveScaleFactor;
      const pixelY = coords.y * effectiveScaleFactor;

      writeMCPLog(
        `[locateGUIElement] Marking point on screenshot: logical=(${coords.x}, ${coords.y}), pixel=(${pixelX}, ${pixelY}), effectiveScale=${effectiveScaleFactor}`,
        'Image Marking'
      );

      // coords.boundingBox is already in pixel coordinates
      const markedPath = await markPointOnImage(
        screenshotPath,
        pixelX,
        pixelY,
        undefined,
        coords.boundingBox
      );
      writeMCPLog(`[locateGUIElement] Marked screenshot saved to: ${markedPath}`, 'Image Marking');
    }
  } catch (markError: unknown) {
    // Don't fail if marking fails, just log the error
    writeMCPLog(
      `[locateGUIElement] Failed to mark screenshot: ${markError instanceof Error ? markError.message : String(markError)}`,
      'Image Marking Warning'
    );
  }

  return coords;
}

/**
 * Execute a single GUI action step
 */
export async function executeActionStep(
  step: { step: number; action: string; element_description: string; value?: string },
  displayIndex?: number
): Promise<{
  success: boolean;
  step: number;
  action: string;
  coordinates?: { x: number; y: number };
  error?: string;
}> {
  try {
    writeMCPLog(
      `[executeActionStep] Starting step ${step.step}: ${step.action} on "${step.element_description}"`,
      'Step Execution'
    );

    // Locate the element
    const coords = await locateGUIElement(step.element_description, displayIndex);
    writeMCPLog(
      `[executeActionStep] Step ${step.step}: Located element at (${coords.x}, ${coords.y}) with confidence ${coords.confidence}%`,
      'Step Execution'
    );

    if (coords.confidence < 50) {
      writeMCPLog(
        `[executeActionStep] Step ${step.step}: Low confidence (${coords.confidence}%), aborting`,
        'Step Execution'
      );
      return {
        success: false,
        step: step.step,
        action: step.action,
        error: `Element "${step.element_description}" not found with sufficient confidence (${coords.confidence}%)`,
      };
    }

    // Perform the action
    writeMCPLog(
      `[executeActionStep] Step ${step.step}: Executing action "${step.action}"`,
      'Step Execution'
    );
    switch (step.action) {
      case 'click':
        await performClick(coords.x, coords.y, coords.displayIndex, 'single');
        writeMCPLog(
          `[executeActionStep] Step ${step.step}: Click completed successfully`,
          'Step Execution'
        );
        return {
          success: true,
          step: step.step,
          action: 'click',
          coordinates: { x: coords.x, y: coords.y },
        };

      case 'double_click':
        await performClick(coords.x, coords.y, coords.displayIndex, 'double');
        writeMCPLog(
          `[executeActionStep] Step ${step.step}: Double click completed successfully`,
          'Step Execution'
        );
        return {
          success: true,
          step: step.step,
          action: 'double_click',
          coordinates: { x: coords.x, y: coords.y },
        };

      case 'right_click':
        await performClick(coords.x, coords.y, coords.displayIndex, 'right');
        writeMCPLog(
          `[executeActionStep] Step ${step.step}: Right click completed successfully`,
          'Step Execution'
        );
        return {
          success: true,
          step: step.step,
          action: 'right_click',
          coordinates: { x: coords.x, y: coords.y },
        };

      case 'type':
        if (!step.value) {
          writeMCPLog(
            `[executeActionStep] Step ${step.step}: Type action missing value`,
            'Step Execution Error'
          );
          return {
            success: false,
            step: step.step,
            action: 'type',
            error: 'Value is required for type action',
          };
        }
        // Click first to focus, then type
        writeMCPLog(
          `[executeActionStep] Step ${step.step}: Clicking to focus, then typing "${step.value}"`,
          'Step Execution'
        );
        await performClick(coords.x, coords.y, coords.displayIndex, 'single');
        await new Promise((resolve) => setTimeout(resolve, 200));
        await performType(step.value, false);
        writeMCPLog(
          `[executeActionStep] Step ${step.step}: Type completed successfully`,
          'Step Execution'
        );
        return {
          success: true,
          step: step.step,
          action: 'type',
          coordinates: { x: coords.x, y: coords.y },
        };

      case 'hover':
        await moveMouse(coords.x, coords.y, coords.displayIndex);
        writeMCPLog(
          `[executeActionStep] Step ${step.step}: Hover completed successfully`,
          'Step Execution'
        );
        return {
          success: true,
          step: step.step,
          action: 'hover',
          coordinates: { x: coords.x, y: coords.y },
        };

      case 'key_press':
        if (!step.value) {
          writeMCPLog(
            `[executeActionStep] Step ${step.step}: Key press action missing key name`,
            'Step Execution Error'
          );
          return {
            success: false,
            step: step.step,
            action: 'key_press',
            error: 'Key name is required for key_press action',
          };
        }
        writeMCPLog(
          `[executeActionStep] Step ${step.step}: Pressing key "${step.value}"`,
          'Step Execution'
        );
        await performKeyPress(step.value, []);
        writeMCPLog(
          `[executeActionStep] Step ${step.step}: Key press completed successfully`,
          'Step Execution'
        );
        return {
          success: true,
          step: step.step,
          action: 'key_press',
        };

      default:
        writeMCPLog(
          `[executeActionStep] Step ${step.step}: Unsupported action "${step.action}"`,
          'Step Execution Error'
        );
        return {
          success: false,
          step: step.step,
          action: step.action,
          error: `Unsupported action: ${step.action}`,
        };
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    writeMCPLog(
      `[executeActionStep] Step ${step.step}: Error occurred: ${errMsg}`,
      'Step Execution Error'
    );
    writeMCPLog(
      `[executeActionStep] Step ${step.step}: Error stack: ${errStack}`,
      'Step Execution Error'
    );
    return {
      success: false,
      step: step.step,
      action: step.action,
      error: errMsg,
    };
  }
}

/**
 * Perform GUI interaction using vision - automatically plans and executes steps
 */
export async function performVisionBasedInteraction(
  taskDescription: string,
  displayIndex?: number
): Promise<string> {
  // Supported on both macOS and Windows
  if (PLATFORM !== 'darwin' && PLATFORM !== 'win32') {
    throw new Error(`Vision-based GUI interaction is not supported on platform: ${PLATFORM}`);
  }

  writeMCPLog(`[performVisionBasedInteraction] Starting task: "${taskDescription}"`, 'Task Start');
  writeMCPLog(
    `[performVisionBasedInteraction] Display index: ${displayIndex ?? 'main'}`,
    'Task Start'
  );

  // Step 1: Plan the actions
  writeMCPLog(`[performVisionBasedInteraction] Step 1: Planning actions...`, 'Task Planning');
  let plan;
  try {
    plan = await planGUIActions(taskDescription, displayIndex);
    writeMCPLog(
      `[performVisionBasedInteraction] Planning completed. Total steps: ${plan.steps.length}`,
      'Task Planning'
    );
    writeMCPLog(
      `[performVisionBasedInteraction] Plan summary: ${plan.summary || 'No summary'}`,
      'Task Planning'
    );
  } catch (error: unknown) {
    writeMCPLog(
      `[performVisionBasedInteraction] Planning failed: ${error instanceof Error ? error.message : String(error)}`,
      'Task Planning Error'
    );
    throw error;
  }

  // Step 2: Execute each step
  writeMCPLog(
    `[performVisionBasedInteraction] Step 2: Executing ${plan.steps.length} steps...`,
    'Task Execution'
  );
  const results: Array<{
    step: number;
    success: boolean;
    action: string;
    element_description: string;
    error?: string;
    coordinates?: { x: number; y: number };
  }> = [];

  for (const step of plan.steps) {
    writeMCPLog(
      `[performVisionBasedInteraction] Executing step ${step.step}/${plan.steps.length}: ${step.action}`,
      'Task Execution'
    );
    // Wait a bit between steps to allow GUI to update
    // Longer wait after type actions to allow UI to process
    if (results.length > 0) {
      const lastAction = results[results.length - 1]?.action;
      const waitTime = lastAction === 'type' ? 800 : 500;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    const result = await executeActionStep(step, displayIndex);
    results.push({
      step: step.step,
      success: result.success,
      action: step.action,
      element_description: step.element_description,
      error: result.error,
      coordinates: result.coordinates,
    });

    // If a step fails, stop execution
    if (!result.success) {
      writeMCPLog(
        `[performVisionBasedInteraction] Step ${step.step} failed, stopping execution`,
        'Task Execution Error'
      );
      break;
    } else {
      writeMCPLog(
        `[performVisionBasedInteraction] Step ${step.step} completed successfully`,
        'Task Execution'
      );
    }

    // Additional wait after click actions that might open dialogs/menus
    if (step.action === 'click' || step.action === 'double_click') {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const allSuccessful = results.every((r) => r.success);
  writeMCPLog(
    `[performVisionBasedInteraction] Task completed. Success: ${allSuccessful}, Steps executed: ${results.length}/${plan.steps.length}`,
    'Task Completion'
  );

  return JSON.stringify({
    success: allSuccessful,
    task: taskDescription,
    plan_summary: plan.summary || 'No summary provided',
    steps_executed: results.length,
    total_steps: plan.steps.length,
    results,
    failed_at_step: allSuccessful ? undefined : results.findIndex((r) => !r.success) + 1,
  });
}

/**
 * Verify GUI state using vision
 */
export async function verifyGUIState(question: string, displayIndex?: number): Promise<string> {
  // Supported on both macOS and Windows
  if (PLATFORM !== 'darwin' && PLATFORM !== 'win32') {
    throw new Error(`GUI verification is not supported on platform: ${PLATFORM}`);
  }

  const normalizedDisplayIndex = displayIndex ?? 0;
  const regionKey = toRegionKey(undefined);
  const reusable = getReusableScreenshot(normalizedDisplayIndex, regionKey);

  let screenshotPath: string;
  let base64Image: string;

  if (reusable) {
    screenshotPath = reusable.path;
    base64Image = reusable.base64Image;
    writeMCPLog(
      `[verifyGUIState] Reusing recent screenshot captured ${Date.now() - reusable.capturedAt}ms ago: ${reusable.path}`,
      'Screenshot Reuse'
    );
  } else {
    screenshotPath = path.join(SCREENSHOTS_DIR, `gui_verify_${Date.now()}.png`);
    await takeScreenshot(screenshotPath, displayIndex);
    const imageBuffer = await fs.readFile(screenshotPath);
    base64Image = imageBuffer.toString('base64');

    const config = await getDisplayConfiguration();
    const display =
      config.displays.find((d) => d.index === normalizedDisplayIndex) || config.displays[0];
    updateScreenshotCache({
      displayIndex: normalizedDisplayIndex,
      regionKey,
      path: screenshotPath,
      base64Image,
      capturedAt: Date.now(),
      displayInfo: {
        width: display.width,
        height: display.height,
        scaleFactor: display.scaleFactor,
      },
    });
  }

  const prompt = `Analyze this GUI screenshot and answer the following question:

${question}

Provide a detailed answer based on what you can see in the image.

IMPORTANT: At the end of your response, you MUST provide a formatted judgment on whether the most recent GUI operation was accurate/successful. Use this exact format:

**Operation Success Judgment:**
- Status: [SUCCESS/FAILURE]
- Reason: [Brief explanation of why the operation succeeded or failed]

Example:
**Operation Success Judgment:**
- Status: SUCCESS
- Reason: The button was clicked correctly in the expected dialog window.`;

  let answer = await callVisionAPI(base64Image, prompt, 20000, 'verifyGUIState');
  writeMCPLog(`[verifyGUIState] Response Length: ${answer.length}`, 'Response');
  writeMCPLog(
    `[verifyGUIState] Response (first 500 chars): ${answer.substring(0, 500)}`,
    'Response Preview'
  );

  // Parse the operation success judgment
  let operationSuccess = false;
  const successMatch = answer.match(
    /\*\*Operation Success Judgment:\*\*[\s\S]*?Status:\s*(SUCCESS|FAILURE)/i
  );
  if (successMatch) {
    operationSuccess = successMatch[1].toUpperCase() === 'SUCCESS';
    writeMCPLog(
      `[verifyGUIState] Parsed operation success: ${operationSuccess}`,
      'Success Parsing'
    );

    // If operation was successful and we have a recent click, increment its successCount
    if (operationSuccess && lastClickEntry) {
      lastClickEntry.successCount = (lastClickEntry.successCount || 0) + 1;
      writeMCPLog(
        `[verifyGUIState] Incremented successCount for click at (${lastClickEntry.x}, ${lastClickEntry.y}) to ${lastClickEntry.successCount}`,
        'Success Tracking'
      );

      // Save the updated click history to disk
      await saveLatestClickToHistory(lastClickEntry, { incrementCount: false });
    }
  } else {
    writeMCPLog(
      `[verifyGUIState] Could not parse operation success judgment from response`,
      'Success Parsing Warning'
    );
  }

  // Cross-check with macOS frontmost app for app-open verification style questions.
  // This prevents false-positive "SUCCESS" when the wrong app is actually focused.
  if (PLATFORM === 'darwin') {
    const expectedAliases = inferExpectedAppAliasesFromText(question);
    const requiresForegroundMatch = isLikelyAppLaunchVerification(question);

    if (expectedAliases.length > 0 && requiresForegroundMatch) {
      const frontmostApp = await getFrontmostMacApplicationName();
      if (frontmostApp) {
        const frontmostMatched = appNameMatchesAliases(frontmostApp, expectedAliases);
        writeMCPLog(
          `[verifyGUIState] Frontmost app cross-check. frontmost="${frontmostApp}", expectedAliases=${JSON.stringify(expectedAliases)}, matched=${frontmostMatched}`,
          'Success Parsing'
        );

        if (operationSuccess && !frontmostMatched) {
          operationSuccess = false;
          answer += `\n\n[System Cross-check] Frontmost app is "${frontmostApp}", which does not match the expected target app from the question.`;
          writeMCPLog(
            `[verifyGUIState] Overrode operationSuccess to false due to frontmost app mismatch.`,
            'Success Parsing Warning'
          );
        }
      }
    }
  }

  // Keep success parsing internal; strip the judgment block from user-visible answer text.
  answer = stripOperationSuccessJudgmentBlock(answer);

  return JSON.stringify({
    success: true,
    question,
    answer,
    operationSuccess,
    screenshot_path: screenshotPath,
    displayIndex: normalizedDisplayIndex,
  });
}

export function stripOperationSuccessJudgmentBlock(answer: string): string {
  if (!answer) {
    return answer;
  }

  const normalized = answer.replace(/\r\n/g, '\n');
  const patterns = [
    /\n?\*\*Operation Success Judgment:\*\*[\s\S]*?(?:- Status:\s*(?:SUCCESS|FAILURE)[\s\S]*?(?:\n{2,}|$))/gi,
    /\n?Operation Success Judgment:\s*[\s\S]*?(?:Status:\s*(?:SUCCESS|FAILURE)[\s\S]*?(?:\n{2,}|$))/gi,
  ];

  let stripped = normalized;
  for (const pattern of patterns) {
    stripped = stripped.replace(pattern, '\n\n');
  }
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

export async function extractGUIInfo(extractionPrompt: string, displayIndex?: number): Promise<string> {
  // Supported on both macOS and Windows
  if (PLATFORM !== 'darwin' && PLATFORM !== 'win32') {
    throw new Error(`GUI extraction is not supported on platform: ${PLATFORM}`);
  }

  // Take screenshot
  const screenshotPath = path.join(SCREENSHOTS_DIR, `gui_extract_${Date.now()}.png`);
  await takeScreenshot(screenshotPath, displayIndex);

  // Analyze with vision model
  const imageBuffer = await fs.readFile(screenshotPath);
  const base64Image = imageBuffer.toString('base64');

  const prompt = `You are an expert at extracting information from GUI screenshots. Analyze this screenshot and extract the requested information.

**Extraction Request:**
${extractionPrompt}

**Instructions:**
1. Carefully examine the screenshot to find the requested information.
2. Extract the information as accurately and completely as possible.
3. If the information is structured (like a list of messages, table data, menu items), format it clearly.
4. If certain information cannot be found or is partially visible, mention what is visible and what is missing.
5. Use appropriate formatting (bullet points, numbered lists, etc.) to present the extracted information clearly.

**Response Format:**
Provide the extracted information in a clear, structured format. If extracting multiple items, organize them logically.`;

  const extractedInfo = await callVisionAPI(base64Image, prompt, 30000, 'extractGUIInfo');
  writeMCPLog(`[extractGUIInfo] Response Length: ${extractedInfo.length}`, 'Response');
  writeMCPLog(
    `[extractGUIInfo] Response (first 500 chars): ${extractedInfo.substring(0, 500)}`,
    'Response Preview'
  );

  return JSON.stringify({
    success: true,
    extraction_prompt: extractionPrompt,
    extracted_info: extractedInfo,
    screenshot_path: screenshotPath,
    displayIndex: displayIndex ?? 'all',
  });
}

// ============================================================================
// MCP Server Setup
// ============================================================================
