import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useAppStore } from '../src/renderer/store';
import type { WorkflowState } from '../src/shared/workflow-types';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const banner = read('src/renderer/components/WorkflowStatusBanner.tsx');
const app = read('src/renderer/App.tsx');
const storeSource = read('src/renderer/store/index.ts');
const ipc = read('src/renderer/hooks/useIPC.ts');
const serverTypes = read('src/shared/types.ts');
const mainIndex = read('src/main/index.ts');

function workflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    phase: 'executing',
    mode: 'execute',
    contractId: 'contract-1',
    objective: 'Ship the workflow banner',
    tasks: [],
    groups: [],
    completedTaskIds: [],
    readyTaskIds: [],
    approval: null,
    approvalOutcome: null,
    checkpoints: [],
    blockers: [],
    updatedAt: 1,
    ...overrides,
  };
}

describe('workflow status store slice', () => {
  beforeEach(() => {
    useAppStore.setState({ workflowStates: {} });
  });

  it('keeps workflow state per session', () => {
    const { setWorkflowState } = useAppStore.getState();
    setWorkflowState('s1', workflowState());
    setWorkflowState('s2', workflowState({ phase: 'completed', updatedAt: 2 }));

    const states = useAppStore.getState().workflowStates;
    expect(states.s1.phase).toBe('executing');
    expect(states.s2.phase).toBe('completed');
  });

  it('replaces the previous state for the same session', () => {
    const { setWorkflowState } = useAppStore.getState();
    setWorkflowState('s1', workflowState());
    setWorkflowState('s1', workflowState({ phase: 'verifying', updatedAt: 9 }));

    expect(useAppStore.getState().workflowStates.s1.phase).toBe('verifying');
    expect(useAppStore.getState().workflowStates.s1.updatedAt).toBe(9);
  });
});

describe('workflow status banner', () => {
  it('renders the live phase from the store slice', () => {
    expect(banner).toContain('useAppStore((s) => s.workflowStates[sessionId] ?? null)');
    expect(banner).toContain("t('planPanel.phase.' + state.phase)");
  });

  it('hides itself while no plan exists', () => {
    expect(banner).toContain('!state || !state.contractId');
  });

  it('re-fetches state so restored workflows stay visible', () => {
    expect(banner).toContain('.getState(sessionId)');
    expect(banner).toContain('setWorkflowState(sessionId, next)');
  });

  it('shows progress, blockers and an entry point to the plan panel', () => {
    expect(banner).toContain("t('workflowBanner.progress', { done, total })");
    expect(banner).toContain("t('workflowBanner.blockers', { count: state.blockers.length })");
    expect(banner).toContain('setPlanPanelVisible(true)');
  });

  it('surfaces running sub-agents and links to the consolidated activity view', () => {
    expect(banner).toContain('useSubagentStates(sessionId)');
    expect(banner).toContain("t('workflowBanner.subagents', { count: runningSubagents })");
    expect(banner).toContain("t('workflowBanner.openCenter')");
    expect(banner).toContain('setControlCenterVisible(true)');
  });

  it('is mounted from the app shell for the active session', () => {
    expect(app).toContain(
      "import { WorkflowStatusBanner } from './components/WorkflowStatusBanner'"
    );
    expect(app).toContain('<WorkflowStatusBanner sessionId={activeSessionId} />');
  });
});

describe('workflow state push plumbing', () => {
  it('declares the workflow.state server event', () => {
    expect(serverTypes).toContain("type: 'workflow.state'");
    expect(serverTypes).toContain('payload: { sessionId: string; state: WorkflowState }');
  });

  it('broadcasts orchestrator transitions from the main process', () => {
    expect(mainIndex).toContain('onStateChange: (sessionId, state) => {');
    expect(mainIndex).toContain(
      "sendToRenderer({ type: 'workflow.state', payload: { sessionId, state } })"
    );
  });

  it('routes the event into the store slice', () => {
    expect(ipc).toContain("case 'workflow.state':");
    expect(ipc).toContain('store.setWorkflowState(event.payload.sessionId, event.payload.state)');
  });

  it('declares the store slice and its action', () => {
    expect(storeSource).toContain('workflowStates: Record<string, WorkflowState>;');
    expect(storeSource).toContain('setWorkflowState: (sessionId: string, state: WorkflowState) => void;');
    expect(storeSource).toContain('workflowStates: {},');
  });

  it('ships the banner strings in every locale', () => {
    for (const locale of ['en', 'fr', 'zh']) {
      const json = JSON.parse(
        read('src/renderer/i18n/locales/' + locale + '.json')
      ) as { workflowBanner?: Record<string, string> };
      expect(json.workflowBanner, locale).toBeDefined();
      expect(Object.keys(json.workflowBanner ?? {}).sort()).toEqual([
        'blockers',
        'cancel',
        'dismiss',
        'open',
        'openCenter',
        'pause',
        'progress',
        'resume',
        'subagents',
        'tokens',
      ]);
    }
  });
});
