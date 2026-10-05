/**
 * @module main/agent/delegation-limits
 *
 * Neutral home for the delegation depth cap.
 *
 * Why it is not in `background-delegations.ts`: the fork policy needs the cap
 * to refuse a fork that would exceed the hierarchy, and `background-delegations`
 * needs the fork policy to decide. Declaring the constant in the orchestrator
 * made `fork-policy` import `background-delegations` while
 * `background-delegations` imported `fork-policy` back — a runtime import cycle
 * (see `.cowork-verify/audit-graph.mjs`, value-edge SCC).
 *
 * A shared limit is a leaf concept: nothing else in this file may import.
 */

/** Hard hierarchy cap: main agent (0) → sub-agent (1) → sub-sub-agent (2). */
export const MAX_DELEGATION_DEPTH = 2;
