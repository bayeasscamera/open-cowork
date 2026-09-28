/**
 * Centralized Zustand store selectors.
 *
 * Rules:
 *  - All hooks use the `use` prefix.
 *  - Per-session derived state always falls back to safe empty values so
 *    callers never have to guard against undefined.
 *  - Hooks that subscribe to more than one scalar field use `useShallow` so
 *    that the component only re-renders when one of the selected values
 *    actually changes by reference / value.
 *
 * Usage example:
 *   const session = useCurrentSession();
 *   const messages = useActiveSessionMessages();
 */

import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from './index';
import type {
  Session,
  Message,
  TraceStep,
  Settings,
  AppConfig,
  ContentBlock,
  ToolUseContent,
  ToolResultContent,
} from '../types';
import type { GlobalNotice, SessionExecutionClock, CompactionEvent } from './index';

/**
 * Shared empty references.
 *
 * A `?? []` inside a zustand selector allocates a NEW array on every read, so
 * `Object.is` never matches and the component re-renders on every unrelated
 * store update — with a streamed response that is once per frame. Returning a
 * shared constant keeps the subscription stable.
 */
const EMPTY_STEPS: TraceStep[] = [];
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_BLOCKS: ContentBlock[] = [];

// ---------------------------------------------------------------------------
// Session domain
// ---------------------------------------------------------------------------

/** Returns the full list of sessions. */
export function useSessions(): Session[] {
  return useAppStore((s) => s.sessions);
}

/** Returns the ID of the currently active session (may be null). */
export function useActiveSessionId(): string | null {
  return useAppStore((s) => s.activeSessionId);
}

/**
 * Returns the active Session object, or null when none is selected.
 * Stable reference: re-renders only when the active session object changes.
 */
export function useCurrentSession(): Session | null {
  return useAppStore(
    useShallow((s) =>
      s.activeSessionId ? (s.sessions.find((sess) => sess.id === s.activeSessionId) ?? null) : null
    )
  );
}

/** Returns whether the active session is currently executing. */
export function useIsSessionRunning(): boolean {
  return useAppStore((s) => {
    if (!s.activeSessionId) return false;
    const session = s.sessions.find((sess) => sess.id === s.activeSessionId);
    return session?.status === 'running';
  });
}

// ---------------------------------------------------------------------------
// Message domain
// ---------------------------------------------------------------------------

/** Returns the committed messages for the active session. */
export function useActiveSessionMessages(): Message[] {
  return useAppStore((s) =>
    s.activeSessionId ? (s.sessionStates[s.activeSessionId]?.messages ?? []) : []
  );
}

/**
 * Returns the messages for an arbitrary session by ID.
 * Useful in list components that render session previews.
 *
 * The empty fallback is a shared constant: a fresh `[]` here would fail the
 * store's identity check on every read and re-render subscribers constantly.
 */
export function useSessionMessages(sessionId: string | undefined): Message[] {
  return useAppStore((s) => (sessionId ? s.sessionStates[sessionId]?.messages : undefined) ?? EMPTY_MESSAGES);
}

/** Returns the in-progress (streaming) text of the active session's response. */
export function useActivePartialMessage(): string {
  return useAppStore((s) =>
    s.activeSessionId ? (s.sessionStates[s.activeSessionId]?.partialMessage ?? '') : ''
  );
}

/** Returns the in-progress thinking text for the active session. */
export function useActivePartialThinking(): string {
  return useAppStore((s) =>
    s.activeSessionId ? (s.sessionStates[s.activeSessionId]?.partialThinking ?? '') : ''
  );
}

/**
 * Returns both partial message and partial thinking for the active session in
 * a single subscription so the consumer only renders once per streaming tick.
 */
export function useActivePartialContent(): { partialMessage: string; partialThinking: string } {
  return useAppStore(
    useShallow((s) => ({
      partialMessage: s.activeSessionId
        ? (s.sessionStates[s.activeSessionId]?.partialMessage ?? '')
        : '',
      partialThinking: s.activeSessionId
        ? (s.sessionStates[s.activeSessionId]?.partialThinking ?? '')
        : '',
    }))
  );
}

// ---------------------------------------------------------------------------
// Turn / execution state domain
// ---------------------------------------------------------------------------

