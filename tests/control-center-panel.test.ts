import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const panel = read('src/renderer/components/ControlCenterPanel.tsx');
const activity = read('src/renderer/components/ActivityFeed.tsx');
const activityView = read('src/renderer/components/ActivityView.tsx');
const chatView = read('src/renderer/components/ChatView.tsx');
const workspace = read('src/renderer/components/WorkspacePane.tsx');
const queue = read('src/renderer/components/TaskQueuePane.tsx');
const terminal = read('src/renderer/components/TerminalPane.tsx');
const app = read('src/renderer/App.tsx');
const store = read('src/renderer/store/index.ts');
const preload = read('src/preload/index.ts');
const handlers = read('src/main/ipc/control-center-handlers.ts');
const types = read('src/shared/control-center-types.ts');

describe('control center panel wiring', () => {
  it('renders the control-center panes as tabs', () => {
    expect(panel).toContain(
      "const TABS: ControlCenterTab[] = ['activity', 'workspace', 'queue', 'terminal', 'settings'];"
    );
    expect(panel).toContain("t('controlCenter.tab.' + candidate)");
    expect(panel).toContain('<ActivityView sessionId={sessionId} />');
    expect(panel).toContain('<WorkspacePane sessionId={sessionId} />');
    expect(panel).toContain('<TaskQueuePane sessionId={sessionId} />');
    expect(panel).toContain('<TerminalPane sessionId={sessionId} />');
    expect(panel).toContain('<SettingsLevelsPane sessionId={sessionId} />');
  });

  it('re-runs only the failed test files from the workspace pane', () => {
    expect(workspace).toContain('api.rerunFailedTests(sessionId)');
    expect(workspace).toContain("t('controlCenter.workspace.rerunFailed')");
    expect(workspace).toContain("t('controlCenter.workspace.rerun.' + rerun.reason)");
    expect(workspace).toContain('outcome.ran && outcome.result');
  });

  it('drives the embedded terminal from its pane', () => {
    expect(terminal).toContain('api.terminalList(sessionId)');
    expect(terminal).toContain('api.terminalOpen(sessionId)');
    expect(terminal).toContain('api.terminalSnapshot(sessionId, activeId, cursor.current)');
    expect(terminal).toContain('api.terminalWrite(sessionId, activeId, input)');
    expect(terminal).toContain('api.terminalClear(sessionId, activeId)');
    expect(terminal).toContain('api.terminalClose(sessionId, activeId)');
    expect(terminal).toContain("t('controlCenter.terminal.hint')");
    expect(terminal).toContain("t('controlCenter.terminal.exited'");
  });

  it('summarizes the workspace, branch, running tasks and unread notifications', () => {
    expect(panel).toContain('api.snapshot(sessionId)');
    expect(panel).toContain("t('controlCenter.summary.workspace'");
    expect(panel).toContain("t('controlCenter.summary.branch'");
    expect(panel).toContain("t('controlCenter.summary.running'");
    expect(panel).toContain("t('controlCenter.summary.unread'");
  });

  it('consolidates tool activity and sub-agents into a single activity view', () => {
    expect(activityView).toContain('useSubagentStates(sessionId)');
    expect(activityView).toContain('<SubagentProgress key={state.subagentId} state={state} />');
    expect(activityView).toContain('<ActivityFeed sessionId={sessionId} />');
    expect(activityView).toContain("t('controlCenter.activity.subagents', { count: subagents.length })");
    expect(activityView).toContain("t('controlCenter.activity.tools')");
  });

  it('no longer splits sub-agent progress into a second chat-inline view', () => {
    expect(chatView).not.toContain('SubagentTracker');
  });

  it('shows live tool activity with status, duration and errors', () => {
    expect(activity).toContain('api.activity(sessionId, 100)');
    expect(activity).toContain('api.clearActivity(sessionId)');
    expect(activity).toContain("t('controlCenter.activity.status.' + event.status)");
    expect(activity).toContain("t('controlCenter.activity.duration'");
    expect(activity).toContain('event.error');
  });

  it('browses the workspace, git status and project checks', () => {
    expect(workspace).toContain('api.workspaceTree(sessionId');
    expect(workspace).toContain('api.gitStatus(sessionId)');
    expect(workspace).toContain('api.readFile(sessionId, entry.path');
    expect(workspace).toContain('api.runTests(sessionId, commandId)');
    expect(workspace).toContain("t('controlCenter.workspace.staged')");
    expect(workspace).toContain("t('controlCenter.workspace.test.' + commandId)");
  });

  it('surfaces detached tasks and approval notifications', () => {
    expect(queue).toContain('api.queue(sessionId)');
    expect(queue).toContain('api.notifications(sessionId)');
    expect(queue).toContain("api.updateTask(sessionId, task.id, 'running')");
    expect(queue).toContain('api.cancelTask(sessionId, task.id)');
    expect(queue).toContain('api.acknowledgeNotification(sessionId, notification.id)');
    expect(queue).toContain('api.acknowledgeAll(sessionId)');
  });

  it('is mounted from the app shell behind a store flag', () => {
    expect(app).toContain("import('./components/ControlCenterPanel')");
    expect(app).toContain('controlCenterVisible');
    expect(store).toContain('controlCenterVisible: boolean;');
    expect(store).toContain('setControlCenterVisible: (visible: boolean) => void;');
    expect(store).toContain('modelRoutingVisible: boolean;');
  });

  it('declares every control center channel in the preload bridge', () => {
    const channelPattern = /'controlCenter\.([a-zA-Z]+)'/g;
    const handlerChannels = new Set<string>();
    for (const match of handlers.matchAll(channelPattern)) {
      handlerChannels.add(match[1]);
    }
    expect(handlerChannels.size).toBe(25);

    for (const channel of handlerChannels) {
      expect(preload, 'preload is missing controlCenter.' + channel).toContain(
        'controlCenter.' + channel
      );
    }
  });

  it('keeps the control center types shared so preload never imports main', () => {
    expect(preload).toContain("from '../shared/control-center-types'");
    expect(preload).not.toContain("from '../main/");
    expect(types).toContain('export interface ControlCenterSnapshot');
    expect(types).toContain('export type TestCommandId');
  });
});
