import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const panel = read('src/renderer/components/ControlCenterPanel.tsx');
const activity = read('src/renderer/components/ActivityFeed.tsx');
const workspace = read('src/renderer/components/WorkspacePane.tsx');
const queue = read('src/renderer/components/TaskQueuePane.tsx');
const app = read('src/renderer/App.tsx');
const store = read('src/renderer/store/index.ts');
const preload = read('src/preload/index.ts');
const handlers = read('src/main/ipc/control-center-handlers.ts');
const types = read('src/shared/control-center-types.ts');

describe('control center panel wiring', () => {
  it('renders the three control-center panes as tabs', () => {
    expect(panel).toContain("const TABS: ControlCenterTab[] = ['activity', 'workspace', 'queue'];");
    expect(panel).toContain("t('controlCenter.tab.' + candidate)");
    expect(panel).toContain('<ActivityFeed sessionId={sessionId} />');
    expect(panel).toContain('<WorkspacePane sessionId={sessionId} />');
    expect(panel).toContain('<TaskQueuePane sessionId={sessionId} />');
  });

  it('summarizes the workspace, branch, running tasks and unread notifications', () => {
    expect(panel).toContain('api.snapshot(sessionId)');
    expect(panel).toContain("t('controlCenter.summary.workspace'");
    expect(panel).toContain("t('controlCenter.summary.branch'");
    expect(panel).toContain("t('controlCenter.summary.running'");
    expect(panel).toContain("t('controlCenter.summary.unread'");
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
    expect(handlerChannels.size).toBe(17);

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