/** Returns the active turn info for the current session (or null). */
export function useActiveTurn(): { stepId: string; userMessageId: string } | null {
  return useAppStore((s) =>
    s.activeSessionId ? (s.sessionStates[s.activeSessionId]?.activeTurn ?? null) : null
  );
}

/** Returns the list of pending turn message IDs for the active session. */
export function usePendingTurns(): string[] {
  return useAppStore((s) =>
    s.activeSessionId ? (s.sessionStates[s.activeSessionId]?.pendingTurns ?? []) : []
  );
}

/**
 * Returns a summary of the execution state for the active session.
 * Combines running status, active turn, and pending count in one subscription.
 */
export function useActiveSessionExecution(): {
  isRunning: boolean;
  hasActiveTurn: boolean;
  pendingCount: number;
  canStop: boolean;
} {
  return useAppStore(
    useShallow((s) => {
      const id = s.activeSessionId;
      const session = id ? s.sessions.find((sess) => sess.id === id) : undefined;
      const isRunning = session?.status === 'running';
      const activeTurn = id ? (s.sessionStates[id]?.activeTurn ?? null) : null;
      const hasActiveTurn = Boolean(activeTurn);
      const pendingCount = id ? (s.sessionStates[id]?.pendingTurns ?? []).length : 0;
      return {
        isRunning,
        hasActiveTurn,
        pendingCount,
        canStop: isRunning || hasActiveTurn || pendingCount > 0,
      };
    })
  );
}

/** Returns the execution clock record for the active session. */
export function useActiveExecutionClock(): SessionExecutionClock | undefined {
  return useAppStore((s) =>
    s.activeSessionId ? s.sessionStates[s.activeSessionId]?.executionClock : undefined
  );
}

// ---------------------------------------------------------------------------
// Trace steps domain
// ---------------------------------------------------------------------------

/** Returns the trace steps for the active session. */
export function useActiveTraceSteps(): TraceStep[] {
  return useAppStore((s) =>
    s.activeSessionId ? (s.sessionStates[s.activeSessionId]?.traceSteps ?? EMPTY_STEPS) : EMPTY_STEPS
  );
}

// ---------------------------------------------------------------------------
// Tool block index
// ---------------------------------------------------------------------------

/**
 * Lookup tables for the tool blocks of one session, so the chat no longer
 * scans every message for every rendered block.
 *
 * Both ToolUseBlock and ToolResultBlock pair a `tool_use` with its
 * `tool_result`. They used to do that with a nested loop over all messages ×
 * all blocks, per component, recomputed whenever the message list changed — and
 * the message list changes on every streamed turn. With a few dozen tool calls
 * that is quadratic work in the hot path, on exactly the long sessions where
 * the UI already struggles.
 *
 * The index is cached per message-array reference in a WeakMap: a new array
 * (any real change) rebuilds, an unchanged one is free, and nothing can go
 * stale because the cache entry dies with the array it was built from.
 */
export interface SessionBlockIndex {
  /** tool_use blocks by their own id. */
  toolUseById: Map<string, ToolUseContent>;
  /** tool_result blocks by the id of the tool_use they answer. */
  toolResultByToolUseId: Map<string, ToolResultContent>;
}

const blockIndexCache = new WeakMap<Message[], SessionBlockIndex>();

/** Stable empty index, so a session with no messages never allocates. */
const EMPTY_BLOCK_INDEX: SessionBlockIndex = {
  toolUseById: new Map(),
  toolResultByToolUseId: new Map(),
};

function isContentBlockList(content: unknown): content is ContentBlock[] {
  return Array.isArray(content);
}

export function buildSessionBlockIndex(messages: Message[]): SessionBlockIndex {
  const cached = blockIndexCache.get(messages);
  if (cached) return cached;
  const toolUseById = new Map<string, ToolUseContent>();
  const toolResultByToolUseId = new Map<string, ToolResultContent>();
  for (const message of messages) {
    if (!isContentBlockList(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) {
        toolUseById.set(block.id, block as ToolUseContent);
      } else if (block.type === 'tool_result' && block.toolUseId) {
        toolResultByToolUseId.set(block.toolUseId, block as ToolResultContent);
      }
    }
  }
  const index: SessionBlockIndex = { toolUseById, toolResultByToolUseId };
  blockIndexCache.set(messages, index);
  return index;
}

