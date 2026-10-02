/**
 * @module main/presets/tool-presenter
 *
 * How the model SEES the tools. Two presentations, one per preset:
 *
 *   - `direct`: every allowed tool is passed to the SDK as its own tool
 *     definition. This is the historical behaviour and is byte-for-byte
 *     unchanged for the `standard` preset.
 *   - `code`: the model sees a single `run_code` entry point plus a generated
 *     TypeScript SDK describing the other tools, so a multi-step task becomes
 *     one code block instead of N tool-call round trips.
 *
 * Two invariants matter more than the feature itself:
 *
 *   1. **Determinism.** The generated SDK goes into the system prompt, so any
 *      non-determinism (map iteration, timestamps, absolute paths) would
 *      invalidate the prompt cache on every turn. Output is sorted and free of
 *      ambient data.
 *   2. **run_code never describes itself.** Including it in the SDK it
 *      implements would let generated code recurse into the code path, and it
 *      is always present as a direct tool anyway.
 */

import type { AgentPreset } from './preset-schema';
import type { ToolDefinition } from '../tools/registry';

/** Tools that must stay direct even in code mode. */
export const DEFAULT_DIRECT_TOOLS: readonly string[] = ['run_code'];

/** The name of the code entry point. */
export const RUN_CODE_TOOL_NAME = 'run_code';

export interface PresentedCatalog {
  /** Tool definitions to hand to the SDK as first-class tools. */
  direct: ToolDefinition[];
  /** Names of the tools reachable from generated code. */
  viaCode: string[];
  /** The generated SDK, '' in direct mode. */
  sdkSource: string;
}

export interface ToolPresenter {
  /** What the model receives as a tool catalog. */
  present(tools: ToolDefinition[]): PresentedCatalog;
  /** Text added to the system prompt; may be empty. */
  promptSection(tools: ToolDefinition[]): string;
}

// ---------------------------------------------------------------------------
// Deterministic TypeScript SDK generation
// ---------------------------------------------------------------------------

/** A reserved word cannot be used bare as a property name. */
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'as', 'implements', 'interface', 'let',
  'package', 'private', 'protected', 'public', 'static', 'yield',
]);

/** A property key that is not a plain identifier must be quoted. */
function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name)
    ? name
    : JSON.stringify(name);
}

/**
 * A tool name must be usable as a method name on the `tools` object. The
 * registry already enforces lowercase snake_case; this is the second,
 * independent check at the point of code generation, so a hand-edited preset
 * or a future registry cannot emit an SDK that does not compile.
 */
export function isUsableSdkMethodName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name);
}

type JsonSchemaLike = {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchemaLike;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaLike;
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  description?: string;
};

function firstTypeName(types: string | string[] | undefined): string {
  if (Array.isArray(types)) {
    // A union renders as its first non-null member, which is enough for an
    // ambient declaration the model reads for shape, not for exact checking.
    const named = types.find((t) => t !== 'null');
    return named ?? 'unknown';
  }
  return types ?? 'unknown';
}

/** Render a JSON Schema node as a TypeScript type, deterministically. */
export function renderSchemaType(
  schema: JsonSchemaLike | undefined,
  indent: string
): string {
  if (!schema || typeof schema !== 'object') return 'unknown';

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    // Literals sorted, so schema key order cannot change the output.
    const literals = [...schema.enum]
      .map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v)))
      .sort();
    return literals.join(' | ');
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.map((s) => renderSchemaType(s, indent)).join(' | ');
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.map((s) => renderSchemaType(s, indent)).join(' | ');
  }

  const type = firstTypeName(schema.type);
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const item = renderSchemaType(schema.items, indent);
      // Parenthesise a union so `Array<A | B>` does not become `A[] | B`.
      return `Array<${item.includes('|') ? `(${item})` : item}>`;
    }
    case 'object': {
      const properties = schema.properties;
      if (!properties || Object.keys(properties).length === 0) {
        return 'Record<string, unknown>';
      }
      const required = new Set(schema.required ?? []);
      const inner = indent + '  ';
      // Sorted keys: the single biggest source of accidental non-determinism.
      const lines = Object.keys(properties)
        .sort()
        .map((key) => {
          const child = properties[key];
          const rendered = renderSchemaType(child, inner);
          const optional = required.has(key) ? '' : '?';
          return `${inner}${propertyKey(key)}${optional}: ${rendered};`;
        });
      return `{\n${lines.join('\n')}\n${indent}}`;
    }
    default:
      return 'unknown';
  }
}

