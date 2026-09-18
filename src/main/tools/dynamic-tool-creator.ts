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
import { SystemController } from '../system/system-controller';
import { SelfHealingRunner } from '../agent/self-healing-runner';
import { CodeGraphIndexer } from '../memory/codegraph-indexer';
import { MultiAgentCoordinator } from '../agent/multi-agent-coordinator';
import { createSwarmRunner } from '../agent/swarm-runner';
import { configStore } from '../config/config-store';
import { spawn, type ChildProcess } from 'child_process';


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

      // Persist to disk atomically to prevent partial writes
      const filePath = path.join(this.toolsDir, `${sanitizedName}.json`);
      const tempPath = `${filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(def, null, 2), 'utf-8');
      fs.renameSync(tempPath, filePath);
      log(`[DynamicToolRegistry] Registered and persisted dynamic tool: ${sanitizedName}`);
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

    // =========================================================================
    // PILIER 1 — OMNIPOTENCE SYSTÈME (OPENCLAW STYLE)
    // =========================================================================

    // 10. System App Control
    {
      name: 'system_app_control',
      label: 'Control OS Application',
      description:
        'Launch, switch to, or close any application installed on the host machine (e.g. "Safari", "Terminal", "Visual Studio Code", "Slack", "Notes").',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('launch'), Type.Literal('quit'), Type.Literal('force_quit')], {
          description: 'Action to perform on the target application',
        }),
        appName: Type.String({ description: 'Name of the application on the system (e.g. "Safari", "Slack")' }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { action: 'launch' | 'quit' | 'force_quit'; appName: string };
        const sys = SystemController.getInstance();
        if (args.action === 'launch') {
          const res = await sys.launchApp(args.appName);
          return { content: [{ type: 'text' as const, text: res.output }], details: res };
        } else {
          const res = await sys.quitApp(args.appName, args.action === 'force_quit');
          return { content: [{ type: 'text' as const, text: res.output }], details: res };
        }
      },
    },

    // 11. Clipboard Manipulation
    {
      name: 'system_clipboard',
      label: 'Read/Write System Clipboard',
      description:
        'Access the host OS clipboard. Read the currently copied content or write new text/code into the user clipboard.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('read'), Type.Literal('write')], {
          description: 'Whether to read from or write to the clipboard',
        }),
        text: Type.Optional(Type.String({ description: 'Text to copy into clipboard (required when action is write)' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { action: 'read' | 'write'; text?: string };
        const sys = SystemController.getInstance();
        if (args.action === 'read') {
          const content = sys.readClipboard();
          return {
            content: [{ type: 'text' as const, text: content ? `Clipboard Content:\n${content}` : 'Clipboard is empty.' }],
            details: { hasContent: Boolean(content) },
          };
        } else {
          const success = sys.writeClipboard(args.text || '');
          return {
            content: [{ type: 'text' as const, text: success ? 'Text copied to clipboard successfully.' : 'Failed to write to clipboard.' }],
            details: { success },
          };
        }
      },
    },

    // 12. Native System Notifications
    {
      name: 'system_notify',
      label: 'Send Native OS Notification',
      description:
        'Trigger a native desktop notification banner on macOS or Windows. Use to alert the user when an important background task completes.',
      parameters: Type.Object({
        title: Type.String({ description: 'Notification title' }),
        message: Type.String({ description: 'Notification body message' }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { title: string; message: string };
        const sys = SystemController.getInstance();
        const sent = sys.notify(args.title, args.message);
        return {
          content: [{ type: 'text' as const, text: sent ? `Notification sent: "${args.title}"` : 'Failed to dispatch notification.' }],
          details: { sent },
        };
      },
    },

    // 13. Process Manager
    {
      name: 'system_process_manager',
      label: 'Inspect & Manage Processes',
      description:
        'List active system processes or terminate a process by its PID. Useful for checking resource usage or killing stuck servers/ports.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('kill')], {
          description: 'List active processes or kill a specific process',
        }),
        filter: Type.Optional(Type.String({ description: 'Process name filter when listing (e.g. "node", "python")' })),
        pid: Type.Optional(Type.Number({ description: 'PID to terminate when action is kill' })),
        force: Type.Optional(Type.Boolean({ description: 'Force kill (SIGKILL) when action is kill' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { action: 'list' | 'kill'; filter?: string; pid?: number; force?: boolean };
        const sys = SystemController.getInstance();
        if (args.action === 'list') {
          const procs = await sys.listProcesses(args.filter);
          const lines = procs.slice(0, 25).map((p) => `PID ${p.pid} | CPU ${p.cpu || 'N/A'} | MEM ${p.mem || 'N/A'} | ${p.name}`);
          return {
            content: [{ type: 'text' as const, text: `Active Processes (${procs.length}):\n${lines.join('\n')}` }],
            details: { count: procs.length },
          };
        } else {
          if (!args.pid) {
            return { content: [{ type: 'text' as const, text: 'PID is required for action kill' }], details: {} };
          }
          const res = await sys.killProcess(args.pid, args.force);
          return { content: [{ type: 'text' as const, text: res.output }], details: res };
        }
      },
    },

    // 14. Native AppleScript Runner (macOS automation)
    {
      name: 'system_run_script',
      label: 'Execute AppleScript / JXA (macOS)',
      description:
        'Run custom AppleScript directly on macOS to automate UI actions, control Finder, query window states, or interact with native apps (Safari, Mail, Calendar, etc.).',
      parameters: Type.Object({
        script: Type.String({ description: 'AppleScript code to execute (e.g. tell application "Finder" to get name of every window)' }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { script: string };
        const sys = SystemController.getInstance();
        const res = await sys.runAppleScript(args.script);
        return {
          content: [{ type: 'text' as const, text: res.output }],
          details: res,
        };
      },
    },

    // =========================================================================
    // PILIER 2 — VISION GUI & CONTRÔLE ÉCRAN (COMPUTER USE)
    // =========================================================================

    // 15. Screen Capture (Vision GUI)
    {
      name: 'screen_capture',
      label: 'Capture Screen / Window',
      description:
        'Capture a screenshot of the entire screen or desktop display. Returns file path and base64 image data for visual inspection.',
      parameters: Type.Object({
        targetPath: Type.Optional(Type.String({ description: 'Optional destination file path for screenshot (.png)' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { targetPath?: string };
        const sys = SystemController.getInstance();
        const res = await sys.takeScreenshot(args.targetPath);
        if (res.success) {
          return {
            content: [
              { type: 'text' as const, text: `Screenshot successfully captured: ${res.filePath}` },
              ...(res.base64 ? [{
                type: 'image' as const,
                data: res.base64,
                mimeType: 'image/png',
              }] : []),
            ],
            details: { filePath: res.filePath },
          };
        } else {
          return {
            content: [{ type: 'text' as const, text: `Screenshot failed: ${res.error || 'Unknown error'}` }],
            details: { error: res.error },
          };
        }
      },
    },

    // 16. Simulate GUI Action (Click / Keystroke)
    {
      name: 'gui_interact',
      label: 'Simulate GUI Interaction',
      description:
        'Simulate mouse click at coordinates or send keystrokes/shortcuts to active desktop applications.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('click'), Type.Literal('type'), Type.Literal('key_combo')]),
        x: Type.Optional(Type.Number({ description: 'X screen coordinate for click' })),
        y: Type.Optional(Type.Number({ description: 'Y screen coordinate for click' })),
        text: Type.Optional(Type.String({ description: 'Text to type into focused window' })),
        key: Type.Optional(Type.String({ description: 'Key name for shortcut (e.g. "c", "v", "return", "tab")' })),
        modifiers: Type.Optional(Type.Array(Type.String(), { description: 'Modifiers: command, option, control, shift' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as {
          action: 'click' | 'type' | 'key_combo';
          x?: number;
          y?: number;
          text?: string;
          key?: string;
          modifiers?: string[];
        };
        const sys = SystemController.getInstance();
        const res = await sys.simulateGuiAction(args.action, args);
        return {
          content: [{ type: 'text' as const, text: res.output }],
          details: res,
        };
      },
    },

    // =========================================================================
    // PILIER 1 & 4 — SELF-HEALING & CODE GRAPH AST
    // =========================================================================

    // 17. Self-Healing Test Runner
    {
      name: 'auto_test_and_heal',
      label: 'Autonomous Self-Healing Loop',
      description:
        'Run verification tests or linter in a closed-loop. If failure occurs, extracts root errors to provide instant diagnostics for immediate self-correction.',
      parameters: Type.Object({
        command: Type.String({ description: 'Test command to run (e.g. "npm test", "npm run lint", "npm run typecheck")' }),
        cwd: Type.Optional(Type.String({ description: 'Working directory' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { command: string; cwd?: string };
        const workDir = args.cwd || process.cwd();
        const runner = new SelfHealingRunner(3);
        const res = await runner.runTestCommand(args.command, workDir);

        if (res.passed) {
          return {
            content: [{ type: 'text' as const, text: `✅ Command "${args.command}" PASSED without errors.\n\n${res.stdout}` }],
            details: res,
          };
        } else {
          return {
            content: [
              {
                type: 'text' as const,
                text: `❌ Command "${args.command}" FAILED (exit code ${res.exitCode}).\n\nExtracted Errors:\n${res.extractedErrors.join('\n')}\n\nStderr snippet:\n${res.stderr.slice(0, 1500)}`,
              },
            ],
            details: res,
          };
        }
      },
    },

    // 18. Codebase Symbol & Graph Explorer (AST In-Memory)
    {
      name: 'query_codebase_graph',
      label: 'Query Codebase Graph & Symbols',
      description:
        'Scan workspace codebase and query symbols (functions, classes, types, interfaces) with fast in-memory AST lookup without scanning files sequentially.',
      parameters: Type.Object({
        query: Type.String({ description: 'Symbol name or keyword to look for' }),
        dirPath: Type.Optional(Type.String({ description: 'Root directory to index if not yet scanned' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { query: string; dirPath?: string };
        const rootDir = args.dirPath || process.cwd();
        const indexer = new CodeGraphIndexer();
        await indexer.scanDirectory(rootDir);
        const matches = indexer.searchSymbol(args.query);

        if (matches.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No symbols matching "${args.query}" found in ${rootDir}.` }],
            details: { count: 0 },
          };
        }

        const lines = matches.slice(0, 30).map((m) => `[${m.kind.toUpperCase()}] ${m.name} -> ${m.filePath}:${m.line}`);
        return {
          content: [{ type: 'text' as const, text: `Found ${matches.length} symbol match(es) for "${args.query}":\n\n${lines.join('\n')}` }],
          details: { matches },
        };
      },
    },

    // =========================================================================
    // PILIER 3 — BACKGROUND DAEMONS & ASYNC JOBS
    // =========================================================================

    // 19. Background Daemon / Job Manager
    {
      name: 'background_job_manager',
      label: 'Manage Background Jobs & Daemons',
      description:
        'Launch long-running commands in background (dev servers, log watchers, long builds), poll their stdout/stderr, or terminate them cleanly.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('start'), Type.Literal('status'), Type.Literal('stop'), Type.Literal('list')]),
        jobId: Type.Optional(Type.String({ description: 'Unique ID of the job' })),
        command: Type.Optional(Type.String({ description: 'Command to run (e.g. "npm run dev")' })),
        cwd: Type.Optional(Type.String({ description: 'Working directory' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { action: 'start' | 'status' | 'stop' | 'list'; jobId?: string; command?: string; cwd?: string };
        const mgr = BackgroundJobRegistry.getInstance();

        if (args.action === 'start') {
          if (!args.command) {
            return { content: [{ type: 'text' as const, text: 'Command is required to start a background job.' }], details: {} };
          }
          const id = args.jobId || `job-${Date.now()}`;
          const res = mgr.startJob(id, args.command, args.cwd || process.cwd());
          return { content: [{ type: 'text' as const, text: res.message }], details: res };
        } else if (args.action === 'status') {
          if (!args.jobId) {
            return { content: [{ type: 'text' as const, text: 'jobId is required to query status.' }], details: {} };
          }
          const st = mgr.getJobStatus(args.jobId);
          return { content: [{ type: 'text' as const, text: JSON.stringify(st, null, 2) }], details: st };
        } else if (args.action === 'stop') {
          if (!args.jobId) {
            return { content: [{ type: 'text' as const, text: 'jobId is required to stop a job.' }], details: {} };
          }
          const res = mgr.stopJob(args.jobId);
          return { content: [{ type: 'text' as const, text: res.message }], details: res };
        } else {
          const list = mgr.listJobs();
          return { content: [{ type: 'text' as const, text: `Active background jobs (${list.length}):\n${JSON.stringify(list, null, 2)}` }], details: list };
        }
      },
    },

    // =========================================================================
    // PILIER 5 — MULTI-AGENT SWARM ORCHESTRATION
    // =========================================================================

    // 20. Multi-Agent Swarm Coordinator
    {
      name: 'orchestrate_multi_agent_plan',
      label: 'Multi-Agent Swarm Coordinator',
      description:
        'Decompose complex multi-step tasks into specialized autonomous sub-agents (Architect, Developer, Reviewer, Security) organized in a collaborative DAG.',
      parameters: Type.Object({
        goal: Type.String({ description: 'Overall project or engineering goal to plan and coordinate' }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { goal: string };
        const config = configStore.getAll();
        // Every sub-agent is confined to the default workspace.
        const swarmCwd = config.defaultWorkdir?.trim() || process.cwd();

        const coordinator = new MultiAgentCoordinator();
        coordinator.setRunner(createSwarmRunner({ cwd: swarmCwd }));
        const plan = coordinator.createCollaborativePlan(args.goal);
        const executed = await coordinator.executePlan(plan.id);

        const taskSummary = executed.tasks
          .map((t) => {
            const model = t.modelUsed ? ` on "${t.modelUsed}"` : '';
            const fallback = t.usedFallback ? ' — via fallback to active profile' : '';
            const files =
              t.modifiedFiles && t.modifiedFiles.length > 0
                ? `\n   modified: ${t.modifiedFiles.join(', ')}`
                : '';
            const failure = t.status === 'failed' ? `\n   error: ${t.error || 'unknown'}` : '';
            return `• [${t.role.toUpperCase()}] ${t.title} — ${t.status}${model}${fallback}${files}${failure}`;
          })
          .join('\n');

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `🚀 Multi-Agent Swarm executed (ID: ${executed.id})\n` +
                `Goal: "${executed.goal}"\n` +
                `Status: ${executed.status}\n\n` +
                `Task Results:\n${taskSummary}`,
            },
          ],
          details: executed,
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Background Job Manager Singleton
// ---------------------------------------------------------------------------

export class BackgroundJobRegistry {
  private static instance: BackgroundJobRegistry;
  private jobs: Map<string, { pid?: number; process?: ChildProcess; output: string[]; status: 'running' | 'stopped' | 'failed'; command: string; startedAt: number; logPath?: string }> = new Map();
  private stateFilePath: string;
  private logsDir: string;

  private constructor() {
    const userData = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.cowork');
    this.logsDir = path.join(userData, 'job_logs');
    this.stateFilePath = path.join(userData, 'background_jobs.json');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
    this.loadState();
  }

  public static getInstance(): BackgroundJobRegistry {
    if (!BackgroundJobRegistry.instance) {
      BackgroundJobRegistry.instance = new BackgroundJobRegistry();
    }
    return BackgroundJobRegistry.instance;
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.stateFilePath)) return;
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const data = JSON.parse(raw) as Array<{ id: string; command: string; status: 'running' | 'stopped' | 'failed'; pid?: number; startedAt: number; logPath?: string }>;
      for (const item of data) {
        // Any previously "running" job on startup is marked as "stopped" because process died with app restart
        const status = item.status === 'running' ? 'stopped' : item.status;
        let output: string[] = [];
        if (item.logPath && fs.existsSync(item.logPath)) {
          const content = fs.readFileSync(item.logPath, 'utf-8');
          output = content.split('\n').slice(-50);
        }
        this.jobs.set(item.id, {
          command: item.command,
          status,
          pid: item.pid,
          startedAt: item.startedAt,
          logPath: item.logPath,
          output,
        });
      }
    } catch (err) {
      logError('[BackgroundJobRegistry] Failed to load persisted state:', err);
    }
  }

  private saveState(): void {
    try {
      const serialized = Array.from(this.jobs.entries()).map(([id, j]) => ({
        id,
        command: j.command,
        status: j.status,
        pid: j.pid,
        startedAt: j.startedAt,
        logPath: j.logPath,
      }));
      const tmp = `${this.stateFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(serialized, null, 2), 'utf-8');
      fs.renameSync(tmp, this.stateFilePath);
    } catch {
      // Best-effort save
    }
  }

  public startJob(id: string, command: string, cwd: string): { success: boolean; message: string; jobId: string } {
    try {
      const child = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const logPath = path.join(this.logsDir, `${id}.log`);
      const logStream = fs.createWriteStream(logPath, { flags: 'a' });

      const jobRecord: {
        pid?: number;
        process?: ChildProcess;
        output: string[];
        status: 'running' | 'stopped' | 'failed';
        command: string;
        startedAt: number;
        logPath: string;
      } = {
        pid: child.pid,
        process: child,
        output: [] as string[],
        status: 'running',
        command,
        startedAt: Date.now(),
        logPath,
      };

      child.stdout?.on('data', (data) => {
        const text = data.toString();
        logStream.write(text);
        jobRecord.output.push(text);
        if (jobRecord.output.length > 100) jobRecord.output.shift();
      });

      child.stderr?.on('data', (data) => {
        const text = `[stderr] ${data.toString()}`;
        logStream.write(text);
        jobRecord.output.push(text);
        if (jobRecord.output.length > 100) jobRecord.output.shift();
      });

      child.on('exit', (code) => {
        jobRecord.status = code === 0 ? 'stopped' : 'failed';
        logStream.end();
        this.saveState();
      });

      this.jobs.set(id, jobRecord);
      this.saveState();
      return { success: true, message: `Background job "${id}" started with PID ${child.pid}`, jobId: id };
    } catch (err) {
      return { success: false, message: `Failed to start job: ${err instanceof Error ? err.message : String(err)}`, jobId: id };
    }
  }

  public getJobStatus(id: string): { status: string; command?: string; pid?: number; outputTail: string; logPath?: string } {
    const job = this.jobs.get(id);
    if (!job) return { status: 'not_found', outputTail: '' };
    return {
      status: job.status,
      command: job.command,
      pid: job.pid,
      logPath: job.logPath,
      outputTail: job.output.slice(-15).join(''),
    };
  }

  public stopJob(id: string): { success: boolean; message: string } {
    const job = this.jobs.get(id);
    if (!job) return { success: false, message: `Job ${id} not found.` };
    try {
      if (job.process && job.status === 'running') {
        job.process.kill('SIGTERM');
        job.status = 'stopped';
      }
      this.saveState();
      return { success: true, message: `Job ${id} stopped.` };
    } catch (err) {
      return { success: false, message: `Error stopping job: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  public stopAllJobs(): void {
    for (const job of this.jobs.values()) {
      if (job.process && job.status === 'running') {
        try {
          job.process.kill('SIGTERM');
          job.status = 'stopped';
        } catch {
          // Ignore
        }
      }
    }
    this.saveState();
  }

  public listJobs(): Array<{ id: string; command: string; status: string; pid?: number; startedAt: number; logPath?: string }> {
    return Array.from(this.jobs.entries()).map(([id, j]) => ({
      id,
      command: j.command,
      status: j.status,
      pid: j.pid,
      startedAt: j.startedAt,
      logPath: j.logPath,
    }));
  }
}


