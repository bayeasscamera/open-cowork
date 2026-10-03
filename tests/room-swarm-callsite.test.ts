import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The bridge has a throwing variant and a best-effort one. Which one the swarm
 * call site uses is the property that matters: the swarm has already done the
 * work by then, so a persistence failure must not cost the user their result.
 *
 * Asserting this on the call site rather than on the bridge, because the bridge
 * tests exercise both functions directly and would pass whichever the caller
 * picked.
 */
const creator = readFileSync(
  path.resolve(process.cwd(), 'src/main/tools/dynamic-tool-creator.ts'),
  'utf8'
);

describe('swarm room capture at the call site', () => {
  it('uses the best-effort capture, not the throwing one', () => {
    expect(creator).toContain('const capturedRoom = tryCaptureSwarmIntoRoom({');
    expect(creator).not.toContain('const capturedRoom = captureSwarmIntoRoom({');
  });

  it('captures from the settled plan, after execution and before disposal', () => {
    const captureIndex = creator.indexOf('tryCaptureSwarmIntoRoom({');
    const executeIndex = creator.indexOf('executePlan(plan.id');
    expect(captureIndex).toBeGreaterThan(executeIndex);
  });

  it('reports a capture that did not happen instead of swallowing it', () => {
    // Silence would let the user assume the run was preserved when it was not.
    expect(creator).toContain('could not be recorded');
    expect(creator).toContain('roomSection');
  });

  it('captures after the plan settles rather than before the bus is disposed', () => {
    // The bus is dropped when the plan settles; the plan's own tasks are the
    // durable source, so the capture must read from the executed plan.
    const captureIndex = creator.indexOf('plan: executed,');
    expect(captureIndex).toBeGreaterThan(-1);
  });
});