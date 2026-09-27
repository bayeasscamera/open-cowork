import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Regression contract for two live-observed failures (2026-09-27):
//  1. Sidebar.handleSessionClick early-returned for the already-active session
//     BEFORE its message loads, so a pane stuck empty (failed boot restore)
//     could never recover by re-clicking its own session.
//  2. The window.__navigate debug bridge flipped activeSessionId without
//     loading messages, rendering an empty pane for scripted navigation.

const sidebarSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/components/Sidebar.tsx'),
  'utf8'
);
const storeSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/store/index.ts'),
  'utf8'
);

describe('empty-pane recovery on session re-selection', () => {
  it('no longer early-returns before the loads when re-clicking the active session', () => {
    expect(sidebarSource).not.toContain('if (activeSessionId === sessionId) return;');
    expect(sidebarSource).toContain('if (activeSessionId !== sessionId) {');
  });

  it('still guards the loads behind the empty-state checks', () => {
    expect(sidebarSource).toContain('existingMessages || existingMessages.length === 0');
    expect(sidebarSource).toContain('existingSteps || existingSteps.length === 0');
  });
});

describe('debug navigation bridge loads session content', () => {
  it('fetches messages and trace steps when navigating to a session', () => {
    const navSlice = storeSource.slice(storeSource.indexOf("page === 'session'"));
    expect(navSlice).toContain("'session.getMessages'");
    expect(navSlice).toContain("'session.getTraceSteps'");
    expect(navSlice).toContain('setMessages(sessionId, messages)');
    expect(navSlice).toContain('setTraceSteps(sessionId');
  });

  it('keeps the load behind the empty-state checks (idempotent re-navigation)', () => {
    const navSlice = storeSource.slice(storeSource.indexOf("page === 'session'"));
    expect(navSlice).toContain('needsMessages');
    expect(navSlice).toContain('needsSteps');
  });
});
