/**
 * GUI Operate MCP Server
 *
 * This MCP server provides GUI automation capabilities for macOS and Windows:
 * - Click (single click, double click, right click)
 * - Type text (keyboard input)
 * - Scroll (mouse wheel scroll)
 * - Screenshot (capture screen or specific display)
 * - Get display information (multi-monitor support)
 *
 * Multi-display support:
 * - All operations support display_index parameter
 * - Coordinates are automatically adjusted based on display configuration
 * - Display index 0 is the main display, others are secondary displays
 *
 * Platform-specific tools:
 * - macOS: Uses cliclick (brew install cliclick) and AppleScript
 * - Windows: Uses PowerShell with .NET System.Windows.Forms
 */

// Bootstrap logging - log as early as possible
import { writeMCPLog } from './mcp-logger.js';
import { type CallToolResult, type ListToolsResult, Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

writeMCPLog('=== Module Loading Started ===', 'Bootstrap');
writeMCPLog('Imported MCP SDK modules', 'Bootstrap');

import * as path from 'path';

// Import GUI submodules
import { SCREENSHOTS_DIR } from './gui/state.js';
import { initApp, getAllVisitedApps, clearClickHistory, currentAppName } from './gui/click-history.js';
import { getDisplayConfiguration, resolveClickCoordinates } from './gui/display-coords.js';
import {
  performClick,
  performType,
  performKeyPress,
  performScroll,
  performDrag,
  getMousePosition,
  moveMouse,
  performWait,
  takeScreenshot,
  takeScreenshotForDisplay,
} from './gui/actions.js';
import {
  planGUIActions,
  locateGUIElement,
  performVisionBasedInteraction,
  verifyGUIState,
  extractGUIInfo,
  getBaseUrlHost,
} from './gui/vision.js';

writeMCPLog('Imported GUI modules', 'Bootstrap');

function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'gui-operate',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Define available tools
  server.setRequestHandler('tools/list', async (): Promise<ListToolsResult> => {
    return {
      tools: [
        {
          name: 'get_displays',
          description:
            'Get information about all connected displays. Returns display index, name, resolution, position, and scale factor. Use this to understand the multi-monitor setup before performing GUI operations.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'click',
          description:
            'Perform a mouse click at specified coordinates. Supports single click, double click, right click, and triple click. Coordinates are display-local logical coordinates by default. You can also pass normalized coordinates (0-1000) via coordinate_type.',
          inputSchema: {
            type: 'object',
            properties: {
              coordinate_type: {
                type: 'string',
                enum: ['auto', 'absolute', 'normalized'],
                description:
                  'Coordinate interpretation. "absolute" = display-local logical coordinates. "normalized" = 0-1000 relative coordinates. "auto" (default) uses absolute, but converts from normalized if values are out of bounds.',
              },
              x: {
                type: 'number',
                description: 'X coordinate (interpretation depends on coordinate_type)',
              },
              y: {
                type: 'number',
                description: 'Y coordinate (interpretation depends on coordinate_type)',
              },
              display_index: {
                type: 'number',
                description:
                  'Display index (0 = main display). Use get_displays to see available displays. Default: 0',
              },
              click_type: {
                type: 'string',
                enum: ['single', 'double', 'right', 'triple'],
                description: 'Type of click to perform. Default: single',
              },
              modifiers: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Modifier keys to hold during click: command, shift, option/alt, control/ctrl',
              },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'type_text',
          description:
            'Type text at the current cursor/focus position. Supports Unicode (Chinese/Japanese/emoji) by automatically using clipboard paste (Cmd+V) when needed.',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The text to type',
              },
              press_enter: {
                type: 'boolean',
                description: 'Whether to press Enter after typing. Default: false',
              },
              input_method: {
                type: 'string',
                enum: ['auto', 'keystroke', 'paste'],
                description:
                  'Typing method. "auto" (default) uses clipboard paste for Unicode/CJK and keystroke for ASCII. Use "paste" to force clipboard paste. Use "keystroke" to force AppleScript keystroke.',
              },
              preserve_clipboard: {
                type: 'boolean',
                description:
                  'Whether to restore the previous clipboard after pasting (best-effort). Default: true',
              },
            },
            required: ['text'],
          },
        },
        {
          name: 'key_press',
          description:
            'Press a key or key combination. Useful for special keys like Enter, Tab, Escape, arrow keys, or shortcuts like Cmd+C, Ctrl+C. For system shortcuts like Ctrl+C to interrupt programs, use key="c" with modifiers=["ctrl"].',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description:
                  'Key to press: enter, tab, escape, space, delete, up, down, left, right, home, end, pageup, pagedown, f1-f12, or a single character (a-z, 0-9, etc.)',
              },
              modifiers: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Modifier keys (array of strings). Use: "ctrl" for Control, "cmd" for Command, "shift" for Shift, "alt" for Option. Example: ["ctrl"] for Ctrl+C, ["cmd", "shift"] for Cmd+Shift+Key.',
              },
            },
            required: ['key'],
          },
        },
        {
          name: 'scroll',
          description:
            'Perform a scroll operation at the specified position. Coordinates are display-local logical coordinates by default. You can also pass normalized coordinates (0-1000) via coordinate_type.',
          inputSchema: {
            type: 'object',
            properties: {
              coordinate_type: {
                type: 'string',
                enum: ['auto', 'absolute', 'normalized'],
                description:
                  'Coordinate interpretation. "absolute" = display-local logical coordinates. "normalized" = 0-1000 relative coordinates. "auto" (default) uses absolute, but converts from normalized if values are out of bounds.',
              },
              x: {
                type: 'number',
                description:
                  'X coordinate to scroll at (interpretation depends on coordinate_type)',
              },
              y: {
                type: 'number',
                description:
                  'Y coordinate to scroll at (interpretation depends on coordinate_type)',
              },
              display_index: {
                type: 'number',
                description: 'Display index. Default: 0',
              },
              direction: {
                type: 'string',
                enum: ['up', 'down', 'left', 'right'],
                description: 'Scroll direction',
              },
              amount: {
                type: 'number',
                description: 'Scroll amount (number of lines). Default: 3',
              },
            },
            required: ['x', 'y', 'direction'],
          },
        },
        {
          name: 'drag',
          description:
            'Perform a drag operation from one point to another. By default coordinates are normalized (0-1000) relative to the target display (top-left origin).',
          inputSchema: {
            type: 'object',
            properties: {
              coordinate_type: {
                type: 'string',
                enum: ['auto', 'absolute', 'normalized'],
                description:
                  'Coordinate interpretation. "normalized" (default) means 0-1000 relative coords on the display. "absolute" means display-local logical pixel coords. "auto" uses absolute, but converts from normalized if values are out of bounds.',
              },
              from_x: {
                type: 'number',
                description: 'Starting X coordinate (normalized 0-1000 by default)',
              },
              from_y: {
                type: 'number',
                description: 'Starting Y coordinate (normalized 0-1000 by default)',
              },
              to_x: {
                type: 'number',
                description: 'Ending X coordinate (normalized 0-1000 by default)',
              },
              to_y: {
                type: 'number',
                description: 'Ending Y coordinate (normalized 0-1000 by default)',
              },
              display_index: {
                type: 'number',
                description: 'Display index. Default: 0',
              },
            },
            required: ['from_x', 'from_y', 'to_x', 'to_y'],
          },
        },
        {
          name: 'screenshot',
          description: 'Take a screenshot of the screen, a specific display, or a region.',
          inputSchema: {
            type: 'object',
            properties: {
              output_path: {
                type: 'string',
                description:
                  'Path to save the screenshot. If not provided, saves to workspace directory.',
              },
              display_index: {
                type: 'number',
                description: 'Display index to capture. If not provided, captures all displays.',
              },
              region: {
                type: 'object',
                description: 'Capture a specific region',
                properties: {
                  x: { type: 'number', description: 'X coordinate of region' },
                  y: { type: 'number', description: 'Y coordinate of region' },
                  width: { type: 'number', description: 'Width of region' },
                  height: { type: 'number', description: 'Height of region' },
                },
                required: ['x', 'y', 'width', 'height'],
              },
            },
            required: [],
          },
        },
        {
          name: 'screenshot_for_display',
          description:
            'Take a screenshot and return it as base64 image data for display in the response. Use this when you want to show key screenshots to the user in your reply. The screenshot will be embedded directly in the conversation.',
          inputSchema: {
            type: 'object',
            properties: {
              display_index: {
                type: 'number',
                description:
                  'Display index to capture. If not provided, captures main display (0).',
              },
              region: {
                type: 'object',
                description: 'Capture a specific region',
                properties: {
                  x: { type: 'number', description: 'X coordinate of region' },
                  y: { type: 'number', description: 'Y coordinate of region' },
                  width: { type: 'number', description: 'Width of region' },
                  height: { type: 'number', description: 'Height of region' },
                },
                required: ['x', 'y', 'width', 'height'],
              },
              reason: {
                type: 'string',
                description:
                  'Optional description of why taking this screenshot (e.g., "showing current dialog state", "capturing error message"). This helps document the purpose of the screenshot.',
              },
              force_refresh: {
                type: 'boolean',
                description:
                  'If true, always capture a fresh screenshot and bypass short-term screenshot cache.',
              },
              annotate_clicks: {
                type: 'boolean',
                description:
                  'If true, annotate the screenshot with click history markers. Default: false',
              },
            },
            required: [],
          },
        },
        {
          name: 'get_mouse_position',
          description: 'Get the current mouse cursor position, including which display it is on.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'move_mouse',
          description:
            'Move the mouse cursor to a specified position without clicking. Coordinates are display-local logical coordinates by default. You can also pass normalized coordinates (0-1000) via coordinate_type.',
          inputSchema: {
            type: 'object',
            properties: {
              coordinate_type: {
                type: 'string',
                enum: ['auto', 'absolute', 'normalized'],
                description:
                  'Coordinate interpretation. "absolute" = display-local logical coordinates. "normalized" = 0-1000 relative coordinates. "auto" (default) uses absolute, but converts from normalized if values are out of bounds.',
              },
              x: {
                type: 'number',
                description: 'X coordinate (interpretation depends on coordinate_type)',
              },
              y: {
                type: 'number',
                description: 'Y coordinate (interpretation depends on coordinate_type)',
              },
              display_index: {
                type: 'number',
                description: 'Display index. Default: 0',
              },
            },
            required: ['x', 'y'],
          },
        },
        {
          name: 'wait',
          description:
            'Wait for a specified duration in milliseconds. Use this to allow GUI applications to complete internal operations, animations, loading states, or asynchronous updates. Common use cases: waiting for dialogs to appear, menus to render, files to load, or network requests to complete.',
          inputSchema: {
            type: 'object',
            properties: {
              duration: {
                type: 'number',
                description:
                  'Duration to wait in milliseconds (e.g., 1000 = 1 second, 500 = 0.5 seconds)',
              },
              reason: {
                type: 'string',
                description:
                  'Optional description of why waiting (e.g., "waiting for dialog to appear", "waiting for file to load"). Helps with debugging and logging.',
              },
            },
            required: ['duration'],
          },
        },
        {
          name: 'gui_locate_element',
          description:
            'Locate a GUI element on screen using AI vision. Returns the coordinates and confidence level for the element. You may need to re-call this function if you find previously found positions are not accurate (indicated by unsuccessful following operations).',
          inputSchema: {
            type: 'object',
            properties: {
              element_description: {
                type: 'string',
                description:
                  'Natural language description of the element to locate (e.g., "the red Start button", "the text input field labeled File Name")',
              },
              display_index: {
                type: 'number',
                description: 'Display index to search on. If not provided, uses main display.',
              },
            },
            required: ['element_description'],
          },
        },
        {
          name: 'gui_verify_vision',
          description:
            'Verify GUI state using AI vision. Ask questions about what is visible on screen and get intelligent answers (e.g., "Is the game board visible?", "What is the current player shown?", "Are there any error messages?"). This tool is used to verify the state of the GUI after some operation to ensure the operation was successful (e.g., whether the click was successful, whether the text was typed, etc.).',
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'Question about the GUI state',
              },
              display_index: {
                type: 'number',
                description: 'Display index to verify. If not provided, uses main display.',
              },
            },
            required: ['question'],
          },
        },
        {
          name: 'gui_extract_info',
          description:
            'Extract information from GUI screenshot using AI vision. Use natural language to describe what information you want to extract (e.g., "Extract all chat messages currently visible in this group chat", "List all menu items shown", "Extract the table data displayed", "Get the notification text", "List all filenames in this folder view").',
          inputSchema: {
            type: 'object',
            properties: {
              extraction_prompt: {
                type: 'string',
                description:
                  'Natural language description of what information to extract from the screen',
              },
              display_index: {
                type: 'number',
                description: 'Display index to capture. If not provided, uses main display.',
              },
            },
            required: ['extraction_prompt'],
          },
        },
        {
          name: 'get_all_visited_apps',
          description:
            'Get a list of all applications that have been used before (have stored click history). IMPORTANT: You should call this BEFORE init_app to check if the app already exists and get the exact app name. This prevents creating duplicate directories due to name variations (e.g., "Cursor" vs "cursor" vs "Cursor IDE"). If the app you want is not in the list, you can use init_app with a new app name.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'init_app',
          description:
            'Initialize app context for GUI operations. This MUST be called once before starting GUI operations on any application. IMPORTANT: Call get_all_visited_apps FIRST to check if the app already exists and get the exact app name to avoid creating duplicate directories. This tool loads the persistent click history and other app-specific data from disk. It also loads an optional per-app guide file at `<appDirectory>/guide.md` (if present) and returns its contents as `guide` so you can follow app-specific guidance. Each application has its own independent storage directory.',
          inputSchema: {
            type: 'object',
            properties: {
              app_name: {
                type: 'string',
                description:
                  'Name of the application (e.g., "Cursor", "Safari", "Terminal"). REQUIRED. Call get_all_visited_apps first to see previously used apps and get the exact name.',
              },
            },
            required: ['app_name'],
          },
        },
        {
          name: 'clear_click_history',
          description:
            'Clear the click history for the current application. This removes all click markers from screenshots and deletes the persistent storage for this app. Use this when starting a completely new task or when you want to reset all visual markers.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    try {
      writeMCPLog(`[CallTool] name=${name}, args=${JSON.stringify(args ?? {})}`, 'Tool Call');

      let result: string;

      switch (name) {
        case 'get_displays': {
          const config = await getDisplayConfiguration();
          result = JSON.stringify(config, null, 2);
          break;
        }

        case 'click': {
          const {
            x,
            y,
            display_index = 0,
            click_type = 'single',
            modifiers = [],
            coordinate_type = 'auto',
          } = args as {
            x: number;
            y: number;
            display_index?: number;
            click_type?: 'single' | 'double' | 'right' | 'triple';
            modifiers?: string[];
            coordinate_type?: 'auto' | 'absolute' | 'normalized';
          };
          const resolved = await resolveClickCoordinates(x, y, display_index, coordinate_type);
          result = await performClick(resolved.x, resolved.y, display_index, click_type, modifiers);
          break;
        }

        case 'type_text': {
          const {
            text,
            press_enter = false,
            input_method = 'auto',
            preserve_clipboard = true,
          } = args as {
            text: string;
            press_enter?: boolean;
            input_method?: 'auto' | 'keystroke' | 'paste';
            preserve_clipboard?: boolean;
          };
          result = await performType(text, press_enter, input_method, preserve_clipboard);
          break;
        }

        case 'key_press': {
          const { key, modifiers = [] } = args as {
            key: string;
            modifiers?: string[];
          };
          result = await performKeyPress(key, modifiers);
          break;
        }

        case 'scroll': {
          const {
            x,
            y,
            display_index = 0,
            direction,
            amount = 3,
            coordinate_type = 'auto',
          } = args as {
            x: number;
            y: number;
            display_index?: number;
            direction: 'up' | 'down' | 'left' | 'right';
            amount?: number;
            coordinate_type?: 'auto' | 'absolute' | 'normalized';
          };
          const resolved = await resolveClickCoordinates(x, y, display_index, coordinate_type);
          result = await performScroll(resolved.x, resolved.y, display_index, direction, amount);
          break;
        }

        case 'drag': {
          const {
            from_x,
            from_y,
            to_x,
            to_y,
            display_index = 0,
            coordinate_type = 'normalized',
          } = args as {
            from_x: number;
            from_y: number;
            to_x: number;
            to_y: number;
            display_index?: number;
            coordinate_type?: 'auto' | 'absolute' | 'normalized';
          };

          // Use resolveClickCoordinates for consistent coordinate handling
          const fromResolved = await resolveClickCoordinates(
            from_x,
            from_y,
            display_index,
            coordinate_type
          );
          const toResolved = await resolveClickCoordinates(
            to_x,
            to_y,
            display_index,
            coordinate_type
          );

          result = await performDrag(
            fromResolved.x,
            fromResolved.y,
            toResolved.x,
            toResolved.y,
            display_index
          );
          break;
        }

        case 'screenshot': {
          const { output_path, display_index, region } = args as {
            output_path?: string;
            display_index?: number;
            region?: { x: number; y: number; width: number; height: number };
          };
          // Validate output_path is within SCREENSHOTS_DIR to prevent path traversal
          let safeOutputPath = output_path;
          if (output_path) {
            const resolved = path.resolve(output_path);
            const screenshotsDirResolved = path.resolve(SCREENSHOTS_DIR);
            if (
              !resolved.startsWith(screenshotsDirResolved + path.sep) &&
              resolved !== screenshotsDirResolved
            ) {
              throw new Error(
                `output_path must be within the screenshots directory: ${SCREENSHOTS_DIR}`
              );
            }
            safeOutputPath = resolved;
          }
          result = await takeScreenshot(safeOutputPath, display_index, region);
          break;
        }

        case 'screenshot_for_display': {
          const { display_index, region, reason, force_refresh } = args as {
            display_index?: number;
            region?: { x: number; y: number; width: number; height: number };
            reason?: string;
            force_refresh?: boolean;
          };
          // This tool returns a special format with image data, so return directly
          return await takeScreenshotForDisplay(
            display_index,
            region,
            reason,
            force_refresh === true
          );
        }

        case 'get_mouse_position': {
          const position = await getMousePosition();
          result = JSON.stringify(position, null, 2);
          break;
        }

        case 'move_mouse': {
          const {
            x,
            y,
            display_index = 0,
            coordinate_type = 'auto',
          } = args as {
            x: number;
            y: number;
            display_index?: number;
            coordinate_type?: 'auto' | 'absolute' | 'normalized';
          };
          const resolved = await resolveClickCoordinates(x, y, display_index, coordinate_type);
          result = await moveMouse(resolved.x, resolved.y, display_index);
          break;
        }

        case 'wait': {
          const { duration, reason } = args as {
            duration: number;
            reason?: string;
          };
          const MAX_WAIT_MS = 60000;
          const cappedDuration = Math.min(duration, MAX_WAIT_MS);
          result = await performWait(cappedDuration, reason);
          break;
        }

        case 'gui_plan_action': {
          const { task_description, display_index } = args as {
            task_description: string;
            display_index?: number;
          };
          const plan = await planGUIActions(task_description, display_index);
          result = JSON.stringify(plan, null, 2);
          break;
        }

        case 'gui_locate_element': {
          const { element_description, display_index } = args as {
            element_description: string;
            display_index?: number;
          };
          const location = await locateGUIElement(element_description, display_index);
          result = JSON.stringify(location, null, 2);
          break;
        }

        case 'gui_interact_vision': {
          const { task_description, display_index } = args as {
            task_description: string;
            display_index?: number;
          };
          result = await performVisionBasedInteraction(task_description, display_index);
          break;
        }

        case 'gui_verify_vision': {
          const { question, display_index } = args as {
            question: string;
            display_index?: number;
          };
          result = await verifyGUIState(question, display_index);
          break;
        }

        case 'gui_extract_info': {
          const { extraction_prompt, display_index } = args as {
            extraction_prompt: string;
            display_index?: number;
          };
          result = await extractGUIInfo(extraction_prompt, display_index);
          break;
        }

        case 'init_app': {
          const { app_name } = args as {
            app_name: string;
          };

          if (!app_name) {
            throw new Error('app_name is required');
          }

          const initResult = await initApp(app_name);
          result = JSON.stringify({
            success: true,
            message: `Initialized app context for "${initResult.appName}"`,
            app_name: initResult.appName,
            app_directory: initResult.appDirectory,
            existing_clicks: initResult.clickCount,
            is_new_app: initResult.isNew,
            has_guide: initResult.hasGuide,
            guide_path: initResult.guidePath,
            guide: initResult.guide,
          });
          break;
        }

        case 'get_all_visited_apps': {
          const visitedApps = await getAllVisitedApps();
          result = JSON.stringify({
            success: true,
            visited_apps: visitedApps,
            count: visitedApps.length,
          });
          break;
        }

        case 'clear_click_history': {
          await clearClickHistory();
          result = JSON.stringify({
            success: true,
            message: `Click history cleared for app "${currentAppName}"`,
            app_name: currentAppName,
          });
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
      };
    } catch (error: unknown) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: error instanceof Error ? error.message : String(error),
              tool: name,
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

async function main() {
  try {
    writeMCPLog('=== GUI Operate MCP Server Starting ===', 'Initialization');
    writeMCPLog(`Node version: ${process.version}`, 'Initialization');
    writeMCPLog(`Platform: ${process.platform}`, 'Initialization');
    writeMCPLog(`Working directory: ${process.cwd()}`, 'Initialization');
    writeMCPLog(`Script path: ${__filename}`, 'Initialization');
    writeMCPLog(
      JSON.stringify({
        hasAnthropicApiKey: Boolean(
          process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
        ),
        hasOpenAIApiKey: Boolean(process.env.OPENAI_API_KEY),
        openAIBaseUrlHost: getBaseUrlHost(
          process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL
        ),
        openAIModel: process.env.OPENAI_MODEL || '(unset)',
        anthropicModel:
          process.env.CLAUDE_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '(unset)',
      }),
      'Initialization'
    );

    writeMCPLog('Starting dual-era MCP stdio transport...', 'Initialization');
    const stdioHandle = serveStdio(() => createMcpServer(), {
      onerror: (error) => writeMCPLog(`MCP stdio error: ${error.message}`, 'Error'),
    });

    writeMCPLog('GUI Operate MCP Server running on stdio', 'Server Start');
    writeMCPLog('=== Server Ready ===', 'Server Start');
    writeMCPLog('Waiting for MCP requests...', 'Server Start');

    // Keep the process alive - server will handle MCP protocol messages
    // The transport handles the stdio communication automatically

    // No need for auto-save on exit - each click is saved individually
    process.on('SIGINT', () => {
      writeMCPLog('Received SIGINT, exiting...', 'Server Shutdown');
      void stdioHandle.close().finally(() => process.exit(0));
    });

    process.on('SIGTERM', () => {
      writeMCPLog('Received SIGTERM, exiting...', 'Server Shutdown');
      void stdioHandle.close().finally(() => process.exit(0));
    });

    process.on('exit', (code) => {
      writeMCPLog(`Process exiting with code: ${code}`, 'Server Shutdown');
    });

    // Add unhandled rejection handler
    process.on('unhandledRejection', (reason, promise) => {
      writeMCPLog(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'Error');
    });

    // Add uncaught exception handler
    process.on('uncaughtException', (error) => {
      writeMCPLog(`Uncaught Exception: ${error.message}\nStack: ${error.stack}`, 'Fatal Error');
      process.exit(1);
    });
  } catch (error) {
    writeMCPLog(
      `Error in main(): ${error instanceof Error ? error.message : String(error)}`,
      'Fatal Error'
    );
    if (error instanceof Error && error.stack) {
      writeMCPLog(`Stack trace: ${error.stack}`, 'Fatal Error');
    }
    throw error;
  }
}

// Add startup log before main execution
writeMCPLog('=== Script Loaded ===', 'Bootstrap');
writeMCPLog(`Module loaded, about to call main()`, 'Bootstrap');

main().catch((error) => {
  const errorMsg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : 'No stack trace';
  writeMCPLog(`Fatal error in main(): ${errorMsg}`, 'Fatal Error');
  writeMCPLog(`Stack trace: ${stack}`, 'Fatal Error');
  process.exit(1);
});
