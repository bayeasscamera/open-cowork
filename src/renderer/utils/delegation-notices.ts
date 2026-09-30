import { useAppStore, type GlobalNotice } from '../store';

/** Minimal translate signature — keeps the notice builder pure and testable. */
export type TranslateFn = (key: string, values?: Record<string, string | number>) => string;

/**
 * In-app toast for a delegated task outcome. Complements the badge flash and
 * the native notification, which run through the same "notify when a task
 * finishes" gate. Cancellations never toast (they are user-initiated).
 */
export function buildDelegationOutcomeNotice(
  t: TranslateFn,
  title: string,
  status: 'completed' | 'failed'
): GlobalNotice {
  const messageKey =
    status === 'completed' ? 'delegatedTasks.toastCompleted' : 'delegatedTasks.toastFailed';
  return {
    id: `notice-delegation-${status}-${Date.now()}`,
    type: status === 'completed' ? 'success' : 'error',
    message: t(messageKey, { title }),
    messageKey,
    messageValues: { title },
  };
}

/**
 * Whether the outcome toast may fire — same "Notify when a task finishes"
 * setting as the native notification and the badge flash.
 *
 * Read from the store (hydrated once at startup by useIPC and refreshed by
 * the delegation settings form) rather than re-read over IPC per task, so all
 * three feedback channels share one source of truth.
 */
export function delegationToastEnabled(): boolean {
  return useAppStore.getState().notifyOnCompletion;
}
