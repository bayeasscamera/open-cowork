/**
 * @module main/skills/skill-proposals
 *
 * Proposed-skill store with a MANDATORY manual approval gate.
 *
 * A sub-agent that identifies a recurring pattern can PROPOSE a new skill —
 * static, procedural SKILL.md content, never executable — through the
 * dedicated `propose_skill` tool. Proposals land in
 * `<userData>/claude/skills-proposed/`, a directory that is NEVER scanned as
 * a source of active skills (unlike `<userData>/claude/skills/`). A proposal
 * stays INACTIVE until a human explicitly approves it in the Skill doctor
 * screen, which moves it into the configured active skills directory.
 * Rejection deletes the draft.
 *
 * This module is the ONLY path a dynamic skill proposal may take; it reuses
 * the SkillSynthesizer conventions (frontmatter validation, kebab-case slug,
 * atomic temp+rename writes, SQLite ledger for provenance) as its foundation.
 *
 * Security invariants (all enforced here):
 * - Only SKILL.md and proposal.json are ever written — nothing else.
 * - Content must be plain markdown text with valid frontmatter
 *   (name + description) — it is stored and moved, never parsed for code,
 *   never executed, never imported.
 * - No eval, no spawn, no dynamic import anywhere in this module.
 * - Every filesystem operation is confined to the proposals directory
 *   (strict name validation prevents path traversal) except the explicit
 *   approve move into the active skills directory, which is triggered ONLY
 *   by the user-facing IPC handler.
 * - Approve refuses to overwrite an existing active skill.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { sendToRenderer } from '../events/renderer-sender';
import { log, logError, logWarn } from '../utils/logger';
import type { ServerEvent } from '../../shared/types';

/** A proposal draft is capped so a runaway sub-agent cannot flood the disk. */
const MAX_PROPOSAL_CONTENT_CHARS = 48_000;
const MAX_DESCRIPTION_CHARS = 1_000;

interface SkillProposalMeta {
  name: string;
  description: string;
  /** Who proposed it (role/label of the proposing sub-agent or 'main-agent'). */
  proposedBy: string;
  proposedAt: number;
  /** Draft revision — bumped when the same slug is re-proposed while pending. */
  version: number;
  /** Short free-text rationale captured at proposal time. */
  rationale?: string;
}

interface ProposedSkill extends SkillProposalMeta {
  /** Absolute path of the pending SKILL.md draft. */
  path: string;
  /** The static markdown content (read back from disk — single source of truth). */
  content: string;
}

interface ProposeSkillResult {
  ok: boolean;
  name?: string;
  path?: string;
  version?: number;
  error?: string;
}

interface ApproveSkillResult {
  ok: boolean;
  /** Active path the skill now occupies — set only on success. */
  path?: string;
  /** Final directory name inside the active skills dir (rename applied). */
  name?: string;
  /** Structured failure reason the UI can react to (rename flow). */
  code?: 'invalid_name' | 'not_found' | 'name_conflict' | 'failed';
  error?: string;
}

let overrideDir: string | null = null;

/** Test/optional hook: pin the proposals location before first use. */
export function initSkillProposals(dir: string): void {
  overrideDir = dir;
}

/** The proposals directory — a SIBLING of the active skills dir, never inside it. */
export function getProposedSkillsDir(): string {
  if (overrideDir) return overrideDir;
  let userData = '';
  try {
    userData = app?.getPath ? app.getPath('userData') : '';
  } catch {
    userData = '';
  }
  return path.join(userData || path.join(process.cwd(), '.cowork'), 'claude', 'skills-proposed');
}

/** Derive the proposals dir for a given ACTIVE skills dir (used by tests/synth). */
export function proposalsDirForActiveSkillsDir(activeSkillsDir: string): string {
  return path.join(path.dirname(path.resolve(activeSkillsDir)), 'skills-proposed');
}

/**
 * Tell the renderer the pending-proposal set changed, so the sidebar badge
 * stays live while a sub-agent proposes mid-session. Best-effort: during
 * tests/headless the sender context is absent and the call throws — caught
 * here, never blocking the store mutation itself.
 */
