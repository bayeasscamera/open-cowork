/**
 * @module main/agent/scenario-runner
 *
 * Cowork 4.0 — Phase 0.4: executes a reference scenario through the real agent
 * session, so the metric suite measures the product and not a mock.
 *
 * A scenario is one prompt with the scenario's own budget and write scope.
 * Success is judged against the scenario's own contract — every expected
 * evidence kind must actually have been produced, and a read-only scenario
 * must not have written anything — instead of trusting the agent's claim.
 */

import type { Capability } from '../../shared/task-contract';
import { createAtomicTask, createTaskContract } from '../../shared/task-contract';
import { runAgentTask, type AgentTaskRunnerOptions } from './agent-task-runner';
import type { ScenarioRunFacts, ScenarioRunner } from './metrics-harness';
import { evaluateScenarioRun, type ReferenceScenario } from './reference-scenarios';
import type { WorkflowTaskContext } from './workflow-executor';

export interface ScenarioAgentRunnerOptions extends AgentTaskRunnerOptions {
  workspaceRoot: string;
}

/** Capabilities a scenario may use: a read-only scenario cannot shell out. */
function scenarioCapabilities(scenario: ReferenceScenario): Capability[] {
  return scenario.writeScope.length > 0 ? ['read', 'write', 'shell'] : ['read'];
}

/** Build a runner that executes reference scenarios with real agent sessions. */
export function createScenarioAgentRunner(options: ScenarioAgentRunnerOptions): ScenarioRunner {
  return async (scenario: ReferenceScenario): Promise<ScenarioRunFacts> => {
    const capabilities = scenarioCapabilities(scenario);
    const writeScope = [...scenario.writeScope];

    const task = createAtomicTask({
      id: 'scenario-' + scenario.id,
      title: scenario.title,
      role: 'implementer',
      writeScope,
      exitCriteria: [],
      requiredEvidence: [],
      budget: { ...scenario.budget },
      riskLevel: 'medium',
      parallelizable: false,
      requestedCapabilities: capabilities,
    });

    const contract = createTaskContract({
      id: 'scenario-contract-' + scenario.id,
      objective: scenario.prompt,
      mode: 'execute',
      allowedFiles: writeScope.length > 0 ? writeScope : ['**'],
      acceptanceCriteria: scenario.successCriteria.map((criterion, index) => ({
        id: 'scenario-criterion-' + index,
        description: criterion,
        verification: 'inspection: scenario success criteria',
        required: true,
      })),
      budget: { ...scenario.budget },
      requestedCapabilities: capabilities,
    });

    const controller = new AbortController();
    let toolCalls = 0;
    let humanInterventions = 0;
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
      onToolBlocked: () => {
        // A guard refusal is a boundary the unattended run could not cross.
        humanInterventions += 1;
      },
    };

    const outcome = await runAgentTask(context, options);
    const durationMs = Date.now() - startedAt;
    const evaluation = evaluateScenarioRun(scenario, {
      success: outcome.success,
      summary: outcome.summary,
      evidenceKinds: outcome.evidenceKinds,
      failedCommands: outcome.failedCommands,
    });

    return {
      success: evaluation.success,
      turns: outcome.toolCalls ?? toolCalls,
      costUsd: outcome.costUsd ?? 0,
      durationMs,
      regressions: evaluation.regressions,
      humanInterventions,
      evidenceCount: evaluation.evidenceCount,
    };
  };
}
