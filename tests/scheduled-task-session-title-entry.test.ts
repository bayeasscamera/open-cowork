import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('scheduled task session title wiring', () => {
  it('routes schedule title generation through SessionManager flow', () => {
    const indexPath = path.resolve(process.cwd(), 'src/main/index.ts');
    const content = readFileSync(indexPath, 'utf8');
    expect(content).toContain('async function resolveScheduledTaskTitle(');
    expect(content).toContain('sessionManager.generateScheduledTaskTitle');
    // The schedule.* channels live in their own module since the structural
    // refactor; the title flow is still injected from the app entry point.
    const scheduleHandlers = readFileSync(
      path.resolve(process.cwd(), 'src/main/ipc/schedule-handlers.ts'),
      'utf8'
    );
    expect(content).toContain('resolveScheduledTaskTitle,');
    for (const channel of ['schedule.create', 'schedule.update']) {
      expect(scheduleHandlers).toContain(`'${channel}'`);
    }
  });
});
