import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const runner = read('src/main/agent/agent-runner.ts');
const handler = read('src/main/agent/session-event-handler.ts');
const sessionManager = read('src/main/session/session-manager.ts');
const index = read('src/main/index.ts');
const preload = read('src/preload/index.ts');
const recorder = read('src/main/agent/tool-activity-recorder.ts');
const routingService = read('src/main/agent/model-routing-service.ts');
const subagentExtension = read('src/main/agent/subagent-extension.ts');

describe('control center wired into the agent loop', () => {
  it('mirrors tool executions into the activity tracker', () => {
    expect(runner).toContain("import { ToolActivityRecorder } from './tool-activity-recorder';");
    expect(runner).toContain('new ToolActivityRecorder(this.activityTracker, session.id)');
    expect(runner).toContain('        toolActivity,');
    expect(runner).toContain('toolActivity?.cancelRunning(');
    expect(handler).toContain('ctx.toolActivity?.start({');
    expect(handler).toContain('ctx.toolActivity?.end({');
  });

  it('exposes a setter so the control center can attach after construction', () => {
    expect(runner).toContain('public setActivityTracker(tracker?: ActivityTracker): void');
    expect(sessionManager).toContain('public setActivityTracker(tracker?: ActivityTracker): void');
    expect(sessionManager).toContain('this.agentRunner?.setActivityTracker?.(tracker);');
    expect(sessionManager).toContain(
      '...(this.activityTracker ? { activityTracker: this.activityTracker } : {}),'
    );
  });

  it('raises an approval notification when a permission dialog opens', () => {
    expect(sessionManager).toContain('public setNotificationCenter(center?: NotificationCenter): void');
    expect(sessionManager).toContain('this.notificationCenter?.notify({');
    expect(sessionManager).toContain("kind: 'approval',");
    expect(sessionManager).toContain('title: toolName,');
    expect(sessionManager).toContain('this.notificationCenter?.acknowledge(notification.id);');
  });

  it('wires both bootstrap paths to the shared services', () => {
    expect(index).toContain("import { ControlCenterService } from './agent/control-center-service';");
    expect(index).toContain('function attachAgentServices(manager: SessionManager): void {');
    expect(index).toContain('manager.setActivityTracker(controlCenterService.activity);');
    expect(index).toContain('manager.setNotificationCenter(controlCenterService.notifications);');
    expect(index).toContain('attachAgentServices(sessionManager);');
    expect(index.match(/attachAgentServices\(sessionManager\);/g)?.length).toBe(2);
  });
});

describe('model routing wired into live model selection', () => {
  it('consults the router only when the human opted in', () => {
    expect(runner).toContain('public setModelResolver(');
    expect(runner).toContain('allowAdaptive: !effectiveConfigSetId && !effectiveConfigModelId,');
    expect(runner).toContain("logCtx('[CoworkAgentRunner] Model source:', 'modelRouting');");
    expect(routingService).toContain('if (!this.enabled || !this.activeProfile) {');
    expect(routingService).toContain('return undefined;');
  });

  it('shares the same service instance between IPC and the runner', () => {
    expect(index).toContain('const modelRoutingService = new ModelRoutingService();');
    expect(index).toContain('registerModelRoutingIpcHandlers({ service: modelRoutingService');
    expect(index).toContain('manager.setModelResolver((input) => modelRoutingService.resolveModel(input));');
    expect(sessionManager).toContain('public setModelResolver(');
    expect(sessionManager).toContain('...(this.modelResolver ? { modelResolver: this.modelResolver } : {}),');
  });

  it('declares the adaptive routing channels in the preload bridge', () => {
    for (const channel of ['state', 'setEnabled', 'setActiveProfile']) {
      expect(preload).toContain('modelRouting.' + channel);
    }
    expect(preload).not.toContain("from '../main/");
  });

  it('records a benchmark for every run through the routing service', () => {
    expect(runner).toContain('public setBenchmarkRecorder(');
    expect(runner).toContain('this.benchmarkRecorder?.({');
    expect(runner).toContain('modelId: usedModelString,');
    expect(sessionManager).toContain('public setBenchmarkRecorder(');
    expect(sessionManager).toContain('this.agentRunner?.setBenchmarkRecorder?.(recorder);');
    expect(sessionManager).toContain(
      '...(this.benchmarkRecorder ? { benchmarkRecorder: this.benchmarkRecorder } : {}),'
    );
    expect(index).toContain('manager.setBenchmarkRecorder((input) => {');
    expect(index).toContain('modelRoutingService.recordRun(input);');
    expect(routingService).toContain(
      'public recordRun(input: ModelRunInput): ModelBenchmark | null'
    );
  });

  it('keeps the activity recorder free of console output', () => {
    expect(recorder).not.toContain('console.log');
    expect(routingService).not.toContain('console.log');
  });
});

describe('detached tasks and the embedded terminal are wired end to end', () => {
  it('feeds the detached-task queue from spawned subagents', () => {
    expect(subagentExtension).toContain("import type { TaskQueue } from './task-queue';");
    expect(subagentExtension).toContain('taskQueue.enqueue({');
    expect(subagentExtension).toContain('taskQueue.start(queued.id);');
    expect(subagentExtension).toContain('taskQueue?.complete(queueTaskId);');
    expect(subagentExtension).toContain('taskQueue?.fail(queueTaskId,');
    expect(subagentExtension).toContain('taskQueue?.cancel(queueTaskId,');
    expect(index).toContain('controlCenterService.queue');
  });

  it('declares the embedded terminal channels in the preload bridge', () => {
    for (const channel of [
      'terminalOpen',
      'terminalList',
      'terminalSnapshot',
      'terminalWrite',
      'terminalClear',
      'terminalClose',
    ]) {
      expect(preload).toContain('controlCenter.' + channel);
    }
  });

  it('kills every terminal on shutdown', () => {
    expect(index).toContain('controlCenterService.closeAllTerminals()');
  });
});
