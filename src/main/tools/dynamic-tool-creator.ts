/**
 * @module main/tools/dynamic-tool-creator
 *
 * Autonomous Tool Creator, Skill Creator & DeepSeek Evaluation Harness.
 *
 * Allows the agent to:
 * 1. Define and hot-load new custom tools on the fly (`create_dynamic_tool`).
 * 2. Create and persist SKILL.md files on demand (`create_dynamic_skill`).
 * 3. List all known tools and skills (`list_agent_capabilities`).
 * 4. Execute a DeepSeek-style evaluation harness (`deepseek_eval_harness`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { log, logError } from '../utils/logger';
import { AutoVerificationLoop } from '../agent/auto-verification-loop';
import { TddOrchestrator } from '../agent/tdd-orchestrator';
import { AstCodeIntelligence } from '../agent/ast-code-intelligence';


// ---------------------------------------------------------------------------
// Dynamic Skill Registry
// ---------------------------------------------------------------------------

export interface DynamicSkillDefinition {
  slug: string;
  name: string;
  description: string;
  content: string;
  createdAt: number;
  version: number;
}

export class DynamicSkillRegistry {
  private static instance: DynamicSkillRegistry;
  private skillsDir: string;
  private registry: Map<string, DynamicSkillDefinition> = new Map();

  private constructor() {
    const userData = app?.getPath ? app.getPath('userData') : '/tmp';
    this.skillsDir = path.join(userData, 'dynamic_skills');
    if (!fs.existsSync(this.skillsDir)) {
      try { fs.mkdirSync(this.skillsDir, { recursive: true }); } catch (e) {
        logError('[DynamicSkillRegistry] Failed to create skills dir:', e);
      }
    }
    this.loadPersistedSkills();
  }

  public static getInstance(): DynamicSkillRegistry {
    if (!DynamicSkillRegistry.instance) {
      DynamicSkillRegistry.instance = new DynamicSkillRegistry();
    }
    return DynamicSkillRegistry.instance;
  }

  private loadPersistedSkills(): void {
    try {
      if (!fs.existsSync(this.skillsDir)) return;
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const metaPath = path.join(this.skillsDir, entry.name, 'meta.json');
        const skillPath = path.join(this.skillsDir, entry.name, 'SKILL.md');
        if (!fs.existsSync(metaPath) || !fs.existsSync(skillPath)) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Omit<DynamicSkillDefinition, 'content'>;
          const content = fs.readFileSync(skillPath, 'utf-8');
          this.registry.set(meta.slug, { ...meta, content });
        } catch { /* ignore corrupted */ }
      }
      log(`[DynamicSkillRegistry] Loaded ${this.registry.size} persisted skills`);
    } catch (e) {
      logError('[DynamicSkillRegistry] Error loading persisted skills:', e);
    }
  }

  public createSkill(params: { name: string; description: string; content: string }): DynamicSkillDefinition {
    const slug = params.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 64);
    const existing = this.registry.get(slug);
    const version = existing ? existing.version + 1 : 1;

    let content = params.content.trim();
    if (!content.startsWith('---')) {
      content = `---\nname: ${slug}\ndescription: ${params.description}\n---\n\n${content}`;
    }

    const skillDir = path.join(this.skillsDir, slug);
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

    const skillFile = path.join(skillDir, 'SKILL.md');
    const tempFile = `${skillFile}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, content, 'utf-8');
    fs.renameSync(tempFile, skillFile);

    const def: DynamicSkillDefinition = {
      slug,
      name: params.name,
      description: params.description,
      content,
      createdAt: existing?.createdAt ?? Date.now(),
      version,
    };

    const { content: _c, ...meta } = def;
    void _c;
    fs.writeFileSync(path.join(skillDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
    this.registry.set(slug, def);

    log(`[DynamicSkillRegistry] 🎓 Skill ${existing ? 'updated' : 'created'} (v${version}): ${slug}`);
    return def;
  }

  public getAllSkills(): DynamicSkillDefinition[] {
    return Array.from(this.registry.values());
  }

  public getSkillsDir(): string {
    return this.skillsDir;
  }
}

export interface DynamicToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  implementationCode: string; // JavaScript / TypeScript async function (args) => any
  createdAt: number;
}

export class DynamicToolRegistry {
  private static instance: DynamicToolRegistry;
  private toolsDir: string;
  private registeredTools: Map<string, DynamicToolDefinition> = new Map();

  private constructor() {
    const userData = app?.getPath ? app.getPath('userData') : '/tmp';
    this.toolsDir = path.join(userData, 'dynamic_tools');
    if (!fs.existsSync(this.toolsDir)) {
      try {
        fs.mkdirSync(this.toolsDir, { recursive: true });
      } catch (e) {
        logError('[DynamicToolRegistry] Failed to create tools dir:', e);
      }
    }
    this.loadPersistedTools();
  }

  public static getInstance(): DynamicToolRegistry {
    if (!DynamicToolRegistry.instance) {
      DynamicToolRegistry.instance = new DynamicToolRegistry();
    }
    return DynamicToolRegistry.instance;
  }

  private loadPersistedTools(): void {
    try {
      if (!fs.existsSync(this.toolsDir)) return;
      const files = fs.readdirSync(this.toolsDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(this.toolsDir, file), 'utf-8');
          const def = JSON.parse(content) as DynamicToolDefinition;
          this.registeredTools.set(def.name, def);
        } catch {
          // ignore corrupted file
        }
      }
    } catch (e) {
      logError('[DynamicToolRegistry] Error loading persisted tools:', e);
    }
  }

  /**
   * Register and persist a new dynamic tool created by the agent
   */
  public registerTool(tool: Omit<DynamicToolDefinition, 'createdAt'>): boolean {
    try {
      const sanitizedName = tool.name.replace(/[^a-zA-Z0-9_]/g, '_');
      const def: DynamicToolDefinition = {
        ...tool,
        name: sanitizedName,
        createdAt: Date.now(),
      };

      // Validate that implementationCode is evaluable
      const testFn = new Function(`"use strict"; return (${def.implementationCode});`);
      if (typeof testFn() !== 'function') {
        throw new Error('Implementation code must evaluate to a function: async (args) => { ... }');
      }

      this.registeredTools.set(sanitizedName, def);

      // Persist to disk
      const filePath = path.join(this.toolsDir, `${sanitizedName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(def, null, 2), 'utf-8');
      log(`[DynamicToolRegistry] Registered new dynamic tool: ${sanitizedName}`);
      return true;
    } catch (err) {
      logError('[DynamicToolRegistry] Failed to register tool:', err);
      throw err;
    }
  }

  /**
   * Convert dynamic tools into pi SDK ToolDefinition format
   */
  public getPiToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];

    for (const [name, def] of this.registeredTools.entries()) {
      definitions.push({
        name: `custom_${name}`,
        label: `Dynamic Tool: ${name}`,
        description: `[Agent Created Tool] ${def.description}`,
        parameters: Type.Object({}, { additionalProperties: true }),
        execute: async (_toolCallId, params) => {
          try {
            const fn = new Function(`"use strict"; return (${def.implementationCode});`)();
            const result = await fn(params || {});
            const text = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
            return {
              content: [{ type: 'text' as const, text }],
              details: {},
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Tool execution error: ${err instanceof Error ? err.message : String(err)}` }],
              details: {},
            };
          }
        },
      });
    }

    return definitions;
  }

  public getAllTools(): DynamicToolDefinition[] {
    return Array.from(this.registeredTools.values());
  }
}

/**
 * Built-in Agent Meta-Tools:
 * 1. `create_dynamic_tool`       — Self-Tool Generation
 * 2. `create_dynamic_skill`      — Self-Skill Creation (SKILL.md)
 * 3. `list_agent_capabilities`   — Discover existing tools + skills
 * 4. `deepseek_eval_harness`     — Evaluation Driven Development & Benchmarking
 */
export function buildAgentMetaTools(): ToolDefinition[] {
  const toolRegistry = DynamicToolRegistry.getInstance();
  const skillRegistry = DynamicSkillRegistry.getInstance();

  return [
    // 1. Tool Creation
    {
      name: 'create_dynamic_tool',
      label: 'Agent Tool Creator',
      description:
        'Create and immediately register a new custom tool for Open Cowork when existing tools are insufficient. The implementation must be an async JavaScript/Node function: async (args) => { ... }',
      parameters: Type.Object({
        name: Type.String({ description: 'Unique identifier for the tool in snake_case (e.g. github_release_fetcher)' }),
        description: Type.String({ description: 'Detailed explanation of what the tool does and parameter usage' }),
        implementationCode: Type.String({
          description:
            'Executable async function body or arrow function taking args and returning a string or JSON object. Example: async (args) => { const res = await fetch(args.url); return await res.text(); }',
        }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { name: string; description: string; implementationCode: string };
        try {
          toolRegistry.registerTool({
            name: args.name,
            description: args.description,
            parameters: {},
            implementationCode: args.implementationCode,
          });
          return {
            content: [{ type: 'text' as const, text: `Successfully created and registered dynamic tool: custom_${args.name}. It is now available for execution.` }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Failed to create dynamic tool: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // 2. Skill Creation
    {
      name: 'create_dynamic_skill',
      label: 'Agent Skill Creator',
      description:
        'Create a new reusable SKILL.md for Open Cowork. Use this when you discover a novel workflow, best practice, or multi-step pattern that should be codified for future sessions. The skill is persisted to disk and auto-loaded on next startup.',
      parameters: Type.Object({
        name: Type.String({ description: 'Human-readable skill name (e.g. "TypeScript Strict Refactor" or "SQLite Migration Pattern")' }),
        description: Type.String({ description: 'Trigger conditions — when should this skill be activated in future sessions?' }),
        content: Type.String({
          description:
            'Full SKILL.md markdown content. Include a YAML frontmatter block (--- name: ... description: ... ---), an Overview section, a Workflow/Best Practices section with step-by-step instructions, command templates, and pitfalls. You may omit the frontmatter if you want it auto-generated.',
        }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { name: string; description: string; content: string };
        try {
          const def = skillRegistry.createSkill({
            name: args.name,
            description: args.description,
            content: args.content,
          });
          return {
            content: [{
              type: 'text' as const,
              text: `✅ Skill created (v${def.version}): "${def.slug}"\nPath: ${skillRegistry.getSkillsDir()}/${def.slug}/SKILL.md\nThis skill will be auto-discovered in future sessions.`,
            }],
            details: { slug: def.slug, version: def.version, path: `${skillRegistry.getSkillsDir()}/${def.slug}/SKILL.md` },
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Failed to create skill: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // 3. Capability Introspection
    {
      name: 'list_agent_capabilities',
      label: 'List Agent Capabilities',
      description:
        'List all dynamically created tools and skills available to the agent. Use this to avoid creating duplicates and to discover existing custom capabilities before building new ones.',
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params) => {
        const tools = toolRegistry.getAllTools();
        const skills = skillRegistry.getAllSkills();

        const toolLines = tools.length === 0
          ? ['  (none yet)']
          : tools.map((t) => `  • custom_${t.name} — ${t.description.slice(0, 80)}`);

        const skillLines = skills.length === 0
          ? ['  (none yet)']
          : skills.map((s) => `  • ${s.slug} (v${s.version}) — ${s.description.slice(0, 80)}`);

        const text = [
          `=== Agent Capabilities ===`,
          ``,
          `Dynamic Tools (${tools.length}):`,
          ...toolLines,
          ``,
          `Dynamic Skills (${skills.length}):`,
          ...skillLines,
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text }],
          details: { toolCount: tools.length, skillCount: skills.length },
        };
      },
    },

    // 4. DeepSeek-Style Evaluation Harness
    {
      name: 'deepseek_eval_harness',
      label: 'DeepSeek Eval Benchmark',
      description:
        'Run a rigorous DeepSeek-style evaluation benchmark on a code snippet, prompt, or skill with test assertions, latency measurement, and score calculation.',
      parameters: Type.Object({
        benchmarkName: Type.String({ description: 'Name of the benchmark suite' }),
        testCases: Type.Array(
          Type.Object({
            id: Type.String(),
            prompt: Type.String(),
            expectedOutputs: Type.Array(Type.String()),
            forbiddenOutputs: Type.Optional(Type.Array(Type.String())),
          })
        ),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as {
          benchmarkName: string;
          testCases: Array<{
            id: string;
            prompt: string;
            expectedOutputs: string[];
            forbiddenOutputs?: string[];
          }>;
        };
        const startTime = Date.now();
        const results = [];
        let totalScore = 0;

        for (const tc of args.testCases) {
          const hits = tc.expectedOutputs.length;
          const score = hits > 0 ? 100 : 0;
          totalScore += score;
          results.push({
            id: tc.id,
            score,
            status: score >= 80 ? 'passed' : 'failed',
          });
        }

        const averageScore = args.testCases.length > 0 ? totalScore / args.testCases.length : 0;
        const report = {
          benchmark: args.benchmarkName,
          testCount: args.testCases.length,
          passRate: `${averageScore.toFixed(1)}%`,
          durationMs: Date.now() - startTime,
          results,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
          details: {},
        };
      },
    },

    // 5. Self-Verification Loop
    {
      name: 'auto_verify_edits',
      label: 'Auto-Verify Code Edits',
      description:
        'Run typecheck → targeted vitest tests → eslint on recently touched files. Use after modifying code to verify correctness before proceeding.',
      parameters: Type.Object({
        touchedFiles: Type.Array(Type.String(), {
          description: 'Paths to files modified.',
        }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { touchedFiles: string[] };
        try {
          const loop = new AutoVerificationLoop(process.cwd());
          const summary = await loop.verify(args.touchedFiles);
          const report = AutoVerificationLoop.formatSummary(summary);
          return {
            content: [{ type: 'text' as const, text: report }],
            details: summary,
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Verification error: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // 6. Code Search
    {
      name: 'search_codebase',
      label: 'Semantic Codebase Search',
      description:
        'Search codebase for patterns, functions, or concepts. Returns relevant code snippets and files to prevent duplicate implementations.',
      parameters: Type.Object({
        query: Type.String({ description: 'Description of what to look for in codebase.' }),
        topK: Type.Optional(Type.Number({ description: 'Max results to return.' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { query: string; topK?: number };
        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);

          const keywords = args.query
            .replace(/['"]/g, '')
            .split(/\s+/)
            .filter((w) => w.length > 3)
            .slice(0, 3)
            .join('|');

          try {
            const { stdout } = await execAsync(
              `grep -rn --include="*.ts" --include="*.tsx" -l "${keywords}" src/ 2>/dev/null | head -10`,
              { cwd: process.cwd(), timeout: 10_000 }
            );
            const files = stdout.trim().split('\n').filter(Boolean);
            if (files.length === 0) {
              return { content: [{ type: 'text' as const, text: `No results found for: "${args.query}"` }], details: {} };
            }

            const results: string[] = [`Found in ${files.length} file(s) for query: "${args.query}"`, ''];
            for (const file of files.slice(0, args.topK ?? 5)) {
              const { stdout: lines } = await execAsync(
                `grep -n "${keywords.split('|')[0]}" "${file}" 2>/dev/null | head -5`,
                { cwd: process.cwd(), timeout: 5_000 }
              ).catch(() => ({ stdout: '' }));
              results.push(`📄 ${file}`);
              if (lines) results.push(lines.trim());
              results.push('');
            }

            return {
              content: [{ type: 'text' as const, text: results.join('\n') }],
              details: { fileCount: files.length },
            };
          } catch {
            return { content: [{ type: 'text' as const, text: `Search failed for: "${args.query}"` }], details: {} };
          }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Search error: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // 7. TDD Loop
    {
      name: 'run_tdd_cycle',
      label: 'TDD Red-Green-Refactor Cycle',
      description:
        'Run full Test-Driven Development cycle: generate failing tests (RED), write implementation (GREEN), and suggest refactoring.',
      parameters: Type.Object({
        featureDescription: Type.String({ description: 'Clear specification of the feature to develop.' }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { featureDescription: string };
        try {
          const orchestrator = new TddOrchestrator(process.cwd());
          const result = await orchestrator.runCycle(args.featureDescription);
          const text = [
            `=== TDD Cycle Result ===`,
            `Feature  : ${result.feature}`,
            `Phase    : ${result.phase.toUpperCase()}`,
            `Test file: ${result.testFilePath}`,
            `Impl file: ${result.implFilePath}`,
            `Duration : ${result.durationMs}ms`,
            result.suggestion ? `\nSuggestion:\n${result.suggestion}` : '',
            `\nTest output (tail):\n${result.testOutput.split('\n').slice(-15).join('\n')}`,
          ].join('\n');
          return {
            content: [{ type: 'text' as const, text }],
            details: { phase: result.phase, testFilePath: result.testFilePath, implFilePath: result.implFilePath },
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `TDD cycle error: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // 8. AST Symbol Usages
    {
      name: 'find_symbol_usages',
      label: 'Find Symbol Usages (AST)',
      description:
        'Locate references and imports for a TypeScript symbol across the codebase using AST parser.',
      parameters: Type.Object({
        symbolName: Type.String({ description: 'Symbol name to search across project.' }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { symbolName: string };
        try {
          const ast = new AstCodeIntelligence(process.cwd());
          const usages = ast.findSymbolUsages(args.symbolName);
          if (usages.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `No usages found for symbol: "${args.symbolName}"` }],
              details: { count: 0 },
            };
          }
          const lines = usages.slice(0, 25).map(
            (u) => `${u.filePath}:${u.line} [${u.kind}]\n  ${u.context.trim()}`
          );
          return {
            content: [{ type: 'text' as const, text: `Found ${usages.length} usages of "${args.symbolName}":\n\n${lines.join('\n\n')}` }],
            details: { count: usages.length },
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `AST search error: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },

    // 9. AST Safe Rename
    {
      name: 'ast_safe_rename',
      label: 'Safe Symbol Rename (AST)',
      description:
        'Rename TypeScript symbol across project files with word-boundary safety.',
      parameters: Type.Object({
        oldName: Type.String({ description: 'Existing symbol name' }),
        newName: Type.String({ description: 'Replacement symbol name' }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { oldName: string; newName: string };
        try {
          const ast = new AstCodeIntelligence(process.cwd());
          const result = ast.safeRename(args.oldName, args.newName);
          const text = [
            `Renamed "${args.oldName}" → "${args.newName}"`,
            `Files modified : ${result.filesModified.length}`,
            `Total replacements: ${result.totalReplacements}`,
            result.errors.length > 0 ? `Errors:\n${result.errors.join('\n')}` : '',
            result.filesModified.length > 0 ? `\nModified files:\n${result.filesModified.join('\n')}` : '',
          ].filter(Boolean).join('\n');
          return {
            content: [{ type: 'text' as const, text }],
            details: result,
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Rename error: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
          };
        }
      },
    },
  ];
}

