import { describe, expect, it } from 'vitest';
import { LAYER_WEIGHT } from '../src/main/memory/memory-relevance';
import { DEFAULT_TTL_MS } from '../src/main/memory/project-memory-store';
import { MEMORY_LAYERS } from '../src/shared/project-memory-types';

/**
 * `LAYER_WEIGHT` and `DEFAULT_TTL_MS` are `Record<MemoryLayer, ...>`, so
 * TypeScript already refuses a layer missing from either table — adding a
 * member to the union without adding it to a table is a compile error.
 *
 * This test exists because that guarantee is INVISIBLE. A type error names a
 * line; a passing assertion names a fact in the CI log, and it states WHICH
 * table is complete rather than leaving the reader to infer it. It also pins
 * the direction of the guarantee: every declared layer is weighted and has a
 * TTL policy, so a new layer cannot arrive half-configured.
 */
describe('per-layer tables stay complete', () => {
  it('weights every declared layer', () => {
    for (const layer of MEMORY_LAYERS) {
      expect(LAYER_WEIGHT[layer], `LAYER_WEIGHT is missing "${layer}"`).toBeTypeOf('number');
      expect(Number.isFinite(LAYER_WEIGHT[layer])).toBe(true);
    }
  });

  it('gives every declared layer a TTL policy', () => {
    for (const layer of MEMORY_LAYERS) {
      const ttl = DEFAULT_TTL_MS[layer];
      // null is a deliberate "never expires"; undefined means the key is
      // missing, which is the failure this guards.
      expect(ttl === null || Number.isFinite(ttl), `DEFAULT_TTL_MS["${layer}"] is ${ttl}`).toBe(
        true
      );
    }
  });

  it('keeps error and task-state the heaviest layers', () => {
    // The ordering is a product decision, not an implementation detail: a
    // regression or an in-flight state should outrank a static decision.
    expect(LAYER_WEIGHT.errors).toBeGreaterThan(LAYER_WEIGHT['task-state']);
    expect(LAYER_WEIGHT['task-state']).toBeGreaterThan(LAYER_WEIGHT.rules);
    expect(LAYER_WEIGHT.rules).toBeGreaterThan(LAYER_WEIGHT.decisions);
  });

  it('expires task state and errors, and keeps rules and decisions', () => {
    expect(DEFAULT_TTL_MS['task-state']).not.toBeNull();
    expect(DEFAULT_TTL_MS.errors).not.toBeNull();
    expect(DEFAULT_TTL_MS.rules).toBeNull();
    expect(DEFAULT_TTL_MS.decisions).toBeNull();
  });
});
