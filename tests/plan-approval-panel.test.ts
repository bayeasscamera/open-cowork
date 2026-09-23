import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const panel = read('src/renderer/components/PlanApprovalPanel.tsx');
const planGraph = read('src/renderer/components/PlanGraph.tsx');
const app = read('src/renderer/App.tsx');
const store = read('src/renderer/store/index.ts');
const preload = read('src/preload/index.ts');
const handlers = read('src/main/ipc/workflow-handlers.ts');
const contract = read('src/shared/task-contract.ts');
const workflowTypes = read('src/shared/workflow-types.ts');

describe('plan approval panel wiring', () => {
  it('renders the three workflow modes', () => {
    expect(panel).toContain("const MODES: WorkflowMode[] = ['explore', 'plan', 'execute'];");
    expect(panel).toContain("t('planPanel.mode.' + mode)");
  });

  it('gates execution on approval and surfaces blockers', () => {
    expect(panel).toContain('blockers.length > 0');
    expect(panel).toContain('api.approve(sessionId');
    expect(panel).toContain("t('planPanel.blockers.title')");
  });

  it('imports and renders the execution report panel', () => {
    expect(panel).toContain("import { ExecutionReportPanel } from './ExecutionReportPanel'");
    expect(panel).toContain('<ExecutionReportPanel report={execReport} totalTasks={state.tasks.length} />');
  });

  it('captures executePlan results into execReport state', () => {
    expect(panel).toContain('setExecReport(result as WorkflowExecutionReport)');
    expect(panel).toContain('WorkflowExecutionReport');
  });

  it('exposes per-task checkpoint actions', () => {
    expect(panel).toContain('api.acceptTask(sessionId, task.id)');
    expect(panel).toContain('api.rejectTask(sessionId, task.id)');
    expect(panel).toContain('api.restoreTask(sessionId, task.id)');
    expect(panel).toContain('api.restorePlan(sessionId)');
  });

  it('is mounted from the app shell behind a store flag', () => {
    expect(app).toContain("import('./components/PlanApprovalPanel')");
    expect(app).toContain('planPanelVisible');
    expect(store).toContain('planPanelVisible: boolean;');
    expect(store).toContain('setPlanPanelVisible: (visible: boolean) => void;');
  });

  it('declares every workflow channel in the preload bridge', () => {
    const channelPattern = /'workflow.([a-zA-Z]+)'/g;
    const handlerChannels = new Set<string>();
    for (const match of handlers.matchAll(channelPattern)) {
      handlerChannels.add(match[1]);
    }
    expect(handlerChannels.size).toBeGreaterThanOrEqual(16);

    for (const channel of handlerChannels) {
      expect(preload, 'preload is missing workflow.' + channel).toContain("'workflow." + channel + "'");
    }
  });

  it('surfaces write conflicts before approval', () => {
    expect(panel).toContain('const writeConflicts = state?.writeConflicts ?? [];');
    expect(panel).toContain("t('planPanel.conflicts.title')");
    expect(panel).toContain("t('planPanel.conflicts.item'");
    expect(planGraph).toContain("t('planPanel.graph.conflict')");
    expect(workflowTypes).toContain('writeConflicts: WriteScopeConflict[];');
  });

  it('keeps the IPC contract in shared so preload never imports main', () => {
    expect(preload).toContain("from '../shared/workflow-types'");
    expect(preload).not.toContain("from '../main/");
    expect(workflowTypes).toContain('export interface WorkflowState');
    expect(workflowTypes).toContain('export interface TaskCheckpoint');
    expect(contract).toContain('WORKFLOW_MODE_CAPABILITIES');
  });
});
