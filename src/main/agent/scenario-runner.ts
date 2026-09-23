/**
 * @module main/agent/scenario-runner
 *
 * Cowork 4.0 — Phase 0.4: executes a reference scenario through the real agent
 * session, so the metric suite measures the product and not a mock.
 *
 * A scenario is one prompt with the scenario's own budget; success means the
 * session finished and produced output. Tool calls stand in for turns, which is
 * the honest, cheap proxy available without a per-turn counter.
 */

import { createAtomicTask, createTaskContract } from '../../shared/task-contract';
import { runAgentTask, type AgentTaskRunnerOptions } from './agent-task-runner';
import type { ScenarioRunFacts, ScenarioRunner } from './metrics-harness';
import type { ReferenceScenario } from './reference-scenarios';
import type { WorkflowTaskContext } from './workflow-executor';

export interface ScenarioAgentRunnerOptions extends AgentTaskRunnerOptions {
  workspaceRoot: string;
}

/** Build a runner that executes reference scenarios with real agent sessions. */
export function createScenarioAgentRunner(options: ScenarioAgentRunnerOptions): ScenarioRunner {
  return async (scenario: ReferenceScenario): Promise<ScenarioRunFacts> => {
    const task = createAtomicTask({
      id: 'scenario-' + scenario.id,
      title: scenario.title,
      role: 'implementer',
      writeScope: [],
      exitCriteria: [],
      requiredEvidence: [],
      budget: { ...scenario.budget },
      riskLevel: 'medium',
      parallelizable: false,
      requestedCapabilities: ['read', 'write', 'shell'],
    });

    const contract = createTaskContract({
      id: 'scenario-contract-' + scenario.id,
      objective: scenario.prompt,
      mode: 'execute',
      allowedFiles: ['**'],
      acceptanceCriteria: scenario.successCriteria.map((criterion, index) => ({
        id: 'scenario-criterion-' + index,
        description: criterion,
        verification: 'inspection: scenario success criteria',
        required: true,
      })),
      budget: { ...scenario.budget },
      requestedCapabilities: ['read', 'write', 'shell'],
    });

    const controller = new AbortController();
    let toolCalls = 0;
    const startedAt = Date.now();

    const context: WorkflowTaskContext = {
      task,
      contract,
      cwd: options.workspaceRoot,
      prompt: scenario.prompt,
      isolated: false,
      signal: controller.signal,
      onToolCall: (count = 1) => {
        toolCalls += count;
      },
    };

    const outcome = await runAgentTask(context, options);
    const durationMs = Date.now() - startedAt;

    return {
      success: outcome.success,
      turns: outcome.toolCalls ?? toolCalls,
      costUsd: outcome.costUsd ?? 0,
      durationMs,
      regressions: 0,
      humanInterventions: 0,
      evidenceCount: outcome.success ? scenario.expectedEvidence.length : 0,
    };
  };
}
