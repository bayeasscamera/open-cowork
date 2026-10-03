/**
 * Real render of the machine-access card, using react-dom/server so it works in
 * the Node test environment (no DOM). Written with createElement rather than JSX
 * so it stays a .ts file: the project's vitest include does not cover .tsx, and
 * widening that shared glob is not worth it for one test.
 *
 * This is stronger than a source-assertion test: it proves the component renders
 * and pins the security-relevant ABSENCE — a dangerous card must not offer a
 * standing approval.
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

import {
  MachineApprovalCard,
  type ApprovalCardView,
} from '../src/renderer/components/MachineApprovalCard';

const BASE: ApprovalCardView = {
  titleKey: 'machineAccess.title',
  what: 'rm -rf ~/Documents',
  why: 'recursive forced deletion',
  worstCase: 'data loss outside the trash',
  undo: 'restore from the journal',
  origin: 'user-message',
  risk: 'dangereux',
};

const render = (card: ApprovalCardView): string =>
  renderToStaticMarkup(
    createElement(MachineApprovalCard, {
      card,
      onApproveOnce: () => undefined,
      onRefuse: () => undefined,
    })
  );

describe('MachineApprovalCard renders', () => {
  it('shows what it does, why, worst case, undo and origin', () => {
    const html = render(BASE);
    expect(html).toContain('rm -rf ~/Documents');
    expect(html).toContain('recursive forced deletion');
    expect(html).toContain('data loss outside the trash');
    expect(html).toContain('restore from the journal');
    expect(html).toContain('user-message');
    expect(html).toContain('machineAccess.approveOnce');
    expect(html).toContain('machineAccess.refuse');
  });

  it('offers only "approve once" and "refuse" — never a standing approval', () => {
    for (const risk of ['dangereux', 'suspect'] as const) {
      const html = render({ ...BASE, risk });
      expect(html).toContain('machineAccess.approveOnce');
      expect(html).toContain('machineAccess.refuse');
      // Nothing resembling a standing-approval control may appear.
      const lowered = html.toLowerCase();
      expect(lowered).not.toContain('always');
      expect(lowered).not.toContain('remember');
      expect(html).not.toContain('allow_always');
    }
  });

  it('hides the worst-case block for an ordinary action', () => {
    const html = render({ ...BASE, risk: 'ordinaire', why: '', worstCase: '', undo: '' });
    expect(html).toContain('machineAccess.approveOnce');
    expect(html).not.toContain('machineAccess.card.worstCase');
    expect(html).not.toContain('machineAccess.card.why');
  });

  it('renders the before/after preview for a batch', () => {
    const html = render({
      ...BASE,
      rows: [
        { before: '/w/a.txt', after: '/w/sorted/a.txt' },
        { before: '/w/b.txt', after: '/w/sorted/b.txt' },
      ],
    });
    expect(html).toContain('/w/sorted/a.txt');
    expect(html).toContain('/w/sorted/b.txt');
    expect(html).toContain('machineAccess.card.before');
    expect(html).toContain('machineAccess.card.after');
  });

  it('names the untrusted source when a reconfirmation is required', () => {
    const html = render({ ...BASE, risk: 'suspect', reconfirmationSource: 'notes.txt' });
    expect(html).toContain('notes.txt');
    expect(html).toContain('machineAccess.card.reconfirmation');
  });

  it('colours the risk level so it reads at a glance', () => {
    const dangerous = render(BASE);
    const ordinary = render({ ...BASE, risk: 'ordinaire' });
    expect(dangerous).toContain('text-danger');
    expect(dangerous).toContain('machineAccess.risk.dangereux');
    expect(ordinary).toContain('machineAccess.risk.ordinaire');
    expect(ordinary).not.toContain('border-danger');
  });
});
