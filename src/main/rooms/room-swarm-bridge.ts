/**
 * @module main/rooms/room-swarm-bridge
 *
 * Mirrors a settled swarm plan into a room, so what a multi-agent run produced
 * survives the run.
 *
 * This is deliberately a one-way copy taken at one moment: right after the plan
 * settles and before the teammate bus is disposed. The bus is plan-scoped
 * scratch state that a swarm must not carry across runs, so reading from the
 * plan's own tasks — which the coordinator already populated — is the correct
 * source rather than reaching into the live bus.
 *
 * Nothing here changes how a swarm executes. A room is a record of what already
 * happened; recording it must not be able to fail the run that produced it, so
 * every failure here is swallowed by the caller rather than thrown.
 */

import type { MultiAgentPlan } from '../agent/multi-agent-coordinator';
import type { TeammateExchange } from '../agent/teammate-bus';
import type { RoomStore } from './room-store';

/** Longest task result kept verbatim in a room note. */
const MAX_RESULT_CHARS = 4000;

/** Longest error text kept verbatim. */
const MAX_ERROR_CHARS = 500;

export interface CaptureSwarmInput {
  plan: MultiAgentPlan;
  store: RoomStore;
  sessionId?: string | null;
  projectId?: string | null;
  /** Names the room after the goal unless a better label is supplied. */
  roomName?: string;
}

export interface CapturedRoom {
  roomId: string;
  created: boolean;
  exchangesRecorded: number;
  modelCalls: number;
}

function planRoomName(goal: string): string {
  const trimmed = goal.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}…`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Copy one swarm plan into a room. Returns what was written so the caller can
 * report it.
 */
export function captureSwarmIntoRoom(input: CaptureSwarmInput): CapturedRoom {
  const { plan, store } = input;

  const room = store.create({
    name: input.roomName ?? planRoomName(plan.goal),
    goal: plan.goal,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
  });

  for (const task of plan.tasks) {
    store.addMember(room.id, task.role, task.id);

    // What the task produced, so the room is readable without the swarm report.
    if (task.result) {
      store.postMessage({
        roomId: room.id,
        fromRole: task.role,
        kind: 'note',
        body: clip(`[${task.title}] ${task.result}`, MAX_RESULT_CHARS),
      });
    }
    if (task.error) {
      store.postMessage({
        roomId: room.id,
        fromRole: task.role,
        kind: 'note',
        body: clip(`[${task.title}] failed: ${task.error}`, MAX_ERROR_CHARS),
      });
    }
    if (task.modifiedFiles && task.modifiedFiles.length > 0) {
      store.postMessage({
        roomId: room.id,
        fromRole: task.role,
        kind: 'note',
        body: `[${task.title}] modified ${task.modifiedFiles.length} file(s): ${task.modifiedFiles
          .slice(0, 20)
          .join(', ')}`,
      });
    }
  }

  let exchangesRecorded = 0;
  let modelCalls = 0;
  for (const task of plan.tasks) {
    const exchanges = (task.teammateExchanges ?? []) as TeammateExchange[];
    for (const exchange of exchanges) {
      store.recordExchange({
        roomId: room.id,
        fromRole: exchange.fromRole,
        fromTaskId: exchange.fromTaskId,
        targetRole: exchange.targetRole,
        question: clip(exchange.question, MAX_RESULT_CHARS),
        // An unanswered question carries a fallback string from the bus; keeping
        // it is what explains why the blocked agent continued.
        answer: clip(exchange.answer, MAX_RESULT_CHARS),
        status: exchange.status,
        modelCalls: exchange.modelCalls,
        at: exchange.at,
        durationMs: exchange.durationMs,
      });
      exchangesRecorded++;
      modelCalls += exchange.modelCalls;
    }
  }

  // Left open rather than closed: the run is over, but the space stays available
  // for follow-up work instead of being sealed shut at the end of the swarm.
  store.setStatus(room.id, 'open');

  return { roomId: room.id, created: true, exchangesRecorded, modelCalls };
}

/**
 * Best-effort capture for a swarm call site.
 *
 * A room is bookkeeping over work that has already succeeded. If persisting it
 * fails — disk full, schema drift — the swarm result must still reach the user,
 * so this never throws and reports success=false instead.
 */
export function tryCaptureSwarmIntoRoom(input: CaptureSwarmInput): CapturedRoom | null {
  try {
    return captureSwarmIntoRoom(input);
  } catch {
    return null;
  }
}