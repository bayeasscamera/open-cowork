import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initSkillProposals,
  getProposedSkillsDir,
  proposeSkill,
  listProposals,
  approveProposal,
  rejectProposal,
  validateProposalSlug,
  validateProposalContent,
} from '../src/main/skills/skill-proposals';
import { loadSkillSourcesFromDir } from '../src/main/mods/skill-doctor';

const VALID_SKILL_MD = [
  '---',
  'name: code-review-checklist',
  'description: Step-by-step review checklist for pull requests',
  '---',
  '',
  '# Code review checklist',
  '',
  '1. Read the diff twice before commenting.',
  '2. Check error handling on every await.',
].join('\n');

describe('skill-proposals — pending store + MANDATORY approval gate', () => {
  let proposalsDir: string;
  let activeDir: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-proposals-test-'));
    proposalsDir = path.join(tmp, 'skills-proposed');
    activeDir = path.join(tmp, 'skills');
    fs.mkdirSync(activeDir, { recursive: true });
    initSkillProposals(proposalsDir);
  });

  afterEach(() => {
    // Leave the tmp tree; override is re-pinned by the next beforeEach.
  });

  it('a proposal lands ONLY in the pending dir and is INERT (not active) until approved', () => {
    const result = proposeSkill({
      name: 'code-review-checklist',
      description: 'Review checklist',
      content: VALID_SKILL_MD,
      proposedBy: 'sub-agent',
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);

    // The draft exists ONLY under skills-proposed.
    expect(fs.existsSync(path.join(proposalsDir, 'code-review-checklist', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(activeDir, 'code-review-checklist'))).toBe(false);

    // PROOF of inactivity: the Skill doctor's own active-skills loader (the
    // same function its IPC handler uses) sees NOTHING in the active dir.
    const activeSources = loadSkillSourcesFromDir(activeDir);
    expect(activeSources.map((s) => s.name)).not.toContain('code-review-checklist');
    // And the doctor never reads the proposals dir as skills.
    const proposalSources = loadSkillSourcesFromDir(getProposedSkillsDir());
    expect(proposalSources.length).toBe(1); // visible as pending, not as active skill inventory cost
  });

  it('listProposals exposes the pending draft with its metadata', () => {
    proposeSkill({
      name: 'code-review-checklist',
      description: 'Review checklist',
      content: VALID_SKILL_MD,
      proposedBy: 'sub-agent:reviewer',
      rationale: 'Same review flow repeated 3 times',
    });
    const pending = listProposals();
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe('code-review-checklist');
    expect(pending[0].proposedBy).toBe('sub-agent:reviewer');
    expect(pending[0].rationale).toContain('repeated');
    expect(pending[0].content).toContain('# Code review checklist');
  });

  it('re-proposing the same slug bumps the draft version (still pending)', () => {
    const first = proposeSkill({
      name: 'code-review-checklist',
      description: 'd',
      content: VALID_SKILL_MD,
      proposedBy: 'a',
    });
    const second = proposeSkill({
      name: 'code-review-checklist',
      description: 'd2',
      content: VALID_SKILL_MD + '\nMore guidance.',
      proposedBy: 'b',
    });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(listProposals()).toHaveLength(1);
    // Still inactive.
    expect(fs.existsSync(path.join(activeDir, 'code-review-checklist'))).toBe(false);
  });

  it('APPROVE (the only activation path) moves the draft into the active skills dir', () => {
    proposeSkill({
      name: 'code-review-checklist',
      description: 'Review checklist',
      content: VALID_SKILL_MD,
      proposedBy: 'sub-agent',
    });

    const approved = approveProposal('code-review-checklist', activeDir);
    expect(approved.ok).toBe(true);
    expect(approved.path).toBe(path.join(activeDir, 'code-review-checklist', 'SKILL.md'));
    expect(fs.existsSync(approved.path!)).toBe(true);

    // Gone from the pending store…
    expect(listProposals()).toHaveLength(0);
    // …and NOW visible to the active-skills loader.
    const activeSources = loadSkillSourcesFromDir(activeDir);
    expect(activeSources.map((s) => s.name)).toContain('code-review-checklist');
  });

  it('approve REFUSES to overwrite an existing active skill', () => {
    fs.mkdirSync(path.join(activeDir, 'code-review-checklist'), { recursive: true });
    fs.writeFileSync(
      path.join(activeDir, 'code-review-checklist', 'SKILL.md'),
      '---\nname: code-review-checklist\ndescription: existing active\n---\n# Existing',
      'utf-8'
    );
    proposeSkill({
      name: 'code-review-checklist',
      description: 'd',
      content: VALID_SKILL_MD,
      proposedBy: 'sub-agent',
    });

    const refused = approveProposal('code-review-checklist', activeDir);
    expect(refused.ok).toBe(false);
    // Structured code drives the UI's approve-as-rename flow.
    expect(refused.code).toBe('name_conflict');
    expect(refused.error).toContain('already exists');
    // The active skill is untouched; the draft is still pending.
    expect(
      fs.readFileSync(path.join(activeDir, 'code-review-checklist', 'SKILL.md'), 'utf-8')
    ).toContain('existing active');
    expect(listProposals()).toHaveLength(1);
  });

  it('APPROVE WITH RENAME activates a conflicting draft under a new name', () => {
    fs.mkdirSync(path.join(activeDir, 'code-review-checklist'), { recursive: true });
    fs.writeFileSync(
      path.join(activeDir, 'code-review-checklist', 'SKILL.md'),
      '---\nname: code-review-checklist\ndescription: existing active\n---\n# Existing',
      'utf-8'
    );
    proposeSkill({
      name: 'code-review-checklist',
      description: 'd',
      content: VALID_SKILL_MD,
      proposedBy: 'sub-agent',
    });

    const renamed = approveProposal('code-review-checklist', activeDir, 'code-review-checklist-v2');
    expect(renamed.ok).toBe(true);
    expect(renamed.name).toBe('code-review-checklist-v2');
    expect(fs.existsSync(renamed.path!)).toBe(true);
    // The pre-existing active skill is untouched.
    expect(
      fs.readFileSync(path.join(activeDir, 'code-review-checklist', 'SKILL.md'), 'utf-8')
    ).toContain('existing active');
    // The proposal is gone from the pending store.
    expect(listProposals()).toHaveLength(0);
  });

  it('approve with an INVALID rename name is refused without touching anything', () => {
    proposeSkill({
      name: 'code-review-checklist',
      description: 'd',
      content: VALID_SKILL_MD,
      proposedBy: 'sub-agent',
    });
    const refused = approveProposal('code-review-checklist', activeDir, '../escape');
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('invalid_name');
    expect(fs.existsSync(path.join(activeDir, 'escape'))).toBe(false);
    // Still pending — nothing moved.
    expect(listProposals()).toHaveLength(1);
  });

  it('REJECT deletes the draft permanently (nothing becomes active)', () => {
    proposeSkill({
      name: 'code-review-checklist',
      description: 'd',
      content: VALID_SKILL_MD,
      proposedBy: 'sub-agent',
    });
    const rejected = rejectProposal('code-review-checklist');
    expect(rejected.ok).toBe(true);
    expect(fs.existsSync(path.join(proposalsDir, 'code-review-checklist'))).toBe(false);
    expect(fs.existsSync(path.join(activeDir, 'code-review-checklist'))).toBe(false);
    expect(listProposals()).toHaveLength(0);
  });

  it('reject on an unknown name fails gracefully', () => {
    expect(rejectProposal('does-not-exist').ok).toBe(false);
  });

  it('validateProposalSlug blocks traversal and unsafe names', () => {
    expect(validateProposalSlug('../escape')).toMatchObject({ error: expect.any(String) });
    expect(validateProposalSlug('a/b')).toMatchObject({ error: expect.any(String) });
    expect(validateProposalSlug('..')).toMatchObject({ error: expect.any(String) });
    expect(validateProposalSlug('ab')).toMatchObject({ error: expect.any(String) }); // too short
    // Uppercase is NORMALIZED to a lowercase slug — never a rejection.
    expect(validateProposalSlug('UPPER-CASE')).toMatchObject({ slug: 'upper-case' });
    expect(validateProposalSlug('valid-name_1')).toMatchObject({ slug: 'valid-name_1' });
  });

  it('validateProposalContent demands frontmatter and caps size', () => {
    expect(validateProposalContent('no frontmatter here')).toBeDefined();
    expect(validateProposalContent('---\nname: x\n---')).toBeDefined(); // missing description
    expect(validateProposalContent('')).toBeDefined();
    const oversized = '---\nname: x\ndescription: d\n---\n' + 'a'.repeat(49_000);
    expect(validateProposalContent(oversized)).toBeDefined();
    expect(validateProposalContent(VALID_SKILL_MD)).toBeUndefined();
  });

  it('proposeSkill refuses invalid drafts and never creates files', () => {
    const before = fs.existsSync(proposalsDir) ? fs.readdirSync(proposalsDir) : [];
    const bad = proposeSkill({
      name: '../escape',
      description: 'd',
      content: VALID_SKILL_MD,
      proposedBy: 'sub-agent',
    });
    expect(bad.ok).toBe(false);
    const badContent = proposeSkill({
      name: 'good-name',
      description: 'd',
      content: 'definitely not markdown with frontmatter',
      proposedBy: 'sub-agent',
    });
    expect(badContent.ok).toBe(false);
    const after = fs.existsSync(proposalsDir) ? fs.readdirSync(proposalsDir) : [];
    expect(after).toEqual(before); // nothing written on refusal
  });

  it('SECURITY — the proposals store contains no code-execution primitive', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/main/skills/skill-proposals.ts'),
      'utf-8'
    );
    expect(source).not.toContain('new Function');
    expect(source).not.toContain('eval(');
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('spawn(');
    expect(source).not.toContain('import(');
  });
});


