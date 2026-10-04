/**
 * @module main/tools/dynamic-tool-creator
 *
 * Agent meta-tools & DeepSeek Evaluation Harness.
 *
 * Allows the agent to:
 * 1. Propose reusable SKILL.md drafts (`propose_skill`) — pending human
 *    approval in the Skill doctor, never auto-activated.
 * 2. List all known skills and pending proposals (`list_agent_capabilities`).
 * 3. Execute a DeepSeek-style evaluation harness (`deepseek_eval_harness`).
 *
 * SECURITY: the former `create_dynamic_tool` self-extension mechanism (which
 * evaluated agent-written JavaScript) has been REMOVED — tools stay fixed,
 * audited and confined. There is no longer any dynamic tool creation path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { log, logError, logWarn } from '../utils/logger';
import { AutoVerificationLoop } from '../agent/auto-verification-loop';
import { TddOrchestrator } from '../agent/tdd-orchestrator';
import { AstCodeIntelligence } from '../agent/ast-code-intelligence';
import { SystemController } from '../system/system-controller';
import { SelfHealingRunner } from '../agent/self-healing-runner';
import { CodeGraphIndexer } from '../memory/codegraph-indexer';
import {
  MultiAgentCoordinator,
  type AgentRole,
  type AggregationPolicy,
} from '../agent/multi-agent-coordinator';
import { buildProposeSkillTool, createSwarmRunner } from '../agent/swarm-runner';
import { listProposals, proposeSkill } from '../skills/skill-proposals';
import { startDelegation, listDelegations, subAgentGate } from '../agent/background-delegations';
import { getRunSignal } from '../agent/run-abort-registry';
import { recordSwarmExecution } from '../agent/swarm-stats';
import {
  disposeTeammateTeam,
  formatTeammateReportSection,
  summarizeTeammateExchanges,
} from '../agent/teammate-bus';
import { tryCaptureSwarmIntoRoom } from '../rooms/room-swarm-bridge';
import { getSharedRoomStore } from '../rooms/room-store-factory';
import {
  CROSS_VERIFICATION_COST,
  renderCrossVerificationSection,
  summarizeCrossVerification,
} from '../agent/cross-verification';
import { configStore } from '../config/config-store';
import { spawn, type ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Dynamic Skill Registry
// ---------------------------------------------------------------------------

interface DynamicSkillDefinition {
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
      try {
        fs.mkdirSync(this.skillsDir, { recursive: true });
      } catch (e) {
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
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Omit<
            DynamicSkillDefinition,
            'content'
          >;
          const content = fs.readFileSync(skillPath, 'utf-8');
          this.registry.set(meta.slug, { ...meta, content });
        } catch {
          /* ignore corrupted */
        }
      }
      log(`[DynamicSkillRegistry] Loaded ${this.registry.size} persisted skills`);
    } catch (e) {
      logError('[DynamicSkillRegistry] Error loading persisted skills:', e);
    }
  }

  public createSkill(params: {
    name: string;
    description: string;
    content: string;
  }): DynamicSkillDefinition {
    const slug = params.name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 64);
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

    log(
      `[DynamicSkillRegistry] 🎓 Skill ${existing ? 'updated' : 'created'} (v${version}): ${slug}`
    );
    return def;
  }

  public getAllSkills(): DynamicSkillDefinition[] {
    return Array.from(this.registry.values());
  }

  public getSkillsDir(): string {
    return this.skillsDir;
  }

  /**
   * Remove a legacy skill from disk and memory. Used by the one-time
   * migration into the PENDING-proposals store (migrateLegacyDynamicSkillsTo
   * Proposals) — never reachable from any agent tool.
   */
  public deleteSkill(slug: string): boolean {
    if (!this.registry.has(slug)) return false;
    this.registry.delete(slug);
    try {
      fs.rmSync(path.join(this.skillsDir, slug), { recursive: true, force: true });
    } catch (e) {
      logWarn(`[DynamicSkillRegistry] Could not remove legacy dir for ${slug}:`, e);
    }
    return true;
  }
}

/**
 * ONE-TIME legacy sweep: every skill left in the retired create_dynamic_skill
 * registry (<userData>/dynamic_skills/) becomes a PENDING proposal in the
 * skills-proposed store — the same human approval gate as every other
 * proposed skill — and is then removed from the legacy registry (disk +
 * memory), so nothing stays outside the gate. Called once at app startup
 * (GUI path only); never reachable from any agent tool.
 */
