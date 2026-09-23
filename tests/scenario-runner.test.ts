import { describe, it, expect } from 'vitest';
import type { TaskSession, TaskSessionEvent } from '../src/main/agent/agent-task-runner';
import { createScenarioAgentRunner } from '../src/main/agent/scenario-runner';
import { REFERENCE_SCENARIOS } from '../src/main/agent/reference-scenarios';
import type { WorkflowTaskContext } from '../src/main/agent/workflow-executor';

function fakeSession(events: TaskSessionEvent[]): TaskSession {
  let listener: ((event: TaskSessionEvent) => void) | undefined;
  return {
    prompt: async () => {
      for (const event of events) {
        listener?.(event);
      }
    },
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    dispose: () => {},
  };
}

const bugfix = REFERENCE_SCENARIOS.find((scenario) => scenario.id === 'bugfix-null-guard')!;
const audit = REFERENCE_SCENARIOS.find((scenario) => scenario.id === 'security-audit')!;

const editAndTest: TaskSessionEvent[] = [
  { type: 'tool_execution_start', toolCallId: '1', toolName: 'edit', args: { file_path: 'src/a.ts' } },
  { type: 'tool_execution_end', toolCallId: '1', toolName: 'edit', isError: false },
  { type: 'tool_execution_start', toolCallId: '2', toolName: 'bash', args: { command: 'npm test' } },
  { type: 'tool_execution_end', toolCallId: '2', toolName: 'bash', isError: false },
  {
    type: 'agent_end',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'Fixed the null guard; npm test passes.' }] },
    ],
  },
];

function runnerFor(events: TaskSessionEvent[], onContext?: (context: WorkflowTaskContext) => void) {
  return createScenarioAgentRunner({
    workspaceRoot: '/ws',
    sessionFactory: async (context) => {
      onContext?.(context);
      return fakeSession(events);
    },
  });
}

describe('createScenarioAgentRunner', () => {
  it('runs the scenario inside its declared write scope', async () => {
    let seen: WorkflowTaskContext | undefined;
    const facts = await runnerFor(editAndTest, (context) => {
      seen = context;
    })(bugfix);

    expect(seen?.task.writeScope).toEqual(bugfix.writeScope);
    expect(seen?.task.requestedCapabilities).toContain('write');
    expect(facts.success).toBe(true);
    expect(facts.evidenceCount).toBe(bugfix.expectedEvidence.length);
    expect(facts.turns).toBe(2);
  });

  it('fails the run when an expected evidence kind is missing', async () => {
    const facts = await runnerFor([
      { type: 'tool_execution_start', toolCallId: '1', toolName: 'edit', args: { file_path: 'src/a.ts' } },
      { type: 'tool_execution_end', toolCallId: '1', toolName: 'edit', isError: false },
      {
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Applied the fix.' }] }],
      },
    ])(bugfix);

    expect(facts.success).toBe(false);
    expect(facts.evidenceCount).toBe(1);
  });

  it('counts a failed command as a regression', async () => {
    const facts = await runnerFor([
      ...editAndTest.slice(0, 4),
      { type: 'tool_execution_start', toolCallId: '3', toolName: 'bash', args: { command: 'npm run lint' } },
      { type: 'tool_execution_end', toolCallId: '3', toolName: 'bash', isError: true },
      editAndTest[4],
    ])(bugfix);

    expect(facts.regressions).toBe(1);
    expect(facts.success).toBe(true);
  });

  it('runs a read-only scenario without the write or shell capability', async () => {
    let seen: WorkflowTaskContext | undefined;
    await runnerFor(
      [
        {
          type: 'agent_end',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'src/main/index.ts:88 — API key written to the log.' }],
            },
          ],
        },
      ],
      (context) => {
        seen = context;
      }
    )(audit);

    expect(seen?.task.writeScope).toEqual([]);
    expect(seen?.task.requestedCapabilities).toEqual(['read']);
  });

  it('rejects a read-only scenario that wrote a file', async () => {
    const facts = await runnerFor([
      { type: 'tool_execution_start', toolCallId: '1', toolName: 'write', args: { file_path: 'src/a.ts' } },
      { type: 'tool_execution_end', toolCallId: '1', toolName: 'write', isError: false },
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'src/main/index.ts:88 — API key written to the log.' }],
          },
        ],
      },
    ])(audit);

    expect(facts.success).toBe(false);
  });
});
