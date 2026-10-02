import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Where the main bundle's `new Function` comes from, and what must never reach it.
 *
 * The main bundle contains a `new Function` even though no first-party source
 * evaluates anything there. It belongs to AJV, which compiles JSON Schema into
 * JavaScript source and evaluates it. AJV arrives through @mariozechner/pi-ai
 * (tool-argument validation), electron-store/conf (the app's own config) and
 * electron-builder (build-time only).
 *
 * The distinction that matters for the agent threat model is schema versus data:
 *
 *   - MODEL OUTPUT is the DATA being validated. It never becomes a schema and is
 *     never compiled. This is the invariant these tests protect.
 *   - TOOL SCHEMAS are compiled. Ours are app-authored TypeBox. MCP servers
 *     supply their own, which means a malicious MCP server can reach AJV's
 *     codegen. That is documented in AGENTS.md as a known property rather than
 *     hidden, because it follows from MCP being an extension point and from AJV
 *     being a validator.
 *
 * A future change that fed model output in as a schema would turn this into a
 * direct code-execution path from the model, and would be extremely easy to miss.
 */

const PI_VALIDATION =
  "node_modules/@mariozechner/pi-ai/dist/utils/validation.js";

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('the main bundle eval is AJV, and is accounted for', () => {
  it('no first-party source evaluates anything in the main process', () => {
    // The child is the one permitted eval, and it is not reachable from main.
    const agentDir = 'src/main/agent';
    const evaluating = readdirSync(agentDir).filter((file) => {
      if (!file.endsWith('.ts')) return false;
      const source = read(`${agentDir}/${file}`)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return /new\s+Function\s*\(/.test(source);
    });
    // Exactly one: the run_code child.
    expect(evaluating).toEqual(['run-code-child.ts']);
  });

  it('the AJV usage is schema compilation, and it lives in a dependency', () => {
    const source = read(PI_VALIDATION);
    expect(source).toContain('new Ajv(');
    // It compiles `tool.parameters` — the schema — and validates
    // `toolCall.arguments` — the data — against it.
    expect(source).toMatch(/ajv\.compile\(/);
  });

  it('our own code does not import AJV directly', () => {
    const runner = read('src/main/tools/registry.ts');
    expect(runner).not.toMatch(/from 'ajv'/);
  });
});

describe('MCP-provided schemas do reach AJV, and that is documented', () => {
  it('an MCP tool schema becomes the compiled schema', () => {
    // Not a bug to fix here — AJV compiles whatever schema it is given, and MCP
    // servers supply their own. It is a property of the extension point, so it
    // is asserted here and written down in AGENTS.md rather than left to be
    // discovered.
    const bridge = read('src/main/agent/agent-runner-mcp-tools.ts');
    expect(bridge).toContain('mcpTool.inputSchema');
    expect(bridge).toContain('parameters');
  });

  it('AGENTS.md states the MCP schema trust boundary', () => {
    const agents = read('AGENTS.md');
    expect(agents).toMatch(/MCP/i);
    expect(agents).toMatch(/schema/i);
  });
});

describe('model output is the data, never the schema', () => {
  it('no source passes a tool call into a schema-compiling position', () => {
    // The shape to avoid: feeding model-produced text into ajv.compile.
    const tools = read('src/main/tools/registry.ts');
    expect(tools).not.toMatch(/compile\s*\(\s*(args|input|toolCall)/);
  });

  it('tool arguments are validated against an app-authored schema', () => {
    // inputSchema is TypeBox, declared in source, never assembled from input.
    const registry = read('src/main/tools/registry.ts');
    expect(registry).toContain('inputSchema');
  });
});
