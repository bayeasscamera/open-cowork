/**
 * @module main/agent/teammate-bus
 *
 * Opt-in teammate question bus for the swarm (the `ask_teammate` tool).
 *
 * A sub-agent may ask ONE blocking question to another team member when it
 * genuinely cannot continue without that piece of information. This module
 * owns everything that makes the feature safe and cheap:
 *
 * - a per-team registry of members (role + task + responder);
 * - a HARD per-task call limit ({@link MAX_TEAMMATE_CALLS_PER_TASK}), so the
 *   tool can never turn into continuous chatter;
 * - a per-question deadline ({@link TEAMMATE_QUESTION_TIMEOUT_MS}) that always
 *   resolves — a blocked agent continues with its best judgment instead of
 *   hanging;
 * - one question / one answer, no dialogue: a follow-up is just another call
 *   and therefore spends one of the two allowed slots;
 * - an audit trail of every exchange (who asked what, when, and the exact
 *   model-call cost) reused by the swarm cost report.
 *
 * The target is NEVER interrupted mid-thought: questions accumulate in its
 * queue and are drained only at an explicit task boundary
 * ({@link markTeammateBoundary}, called on every tool completion). The actual
 * answering is delegated to an injected {@link TeammateResponder}, which keeps
 * this module free of any LLM dependency and trivially testable.
 *
 * Cost contract: an answered exchange costs exactly ONE model call; a timeout,
 * an unavailable target and a limit rejection cost ZERO. A swarm that never
 * calls `ask_teammate` therefore spends exactly the same number of model calls
 * as the classic DAG.
 */

/** Hard cap on `ask_teammate` calls per sub-agent per task. */
export const MAX_TEAMMATE_CALLS_PER_TASK = 2;

/** Default deadline for one question, in milliseconds. */
export const TEAMMATE_QUESTION_TIMEOUT_MS = 30_000;

/** Handed back to the asker when nobody answered in time. */
export const TEAMMATE_TIMEOUT_FALLBACK =
  'No answer in time — continue with your best judgment and state the assumption you made in your final report.';

/** Handed back to the asker when the target could not answer at all. */
export const TEAMMATE_UNAVAILABLE_FALLBACK =
  'No teammate answered — continue with your best judgment and state the assumption you made in your final report.';

/** Handed back to the asker once its two questions are spent. */
export const TEAMMATE_LIMIT_FALLBACK =
  'Teammate question limit reached (2 per task) — continue with your best judgment and state the assumption you made in your final report.';

export type TeammateExchangeStatus = 'answered' | 'timeout' | 'unavailable' | 'limit';

/** One traced question/answer exchange. */
export interface TeammateExchange {
  id: string;
  fromRole: string;
  fromTaskId: string;
  targetRole: string;
  question: string;
  answer: string;
  status: TeammateExchangeStatus;
  /** Model calls this exchange actually spent (1 when answered, 0 otherwise). */
  modelCalls: number;
  /** Epoch ms at which the question was asked. */
  at: number;
  durationMs: number;
}

/** Context handed to a responder when the target reaches a task boundary. */
export interface TeammateResponderContext {
  askedByRole: string;
  askedByTaskId: string;
  /** Aborted when the question deadline expires. */
  signal: AbortSignal;
}

/** Answers one teammate question on the target's behalf. */
export type TeammateResponder = (
  question: string,
  context: TeammateResponderContext
) => Promise<string>;

export interface TeammateMemberInput {
  role: string;
  taskId: string;
  responder: TeammateResponder;
}

interface PendingRequest {
  id: string;
  fromRole: string;
  fromTaskId: string;
  targetRole: string;
  question: string;
  at: number;
  settled: boolean;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  member: TeammateMember;
  resolve: (exchange: TeammateExchange) => void;
}

interface TeammateMember {
  role: string;
  taskId: string;
  responder: TeammateResponder;
  queue: PendingRequest[];
  draining: boolean;
  closed: boolean;
}

export interface TeammateTeam {
  readonly id: string;
  members: Map<string, TeammateMember>;
  exchanges: TeammateExchange[];
  calls: Map<string, number>;
}

export interface AskTeammateInput {
  fromRole: string;
  fromTaskId: string;
  targetRole: string;
  question: string;
  timeoutMs?: number;
}

const teams = new Map<string, TeammateTeam>();
let exchangeCounter = 0;

/** Get (or lazily create) the shared bus for one swarm plan. */
export function getTeammateTeam(teamId: string): TeammateTeam {
  const existing = teams.get(teamId);
  if (existing) return existing;
  const created: TeammateTeam = {
    id: teamId,
    members: new Map(),
    exchanges: [],
    calls: new Map(),
  };
  teams.set(teamId, created);
  return created;
}

