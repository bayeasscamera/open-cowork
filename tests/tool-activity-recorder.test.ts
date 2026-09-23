import { describe, expect, it } from 'vitest';
import { ActivityTracker } from '../src/main/agent/activity-tracker';
import {
  MAX_ACTIVITY_DETAIL_CHARS,
  ToolActivityRecorder,
  summarizeToolActivityDetail,
  summarizeToolActivityError,
} from '../src/main/agent/tool-activity-recorder';

function createTracker() {
  let counter = 0;
  return new ActivityTracker({
    now: () => 1000,
    idFactory: () => {
      counter += 1;
      return 'act-' + counter;
    },
  });
}

describe('summarizeToolActivityDetail', () => {
  it('prefers the command and collapses whitespace', () => {
    expect(summarizeToolActivityDetail({ command: 'npm   run\n test' })).toBe('npm run test');
  });

  it('falls back through the ordered key list', () => {
    expect(summarizeToolActivityDetail({ path: 'src/index.ts' })).toBe('src/index.ts');
    expect(summarizeToolActivityDetail({ filePath: 'a.ts', path: 'b.ts' })).toBe('a.ts');
  });

  it('accepts an array of paths', () => {
    expect(summarizeToolActivityDetail({ paths: ['  ', 'src/a.ts', 'src/b.ts'] })).toBe('src/a.ts');
  });

  it('truncates long values with an ellipsis', () => {
    const detail = summarizeToolActivityDetail({ command: 'x'.repeat(400) });
    expect(detail).toBeDefined();
    expect(detail?.length).toBe(MAX_ACTIVITY_DETAIL_CHARS);
    expect(detail?.endsWith('…')).toBe(true);
  });

  it('returns undefined for unusable arguments', () => {
    expect(summarizeToolActivityDetail(undefined)).toBeUndefined();
    expect(summarizeToolActivityDetail(null)).toBeUndefined();
    expect(summarizeToolActivityDetail('npm test')).toBeUndefined();
    expect(summarizeToolActivityDetail([])).toBeUndefined();
    expect(summarizeToolActivityDetail({ command: '   ' })).toBeUndefined();
  });
});

describe('summarizeToolActivityError', () => {
  it('keeps the first non-empty line only', () => {
    expect(summarizeToolActivityError('\n\nboom: failed\nstack')).toBe('boom: failed');
  });

  it('returns undefined when there is nothing to show', () => {
    expect(summarizeToolActivityError('   \n  ')).toBeUndefined();
    expect(summarizeToolActivityError(undefined)).toBeUndefined();
  });
});

describe('ToolActivityRecorder', () => {
  it('opens and closes an activity keyed by toolCallId', () => {
    const tracker = createTracker();
    const recorder = new ToolActivityRecorder(tracker, 'session-1');
    const started = recorder.start({
      toolCallId: 'call-1',
      toolName: 'bash',
      label: 'bash',
      args: { command: 'npm test' },
    });
    expect(started.status).toBe('running');
    expect(started.sessionId).toBe('session-1');
    expect(started.detail).toBe('npm test');
    expect(recorder.runningCount()).toBe(1);

    const finished = recorder.end({ toolCallId: 'call-1', isError: false });
    expect(finished?.status).toBe('ok');
    expect(finished?.durationMs).toBe(0);
    expect(recorder.runningCount()).toBe(0);
    expect(tracker.summary().ok).toBe(1);
  });

  it('records the error excerpt on failure', () => {
    const tracker = createTracker();
    const recorder = new ToolActivityRecorder(tracker, 's');
    recorder.start({ toolCallId: 'c', toolName: 'read' });
    const finished = recorder.end({ toolCallId: 'c', isError: true, output: '\nENOENT: no such file' });
    expect(finished?.status).toBe('error');
    expect(finished?.error).toBe('ENOENT: no such file');
  });

  it('ignores an unknown toolCallId', () => {
    const tracker = createTracker();
    const recorder = new ToolActivityRecorder(tracker, 's');
    expect(recorder.end({ toolCallId: 'nope', isError: false })).toBeNull();
  });

  it('cancels every running activity and clears the map', () => {
    const tracker = createTracker();
    const recorder = new ToolActivityRecorder(tracker, 's');
    recorder.start({ toolCallId: 'a', toolName: 'bash' });
    recorder.start({ toolCallId: 'b', toolName: 'read' });
    expect(recorder.cancelRunning('Run aborted.')).toBe(2);
    expect(recorder.runningCount()).toBe(0);
    expect(recorder.cancelRunning()).toBe(0);
    expect(tracker.summary().cancelled).toBe(2);
  });

  it('does not close an activity twice', () => {
    const tracker = createTracker();
    const recorder = new ToolActivityRecorder(tracker, 's');
    recorder.start({ toolCallId: 'a', toolName: 'bash' });
    recorder.end({ toolCallId: 'a', isError: false });
    expect(recorder.end({ toolCallId: 'a', isError: false })).toBeNull();
  });
});
