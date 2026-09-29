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

  // Scans the whole repository AST, so allow more than the 5s default under load.
  it('find_symbol_usages locates usages via AST', { timeout: 30000 }, async () => {
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

/**
 * `search_codebase` used to run grep through `exec`, interpolating the query
 * into a shell command line. Its quote-stripping filter let `$(...)`,
 * backticks, `;`, `|` and `&&` straight through, and a query wrapped in double
 * quotes is still command substitution to a shell — so a model, or a file that
 * model had read, could execute anything in the main process with the Electron
 * app's privileges.
 */
describe('search_codebase — shell injection', () => {
  const marker = path.join(os.tmpdir(), `cowork-inject-${process.pid}-${Date.now()}`);

  const runSearch = (query: string) => {
    const tool = buildAgentMetaTools().find((t) => t.name === 'search_codebase')!;
    return (tool as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }).execute('call_search', { query });
  };

  afterEach(() => {
    fs.rmSync(marker, { force: true });
  });

  it.each([
    ['command substitution', (m: string) => `authx authy $(id>${m})`],
    ['backtick substitution', (m: string) => 'authx authy `id>' + m + '`'],
    ['command separator', (m: string) => `authx authy ; touch ${m}`],
    ['pipe', (m: string) => `authx authy | touch ${m}`],
    ['and-list', (m: string) => `authx authy && touch ${m}`],
    ['quoted command', (m: string) => `authx authy 'touch' ${m}`],
    ['IFS split', (m: string) => `authx authy $IFS touch ${m}`],
    ['embedded newline', (m: string) => `authx authy\n touch ${m}`],
  ])('does not execute a %s payload', async (_label, build) => {
    await runSearch(build(marker));
    // Whatever the tool returns, nothing ran: the marker was never created.
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('still searches for a normal query', async () => {
    const result = await runSearch('DynamicSkillRegistry');
    expect(result.content[0].text).toContain('DynamicSkillRegistry');
    expect(result.content[0].text).toMatch(/Found in|No results/);
  });

  it('reports cleanly when a query has no usable search term', async () => {
    const result = await runSearch('a b c');
    expect(result.content[0].text).toContain('No usable search terms');
  });

  it('runs grep through execFile, never a shell', () => {
    // The structural guarantee, so a future edit cannot reintroduce a shell.
    // A template literal inside an error message is harmless; what must not
    // exist is a shell invocation, or a command line built by interpolation.
    const creator = fs.readFileSync('src/main/tools/dynamic-tool-creator.ts', 'utf-8');
    const searchSection = creator.slice(
      creator.indexOf("name: 'search_codebase'"),
      creator.indexOf('// 6. TDD Loop')
    );
    expect(searchSection).toContain('execFile');
    expect(searchSection).not.toContain('execAsync');
    expect(searchSection).not.toMatch(/promisify\(exec\)/);
    // The only child process spawned is grep, by name, with an argv array.
    expect([...searchSection.matchAll(/await import\('child_process'\)/g)]).toHaveLength(1);
    expect(searchSection).toMatch(/execFileAsync\(\s*'grep',\s*\[/);
  });
});