/** Drop a finished team, resolving anything still queued as unavailable. */
export function disposeTeammateTeam(teamId: string): void {
  const team = teams.get(teamId);
  if (!team) return;
  for (const taskId of [...team.members.keys()]) {
    unregisterTeammate(team, taskId);
  }
  teams.delete(teamId);
}

/** Test hook: forget every registered team. */
export function __resetTeammateTeamsForTest(): void {
  teams.clear();
  exchangeCounter = 0;
}

/** Register a sub-agent as an answerable teammate for the duration of its task. */
export function registerTeammate(team: TeammateTeam, input: TeammateMemberInput): void {
  const previous = team.members.get(input.taskId);
  if (previous) {
    previous.closed = true;
    settleQueuedAsUnavailable(team, previous);
  }
  team.members.set(input.taskId, {
    role: input.role,
    taskId: input.taskId,
    responder: input.responder,
    queue: [],
    draining: false,
    closed: false,
  });
}

/** Resolve every queued question of a member as unavailable and close it. */
function settleQueuedAsUnavailable(team: TeammateTeam, member: TeammateMember): void {
  const pending = member.queue.splice(0, member.queue.length);
  for (const request of pending) {
    settle(team, request, 'unavailable', TEAMMATE_UNAVAILABLE_FALLBACK, 0);
  }
}

/** Unregister a finished sub-agent; queued questions degrade to unavailable. */
export function unregisterTeammate(team: TeammateTeam, taskId: string): void {
  const member = team.members.get(taskId);
  if (!member) return;
  member.closed = true;
  settleQueuedAsUnavailable(team, member);
  team.members.delete(taskId);
}

/** How many `ask_teammate` calls a given task has already spent. */
export function callsUsed(team: TeammateTeam, taskId: string): number {
  return team.calls.get(taskId) ?? 0;
}

/** Copy of every traced exchange, in ask order. */
export function getTeammateExchanges(team: TeammateTeam): TeammateExchange[] {
  return [...team.exchanges];
}

/** Total model calls spent answering teammate questions. */
export function countTeammateModelCalls(team: TeammateTeam): number {
  return team.exchanges.reduce((sum, exchange) => sum + exchange.modelCalls, 0);
}

/**
 * Ask one teammate ONE question. Always resolves:
 * - `answered` when the target reached a boundary and answered;
 * - `timeout` when the deadline expired first;
 * - `unavailable` when no member holds the target role;
 * - `limit` when the asker already spent its two calls (not counted).
 */
export function askTeammate(team: TeammateTeam, input: AskTeammateInput): Promise<TeammateExchange> {
  const timeoutMs = input.timeoutMs ?? TEAMMATE_QUESTION_TIMEOUT_MS;
  const used = callsUsed(team, input.fromTaskId);
  if (used >= MAX_TEAMMATE_CALLS_PER_TASK) {
    return Promise.resolve(
      trace(team, {
        fromRole: input.fromRole,
        fromTaskId: input.fromTaskId,
        targetRole: input.targetRole,
        question: input.question,
        answer: TEAMMATE_LIMIT_FALLBACK,
        status: 'limit',
        modelCalls: 0,
        durationMs: 0,
      })
    );
  }
  // Counted BEFORE resolving the target: an unavailable teammate or a silent
  // one still spends a call, which is what makes the cap impossible to bypass
  // by spraying questions at roles that do not exist.
  team.calls.set(input.fromTaskId, used + 1);

  const member = findMemberByRole(team, input.targetRole);
  if (!member) {
    return Promise.resolve(
      trace(team, {
        fromRole: input.fromRole,
        fromTaskId: input.fromTaskId,
        targetRole: input.targetRole,
        question: input.question,
        answer: TEAMMATE_UNAVAILABLE_FALLBACK,
        status: 'unavailable',
        modelCalls: 0,
        durationMs: 0,
      })
    );
  }

  return new Promise<TeammateExchange>((resolve) => {
    const request: PendingRequest = {
      id: `tq-${++exchangeCounter}`,
      fromRole: input.fromRole,
      fromTaskId: input.fromTaskId,
      targetRole: input.targetRole,
      question: input.question,
      at: Date.now(),
      settled: false,
      controller: new AbortController(),
      timer: undefined,
      member,
      resolve,
    };
    request.timer = setTimeout(() => {
      request.controller.abort();
      settle(team, request, 'timeout', TEAMMATE_TIMEOUT_FALLBACK, 0);
    }, timeoutMs);
    member.queue.push(request);
  });
}

function findMemberByRole(team: TeammateTeam, role: string): TeammateMember | undefined {
  for (const member of team.members.values()) {
    if (member.role === role && !member.closed) return member;
  }
  return undefined;
}

