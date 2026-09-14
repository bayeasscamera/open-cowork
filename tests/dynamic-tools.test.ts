import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicToolRegistry, buildAgentMetaTools } from '../src/main/tools/dynamic-tool-creator';

describe('DynamicToolCreator & DeepSeek Eval Harness', () => {
  let registry: DynamicToolRegistry;

  beforeEach(() => {
    registry = DynamicToolRegistry.getInstance();
  });

  it('provides create_dynamic_tool and deepseek_eval_harness meta tools', () => {
    const metaTools = buildAgentMetaTools();
    const names = metaTools.map((t) => t.name);

    expect(names).toContain('create_dynamic_tool');
    expect(names).toContain('deepseek_eval_harness');
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

    const piTools = registry.getPiToolDefinitions();
    const multiplierTool = piTools.find((t) => t.name === 'custom_math_multiplier');
    expect(multiplierTool).toBeDefined();

    const output = await (multiplierTool as any).execute('call_2', { a: 7, b: 6 });
    expect(output.content[0].text).toContain('"product": 42');
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
});