describe('FULL FLOW — a sub-agent proposes, the human approves (only then active)', () => {
  it('propose_skill tool → pending draft → INACTIVE → human approve → active', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-flow-e2e-'));
    const activeDir = path.join(tmp, 'skills');
    fs.mkdirSync(activeDir, { recursive: true });
    initSkillProposals(path.join(tmp, 'skills-proposed'));

    // 1. The EXACT tool a sub-agent session carries, invoked the way the
    //    pi SDK would invoke it.
    const { buildProposeSkillTool } = await import('../src/main/agent/swarm-runner');
    const tool = buildProposeSkillTool();
    expect(tool.name).toBe('propose_skill');
    const outcome = (await tool.execute('call-1', {
      name: 'release-notes-checklist',
      description: 'Checklist for writing release notes',
      rationale: 'Produced release notes three times the same way',
      content: [
        '---',
        'name: release-notes-checklist',
        'description: Checklist for writing release notes',
        '---',
        '',
        '# Release notes checklist',
        '',
        '1. Group changes by user impact.'
      ].join('\\n'),
    })) as { content: Array<{ type: string; text: string }> };
    expect(outcome.content[0].text).toContain('PENDING');

    // 2. Pending: visible in the proposals list, INVISIBLE to the active-skills
    //    loader the Skill doctor uses.
    const pending = listProposals();
    expect(pending.map((p) => p.name)).toContain('release-notes-checklist');
    expect(
      loadSkillSourcesFromDir(activeDir).map((s) => s.name)
    ).not.toContain('release-notes-checklist');

    // 3. Human approval — the ONLY activation path.
    const approved = approveProposal('release-notes-checklist', activeDir);
    expect(approved.ok).toBe(true);
    expect(
      loadSkillSourcesFromDir(activeDir).map((s) => s.name)
    ).toContain('release-notes-checklist');
    expect(listProposals()).toHaveLength(0);
  });
});