/**
 * Signal that a sub-agent finished one action and can answer its queue.
 * Deliberately non-blocking and non-throwing: a teammate question must never
 * slow down or break the target's own task loop.
 */
export function markTeammateBoundary(team: TeammateTeam, taskId: string): void {
  void drainTeammate(team, taskId).catch(() => {
    // drainTeammate already settles every request; nothing to propagate.
  });
}

/**
 * Await a teammate's queue drain. Used at task teardown, where the last queued
 * questions deserve an answer before the member is unregistered.
 */
export async function drainTeammate(team: TeammateTeam, taskId: string): Promise<void> {
  const member = team.members.get(taskId);
  if (!member || member.closed) return;
  await drainMember(team, member);
}

async function drainMember(team: TeammateTeam, member: TeammateMember): Promise<void> {
  if (member.draining) return;
  member.draining = true;
  try {
    while (!member.closed && member.queue.length > 0) {
      const request = member.queue.shift();
      if (!request || request.settled) continue;
      await answerRequest(team, member, request);
    }
  } finally {
    member.draining = false;
  }
}

async function answerRequest(
  team: TeammateTeam,
  member: TeammateMember,
  request: PendingRequest
): Promise<void> {
  if (request.settled) return;
  try {
    const answer = await member.responder(request.question, {
      askedByRole: request.fromRole,
      askedByTaskId: request.fromTaskId,
      signal: request.controller.signal,
    });
    const text = answer.trim();
    settle(
      team,
      request,
      'answered',
      text || TEAMMATE_UNAVAILABLE_FALLBACK,
      text ? 1 : 0
    );
  } catch {
    settle(team, request, 'unavailable', TEAMMATE_UNAVAILABLE_FALLBACK, 0);
  }
}

function settle(
  team: TeammateTeam,
  request: PendingRequest,
  status: TeammateExchangeStatus,
  answer: string,
  modelCalls: number
): void {
  if (request.settled) return;
  request.settled = true;
  if (request.timer) clearTimeout(request.timer);
  // Drop it from the queue so a timed-out question can never linger or grow
  // the target's pending list unbounded.
  const queued = request.member.queue.indexOf(request);
  if (queued >= 0) request.member.queue.splice(queued, 1);
  request.resolve(
    trace(team, {
      fromRole: request.fromRole,
      fromTaskId: request.fromTaskId,
      targetRole: request.targetRole,
      question: request.question,
      answer,
      status,
      modelCalls,
      at: request.at,
      durationMs: Date.now() - request.at,
    })
  );
}

function trace(
  team: TeammateTeam,
  exchange: Omit<TeammateExchange, 'id' | 'at'> & { at?: number }
): TeammateExchange {
  const traced: TeammateExchange = {
    ...exchange,
    id: `tq-${++exchangeCounter}`,
    at: exchange.at ?? Date.now(),
  };
  team.exchanges.push(traced);
  return traced;
}


/** Aggregate cost/usage view of a team's teammate exchanges. */
export interface TeammateUsageSummary {
  exchanges: number;
  answered: number;
  timeouts: number;
  unavailable: number;
  limited: number;
  modelCalls: number;
}

export function summarizeTeammateExchanges(exchanges: TeammateExchange[]): TeammateUsageSummary {
  const count = (status: TeammateExchangeStatus): number =>
    exchanges.filter((exchange) => exchange.status === status).length;
  return {
    exchanges: exchanges.length,
    answered: count('answered'),
    timeouts: count('timeout'),
    unavailable: count('unavailable'),
    limited: count('limit'),
    modelCalls: exchanges.reduce((sum, exchange) => sum + exchange.modelCalls, 0),
  };
}

/**
 * Honest audit section appended to the swarm report. Returns '' when no
 * teammate question was ever asked, so a default run's report is unchanged.
 */
export function formatTeammateReportSection(exchanges: TeammateExchange[]): string {
  if (exchanges.length === 0) return '';
  const summary = summarizeTeammateExchanges(exchanges);
  const lines = exchanges.map((exchange) => {
    const plural = exchange.modelCalls === 1 ? '' : 's';
    const head =
      `- [${exchange.status}] ${exchange.fromRole} → ${exchange.targetRole} ` +
      `(${exchange.durationMs}ms, ${exchange.modelCalls} model call${plural})`;
    return [head, `  Q: ${exchange.question.trim()}`, `  A: ${exchange.answer.trim()}`].join('\n');
  });
  return [
    '### Teammate questions (opt-in)',
    `${summary.exchanges} question(s): ${summary.answered} answered, ` +
      `${summary.timeouts} timeout, ${summary.unavailable} unavailable, ` +
      `${summary.limited} refused (limit) — ${summary.modelCalls} extra model call(s).`,
    ...lines,
  ].join('\n');
}

