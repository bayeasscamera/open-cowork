import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Spy on the renderer sender before the store module loads.
const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));
vi.mock('../src/main/events/renderer-sender', () => ({
  sendToRenderer: sendSpy,
}));

import {
  initSkillProposals,
  proposeSkill,
  approveProposal,
  rejectProposal,
} from '../src/main/skills/skill-proposals';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf-8');

const SKILL_MD = [
  '---',
  'name: badge-test-skill',
  'description: whatever',
  '---',
  '# Badge test',
].join('\n');

describe('pending-proposals badge — live event + sidebar wiring', () => {
  let tmp: string;
  let activeDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-test-'));
    activeDir = path.join(tmp, 'skills');
    fs.mkdirSync(activeDir, { recursive: true });
    initSkillProposals(path.join(tmp, 'skills-proposed'));
    sendSpy.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('propose/approve/reject each emit skills.proposalsChanged with the new count', () => {
    // Propose → count becomes 1.
    const p = proposeSkill({
      name: 'badge-test-skill',
      description: 'd',
      content: SKILL_MD,
      proposedBy: 'sub-agent',
    });
    expect(p.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'skills.proposalsChanged',
      payload: { count: 1 },
    });

    // Approve → back to 0 pending.
    sendSpy.mockClear();
    const a = approveProposal('badge-test-skill', activeDir);
    expect(a.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'skills.proposalsChanged',
      payload: { count: 0 },
    });

    // Reject path: propose again, then reject.
    sendSpy.mockClear();
    proposeSkill({ name: 'badge-test-skill', description: 'd', content: SKILL_MD, proposedBy: 'x' });
    sendSpy.mockClear();
    const r = rejectProposal('badge-test-skill');
    expect(r.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'skills.proposalsChanged',
      payload: { count: 0 },
    });
  });

  it('a failed mutation emits nothing (no false badge)', () => {
    const refused = proposeSkill({
      name: '../bad',
      description: 'd',
      content: SKILL_MD,
      proposedBy: 'x',
    });
    expect(refused.ok).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('wiring — the event type, renderer handler and sidebar badge exist', () => {
    const shared = read('../src/shared/types.ts');
    expect(shared).toContain("type: 'skills.proposalsChanged'");
    expect(shared).toContain('payload: { count: number }');

    const useIPC = read('../src/renderer/hooks/useIPC.ts');
    expect(useIPC).toContain("case 'skills.proposalsChanged':");
    expect(useIPC).toContain('store.setPendingProposalCount(event.payload.count)');

    const sidebar = read('../src/renderer/components/Sidebar.tsx');
    // Badge rendered in BOTH the expanded entry and the collapsed rail.
    expect((sidebar.match(/pendingProposalCount > 0 &&/g) || []).length).toBe(2);
    expect(sidebar).toContain('setPendingProposalCount(result.proposals.length)');
  });

  it('wiring — the store exposes the badge count', () => {
    const store = read('../src/renderer/store/index.ts');
    expect(store).toContain('pendingProposalCount: number;');
    expect(store).toContain('setPendingProposalCount: (count: number) => void;');
  });
});