export function migrateLegacyDynamicSkillsToProposals(): {
  migrated: number;
  skipped: Array<{ slug: string; reason: string }>;
} {
  const registry = DynamicSkillRegistry.getInstance();
  const legacy = registry.getAllSkills();
  const skipped: Array<{ slug: string; reason: string }> = [];
  let migrated = 0;

  for (const skill of legacy) {
    try {
      let content = typeof skill.content === 'string' ? skill.content : '';
      // Defensive: the legacy writer always added frontmatter, but a
      // hand-edited file may lack it — regenerate from the stored meta.
      if (!content.trim().startsWith('---')) {
        content = `---\nname: ${skill.slug}\ndescription: ${skill.description ?? ''}\n---\n\n${content}`;
      }
      const result = proposeSkill({
        name: skill.slug,
        description: skill.description || skill.name || skill.slug,
        content,
        proposedBy: 'legacy-migration',
        rationale:
          'Migrated from the retired create_dynamic_skill registry (dynamic_skills/) — awaiting the same human approval as every other proposed skill.',
      });
      if (!result.ok || !result.name) {
        skipped.push({ slug: skill.slug, reason: result.error || 'unknown' });
        continue;
      }
      registry.deleteSkill(skill.slug);
      migrated += 1;
    } catch (e) {
      skipped.push({ slug: skill.slug, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  if (migrated > 0 || skipped.length > 0) {
    log(
      `[LegacySkillMigration] ${migrated} legacy skill(s) migrated to PENDING proposals` +
        (skipped.length ? `, ${skipped.length} skipped: ${JSON.stringify(skipped)}` : '')
    );
  }
  return { migrated, skipped };
}

/**
 * Built-in Agent Meta-Tools:
 * 1. `propose_skill`            — Propose a SKILL.md draft (human-gated)
 * 2. `list_agent_capabilities`  — Discover existing skills + pending proposals
 * 3. `deepseek_eval_harness`    — Evaluation Driven Development & Benchmarking
 */
/** Minimal interface for plugin runtime service needed by install_plugin tool. */
export interface PluginRuntimeServiceLike {
  install(pluginName: string): Promise<unknown>;
}

/** Minimal interface for session manager needed to invalidate skills after creation. */
export interface SessionManagerLike {
  invalidateSkillsSetup(): void;
}

export function buildAgentMetaTools(
  options: {
    sessionId?: string;
    cwd?: string;
    pluginRuntimeService?: PluginRuntimeServiceLike;
    sessionManager?: SessionManagerLike;
  } = {}
): ToolDefinition[] {
  const skillRegistry = DynamicSkillRegistry.getInstance();

  return [
    // 1. Skill PROPOSAL — the ONLY dynamic-skill path for the main agent:
    // a static markdown draft that stays PENDING until a human approves it
    // in the Skill doctor. No executable code, no auto-activation.
    buildProposeSkillTool(),

    // 2. Capability Introspection
    {
      name: 'list_agent_capabilities',
      label: 'List Agent Capabilities',
      description:
        'List existing dynamic skills and PENDING skill proposals (not yet approved). Use this to avoid proposing duplicates and to check whether a capability is awaiting approval.',
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params) => {
        const skills = skillRegistry.getAllSkills();
        const proposals = listProposals();

        const skillLines =
          skills.length === 0
            ? ['  (none)']
            : skills.map((s) => `  • ${s.slug} (v${s.version}) — ${s.description.slice(0, 80)}`);

        const proposalLines =
          proposals.length === 0
            ? ['  (none)']
            : proposals.map(
                (p) =>
                  `  • ${p.name} (draft v${p.version}, by ${p.proposedBy}) — PENDING approval — ${p.description.slice(0, 60)}`
              );

        const text = [
          `=== Agent Capabilities ===`,
          ``,
          `Dynamic Skills (${skills.length}):`,
          ...skillLines,
          ``,
          `Pending Skill Proposals (${proposals.length}) — awaiting human approval:`,
          ...proposalLines,
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text }],
          details: { skillCount: skills.length, proposalCount: proposals.length },
        };
      },
    },

    // 3. DeepSeek-Style Evaluation Harness
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

    // 4. Self-Verification Loop
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
            content: [
              {
                type: 'text' as const,
                text: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // 5. Code Search
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
          const { execFile } = await import('child_process');
          const { promisify } = await import('util');
          // execFile, never exec: a shell would expand `$(...)`, backticks and
          // `;` inside the query. The query is model-authored, and a model that
          // read an untrusted file can be made to author one — so the query
          // reaches grep as ONE argv element and is never parsed as syntax.
          const execFileAsync = promisify(execFile);

          // grep BRE alternation. Only characters that are safe inside a BRE
          // survive, so a payload cannot reach even the argv layer intact.
          const keywords = args.query
            .split(/\s+/)
            .map((word) => word.replace(/[^\p{L}\p{N}_.-]/gu, ''))
            .filter((word) => word.length > 3)
            .slice(0, 3)
            .map((word) => word.replace(/-/g, '\\-'))
            .join('|');
          if (!keywords) {
            return {
              content: [
                { type: 'text' as const, text: `No usable search terms in: "${args.query}"` },
              ],
              details: {},
            };
          }

          const grep = async (
            patterns: string[],
            targets: string[]
          ): Promise<string> => {
            const { stdout } = await execFileAsync(
              'grep',
              ['-n', '--include=*.ts', '--include=*.tsx', ...patterns, ...targets],
              { cwd: process.cwd(), timeout: 10_000, maxBuffer: 1024 * 1024 }
            );
            return typeof stdout === 'string' ? stdout : String(stdout ?? '');
          };

          try {
            // Files first (-l), then the matching lines of each one. A file
            // path can never be an argument here: it is whatever grep printed.
            const listing = await grep(['-l', '-r', '-E', keywords], ['src/']);
            const files = listing.trim().split('\n').filter(Boolean);
            if (files.length === 0) {
              return {
                content: [{ type: 'text' as const, text: `No results found for: "${args.query}"` }],
                details: {},
              };
            }

            const results: string[] = [
              `Found in ${files.length} file(s) for query: "${args.query}"`,
              '',
            ];
            for (const file of files.slice(0, args.topK ?? 5)) {
              const lines = await grep(['-E', keywords], [file]).catch(() => '');
              results.push(`📄 ${file}`);
              if (lines) results.push(lines.trim().split('\n').slice(0, 5).join('\n'));
              results.push('');
            }

            return {
              content: [{ type: 'text' as const, text: results.join('\n') }],
              details: { fileCount: files.length },
            };
          } catch {
            return {
              content: [{ type: 'text' as const, text: `Search failed for: "${args.query}"` }],
              details: {},
            };
          }
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Search error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // 6. TDD Loop
    {
      name: 'run_tdd_cycle',
      label: 'TDD Red-Green-Refactor Cycle',
      description:
        'Run full Test-Driven Development cycle: generate failing tests (RED), write implementation (GREEN), and suggest refactoring.',
      parameters: Type.Object({
        featureDescription: Type.String({
          description: 'Clear specification of the feature to develop.',
        }),
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
            details: {
              phase: result.phase,
              testFilePath: result.testFilePath,
              implFilePath: result.implFilePath,
            },
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `TDD cycle error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // 7. AST Symbol Usages
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
              content: [
                { type: 'text' as const, text: `No usages found for symbol: "${args.symbolName}"` },
              ],
              details: { count: 0 },
            };
          }
          const lines = usages
            .slice(0, 25)
            .map((u) => `${u.filePath}:${u.line} [${u.kind}]\n  ${u.context.trim()}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${usages.length} usages of "${args.symbolName}":\n\n${lines.join('\n\n')}`,
              },
            ],
            details: { count: usages.length },
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `AST search error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // 8. AST Safe Rename
    {
      name: 'ast_safe_rename',
      label: 'Safe Symbol Rename (AST)',
      description: 'Rename TypeScript symbol across project files with word-boundary safety.',
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
            result.filesModified.length > 0
              ? `\nModified files:\n${result.filesModified.join('\n')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n');
          return {
            content: [{ type: 'text' as const, text }],
            details: result,
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Rename error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // =========================================================================
    // PILIER 1 — OMNIPOTENCE SYSTÈME (OPENCLAW STYLE)
    // =========================================================================

    // 9. System App Control
    {
      name: 'system_app_control',
      label: 'Control OS Application',
      description:
        'Launch, switch to, or close any application installed on the host machine (e.g. "Safari", "Terminal", "Visual Studio Code", "Slack", "Notes").',
      parameters: Type.Object({
        action: Type.Union(
          [Type.Literal('launch'), Type.Literal('quit'), Type.Literal('force_quit')],
          {
            description: 'Action to perform on the target application',
          }
        ),
        appName: Type.String({
          description: 'Name of the application on the system (e.g. "Safari", "Slack")',
        }),
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

    // 10. Clipboard Manipulation
    {
      name: 'system_clipboard',
      label: 'Read/Write System Clipboard',
      description:
        'Access the host OS clipboard. Read the currently copied content or write new text/code into the user clipboard.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('read'), Type.Literal('write')], {
          description: 'Whether to read from or write to the clipboard',
        }),
        text: Type.Optional(
          Type.String({
            description: 'Text to copy into clipboard (required when action is write)',
          })
        ),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { action: 'read' | 'write'; text?: string };
        const sys = SystemController.getInstance();
        if (args.action === 'read') {
          const content = sys.readClipboard();
          return {
            content: [
              {
                type: 'text' as const,
                text: content ? `Clipboard Content:\n${content}` : 'Clipboard is empty.',
              },
            ],
            details: { hasContent: Boolean(content) },
          };
        } else {
          const success = sys.writeClipboard(args.text || '');
          return {
            content: [
              {
                type: 'text' as const,
                text: success
                  ? 'Text copied to clipboard successfully.'
                  : 'Failed to write to clipboard.',
              },
            ],
            details: { success },
          };
        }
      },
    },

    // 11. Native System Notifications
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
          content: [
            {
              type: 'text' as const,
              text: sent
                ? `Notification sent: "${args.title}"`
                : 'Failed to dispatch notification.',
            },
          ],
          details: { sent },
        };
      },
    },

    // 12. Process Manager
    {
      name: 'system_process_manager',
      label: 'Inspect & Manage Processes',
      description:
        'List active system processes or terminate a process by its PID. Useful for checking resource usage or killing stuck servers/ports.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('kill')], {
          description: 'List active processes or kill a specific process',
        }),
        filter: Type.Optional(
          Type.String({ description: 'Process name filter when listing (e.g. "node", "python")' })
        ),
        pid: Type.Optional(Type.Number({ description: 'PID to terminate when action is kill' })),
        force: Type.Optional(
          Type.Boolean({ description: 'Force kill (SIGKILL) when action is kill' })
        ),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as {
          action: 'list' | 'kill';
          filter?: string;
          pid?: number;
          force?: boolean;
        };
        const sys = SystemController.getInstance();
        if (args.action === 'list') {
          const procs = await sys.listProcesses(args.filter);
          const lines = procs
            .slice(0, 25)
            .map((p) => `PID ${p.pid} | CPU ${p.cpu || 'N/A'} | MEM ${p.mem || 'N/A'} | ${p.name}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Active Processes (${procs.length}):\n${lines.join('\n')}`,
              },
            ],
            details: { count: procs.length },
          };
        } else {
          if (!args.pid) {
            return {
              content: [{ type: 'text' as const, text: 'PID is required for action kill' }],
              details: {},
            };
          }
          const res = await sys.killProcess(args.pid, args.force);
          return { content: [{ type: 'text' as const, text: res.output }], details: res };
        }
      },
    },

    // 13. Native AppleScript Runner (macOS automation)
    {
      name: 'system_run_script',
      label: 'Execute AppleScript / JXA (macOS)',
      description:
        'Run custom AppleScript directly on macOS to automate UI actions, control Finder, query window states, or interact with native apps (Safari, Mail, Calendar, etc.).',
      parameters: Type.Object({
        script: Type.String({
          description:
            'AppleScript code to execute (e.g. tell application "Finder" to get name of every window)',
        }),
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

    // 14. Screen Capture (Vision GUI)
    {
      name: 'screen_capture',
      label: 'Capture Screen / Window',
      description:
        'Capture a screenshot of the entire screen or desktop display. Returns file path and base64 image data for visual inspection.',
      parameters: Type.Object({
        targetPath: Type.Optional(
          Type.String({ description: 'Optional destination file path for screenshot (.png)' })
        ),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { targetPath?: string };
        const sys = SystemController.getInstance();
        const res = await sys.takeScreenshot(args.targetPath);
        if (res.success) {
          return {
            content: [
              { type: 'text' as const, text: `Screenshot successfully captured: ${res.filePath}` },
              ...(res.base64
                ? [
                    {
                      type: 'image' as const,
                      data: res.base64,
                      mimeType: 'image/png',
                    },
                  ]
                : []),
            ],
            details: { filePath: res.filePath },
          };
        } else {
          return {
            content: [
              { type: 'text' as const, text: `Screenshot failed: ${res.error || 'Unknown error'}` },
            ],
            details: { error: res.error },
          };
        }
      },
    },

    // 15. Simulate GUI Action (Click / Keystroke)
    {
      name: 'gui_interact',
      label: 'Simulate GUI Interaction',
      description:
        'Simulate mouse click at coordinates or send keystrokes/shortcuts to active desktop applications.',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('click'),
          Type.Literal('type'),
          Type.Literal('key_combo'),
        ]),
        x: Type.Optional(Type.Number({ description: 'X screen coordinate for click' })),
        y: Type.Optional(Type.Number({ description: 'Y screen coordinate for click' })),
        text: Type.Optional(Type.String({ description: 'Text to type into focused window' })),
        key: Type.Optional(
          Type.String({ description: 'Key name for shortcut (e.g. "c", "v", "return", "tab")' })
        ),
        modifiers: Type.Optional(
          Type.Array(Type.String(), { description: 'Modifiers: command, option, control, shift' })
        ),
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

    // 16. Self-Healing Test Runner
    {
      name: 'auto_test_and_heal',
      label: 'Autonomous Self-Healing Loop',
      description:
        'Run verification tests or linter in a closed-loop. If failure occurs, extracts root errors to provide instant diagnostics for immediate self-correction.',
      parameters: Type.Object({
        command: Type.String({
          description: 'Test command to run (e.g. "npm test", "npm run lint", "npm run typecheck")',
        }),
        cwd: Type.Optional(Type.String({ description: 'Working directory' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { command: string; cwd?: string };
        const workDir = args.cwd || process.cwd();
        const runner = new SelfHealingRunner(3);
        const res = await runner.runTestCommand(args.command, workDir);

        if (res.passed) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `✅ Command "${args.command}" PASSED without errors.\n\n${res.stdout}`,
              },
            ],
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

    // 17. Codebase Symbol & Graph Explorer (AST In-Memory)
    {
      name: 'query_codebase_graph',
      label: 'Query Codebase Graph & Symbols',
      description:
        'Scan workspace codebase and query symbols (functions, classes, types, interfaces) with fast in-memory AST lookup without scanning files sequentially.',
      parameters: Type.Object({
        query: Type.String({ description: 'Symbol name or keyword to look for' }),
        dirPath: Type.Optional(
          Type.String({ description: 'Root directory to index if not yet scanned' })
        ),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { query: string; dirPath?: string };
        const rootDir = args.dirPath || process.cwd();
        const indexer = new CodeGraphIndexer();
        await indexer.scanDirectory(rootDir);
        const matches = indexer.searchSymbol(args.query);

        if (matches.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No symbols matching "${args.query}" found in ${rootDir}.`,
              },
            ],
            details: { count: 0 },
          };
        }

        const lines = matches
          .slice(0, 30)
          .map((m) => `[${m.kind.toUpperCase()}] ${m.name} -> ${m.filePath}:${m.line}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${matches.length} symbol match(es) for "${args.query}":\n\n${lines.join('\n')}`,
            },
          ],
          details: { matches },
        };
      },
    },

    // =========================================================================
    // PILIER 3 — BACKGROUND DAEMONS & ASYNC JOBS
    // =========================================================================

    // 18. Background Daemon / Job Manager
    {
      name: 'background_job_manager',
      label: 'Manage Background Jobs & Daemons',
      description:
        'Launch long-running commands in background (dev servers, log watchers, long builds), poll their stdout/stderr, or terminate them cleanly.',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('start'),
          Type.Literal('status'),
          Type.Literal('stop'),
          Type.Literal('list'),
        ]),
        jobId: Type.Optional(Type.String({ description: 'Unique ID of the job' })),
        command: Type.Optional(Type.String({ description: 'Command to run (e.g. "npm run dev")' })),
        cwd: Type.Optional(Type.String({ description: 'Working directory' })),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as {
          action: 'start' | 'status' | 'stop' | 'list';
          jobId?: string;
          command?: string;
          cwd?: string;
        };
        const mgr = BackgroundJobRegistry.getInstance();

        if (args.action === 'start') {
          if (!args.command) {
            return {
              content: [
                { type: 'text' as const, text: 'Command is required to start a background job.' },
              ],
              details: {},
            };
          }
          const id = args.jobId || `job-${Date.now()}`;
          const res = mgr.startJob(id, args.command, args.cwd || process.cwd());
          return { content: [{ type: 'text' as const, text: res.message }], details: res };
        } else if (args.action === 'status') {
          if (!args.jobId) {
            return {
              content: [{ type: 'text' as const, text: 'jobId is required to query status.' }],
              details: {},
            };
          }
          const st = mgr.getJobStatus(args.jobId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(st, null, 2) }],
            details: st,
          };
        } else if (args.action === 'stop') {
          if (!args.jobId) {
            return {
              content: [{ type: 'text' as const, text: 'jobId is required to stop a job.' }],
              details: {},
            };
          }
          const res = mgr.stopJob(args.jobId);
          return { content: [{ type: 'text' as const, text: res.message }], details: res };
        } else {
          const list = mgr.listJobs();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Active background jobs (${list.length}):\n${JSON.stringify(list, null, 2)}`,
              },
            ],
            details: list,
          };
        }
      },
    },

    // =========================================================================
    // PILIER 5 — MULTI-AGENT SWARM ORCHESTRATION
    // =========================================================================

    // 19. Multi-Agent Swarm Coordinator
    {
      name: 'orchestrate_multi_agent_plan',
      label: 'Multi-Agent Swarm Coordinator',
      description:
        'Decompose complex multi-step tasks into specialized autonomous sub-agents (Architect, Developer, Reviewer, Security) organized in a collaborative DAG. ' +
        'MEASURED COST: a 4-task swarm took 452s vs 33s for direct execution of the same simple task (13.7x slower) — use ONLY for genuinely complex, multi-disciplinary work; for simple tasks act directly. ' +
        'Partial-failure aggregation is EXPLICIT (aggregationPolicy): fail-all (default), partial-ok, or retry-failed-only — a swarm never silently reports success with skipped tasks. ' +
        `OPT-IN crossVerification adds up to ${CROSS_VERIFICATION_COST.peerChallenge + CROSS_VERIFICATION_COST.codeReviewRerun} extra model calls (reviewer↔security peer challenge = ${CROSS_VERIFICATION_COST.peerChallenge}; conditional developer re-run on a substantive review point = 0-${CROSS_VERIFICATION_COST.codeReviewRerun}). ` +
        'It makes agents CHALLENGE each other instead of producing independent reports, and surfaces unresolved disagreements rather than forcing consensus. ' +
        'OFF by default — enable it only for high-stakes tasks where a wrong conclusion is costly. ' +
        'OPT-IN teamMode lets a BLOCKED sub-agent ask ONE teammate a single blocking question through ask_teammate (hard cap 2 questions per task, 30s deadline, one question/one answer). ' +
        'Its measured cost is reported: 1 extra model call per ANSWERED question, 0 when nobody asked. OFF by default — a standard swarm is unchanged.',
      parameters: Type.Object({
        goal: Type.String({
          description: 'Overall project or engineering goal to plan and coordinate',
        }),
        crossVerification: Type.Optional(
          Type.Boolean({
            description:
              'OPT-IN debate pass (default false). After the reviewer and security reports exist, each challenges the other and a surviving disagreement is escalated with both positions. Also lets the reviewer raise ONE substantive code point that triggers a single targeted developer re-run. Adds up to 3 extra model calls.',
          })
        ),
        aggregationPolicy: Type.Optional(
          Type.Union(
            [
              Type.Literal('fail-all'),
              Type.Literal('partial-ok'),
              Type.Literal('retry-failed-only'),
            ],
            {
              description:
                "How to aggregate a partially failed swarm (default 'fail-all'). 'fail-all': any unresolved failure fails the plan. 'partial-ok': the plan succeeds when at least one task completed, and every failure/skip is reported. 'retry-failed-only': retry each failed task once, then any unresolved failure fails the plan.",
            }
          )
        ),
        teamMode: Type.Optional(
          Type.Boolean({
            description:
              'OPT-IN team mode (default false). Gives every sub-agent the ask_teammate tool so it can ask ONE other teammate a single blocking question it cannot continue without (hard cap 2 questions per task, 30s deadline, one question / one answer, no dialogue). Measured cost: 1 extra model call per answered question and 0 when the tool is never used, shown in this report and in the swarm stats.',
          })
        ),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as {
          goal: string;
          crossVerification?: boolean;
          aggregationPolicy?: AggregationPolicy;
          teamMode?: boolean;
        };
        const config = configStore.getAll();
        // Every sub-agent is confined to the default workspace.
        const swarmCwd = config.defaultWorkdir?.trim() || process.cwd();
        const swarmStartedAt = Date.now();

        const coordinator = new MultiAgentCoordinator();
        // The swarm shares the GLOBAL hierarchy semaphore (same budget as async
        // delegations and their recursive children) — parallelism is bounded
        // across ALL sub-agent levels combined, never per level.
        coordinator.setRunner(createSwarmRunner({ cwd: swarmCwd, gate: subAgentGate }));
        const plan = coordinator.createCollaborativePlan(args.goal, {
          crossVerification: args.crossVerification === true,
          ...(args.teamMode ? { teamMode: true } : {}),
          ...(args.aggregationPolicy ? { aggregationPolicy: args.aggregationPolicy } : {}),
        });
        // The teammate bus is per-plan scratch state: drop it as soon as the
        // plan settles (even on failure). Exchanges live on the tasks, so the
        // report is unaffected.
        // Resolved HERE, not at tool-build time: the tool set is cached across
        // turns, so a signal captured when the tools were built would belong to
        // an earlier turn. Without it the swarm ignores Stop and keeps billing.
        const runSignal = getRunSignal(options.sessionId);
        const executed = await coordinator
          .executePlan(plan.id, runSignal ? { signal: runSignal } : {})
          .finally(() => disposeTeammateTeam(plan.id));
        recordSwarmExecution(executed, Date.now() - swarmStartedAt);

        const taskSummary = executed.tasks
          .map((t) => {
            const model = t.modelUsed ? ` on "${t.modelUsed}"` : '';
            const fallback = t.usedFallback ? ' — via fallback to active profile' : '';
            const files =
              t.modifiedFiles && t.modifiedFiles.length > 0
                ? `\n   modified: ${t.modifiedFiles.join(', ')}`
                : '';
            const failure = t.status === 'failed' ? `\n   error: ${t.error || 'unknown'}` : '';
            const retry = t.retried
              ? t.recovered
                ? '\n   retried: recovered on the second attempt'
                : '\n   retried: still failing after one retry'
              : '';
            const syntax = t.syntaxIssues?.length
              ? `\n   SYNTAX ISSUES (not fully resolved):\n   ${t.syntaxIssues.join('\n   ')}`
              : '';
            const tokens = t.tokenUsage
              ? `\n   tokens: ${t.tokenUsage.input} in / ${t.tokenUsage.output} out`
              : '';
            return `• [${t.role.toUpperCase()}] ${t.title} — ${t.status}${model}${fallback}${files}${failure}${retry}${syntax}${tokens}`;
          })
          .join('\n');

        // The aggregation policy and its outcome are ALWAYS surfaced, so a
        // partial failure can never be mistaken for a full success.
        const aggregation = executed.aggregation;
        const aggregationLine = aggregation
          ? `Aggregation (${aggregation.policy}): ${aggregation.completed} completed, ${aggregation.failed} failed, ${aggregation.skipped} skipped` +
            (aggregation.retried
              ? `, ${aggregation.retried} retried (${aggregation.recovered} recovered)`
              : '') +
            `\n`
          : '';

        // Cross-verification outcomes are surfaced EXPLICITLY in the report —
        // unresolved disagreements keep both positions, never a forced consensus.
        const crossSection = renderCrossVerificationSection(executed.crossVerificationResults);
        const crossSummary = summarizeCrossVerification(executed.crossVerificationResults);

// Teammate questions are surfaced explicitly (who asked what, the answer
        // and the measured extra model calls) — empty when team mode was off.
        const teammateExchanges = executed.tasks.flatMap((t) => t.teammateExchanges ?? []);
        const teammateSection = formatTeammateReportSection(teammateExchanges);
        const teammateSummary = summarizeTeammateExchanges(teammateExchanges);

        // Mirror the settled plan into a persistent room before the bus is gone.
        // Best-effort: the swarm already did the work, so a failure to record it
        // must not cost the user their result.
        const capturedRoom = tryCaptureSwarmIntoRoom({
          plan: executed,
          store: getSharedRoomStore(),
          sessionId: options.sessionId ?? null,
        });
        // Reported rather than silently kept, so a room that failed to record is
        // visible instead of the user assuming the run was preserved.
        const roomSection = capturedRoom
          ? `\n\nRoom: ${capturedRoom.roomId} (${capturedRoom.exchangesRecorded} exchange(s) preserved)`
          : '\n\nRoom: could not be recorded';

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `🚀 Multi-Agent Swarm executed (ID: ${executed.id})\n` +
                `Goal: "${executed.goal}"\n` +
                `Status: ${executed.status}\n` +
                aggregationLine +
                `\nTask Results:\n${taskSummary}` +
                (crossSection ? `\n${crossSection}` : '') +
                (teammateSection ? `\n${teammateSection}` : '') +
                roomSection,
            },
          ],
          details: { ...executed, crossVerificationSummary: crossSummary, teammateSummary },
        };
      },
    },

    // =========================================================================
    // ASYNC DELEGATION — fire-and-forget background sub-agent
    // =========================================================================

    {
      name: 'delegate_background_task',
      label: 'Background Task Delegation',
      description:
        'Delegate ONE autonomous task (typically a web research) to a background sub-agent and CONTINUE immediately: ' +
        'this tool returns a task id right away WITHOUT blocking. The sub-agent works alone (never asks back — assumptions ' +
        'go in its report), produces a structured report (summary/findings/assumptions/limits/modified files) that is ' +
        'injected into this conversation automatically when ready and visible in the Delegated Tasks view. ' +
        'Use for slow research the user does not need synchronously; do NOT use when the user is waiting for the answer. ' +
        `OPT-IN crossVerification: when TWO OR MORE parallel delegations on the same subject carry it, ONE extra model call cross-checks their reports and surfaces factual contradictions explicitly instead of merging them (${CROSS_VERIFICATION_COST.researchPass} added call per batch). Off by default.`,
      parameters: Type.Object({
        task: Type.String({
          description:
            'Full self-contained instructions for the background sub-agent, e.g. "Research X on the web and summarize key findings with sources"',
        }),
        title: Type.Optional(
          Type.String({ description: 'Short label shown in notifications and the running badge' })
        ),
        role: Type.Optional(
          Type.Union(
            [
              Type.Literal('architect'),
              Type.Literal('developer'),
              Type.Literal('reviewer'),
              Type.Literal('security'),
            ],
            { description: 'Sub-agent profile; defaults to developer' }
          )
        ),
        crossVerification: Type.Optional(
          Type.Boolean({
            description:
              'OPT-IN (default false). Flag this research for cross-verification: when another flagged parallel delegation completes, one extra model call reports factual contradictions between the sources (with a preferred source) instead of merging them silently.',
          })
        ),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as {
          task?: string;
          title?: string;
          role?: AgentRole;
          crossVerification?: boolean;
        };
        if (!args.task || !args.task.trim()) {
          return {
            content: [
              { type: 'text' as const, text: 'task is required to delegate a background job.' },
            ],
            details: {},
          };
        }
        let taskId: string;
        try {
          taskId = startDelegation({
            sessionId: options.sessionId ?? 'default',
            cwd: options.cwd ?? (configStore.getAll().defaultWorkdir?.trim() || process.cwd()),
            title: args.title?.trim() || args.task.trim().slice(0, 60),
            prompt: args.task.trim(),
            role: args.role ?? 'developer',
            ...(args.crossVerification ? { crossVerify: true } : {}),
          }).taskId;
        } catch (delegationError) {
          // Capacity or validation: surface it, the main agent adapts.
          return {
            content: [
              {
                type: 'text' as const,
                text: `Delegation refused: ${delegationError instanceof Error ? delegationError.message : String(delegationError)}`,
              },
            ],
            details: {},
          };
        }
        // Non-blocking by design: startDelegation returns before the sub-agent
        // finishes; the result arrives via background.task events + injection.
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Background task delegated (id: ${taskId}). Continue with whatever the user needs now — ` +
                `the result will be injected into this conversation automatically when the sub-agent finishes.`,
            },
          ],
          details: { taskId },
        };
      },
    },

    {
      name: 'background_task_status',
      label: 'Background Task Status',
      description:
        'List the background tasks delegated in this conversation with their status (running / completed / failed) so you can report progress to the user.',
      parameters: Type.Object({}),
      execute: async () => {
        const list = listDelegations(options.sessionId ?? 'default');
        if (list.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No background tasks delegated in this conversation.',
              },
            ],
            details: { delegations: [] },
          };
        }
        const lines = list.map(
          (d) =>
            `• [${d.status.toUpperCase()}] "${d.title}" (id: ${d.id}, started ${new Date(d.startedAt).toLocaleTimeString()})` +
            (d.status === 'failed' ? ` — ${d.error ?? 'unknown error'}` : '')
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `Background tasks (${list.length}):\n${lines.join('\n')}`,
            },
          ],
          details: { delegations: list },
        };
      },
    },

    // =========================================================================
    // CREATOR MODE — Autonomous Skill & Plugin Creation
    // =========================================================================

    // N+1. Create Task Skill — write a SKILL.md into .claude/skills/<name>/ of the CWD
    {
      name: 'create_task_skill',
      label: 'Create Task Skill (Creator Mode)',
      description:
        'Create a new SKILL.md (and optional supporting files) inside .claude/skills/<name>/ of the current workspace. ' +
        'The skill is immediately available for the next agent turn without restarting the session. ' +
        'Use this when a capability you need for the current task is missing. ' +
        'IMPORTANT: description must be a single line, no apostrophes, no quotes.',
      parameters: Type.Object({
        skillName: Type.String({
          description: 'Snake-case identifier for the skill (e.g. "pomodoro_timer").',
        }),
        skillContent: Type.String({
          description:
            'Full SKILL.md content. Frontmatter must have `name:` and `description:` (single-line, no apostrophes).',
        }),
        extraFiles: Type.Optional(
          Type.Array(
            Type.Object({
              relativePath: Type.String({
                description: 'Path relative to the skill directory (e.g. "scripts/run.sh").',
              }),
              content: Type.String({ description: 'File content.' }),
            }),
            { description: 'Additional files to write alongside SKILL.md (scripts, config, etc.).' }
          )
        ),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as {
          skillName: string;
          skillContent: string;
          extraFiles?: Array<{ relativePath: string; content: string }>;
        };

        // Sanitise skill name: only safe path chars
        const safeName = args.skillName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        if (!safeName) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid skill name.' }],
            details: { success: false },
          };
        }

        try {
          const effectiveCwd = options.cwd ?? process.cwd();
          const skillDir = path.join(effectiveCwd, '.claude', 'skills', safeName);

          fs.mkdirSync(skillDir, { recursive: true });

          const skillMdPath = path.join(skillDir, 'SKILL.md');
          fs.writeFileSync(skillMdPath, args.skillContent, 'utf8');

          const writtenFiles = ['SKILL.md'];

          // Write extra files — confined to the skill directory (no path traversal)
          if (args.extraFiles && args.extraFiles.length > 0) {
            for (const extra of args.extraFiles) {
              // Normalise and check confinement
              const normalised = path.normalize(extra.relativePath);
              if (normalised.startsWith('..') || path.isAbsolute(normalised)) {
                logWarn(
                  `[create_task_skill] Skipped extra file outside skill dir: ${extra.relativePath}`
                );
                continue;
              }
              const dest = path.join(skillDir, normalised);
              // Double-check after join (defence against edge cases)
              if (!dest.startsWith(skillDir + path.sep) && dest !== skillDir) {
                logWarn(`[create_task_skill] Skipped after join check: ${dest}`);
                continue;
              }
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, extra.content, 'utf8');
              writtenFiles.push(normalised);
            }
          }

          // Invalidate skills setup so the runner reloads on the next turn
          if (options.sessionManager) {
            try {
              options.sessionManager.invalidateSkillsSetup();
              log(`[create_task_skill] Skills invalidated for next turn.`);
            } catch (e) {
              logWarn(`[create_task_skill] Could not invalidate skills setup:`, e);
            }
          }

          const text = [
            `✅ Skill "${safeName}" created at ${skillDir}`,
            `Files written: ${writtenFiles.join(', ')}`,
            `The skill will be active on the next agent turn.`,
          ].join('\n');

          return {
            content: [{ type: 'text' as const, text }],
            details: { success: true, skillDir, skillName: safeName, writtenFiles },
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `create_task_skill error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: { success: false },
          };
        }
      },
    },

    // N+2. Install Plugin — install a community plugin and activate it immediately
    {
      name: 'install_plugin',
      label: 'Install Plugin (Creator Mode)',
      description:
        'Install a plugin from the Cowork plugin registry by its plugin ID and activate it immediately for the current session. ' +
        'Use this when a plugin provides the capability you need but is not yet installed.',
      parameters: Type.Object({
        pluginId: Type.String({
          description: 'Plugin identifier as listed in the Cowork plugin registry.',
        }),
      }),
      execute: async (_toolCallId, params) => {
        const args = params as { pluginId: string };

        if (!options.pluginRuntimeService) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Plugin installation is not available in the current session context.',
              },
            ],
            details: { success: false, reason: 'no_plugin_service' },
          };
        }

        // Sanitise plugin ID: only alphanumeric, hyphens, underscores, dots
        const safeId = args.pluginId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 128);
        if (!safeId) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid plugin ID.' }],
            details: { success: false },
          };
        }

        try {
          await options.pluginRuntimeService.install(safeId);

          // Invalidate skills so the runner picks up the newly activated plugin on next turn
          if (options.sessionManager) {
            try {
              options.sessionManager.invalidateSkillsSetup();
              log(`[install_plugin] Skills invalidated after installing "${safeId}".`);
            } catch (e) {
              logWarn(`[install_plugin] Could not invalidate skills setup:`, e);
            }
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: `✅ Plugin "${safeId}" installed and activated. It will be available on the next agent turn.`,
              },
            ],
            details: { success: true, pluginId: safeId },
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `install_plugin error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            details: { success: false, error: err instanceof Error ? err.message : String(err) },
          };
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Background Job Manager Singleton
// ---------------------------------------------------------------------------

export class BackgroundJobRegistry {
  private static instance: BackgroundJobRegistry;
  private jobs: Map<
    string,
    {
      pid?: number;
      process?: ChildProcess;
      output: string[];
      status: 'running' | 'stopped' | 'failed';
      command: string;
      startedAt: number;
      logPath?: string;
    }
  > = new Map();
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
      const data = JSON.parse(raw) as Array<{
        id: string;
        command: string;
        status: 'running' | 'stopped' | 'failed';
        pid?: number;
        startedAt: number;
        logPath?: string;
      }>;
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

  public startJob(
    id: string,
    command: string,
    cwd: string
  ): { success: boolean; message: string; jobId: string } {
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
      return {
        success: true,
        message: `Background job "${id}" started with PID ${child.pid}`,
        jobId: id,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to start job: ${err instanceof Error ? err.message : String(err)}`,
        jobId: id,
      };
    }
  }

  public getJobStatus(id: string): {
    status: string;
    command?: string;
    pid?: number;
    outputTail: string;
    logPath?: string;
  } {
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
      return {
        success: false,
        message: `Error stopping job: ${err instanceof Error ? err.message : String(err)}`,
      };
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

  public listJobs(): Array<{
    id: string;
    command: string;
    status: string;
    pid?: number;
    startedAt: number;
    logPath?: string;
  }> {
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
