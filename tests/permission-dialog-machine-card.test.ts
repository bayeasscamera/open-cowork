/**
 * Wiring test: PermissionDialog renders MachineApprovalCard for an elevated
 * machine-access request, and the card's approve-once/refuse buttons answer
 * the permission round-trip in place of the dialog's own action rows.
 *
 * The card itself is stubbed (its rendering is covered by
 * machine-access-card-render.test.ts); the stub records the props it receives
 * so this test can verify the mapping and invoke the callbacks.
 *
 * Same technique as machine-access-card-render.test.ts: react-dom/server with
 * createElement, so it stays a .ts file (vitest include does not cover .tsx).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApprovalCardView } from '../src/renderer/components/MachineApprovalCard';

interface CapturedCardProps {
  card: ApprovalCardView;
  onApproveOnce: () => void;
  onRefuse: () => void;
}

const mocks = vi.hoisted(() => ({
  captured: null as CapturedCardProps | null,
  respondToPermission: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

vi.mock('../src/renderer/hooks/useIPC', () => ({
  useIPC: () => ({ respondToPermission: mocks.respondToPermission }),
}));

vi.mock('../src/renderer/components/MachineApprovalCard', () => ({
  MachineApprovalCard: (props: CapturedCardProps) => {
    mocks.captured = props;
    return createElement(
      'div',
      null,
      props.card.what,
      props.card.why,
      props.card.worstCase,
      props.card.undo
    );
  },
}));

import { PermissionDialog } from '../src/renderer/components/PermissionDialog';
import type { PermissionRequest } from '../src/shared/types';

const makePermission = (machineAccess: Record<string, unknown>): PermissionRequest => ({
  toolUseId: 'tu-1',
  toolName: 'machine_run_command',
  sessionId: 's-1',
  input: {
    description: 'rm -rf /tmp/x (recursive forced deletion)',
    machineAccess,
  },
});

const ELEVATED = {
  level: 'dangereux',
  reasons: ['recursive forced deletion'],
  sensitive: false,
  autonomy: 'ask-always',
  origin: 'user-message',
};

const render = (permission: PermissionRequest): string =>
  renderToStaticMarkup(createElement(PermissionDialog, { permission }));

beforeEach(() => {
  mocks.captured = null;
  mocks.respondToPermission.mockClear();
});

describe('PermissionDialog with an elevated machine-access request', () => {
  it('renders the approval card instead of the dialog action rows', () => {
    const html = render(makePermission(ELEVATED));

    // Card content is present: the action, the reason, the generic hints.
    expect(html).toContain('rm -rf /tmp/x (recursive forced deletion)');
    expect(html).toContain('recursive forced deletion');
    expect(html).toContain('machineAccess.card.worstCaseHint');
    expect(html).toContain('machineAccess.card.undoHint');

    // The dialog's own decision rows are hidden behind the card.
    expect(html).not.toContain('permission.allow');
    expect(html).not.toContain('permission.alwaysAllow');
  });

  it('maps the machine-access payload onto the card view', () => {
    render(makePermission(ELEVATED));
    const card = mocks.captured?.card;
    expect(card).toBeDefined();
    expect(card?.titleKey).toBe('machineAccess.title');
    expect(card?.what).toBe('rm -rf /tmp/x (recursive forced deletion)');
    expect(card?.why).toBe('recursive forced deletion');
    expect(card?.origin).toBe('user-message');
    expect(card?.risk).toBe('dangereux');
    expect(card?.reconfirmationSource).toBeUndefined();
  });

  it('wires approve-once to allow and refuse to deny', () => {
    render(makePermission(ELEVATED));

    mocks.captured?.onApproveOnce();
    expect(mocks.respondToPermission).toHaveBeenCalledWith('tu-1', 'allow');

    mocks.captured?.onRefuse();
    expect(mocks.respondToPermission).toHaveBeenCalledWith('tu-1', 'deny');
  });

  it('names the untrusted source as a reconfirmation', () => {
    render(makePermission({ ...ELEVATED, level: 'suspect', origin: 'file-content: notes.txt' }));
    expect(mocks.captured?.card.risk).toBe('suspect');
    expect(mocks.captured?.card.reconfirmationSource).toBe('file-content: notes.txt');
  });

  it('treats a sensitive ordinary action as suspect', () => {
    const html = render(makePermission({ ...ELEVATED, level: 'ordinaire', sensitive: true }));
    expect(mocks.captured?.card.risk).toBe('suspect');
    expect(html).not.toContain('permission.allow');
  });
});

describe('PermissionDialog with an ordinary machine-access request', () => {
  it('keeps the dialog buttons and the standing approval', () => {
    const html = render(makePermission({ ...ELEVATED, level: 'ordinaire', reasons: [] }));
    expect(html).toContain('permission.allow');
    expect(html).toContain('permission.deny');
    expect(html).toContain('permission.alwaysAllow');
    // The elevated-only card is not mounted.
    expect(mocks.captured).toBeNull();
  });
});
