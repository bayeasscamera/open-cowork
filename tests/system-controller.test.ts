import { describe, it, expect, vi } from 'vitest';
import { SystemController } from '../src/main/system/system-controller';
import { AdaptiveStrategyEngine } from '../src/main/agent/adaptive-strategy-engine';
import { buildAgentMetaTools } from '../src/main/tools/dynamic-tool-creator';

describe('SystemController & Omnipotent OS Control (OpenClaw style)', () => {
  const sys = SystemController.getInstance();

  it('provides singleton instance', () => {
    expect(sys).toBeDefined();
    expect(SystemController.getInstance()).toBe(sys);
  });

  it('reads and writes to clipboard', () => {
    const testText = `test-clipboard-${Date.now()}`;
    const writeOk = sys.writeClipboard(testText);
    expect(writeOk).toBe(true);

    const readBack = sys.readClipboard();
    expect(readBack).toBe(testText);
  });

  it('lists system processes', async () => {
    const procs = await sys.listProcesses();
    expect(Array.isArray(procs)).toBe(true);
    expect(procs.length).toBeGreaterThan(0);
    expect(procs[0]).toHaveProperty('pid');
    expect(procs[0]).toHaveProperty('name');
  });

  it('exposes all 21 meta tools including the 5 advanced pillars and async delegation', () => {
    const tools = buildAgentMetaTools();
    const names = tools.map((t) => t.name);

    // 21 after the create_dynamic_tool removal; the human-gated propose_skill
    // (the shared replacement for create_dynamic_skill) is part of the list.
    expect(tools.length).toBe(21);
    expect(names).toContain('propose_skill');
    expect(names).not.toContain('create_dynamic_tool');
    expect(names).not.toContain('create_dynamic_skill');
    expect(names).toContain('system_app_control');
    expect(names).toContain('system_clipboard');
    expect(names).toContain('system_notify');
    expect(names).toContain('system_process_manager');
    expect(names).toContain('system_run_script');
    // Pilier 1 & 4
    expect(names).toContain('auto_test_and_heal');
    expect(names).toContain('query_codebase_graph');
    // Pilier 2
    expect(names).toContain('screen_capture');
    expect(names).toContain('gui_interact');
    // Pilier 3
    expect(names).toContain('background_job_manager');
    // Pilier 5
    expect(names).toContain('orchestrate_multi_agent_plan');
    // Async delegation (OpenClaw-style fire-and-forget)
    expect(names).toContain('delegate_background_task');
    expect(names).toContain('background_task_status');
  });
});

describe('AdaptiveStrategyEngine (Hermes Agent style)', () => {
  it('provides strategic prompt with zero give-up directive', () => {
    const prompt = AdaptiveStrategyEngine.getStrategicPrompt();
    expect(prompt).toContain('autonomous_agentic_mindset');
    expect(prompt).toContain('ZERO GIVE-UP');
    expect(prompt).toContain('OPENCLAW 2');
  });

  it('formulates fallback strategy for network tasks', () => {
    const strat = AdaptiveStrategyEngine.formulateStrategy('fetch API data from endpoint');
    expect(strat.fallbackApproach).toContain('curl');
    expect(strat.resilienceScore).toBeGreaterThanOrEqual(0.8);
  });

  it('formulates fallback strategy for app management tasks', () => {
    const strat = AdaptiveStrategyEngine.formulateStrategy('launch Safari browser');
    expect(strat.primaryApproach).toContain('system_app_control');
    expect(strat.fallbackApproach).toContain('AppleScript');
  });
});
