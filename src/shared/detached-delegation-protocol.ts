/**
 * The on-disk contract between a detached delegation and the app that watches
 * it. Kept in shared/ so the writer (headless single-shot mode) and the reader
 * (background delegations) can never drift.
 */

/** Bump when the result file shape changes; older files are then ignored. */
export const DETACHED_RESULT_SCHEMA_VERSION = 1;
