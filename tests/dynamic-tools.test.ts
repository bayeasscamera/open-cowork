import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  DynamicSkillRegistry,
  buildAgentMetaTools,
} from '../src/main/tools/dynamic-tool-creator';
import { initSkillProposals, listProposals } from '../src/main/skills/skill-proposals';

describe('Agent meta-tools — no dynamic TOOL creation, proposal-gated skills', () => {
  let skillRegistry: DynamicSkillRegistry;
  let proposalsDir: string;

  beforeEach(() => {
    skillRegistry = DynamicSkillRegistry.getInstance();
    proposalsDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'meta-tools-proposals-')),
      'skills-proposed'
    );
    initSkillProposals(proposalsDir);
  });

  afterEach(() => {
    fs.rmSync(path.dirname(proposalsDir), { recursive: true, force: true });
  });

  it('ships the meta tools — and NO create_dynamic_tool / create_dynamic_skill', () => {
    const metaTools = buildAgentMetaTools();
    const names = metaTools.map((t) => t.name);

    // The executable-code pathway is GONE.
    expect(names).not.toContain('create_dynamic_tool');
    expect(names).not.toContain('create_dynamic_skill');
    // The main agent now proposes skills through the SAME human-gated tool
    // the sub-agents carry.
    expect(names).toContain('propose_skill');
    expect(names).toContain('list_agent_capabilities');
    expect(names).toContain('deepseek_eval_harness');
    expect(names).toContain('auto_verify_edits');
    expect(names).toContain('search_codebase');
    expect(names).toContain('run_tdd_cycle');
    expect(names).toContain('find_symbol_usages');
    expect(names).toContain('ast_safe_rename');
  });

  it('propose_skill creates a PENDING draft — nothing is auto-activated', async () => {
    const metaTools = buildAgentMetaTools();
    const propose = metaTools.find((t) => t.name === 'propose_skill')!;

    const result = await (propose as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }).execute('call_1', {
      name: 'sqlite-migration-pattern',
      description: 'Trigger when writing SQLite migrations',
      content: [
        '---',
        'name: sqlite-migration-pattern',
        'description: Trigger when writing SQLite migrations',
        '---',
        '',
        '# SQLite Migration Pattern',
        '',
        '1. Add CREATE TABLE IF NOT EXISTS',
      ].join('\n'),
    });

    expect(result.content[0].text).toContain('PENDING');
    expect(result.content[0].text).toContain('Skill doctor');

    // Pending in the proposals store — NOT in any active registry.
    const pending = listProposals();
    expect(pending.map((p) => p.name)).toContain('sqlite-migration-pattern');
    expect(
      skillRegistry.getAllSkills().map((s) => s.slug)
    ).not.toContain('sqlite-migration-pattern');
  });

  it('list_agent_capabilities shows skills and pending proposals (no dynamic tools)', async () => {
    const metaTools = buildAgentMetaTools();
    const listTool = metaTools.find((t) => t.name === 'list_agent_capabilities')!;

    const result = await (listTool as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        content: Array<{ text: string }>;
        details: { skillCount: number; proposalCount: number };
      }>;
    }).execute('call_list_1', {});
    expect(result.content[0].text).toContain('=== Agent Capabilities ===');
    expect(result.content[0].text).toContain('Dynamic Skills');
    expect(result.content[0].text).toContain('Pending Skill Proposals');
    expect(result.content[0].text).not.toContain('Dynamic Tools');
    expect(result.details).toHaveProperty('skillCount');
    expect(result.details).toHaveProperty('proposalCount');
  });

  it('runs deepseek_eval_harness and computes benchmark scoring', async () => {
    const metaTools = buildAgentMetaTools();
    const evalHarness = metaTools.find((t) => t.name === 'deepseek_eval_harness')!;

    const rawReport = await (evalHarness as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }).execute('call_3', {
      benchmarkName: 'Coding Accuracy Benchmark',
      testCases: [
        { id: 'case_1', prompt: 'Sort array', expectedOutputs: ['[1, 2, 3]'] },
        { id: 'case_2', prompt: 'Reverse string', expectedOutputs: ['olleh'] },
      ],
    });

    const report = JSON.parse(rawReport.content[0].text);
    expect(report.benchmark).toBe('Coding Accuracy Benchmark');
    expect(report.testCount).toBe(2);
    expect(report.passRate).toBe('100.0%');
    expect(report.results.length).toBe(2);
  });

  it('find_symbol_usages locates usages via AST', async () => {
    const metaTools = buildAgentMetaTools();
    const findTool = metaTools.find((t) => t.name === 'find_symbol_usages')!;

    const result = await (findTool as unknown as {
      execute: (id: string, params: unknown) => Promise<{
        content: Array<{ text: string }>;
        details: { count: number };
      }>;
    }).execute('call_ast_1', { symbolName: 'DynamicSkillRegistry' });

    expect(result.content[0].text).toContain('Found');
    expect(result.content[0].text).toContain('usages of "DynamicSkillRegistry"');
    expect(result.details.count).toBeGreaterThan(0);
  });

  it('SECURITY — no eval primitive and no dynamic-tool pathway remains in main', () => {
    const read = (p: string) => fs.readFileSync(p, 'utf-8');
    const creator = read('src/main/tools/dynamic-tool-creator.ts');
    expect(creator).not.toContain('new Function');
    // No TOOL DEFINITION and no agent-supplied executable code parameter.
    expect(creator).not.toContain("name: 'create_dynamic_tool'");
    expect(creator).not.toContain('implementationCode');
    expect(creator).not.toContain('getPiToolDefinitions');
    const runner = read('src/main/agent/agent-runner.ts');
    expect(runner).not.toContain('DynamicToolRegistry');
    expect(runner).not.toContain('getPiToolDefinitions');
  });
});