/** The empty index, for callers with no session. */
export function emptySessionBlockIndex(): SessionBlockIndex {
  return EMPTY_BLOCK_INDEX;
}

/** Trace steps of one session, with a stable empty fallback. */
export function useSessionTraceSteps(sessionId: string | undefined): TraceStep[] {
  return useAppStore((s) =>
    sessionId ? (s.sessionStates[sessionId]?.traceSteps ?? EMPTY_STEPS) : EMPTY_STEPS
  );
}

// ---------------------------------------------------------------------------
// Trace step index
// ---------------------------------------------------------------------------

/**
 * Lookup tables for the trace steps of one session.
 *
 * A session keeps one step per thought, tool call and tool result for every
 * turn it has ever served, and the list is reloaded whole on every session
 * switch. Both tool blocks used to answer "what is the duration / tool name of
 * this step?" with a linear scan over that entire list, once per rendered
 * block — quadratic in the length of the conversation, which is the one thing
 * that grows while the user watches.
 *
 * Steps are keyed by id AND type because the two tool blocks look for the
 * same id under different types: a tool_call step and the tool_result step that
 * completes it share the tool-use id.
 *
 * Cached per array reference in a WeakMap, like the block index: a new array
 * rebuilds, an unchanged one is free, nothing can go stale.
 */
export interface TraceStepIndex {
  /** Steps by `${id} ${type}` — the pairing key both tool blocks need. */
  byIdAndType: Map<string, TraceStep>;
  /** Steps grouped by the run (user turn) that emitted them, oldest first. */
  byRunId: Map<string, TraceStep[]>;
  /** The run id of the most recently added step, or undefined when none. */
  latestRunId: string | undefined;
}

/** Composite key for a step: id plus type, since both are needed to identify it. */
export function traceStepKey(id: string, type: TraceStep['type']): string {
  return `${id} ${type}`;
}

const traceStepIndexCache = new WeakMap<TraceStep[], TraceStepIndex>();

const EMPTY_TRACE_STEP_INDEX: TraceStepIndex = {
  byIdAndType: new Map(),
  byRunId: new Map(),
  latestRunId: undefined,
};

export function buildTraceStepIndex(steps: TraceStep[]): TraceStepIndex {
  const cached = traceStepIndexCache.get(steps);
  if (cached) return cached;

  const byIdAndType = new Map<string, TraceStep>();
  const byRunId = new Map<string, TraceStep[]>();
  let latestRunId: string | undefined;

  for (const step of steps) {
    if (!step || typeof step.id !== 'string') continue;
    byIdAndType.set(traceStepKey(step.id, step.type), step);
    // Steps written before the run column existed carry no run id. They still
    // resolve through byIdAndType; they simply are not attributed to a turn.
    if (step.runId) {
      const bucket = byRunId.get(step.runId);
      if (bucket) {
        bucket.push(step);
      } else {
        byRunId.set(step.runId, [step]);
      }
      latestRunId = step.runId;
    }
  }

  const index: TraceStepIndex = { byIdAndType, byRunId, latestRunId };
  traceStepIndexCache.set(steps, index);
  return index;
}

/** The empty index, for callers with no session. */
export function emptyTraceStepIndex(): TraceStepIndex {
  return EMPTY_TRACE_STEP_INDEX;
}

/**
 * The step answering a tool_use id — the same lookup the tool blocks perform,
 * exposed for components that only hold a tool-use id.
 */
export function findToolResultStep(
  index: TraceStepIndex,
  toolUseId: string
): TraceStep | undefined {
  return index.byIdAndType.get(traceStepKey(toolUseId, 'tool_result'));
}

/** The tool_call step that opened a tool_use id. */
export function findToolCallStep(
  index: TraceStepIndex,
  toolUseId: string
): TraceStep | undefined {
  return index.byIdAndType.get(traceStepKey(toolUseId, 'tool_call'));
}

/**
 * The steps of one run, oldest first — the per-turn view a report needs when
 * a session has served several turns. Returns undefined when the run is
 * unknown, so a caller can tell "no such run" from "a run with no steps".
 */
export function selectRunTraceSteps(
  steps: TraceStep[],
  runId: string | undefined
): TraceStep[] | undefined {
  if (!runId) return undefined;
  return buildTraceStepIndex(steps).byRunId.get(runId);
}

