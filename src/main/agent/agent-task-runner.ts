/**
 * @module main/agent/agent-task-runner
 *
 * Cowork 4.0 — Phase 1.4/3.2: runs one atomic workflow task through a real LLM
 * agent session with coding tools, rooted at the task directory (the ephemeral
 * worktree when the task is isolated).
 *
 * The pi session is created behind a small `TaskSession` interface so the whole
 * runner is testable with a fake session, and so the write-scope guard can be
 * installed on the child without leaking library types everywhere.
 */

import {
  createAgentSession,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
  createCodingTools,
  DefaultResourceLoader,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type { EvidenceKind } from '../../shared/task-contract';
import { configStore } from '../config/config-store';
import { logWarn } from '../utils/logger';
import { normalizeTokenUsage } from './agent-runner-formatting';
import { getSharedAuthStorage, ModelRegistry } from './shared-auth';
import { resolvePiRegistryModel, resolvePiRouteProtocol } from './pi-model-resolution';
import { resolveSubAgentCompactionSettings } from './compaction-policy';
import {
  SHELL_TOOLS,
  WRITE_TOOLS,
  createWriteScopeGuard,
  toolCallCommand,
  type ToolBlock,
} from './write-scope-guard';
import type { WorkflowTaskContext, WorkflowTaskOutcome, WorkflowTaskRunner } from './workflow-executor';

export const DEFAULT_TASK_TIMEOUT_MS = 600_000;
export const MAX_TASK_SUMMARY_CHARS = 8_000;

export interface TaskSessionEvent {
  type?: string;
  messages?: unknown[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  args?: unknown;
  /** Present on message_end; carries the provider token usage. */
  message?: unknown;
}

export interface TaskSession {
  prompt(text: string): Promise<unknown>;
  subscribe(listener: (event: TaskSessionEvent) => void): () => void;
  dispose(): void;
  abort?(): Promise<void> | void;
  setBeforeToolCall?(
    hook: (call: { toolName: string; args: unknown }) => ToolBlock | void | Promise<ToolBlock | void>
  ): void;
}

export type TaskSessionFactory = (context: WorkflowTaskContext) => Promise<TaskSession>;

export interface AgentTaskRunnerOptions {
  /** Hard cap for a single task run, whatever the task budget says. */
  maxTimeoutMs?: number;
  /** Fallback when the task declares no time budget. */
  defaultTimeoutMs?: number;
  /** Injectable session factory (tests inject a fake). */
  sessionFactory?: TaskSessionFactory;
  now?: () => number;
}

/** System prompt prepended to every workflow task session. */
export function buildTaskSystemPrompt(context: WorkflowTaskContext): string {
  return [
    'You are a focused sub-agent inside Cowork, executing ONE atomic task of an already approved plan.',
    'Work only inside the current working directory: ' + context.cwd + '.',
    context.isolated
      ? 'This directory is an ephemeral git worktree; changes here are the task deliverable.'
      : 'Changes here land in the live workspace and are checkpointed per task.',
    'Respect the declared write scope exactly. Never edit a file outside it.',
    'Do not claim a command passed unless you actually ran it and saw it succeed.',
    'When finished, reply with a short report: what you changed, what you ran, and the observed result.',
  ].join('\n');
}

function lastAssistantText(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages)) {
    return '';
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    const text = (message.content as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    if (text.trim().length > 0) {
      return text;
    }
  }
  return '';
}

/** A command that runs a test suite is proof of the "test" evidence kind. */
const TEST_COMMAND_PATTERN =
  /\b(vitest|jest|pytest|mocha|ava)\b|(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/i;

/** Evidence kinds a tool call can produce, observed before the call runs. */
function evidenceKindsForTool(toolName: string | undefined, args: unknown): EvidenceKind[] {
  const name = (toolName ?? '').trim();
  if (WRITE_TOOLS.includes(name)) {
    return ['diff'];
  }
  if (SHELL_TOOLS.includes(name)) {
    const command = toolCallCommand(args);
    return command && TEST_COMMAND_PATTERN.test(command) ? ['command', 'test'] : ['command'];
  }
  return [];
}

function resolveTimeout(context: WorkflowTaskContext, options: AgentTaskRunnerOptions): number {
  const budget = context.task.budget.maxDurationMs;
  const fallback = options.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const chosen = typeof budget === 'number' && budget > 0 ? budget : fallback;
  return Math.max(1_000, Math.min(chosen, options.maxTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS));
}

function raceWithTimeoutAndAbort(
  promise: Promise<unknown>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error('Task timed out after ' + Math.round(timeoutMs / 1000) + 's.')),
      timeoutMs
    );
    const onAbort = (): void =>
      fail(new Error('Task aborted: budget exhausted or the run was cancelled.'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => fail(error instanceof Error ? error : new Error(String(error)))
    );
  });
}

async function disposeSession(session: TaskSession): Promise<void> {
  try {
    const result = session.abort?.();
    if (result && typeof result === 'object' && 'then' in result) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      await Promise.race([result as Promise<void>, timeout]);
    }
  } catch {
    // abort may throw once the session already completed; safe to ignore.
  }
  session.dispose();
}

