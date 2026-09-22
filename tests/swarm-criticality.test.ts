/**
 * Tests for structural swarm criticality: a task other tasks depend on is on
 * the critical path and drives the dynamic strong/economical model selection.
 */

import { describe, expect, it } from 'vitest';
import {
  isTaskCritical,
  markTaskCriticality,
  type CriticalityNode,
} from '../src/main/agent/swarm-criticality';

const node = (id: string, dependsOn?: string[]): CriticalityNode => ({ id, dependsOn });

describe('swarm criticality', () => {
  it('marks the shared spine of the default swarm DAG as critical', () => {
    const tasks = [
      node('architect'),
      node('developer', ['architect']),
      node('reviewer', ['developer']),
      node('security', ['developer']),
    ];

    markTaskCriticality(tasks);

    expect(tasks.map((task) => [task.id, task.criticalPath])).toEqual([
      ['architect', true],
      ['developer', true],
      ['reviewer', false],
      ['security', false],
    ]);
  });

  it('marks every task of a linear chain except the terminal one', () => {
    const tasks = [node('a'), node('b', ['a']), node('c', ['b'])];
    markTaskCriticality(tasks);
    expect(tasks.map((task) => task.criticalPath)).toEqual([true, true, false]);
  });

  it('treats an isolated task as non-critical', () => {
    expect(isTaskCritical([node('solo')], 'solo')).toBe(false);
  });

  it('follows transitive dependents', () => {
    const tasks = [node('a'), node('b', ['a']), node('c', ['b'])];
    expect(isTaskCritical(tasks, 'a')).toBe(true);
    expect(isTaskCritical(tasks, 'b')).toBe(true);
    expect(isTaskCritical(tasks, 'c')).toBe(false);
  });

  it('ignores dependencies on unknown task ids', () => {
    expect(isTaskCritical([node('a', ['ghost'])], 'a')).toBe(false);
  });

  it('terminates on a malformed cyclic graph instead of looping forever', () => {
    const tasks = [node('a', ['b']), node('b', ['a'])];
    expect(isTaskCritical(tasks, 'a')).toBe(true);
    markTaskCriticality(tasks);
    expect(tasks.every((task) => task.criticalPath === true)).toBe(true);
  });
});