function emitProposalsChanged(): void {
  try {
    const event: ServerEvent = {
      type: 'skills.proposalsChanged',
      payload: { count: listProposals().length },
    };
    sendToRenderer(event);
  } catch {
    // Renderer channel not configured (tests, headless) — store still updated.
  }
}

/**
 * Strict slug validation: kebab-case-ish, no separators, no traversal.
 * Mirrors SkillsManager.validateSkillName plus a lowercase convention so a
 * proposal can never escape the proposals directory.
 */
export function validateProposalSlug(raw: string): { slug: string } | { error: string } {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 64) {
    return { error: 'Skill name must be 3-64 characters.' };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
    return { error: 'Skill name may only contain lowercase letters, digits, dashes and underscores.' };
  }
  if (/[/\\]|\.\./.test(trimmed)) {
    return { error: 'Skill name must not contain path separators.' };
  }
  return { slug: trimmed };
}

/**
 * Frontmatter validation — the same contract the SkillSynthesizer enforces:
 * the draft MUST start with a YAML frontmatter block carrying name and
 * description. This is static markdown metadata; nothing here executes it.
 */
export function validateProposalContent(content: string): string | undefined {
  if (typeof content !== 'string' || !content.trim()) {
    return 'Skill content is required.';
  }
  if (content.length > MAX_PROPOSAL_CONTENT_CHARS) {
    return `Skill content is too large (max ${MAX_PROPOSAL_CONTENT_CHARS} characters).`;
  }
  if (!content.startsWith('---') || !content.includes('name:') || !content.includes('description:')) {
    return 'Skill content must start with YAML frontmatter containing name: and description:.';
  }
  return undefined;
}

/** Atomically write text: temp file + rename inside the SAME directory. */
function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Record a pending proposal. NEVER touches the active skills directory.
 * Re-proposing the same slug while it is still pending bumps the draft
 * version (the human sees the newest draft, the old content is replaced).
 */
export function proposeSkill(input: {
  name: string;
  description: string;
  content: string;
  proposedBy: string;
  rationale?: string;
}): ProposeSkillResult {
  try {
    const slug = validateProposalSlug(input.name);
    if ('error' in slug) return { ok: false, error: slug.error };

    const description = (input.description ?? '').trim().slice(0, MAX_DESCRIPTION_CHARS);
    if (!description) return { ok: false, error: 'A short description is required.' };

    const contentError = validateProposalContent(input.content);
    if (contentError) return { ok: false, error: contentError };

    const dir = getProposedSkillsDir();
    const targetDir = path.join(dir, slug.slug);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const metaPath = path.join(targetDir, 'proposal.json');
    let version = 1;
    if (fs.existsSync(metaPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SkillProposalMeta;
        version = (prev.version ?? 1) + 1;
      } catch {
        version = 1;
      }
    }

    const meta: SkillProposalMeta = {
      name: slug.slug,
      description,
      proposedBy: (input.proposedBy || 'sub-agent').slice(0, 120),
      proposedAt: Date.now(),
      version,
      ...(input.rationale?.trim() ? { rationale: input.rationale.trim().slice(0, 2_000) } : {}),
    };

    atomicWrite(path.join(targetDir, 'SKILL.md'), input.content);
    atomicWrite(metaPath, JSON.stringify(meta, null, 2));
    log(`[SkillProposals] Proposed skill (v${version}, PENDING approval): ${slug.slug}`);
    emitProposalsChanged();
    return { ok: true, name: slug.slug, path: path.join(targetDir, 'SKILL.md'), version };
  } catch (err) {
    logError('[SkillProposals] Failed to record proposal:', err);
    return { ok: false, error: 'Failed to write the proposal draft.' };
  }
}

function readMeta(targetDir: string): SkillProposalMeta | undefined {
  try {
    const metaPath = path.join(targetDir, 'proposal.json');
    if (!fs.existsSync(metaPath)) return undefined;
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SkillProposalMeta;
  } catch {
    return undefined;
  }
}