/**
 * Stable one-line doc comment for a tool, or undefined when undescribed.
 *
 * The description is attacker-influenced data: it can come from an MCP server
 * or an extension. A comment terminator inside it would close the doc comment
 * early and let the rest of the string inject arbitrary TypeScript into a file
 * the model reads as a type contract, so terminators are neutralised here
 * rather than trusted. Newlines are collapsed because the output must be
 * byte-stable for prompt caching.
 */
function docComment(tool: ToolDefinition): string | undefined {
  const description = tool.description?.trim();
  if (!description) return undefined;
  const flat = description
    .replace(/\s+/g, ' ')
    .replace(/\*\//g, '*{SLASH}')
    .trim();
  return flat || undefined;
}

/**
 * Generate the ambient SDK for a set of tools.
 *
 * Byte-for-byte deterministic for the same input: tools sorted by name,
 * properties sorted, no timestamps, no absolute paths.
 */
export function generateToolsSdk(tools: ToolDefinition[]): string {
  const usable = tools
    .filter((tool) => isUsableSdkMethodName(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (usable.length === 0) {
    return [
      'declare const tools: Record<string, never>;',
      '',
    ].join('\n');
  }

  const lines: string[] = [
    'declare const tools: {',
  ];
  for (const tool of usable) {
    const argsType = renderSchemaType(
      (tool.inputSchema ?? {}) as JsonSchemaLike,
      '  '
    );
    const doc = docComment(tool);
    if (doc) lines.push(`  /** ${doc} */`);
    lines.push(`  ${tool.name}(args: ${argsType}): Promise<ToolResult>;`);
  }
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

/** Historical presentation: every allowed tool is a first-class tool. */
export class DirectPresenter implements ToolPresenter {
  present(tools: ToolDefinition[]): PresentedCatalog {
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    return { direct: sorted, viaCode: [], sdkSource: '' };
  }

  promptSection(): string {
    // Direct mode adds nothing: the SDK already renders the tool list.
    return '';
  }
}

/**
 * Code presentation: one `run_code` entry point, everything else behind a
 * generated SDK.
 *
 * `alwaysDirect` exists because some tools must never be hidden behind code:
 * asking the user a question has to surface in the UI, and a tool that mutates
 * permission state belongs in the approval flow, not inside a code block.
 */
export class CodePresenter implements ToolPresenter {
  private readonly alwaysDirect: readonly string[];

  constructor(alwaysDirect: readonly string[] = DEFAULT_DIRECT_TOOLS) {
    this.alwaysDirect = alwaysDirect;
  }

  present(tools: ToolDefinition[]): PresentedCatalog {
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const direct = sorted.filter((tool) => this.alwaysDirect.includes(tool.name));
    // run_code is an entry point, not something code can call: including it
    // would let generated code recurse into the code path.
    const viaCodeTools = sorted.filter(
      (tool) => !this.alwaysDirect.includes(tool.name) && tool.name !== RUN_CODE_TOOL_NAME
    );
    return {
      direct,
      viaCode: viaCodeTools.map((tool) => tool.name),
      sdkSource: generateToolsSdk(viaCodeTools),
    };
  }

  promptSection(tools: ToolDefinition[]): string {
    const catalog = this.present(tools);
    if (catalog.viaCode.length === 0) return '';
    return [
      '## Driving tools from code',
      '',
      'You have one code entry point, `run_code`, and a TypeScript SDK for the other tools.',
      'Write TypeScript that awaits `tools.*`; each call is a real tool invocation and is',
      'gated exactly like a direct call (permissions, workspace confinement, secret',
      'redaction all apply).',
      '',
      '```ts',
      catalog.sdkSource.trimEnd(),
      '```',
      '',
    ].join('\n');
  }
}

/** Pick the presenter a preset asks for. */
export function presenterFor(
  preset: AgentPreset,
  alwaysDirect: readonly string[] = DEFAULT_DIRECT_TOOLS
): ToolPresenter {
  return preset.presentation === 'code'
    ? new CodePresenter(alwaysDirect)
    : new DirectPresenter();
}

/**
 * Filter the registry catalog down to what a preset allows, then present it.
 *
 * The allow-list is applied HERE as well as in the gate: a tool the preset does
 * not allow must not even appear in the model's catalog, otherwise the model
 * is told about a tool whose every call will be refused.
 */
export function presentToolsForPreset(
  tools: ToolDefinition[],
  preset: AgentPreset,
  alwaysDirect: readonly string[] = DEFAULT_DIRECT_TOOLS
): PresentedCatalog {
  const allowed = new Set(preset.tools.allow);
  const subset = tools.filter((tool) => allowed.has(tool.name));
  return presenterFor(preset, alwaysDirect).present(subset);
}
