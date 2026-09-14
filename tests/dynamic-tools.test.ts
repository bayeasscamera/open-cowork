import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicToolRegistry, DynamicSkillRegistry, buildAgentMetaTools } from '../src/main/tools/dynamic-tool-creator';

describe('DynamicToolCreator & DeepSeek Eval Harness', () => {
  let toolRegistry: DynamicToolRegistry;
  let skillRegistry: DynamicSkillRegistry;

  beforeEach(() => {
    toolRegistry = DynamicToolRegistry.getInstance();
    skillRegistry = DynamicSkillRegistry.getInstance();
  });

  it('provides all 9 meta tools including coding intelligence', () => {
    const metaTools = buildAgentMetaTools();
    const names = metaTools.map((t) => t.name);

    expect(names).toContain('create_dynamic_tool');
    expect(names).toContain('create_dynamic_skill');
    expect(names).toContain('list_agent_capabilities');
    expect(names).toContain('deepseek_eval_harness');
    expect(names).toContain('auto_verify_edits');
    expect(names).toContain('search_codebase');
    expect(names).toContain('run_tdd_cycle');
    expect(names).toContain('find_symbol_usages');
    expect(names).toContain('ast_safe_rename');
  });

  it('allows agent to create a new dynamic tool on the fly and execute it', async () => {
    const metaTools = buildAgentMetaTools();
    const createTool = metaTools.find((t) => t.name === 'create_dynamic_tool')!;

    const createResult = await (createTool as any).execute('call_1', {
      name: 'math_multiplier',
      description: 'Multiplies two numbers',
      implementationCode: 'async (args) => { return { product: args.a * args.b }; }',
    });

    expect(createResult.content[0].text).toContain('Successfully created and registered dynamic tool: custom_math_multiplier');

    const piTools = toolRegistry.getPiToolDefinitions();
    const multiplierTool = piTools.find((t) => t.name === 'custom_math_multiplier');
    expect(multiplierTool).toBeDefined();

    const output = await (multiplierTool as any).execute('call_2', { a: 7, b: 6 });
    expect(output.content[0].text).toContain('"product": 42');
  });

  it('allows agent to create a new skill and persist it', async () => {
    const metaTools = buildAgentMetaTools();
    const createSkill = metaTools.find((t) => t.name === 'create_dynamic_skill')!;

    const result = await (createSkill as any).execute('call_skill_1', {
      name: 'Test SQLite Migration',
      description: 'Trigger when writing SQLite migrations',
      content: `---
name: test-sqlite-migration
description: Trigger when writing SQLite migrations
---

# SQLite Migration Pattern

## Overview
Use this when adding new tables to the database.

## Workflow
1. Add CREATE TABLE IF NOT EXISTS
2. Add indexes
3. Run typecheck`,
    });

    expect(result.content[0].text).toContain('Skill created');
    expect(result.content[0].text).toContain('test-sqlite-migration');
    expect(result.details).toHaveProperty('slug', 'test-sqlite-migration');
    expect(result.details).toHaveProperty('version', expect.any(Number));

    // Verify it's in the registry
    const allSkills = skillRegistry.getAllSkills();
    const created = allSkills.find((s) => s.slug === 'test-sqlite-migration');
    expect(created).toBeDefined();
    expect(created!.content).toContain('SQLite Migration Pattern');
  });

  it('list_agent_capabilities shows tools and skills', async () => {
    const metaTools = buildAgentMetaTools();
    const listTool = metaTools.find((t) => t.name === 'list_agent_capabilities')!;

    const result = await (listTool as any).execute('call_list_1', {});
    expect(result.content[0].text).toContain('=== Agent Capabilities ===');
    expect(result.content[0].text).toContain('Dynamic Tools');
    expect(result.content[0].text).toContain('Dynamic Skills');
    expect(result.details).toHaveProperty('toolCount');
    expect(result.details).toHaveProperty('skillCount');
  });

  it('runs deepseek_eval_harness and computes benchmark scoring', async () => {
    const metaTools = buildAgentMetaTools();
    const evalHarness = metaTools.find((t) => t.name === 'deepseek_eval_harness')!;

    const rawReport = await (evalHarness as any).execute('call_3', {
      benchmarkName: 'Coding Accuracy Benchmark',
      testCases: [
        {
          id: 'case_1',
          prompt: 'Sort array',
          expectedOutputs: ['[1, 2, 3]'],
        },
        {
          id: 'case_2',
          prompt: 'Reverse string',
          expectedOutputs: ['olleh'],
        },
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

    const result = await (findTool as any).execute('call_ast_1', {
      symbolName: 'DynamicToolRegistry',
    });

    expect(result.content[0].text).toContain('Found');
    expect(result.content[0].text).toContain('usages of "DynamicToolRegistry"');
    expect(result.details.count).toBeGreaterThan(0);
  });
});


