import { describe, it, expect } from 'vitest';
import {
  buildTraceStepIndex,
  emptyTraceStepIndex,
  findToolCallStep,
  findToolResultStep,
  selectRunTraceSteps,
  traceStepKey,
} from '../src/renderer/store/selectors';
import type { TraceStep } from '../src/renderer/types';

/**
 * A session keeps one trace step per thought, tool call and tool result for
 * every turn it has ever served, and the whole list is reloaded on every
 * session switch. Both tool blocks used to resolve a step by scanning that
 * list, once per rendered block — quadratic in the length of the conversation.
 * These tests pin the index that replaced those scans, and the run grouping
 * that lets a report isolate a single turn.
 */

const step = (overrides: Partial<TraceStep> & Pick<TraceStep, 'id' | 'type'>): TraceStep => ({
  status: 'completed',
  title: overrides.id,
  timestamp: 0,
  ...overrides,
});

describe('buildTraceStepIndex', () => {
  it('resolves a tool_result step by the tool_use id it answers', () => {
    const steps = [
      step({ id: 'tool-1', type: 'tool_call', toolName: 'Bash' }),
      step({ id: 'tool-1', type: 'tool_result', duration: 1234 }),
    ];
    const index = buildTraceStepIndex(steps);
    expect(findToolResultStep(index, 'tool-1')?.duration).toBe(1234);
  });

  it('keeps a tool_call and its tool_result apart despite sharing an id', () => {
    // The two blocks look for the same id under different types: the pairing
    // key must not collapse them into one entry.
    const steps = [
      step({ id: 'tool-1', type: 'tool_call', toolName: 'Read', title: 'Read a.ts' }),
      step({ id: 'tool-1', type: 'tool_result', duration: 900, toolOutput: 'contents' }),
    ];
    const index = buildTraceStepIndex(steps);
    expect(findToolCallStep(index, 'tool-1')?.toolName).toBe('Read');
    expect(findToolCallStep(index, 'tool-1')?.title).toBe('Read a.ts');
    expect(findToolResultStep(index, 'tool-1')?.toolOutput).toBe('contents');
    expect(index.byIdAndType.size).toBe(2);
  });

  it('returns undefined for a step that does not exist', () => {
    const index = buildTraceStepIndex([step({ id: 'tool-1', type: 'tool_call' })]);
    expect(findToolResultStep(index, 'tool-1')).toBeUndefined();
    expect(findToolCallStep(index, 'missing')).toBeUndefined();
  });

  it('groups steps by run so one turn can be isolated', () => {
    const steps = [
      step({ id: 'a1', type: 'thinking', runId: 'run-a', timestamp: 10 }),
      step({ id: 'a2', type: 'tool_result', runId: 'run-a', timestamp: 20 }),
      step({ id: 'b1', type: 'thinking', runId: 'run-b', timestamp: 30 }),
    ];
    const index = buildTraceStepIndex(steps);
    expect(index.byRunId.get('run-a')?.map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(index.byRunId.get('run-b')?.map((s) => s.id)).toEqual(['b1']);
    expect(index.latestRunId).toBe('run-b');
  });

  it('still indexes steps that carry no run id', () => {
    // Rows written before the run column existed must keep resolving, they are
    // simply not attributed to a turn.
    const steps = [step({ id: 'legacy', type: 'tool_call', toolName: 'Bash' })];
    const index = buildTraceStepIndex(steps);
    expect(findToolCallStep(index, 'legacy')?.toolName).toBe('Bash');
    expect(index.byRunId.size).toBe(0);
    expect(index.latestRunId).toBeUndefined();
  });

  it('returns the cached index for an unchanged array and rebuilds for a new one', () => {
    const steps = [step({ id: 'tool-1', type: 'tool_call' })];
    expect(buildTraceStepIndex(steps)).toBe(buildTraceStepIndex(steps));

    const next = [...steps, step({ id: 'tool-2', type: 'tool_call' })];
    const rebuilt = buildTraceStepIndex(next);
    expect(rebuilt).not.toBe(buildTraceStepIndex(steps));
    expect(findToolCallStep(rebuilt, 'tool-2')).toBeDefined();
  });

  it('skips malformed entries instead of throwing', () => {
    const steps = [
      step({ id: 'ok', type: 'tool_call' }),
      null as unknown as TraceStep,
      { type: 'tool_call' } as unknown as TraceStep,
    ];
    const index = buildTraceStepIndex(steps);
    expect(findToolCallStep(index, 'ok')).toBeDefined();
    expect(index.byIdAndType.size).toBe(1);
  });

  it('handles an empty list', () => {
    const index = buildTraceStepIndex([]);
    expect(index.byIdAndType.size).toBe(0);
    expect(index.byRunId.size).toBe(0);
    expect(emptyTraceStepIndex().byIdAndType.size).toBe(0);
  });

  it('builds a 600-step session without a lookup scan', () => {
    const steps: TraceStep[] = [];
    for (let i = 0; i < 300; i++) {
      steps.push(
        step({ id: `t${i}`, type: 'tool_call', runId: 'run-1', timestamp: i }),
        step({ id: `t${i}`, type: 'tool_result', runId: 'run-1', timestamp: i, duration: i })
      );
    }
    const index = buildTraceStepIndex(steps);
    expect(index.byIdAndType.size).toBe(600);
    expect(index.byRunId.get('run-1')).toHaveLength(600);
    expect(findToolResultStep(index, 't299')?.duration).toBe(299);
  });
});

describe('selectRunTraceSteps', () => {
  it('returns only the steps of the requested run', () => {
    const steps = [
      step({ id: 'a1', type: 'thinking', runId: 'run-a', timestamp: 10 }),
      step({ id: 'b1', type: 'thinking', runId: 'run-b', timestamp: 20 }),
    ];
    expect(selectRunTraceSteps(steps, 'run-b')?.map((s) => s.id)).toEqual(['b1']);
  });

  it('distinguishes an unknown run from a run with no steps', () => {
    const steps = [step({ id: 'a1', type: 'thinking', runId: 'run-a' })];
    expect(selectRunTraceSteps(steps, 'nope')).toBeUndefined();
    expect(selectRunTraceSteps(steps, undefined)).toBeUndefined();
    expect(selectRunTraceSteps(steps, 'run-a')).toEqual([steps[0]]);
  });
});

describe('traceStepKey', () => {
  it('separates the same id under different types', () => {
    expect(traceStepKey('x', 'tool_call')).not.toBe(traceStepKey('x', 'tool_result'));
  });
});
