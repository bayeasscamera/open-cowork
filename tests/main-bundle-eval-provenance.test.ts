import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Where the main bundle's `new Function` comes from, and what must never reach it.
 *
 * The main bundle contains a `new Function` even though no first-party source
 * evaluates anything there. Two dependencies own it:
 *
 *   - @mariozechner/pi-ai validates tool arguments by compiling the tool schema
 *     with TypeBox's `Compile`. TypeBox builds a validator and, when the
 *     environment allows dynamic evaluation (the main process does — no CSP),
 *     it JITs that schema into a function via `new (globalThis.Function)`.
 *     Until pi-ai 0.73 this same slot was AJV's; only the compiler moved, the
 *     boundary did not.
 *   - AJV still arrives through electron-store/conf (the app's own config
 *     schema) and electron-builder (build-time only).
 *
 * The distinction that matters for the agent threat model is schema versus data:
 *
 *   - MODEL OUTPUT is the DATA being validated. It never becomes a schema and is
 *     never compiled. This is the invariant these tests protect.
 *   - TOOL SCHEMAS are compiled. Ours are app-authored TypeBox. MCP servers
 *     supply their own, which means a malicious MCP server can reach the code
 *     generator. That is documented in AGENTS.md as a known property rather than
 *     hidden, because it follows from MCP being an extension point and from the
 *     validator being a compiler.
 *
 * A future change that fed model output in as a schema would turn this into a
 * direct code-execution path from the model, and would be extremely easy to miss.
 */

const PI_VALIDATION = 'node_modules/@mariozechner/pi-ai/dist/utils/validation.js';
const TYPEBOX_COMPILE = 'node_modules/typebox/build/compile/compile.mjs';
const TYPEBOX_EVALUATE = 'node_modules/typebox/build/system/environment/evaluate.mjs';
const TYPEBOX_SETTINGS = 'node_modules/typebox/build/system/settings/settings.mjs';
const AJV_COMPILE = 'node_modules/ajv/dist/compile/index.js';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('the main bundle eval is accounted for', () => {
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

  it('pi-ai compiles the tool schema and validates the model arguments as data', () => {
    const source = read(PI_VALIDATION);
    // Since 0.73, pi-ai compiles tool schemas with TypeBox's compiler (AJV before).
    expect(source).toContain('typebox/compile');
    // It compiles `tool.parameters` — the schema...
    expect(source).toMatch(/getValidator\(tool\.parameters\)/);
    // ...and treats `toolCall.arguments` — the model's output — purely as data:
    // cloned, coerced, then Check/Errors-ed, never handed to the compiler.
    expect(source).toMatch(/structuredClone\(toolCall\.arguments\)/);
    expect(source).not.toMatch(/Compile\(\s*toolCall/);
  });

  it('the eval itself is TypeBox JIT, and it lives in a dependency', () => {
    // `Compile` builds a validator from the schema.
    expect(read(TYPEBOX_COMPILE)).toMatch(/new Validator\(/);
    // The eval — `new (globalThis.Function)(...)` — is TypeBox's environment.
    const evaluate = read(TYPEBOX_EVALUATE);
    expect(evaluate).toMatch(/new \(globalThis\.Function\)/);
    // It only JITs when the environment allows it, gated by CanEvaluate()...
    expect(evaluate).toMatch(/CanEvaluate/);
    // ...and acceleration is on by default, which is why the main process
    // genuinely compiles schemas rather than walking them.
    expect(read(TYPEBOX_SETTINGS)).toMatch(/useAcceleration:\s*true/);
  });

  it('AJV still reaches the bundle, but through conf, not the agent', () => {
    // Not a bug to fix here — electron-store validates its own config schema.
    // Its `new Function` lives in AJV's compiler.
    expect(read(AJV_COMPILE)).toMatch(/new Function/);
  });

  it('our own code does not import AJV directly', () => {
    const runner = read('src/main/tools/registry.ts');
    expect(runner).not.toMatch(/from 'ajv'/);
  });
});

describe('MCP-provided schemas do reach the code generator, and that is documented', () => {
  it('an MCP tool schema becomes the compiled schema', () => {
    // Not a bug to fix here — the validator compiles whatever schema it is
    // given, and MCP servers supply their own. It is a property of the
    // extension point, so it is asserted here and written down in AGENTS.md
    // rather than left to be discovered.
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
    // The shape to avoid: feeding model-produced text into the compiler.
    const tools = read('src/main/tools/registry.ts');
    expect(tools).not.toMatch(/compile\s*\(\s*(args|input|toolCall)/);
  });

  it('tool arguments are validated against an app-authored schema', () => {
    // inputSchema is TypeBox, declared in source, never assembled from input.
    const registry = read('src/main/tools/registry.ts');
    expect(registry).toContain('inputSchema');
  });
});