/** List every PENDING proposal (the active skills dir is never consulted). */
export function listProposals(): ProposedSkill[] {
  const dir = getProposedSkillsDir();
  const out: ProposedSkill[] = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const targetDir = path.join(dir, entry.name);
      const skillMd = path.join(targetDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      try {
        const meta = readMeta(targetDir);
        out.push({
          name: meta?.name ?? entry.name,
          description: meta?.description ?? '',
          proposedBy: meta?.proposedBy ?? 'unknown',
          proposedAt: meta?.proposedAt ?? 0,
          version: meta?.version ?? 1,
          ...(meta?.rationale ? { rationale: meta.rationale } : {}),
          path: skillMd,
          content: fs.readFileSync(skillMd, 'utf-8'),
        });
      } catch (err) {
        logWarn('[SkillProposals] Skipping unreadable proposal:', err);
      }
    }
  } catch (err) {
    logError('[SkillProposals] Failed to list proposals:', err);
  }
  return out.sort((a, b) => b.proposedAt - a.proposedAt);
}

export function getProposal(slug: string): ProposedSkill | undefined {
  return listProposals().find((p) => p.name === slug);
}

/**
 * HUMAN-gated activation: move a pending proposal into the ACTIVE skills
 * directory. Called only from the user-facing IPC handler (Skill doctor
 * Approve button). Refuses to overwrite an existing active skill; an
 * optional `renameTo` lets the human approve a conflicting proposal under a
 * different directory name instead of deleting either side.
 */
export function approveProposal(
  slug: string,
  activeSkillsDir: string,
  renameTo?: string
): ApproveSkillResult {
  try {
    const slugCheck = validateProposalSlug(slug);
    if ('error' in slugCheck) {
      return { ok: false, code: 'invalid_name', error: slugCheck.error };
    }

    // Optional rename — validated with the SAME strict slug rules, so the
    // final directory can never escape the active skills dir.
    let finalName = slugCheck.slug;
    if (typeof renameTo === 'string' && renameTo.trim()) {
      const renameCheck = validateProposalSlug(renameTo);
      if ('error' in renameCheck) {
        return { ok: false, code: 'invalid_name', error: renameCheck.error };
      }
      finalName = renameCheck.slug;
    }

    const resolvedActive = path.resolve(activeSkillsDir);
    if (!fs.existsSync(resolvedActive)) {
      fs.mkdirSync(resolvedActive, { recursive: true });
    }

    const proposalDir = path.join(getProposedSkillsDir(), slugCheck.slug);
    const skillMd = path.join(proposalDir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      return { ok: false, code: 'not_found', error: 'No pending proposal with that name.' };
    }

    const targetDir = path.join(resolvedActive, finalName);
    if (fs.existsSync(targetDir)) {
      return {
        ok: false,
        code: 'name_conflict',
        error: 'An active skill with that name already exists — approve it under a different name instead.',
      };
    }

    fs.renameSync(proposalDir, targetDir);
    log(
      `[SkillProposals] Proposal APPROVED by user${finalName !== slugCheck.slug ? ` (renamed to "${finalName}")` : ''} — now active: ${path.join(targetDir, 'SKILL.md')}`
    );
    emitProposalsChanged();
    return { ok: true, name: finalName, path: path.join(targetDir, 'SKILL.md') };
  } catch (err) {
    logError('[SkillProposals] Failed to approve proposal:', err);
    return { ok: false, code: 'failed', error: 'Failed to move the proposal into the active skills directory.' };
  }
}

/** HUMAN-gated discard: delete a pending proposal (proposals dir only). */
export function rejectProposal(slug: string): { ok: boolean; error?: string } {
  try {
    const slugCheck = validateProposalSlug(slug);
    if ('error' in slugCheck) return { ok: false, error: slugCheck.error };
    const proposalDir = path.join(getProposedSkillsDir(), slugCheck.slug);
    if (!fs.existsSync(proposalDir)) {
      return { ok: false, error: 'No pending proposal with that name.' };
    }
    fs.rmSync(proposalDir, { recursive: true, force: true });
    log(`[SkillProposals] Proposal REJECTED by user — deleted: ${slugCheck.slug}`);
    emitProposalsChanged();
    return { ok: true };
  } catch (err) {
    logError('[SkillProposals] Failed to reject proposal:', err);
    return { ok: false, error: 'Failed to delete the proposal draft.' };
  }
}

/** Test hook: wipe the pending-proposal state (override dir contents). */
export function __resetProposalsForTest(): void {
  const dir = getProposedSkillsDir();
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logError('[SkillProposals] Test reset failed:', err);
  }
}
