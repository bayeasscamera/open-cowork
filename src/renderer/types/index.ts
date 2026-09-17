/**
 * Re-export of the shared type contracts.
 *
 * The canonical definitions moved to `src/shared/types.ts` because the main
 * process also imports them (ClientEvent, Message, ToolResult, ...) — the
 * main process must never import from the renderer. This shim keeps existing
 * renderer imports (`../types`) working unchanged.
 */
export type * from '../../shared/types';
export type * from '../../shared/personal-files';