/** Default factory: a real pi coding session with the write-scope guard. */
export async function createPiTaskSession(context: WorkflowTaskContext): Promise<TaskSession> {
  const config = configStore.getAll();
  const authStorage = getSharedAuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);

  const modelString = config.model?.trim() || 'anthropic/claude-sonnet-4-6';
  const configProtocol = resolvePiRouteProtocol(config.provider, config.customProtocol);
  const piModel = resolvePiRegistryModel(modelString, {
    configProvider: configProtocol,
    customBaseUrl: config.baseUrl?.trim() || undefined,
    rawProvider: config.provider,
    customProtocol: config.customProtocol,
  });
  if (!piModel) {
    throw new Error(
      'Could not resolve a model for the workflow task. Check the provider/model configuration.'
    );
  }

  const codingTools = createCodingTools(context.cwd);
  const customTools: ToolDefinition[] = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: context.cwd,
    appendSystemPrompt: buildTaskSystemPrompt(context),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model: piModel,
    authStorage,
    modelRegistry,
    tools: codingTools,
    customTools,
    sessionManager: PiSessionManager.inMemory(),
    settingsManager: PiSettingsManager.inMemory({
      // A task sub-agent had no context management at all; a long task would
      // overflow its window and fail irrecoverably. Shared policy, same as the
      // swarm and the sub-agent extension.
      compaction: resolveSubAgentCompactionSettings({
        contextWindow: piModel.contextWindow,
        provider: piModel.provider,
      }),
      retry: { enabled: true, maxRetries: 1 },
    }),
    resourceLoader,
    cwd: context.cwd,
  });

  const child = session as unknown as TaskSession;
  const guard = createWriteScopeGuard(context.task, context.cwd);
  if (typeof child.setBeforeToolCall === 'function') {
    child.setBeforeToolCall((call) => {
      const verdict = guard(call);
      if (verdict?.block) {
        // A refusal is a policy boundary: the run cannot proceed unattended.
        context.onToolBlocked?.();
      }
      return verdict;
    });
  } else {
    logWarn(
      '[WorkflowTaskRunner] Child session does not support setBeforeToolCall; write-scope guard inactive'
    );
  }
  return child;
}

/** Run one workflow task and report what happened, never throwing. */
export async function runAgentTask(
  context: WorkflowTaskContext,
  options: AgentTaskRunnerOptions = {}
): Promise<WorkflowTaskOutcome> {
  const timeoutMs = resolveTimeout(context, options);
  const factory = options.sessionFactory ?? createPiTaskSession;

  let session: TaskSession;
  try {
    session = await factory(context);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, summary: '', error: message, toolCalls: 0 };
  }

  let toolCalls = 0;
  let finalText = '';
  let tokens = 0;
  let sawTokens = false;
  let failedCommands = 0;
  const evidenceKinds = new Set<EvidenceKind>();
  const pendingEvidence = new Map<string, EvidenceKind[]>();

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      toolCalls += 1;
      context.onToolCall(1);
      const kinds = evidenceKindsForTool(event.toolName, event.args);
      if (kinds.length > 0) {
        pendingEvidence.set(event.toolCallId ?? event.toolName ?? 'call-' + toolCalls, kinds);
      }
    }
    if (event.type === 'tool_execution_end') {
      const key = event.toolCallId ?? event.toolName ?? '';
      const pending = pendingEvidence.get(key);
      if (event.isError) {
        // A failed (or guard-blocked) call proves nothing about the workspace.
        if (pending?.includes('command') || pending?.includes('test')) {
          failedCommands += 1;
        }
        pendingEvidence.delete(key);
      } else if (pending) {
        for (const kind of pending) {
          evidenceKinds.add(kind);
        }
        pendingEvidence.delete(key);
      }
    }
    if (event.type === 'message_end') {
      const message = event.message as { usage?: unknown } | undefined;
      const usage = normalizeTokenUsage(message?.usage);
      if (usage) {
        const delta = usage.input + usage.output;
        tokens += delta;
        sawTokens = true;
        context.onTokens?.(delta);
      }
    }
    if (event.type === 'agent_end') {
      const text = lastAssistantText(event.messages);
      if (text.trim().length > 0) {
        finalText = text;
      }
    }
  });

  let failure: string | undefined;
  try {
    await raceWithTimeoutAndAbort(session.prompt(context.prompt), timeoutMs, context.signal);
  } catch (error: unknown) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe();
    await disposeSession(session);
  }

  const summary = finalText.trim().slice(0, MAX_TASK_SUMMARY_CHARS);
  const observed = [...evidenceKinds];
  const usage = {
    ...(sawTokens ? { tokens } : {}),
    evidenceKinds: observed,
    failedCommands,
  };
  if (failure) {
    return { success: false, summary, error: failure, toolCalls, ...usage };
  }
  if (summary.length === 0) {
    return {
      success: false,
      summary: '',
      error: 'The task session produced no output.',
      toolCalls,
      ...usage,
    };
  }
  return { success: true, summary, toolCalls, ...usage };
}

/** WorkflowTaskRunner backed by real pi agent sessions. */
export function createAgentTaskRunner(options: AgentTaskRunnerOptions = {}): WorkflowTaskRunner {
  return (context) => runAgentTask(context, options);
}