describe('wiring — propose_skill is proposal-only, no dynamic tools for sub-agents', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf-8');

  it('every sub-agent palette carries propose_skill with the pending-approval contract', () => {
    const runner = read('../src/main/agent/swarm-runner.ts');
    expect(runner).toContain("name: 'propose_skill'");
    expect(runner).toContain('buildProposeSkillTool()');
    expect(runner).toContain('PENDING');
    expect(runner).toContain('Skill doctor');
  });

  it('sub-agents get NO dynamic tool/code creation capability (fixed palette only)', () => {
    const runner = read('../src/main/agent/swarm-runner.ts');
    expect(runner).not.toContain('create_dynamic_tool');
    expect(runner).not.toContain('DynamicToolRegistry');
    expect(runner).not.toContain('new Function');
    const proposalsModule = read('../src/main/skills/skill-proposals.ts');
    // Only SKILL.md + proposal.json are ever written.
    expect(proposalsModule).toContain("'SKILL.md'");
    expect(proposalsModule).toContain("'proposal.json'");
  });

  it('the main IPC surface exposes list/approve/reject — approve is the ONLY activation path', () => {
    const index = read('../src/main/index.ts');
    expect(index).toContain("ipcMain.handle('skills.listProposals'");
    expect(index).toContain("ipcMain.handle('skills.approveProposal'");
    expect(index).toContain("ipcMain.handle('skills.rejectProposal'");
    expect(index).toContain('approveProposal(name, activeDir, rename)');
    const preload = read('../src/preload/index.ts');
    expect(preload).toContain("ipcRenderer.invoke('skills.listProposals')");
    expect(preload).toContain("ipcRenderer.invoke('skills.approveProposal', name, renameTo)");
    expect(preload).toContain("ipcRenderer.invoke('skills.rejectProposal', name)");
  });

  it('the Skill doctor renders the pending section with Approve/Reject buttons', () => {
    const doctor = read('../src/renderer/components/settings/SettingsSkillDoctor.tsx');
    expect(doctor).toContain('ProposedSkillsSection');
    expect(doctor).toContain("act(proposal.name, 'approve')");
    expect(doctor).toContain("act(proposal.name, 'reject')");
    expect(doctor).toContain("approveProposal");
    expect(doctor).toContain("rejectProposal");
  });
});