/**
 * Blocks of one message, with a stable empty fallback. Memoised on the block
 * array itself so an unchanged message never recomputes the tool pairings.
 */
export function useMessageBlocks(blocks: ContentBlock[] | undefined): ContentBlock[] {
  return blocks ?? EMPTY_BLOCKS;
}

/** Returns the context window size (token count) for the active session. */
export function useActiveContextWindow(): number | undefined {
  return useAppStore((s) =>
    s.activeSessionId ? s.sessionStates[s.activeSessionId]?.contextWindow : undefined
  );
}

// ---------------------------------------------------------------------------
// UI layout domain
// ---------------------------------------------------------------------------

/**
 * Returns sidebar and context-panel collapsed flags in a single subscription
 * so layout components don't register two separate subscriptions.
 */
export function useLayoutState(): { sidebarCollapsed: boolean; contextPanelCollapsed: boolean } {
  return useAppStore(
    useShallow((s) => ({
      sidebarCollapsed: s.sidebarCollapsed,
      contextPanelCollapsed: s.contextPanelCollapsed,
    }))
  );
}

/** Returns whether the settings panel is open, plus the active tab. */
export function useSettingsState(): { showSettings: boolean; settingsTab: string | null } {
  return useAppStore(
    useShallow((s) => ({
      showSettings: s.showSettings,
      settingsTab: s.settingsTab,
    }))
  );
}

// ---------------------------------------------------------------------------
// Config / auth domain
// ---------------------------------------------------------------------------

/** Returns the application configuration object (may be null until loaded). */
export function useAppConfig(): AppConfig | null {
  return useAppStore((s) => s.appConfig);
}

/** Returns whether the app has been configured with valid API credentials. */
export function useIsConfigured(): boolean {
  return useAppStore((s) => s.isConfigured);
}

/**
 * Returns the config-related modal/notice state in one subscription.
 * Useful in App.tsx where these flags control overlay visibility.
 */
export function useConfigModalState(): {
  showConfigModal: boolean;
  isConfigured: boolean;
  appConfig: AppConfig | null;
} {
  return useAppStore(
    useShallow((s) => ({
      showConfigModal: s.showConfigModal,
      isConfigured: s.isConfigured,
      appConfig: s.appConfig,
    }))
  );
}

// ---------------------------------------------------------------------------
// Settings domain
// ---------------------------------------------------------------------------

/** Returns the user settings object. */
export function useSettings(): Settings {
  return useAppStore((s) => s.settings);
}

/** Returns only the theme setting to avoid re-renders from unrelated settings changes. */
export function useThemeSetting(): Settings['theme'] {
  return useAppStore((s) => s.settings.theme);
}

/** Returns whether the OS is currently in dark mode. */
export function useSystemDarkMode(): boolean {
  return useAppStore((s) => s.systemDarkMode);
}

// ---------------------------------------------------------------------------
// Sandbox domain
// ---------------------------------------------------------------------------

/** Returns the current sandbox sync status. */
export function useSandboxSyncStatus() {
  return useAppStore((s) => s.sandboxSyncStatus);
}

/** Returns the sandbox setup progress and completion flag together. */
export function useSandboxSetupState() {
  return useAppStore(
    useShallow((s) => ({
      progress: s.sandboxSetupProgress,
      isComplete: s.isSandboxSetupComplete,
    }))
  );
}

// ---------------------------------------------------------------------------
// Misc domain
// ---------------------------------------------------------------------------

/** Returns the active global notice banner (or null when none). */
export function useGlobalNotice(): GlobalNotice | null {
  return useAppStore((s) => s.globalNotice);
}

/** Returns the current working directory. */
export function useWorkingDir(): string | null {
  return useAppStore((s) => s.workingDir);
}

/** Returns pending permission and sudo-password requests. */
export function usePendingDialogs() {
  return useAppStore(
    useShallow((s) => ({
      pendingPermission: s.pendingPermission,
      pendingSudoPassword: s.pendingSudoPassword,
    }))
  );
}

/** Returns the compaction event history for the active session. */
export function useActiveCompactionHistory(): CompactionEvent[] {
  return useAppStore((s) =>
    s.activeSessionId ? (s.sessionStates[s.activeSessionId]?.compactionHistory ?? []) : []
  );
}
