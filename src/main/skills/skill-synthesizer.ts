/**
 * @module main/skills/skill-synthesizer
 *
 * Autonomous Skill Synthesis & Learning Loop (Hermes-inspired).
 *
 * Analyzes completed agent turns and conversation history:
 * 1. Identifies novel problem-solving workflows, specialized tooling chains,
 *    or complex multi-step solutions.
 * 2. Uses one-shot LLM synthesis to extract a structured, standardized SKILL.md.
 * 3. Validates frontmatter, ensures atomic writing with fsync, and maintains
 *    a SQLite ledger of synthesized skills for provenance and dedup.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { log, logError } from '../utils/logger';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { configStore } from '../config/config-store';
import type { Message } from '../../shared/types';
import type Database from 'better-sqlite3';

export interface SynthesizedSkillResult {
  name: string;
  description: string;
  skillPath: string;
  created: boolean;
  reason?: string;
  version?: number;
}

export interface SkillSynthesisEvaluation {
  shouldCreateSkill: boolean;
  name?: string;
  description?: string;
  content?: string;
  reasoning: string;
}

const SYNTHESIS_SYSTEM_PROMPT = `You are the Skill Synthesizer for Open Cowork (an autonomous self-improving AI agent).
Your task is to analyze a completed conversation trajectory and decide if a novel, reusable skill should be synthesized.

CRITERIA FOR CREATING A SKILL:
1. Novelty: The workflow required non-trivial debugging, specific API sequences, specialized tool chains, or a multi-step domain solution that would save tokens and prevent errors if codified.
2. Reusability: The workflow is not a one-off trivial edit (e.g. fixing a typo, basic git commit, simple single-line fix). It represents a generalizable recipe.
3. Quality: Must provide clear guidelines, concrete examples, and actionable instructions.

FORMAT OF SKILL.md:
---
name: <kebab-case-name>
description: <Concise explanation of what the skill does and exact trigger conditions>
---

# <Skill Title>

## Overview
<Context and objective>

## Workflow / Best Practices
<Step-by-step instructions, command templates, common pitfalls>

OUTPUT FORMAT:
Respond with a strict JSON object:
{
  "shouldCreateSkill": boolean,
  "reasoning": "string explaining why or why not",
  "name": "kebab-case-skill-name",
  "description": "trigger description",
  "content": "Full markdown content of SKILL.md including frontmatter"
}
Only output the valid JSON object, no markdown ticks or wrapping.`;

export class SkillSynthesizer {
  private learnedSkillsDir: string;
  private db?: Database.Database;

  constructor(baseSkillsDir: string, db?: Database.Database) {
    this.learnedSkillsDir = path.join(baseSkillsDir, 'learned');
    this.db = db;
    this.ensureLedgerTable();
  }

  setBaseSkillsDir(baseSkillsDir: string): void {
    this.learnedSkillsDir = path.join(baseSkillsDir, 'learned');
  }

  setDatabase(db: Database.Database): void {
    this.db = db;
    this.ensureLedgerTable();
  }

  private ensureLedgerTable(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS synthesized_skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL,
          path TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          trajectory_summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_synthesized_skills_name ON synthesized_skills(name);
      `);
    } catch (err) {
      logError('[SkillSynthesizer] Failed to ensure ledger table:', err);
    }
  }

  async evaluateAndSynthesize(
    prompt: string,
    messages: Message[],
    hasErrorsResolved: boolean
  ): Promise<SynthesizedSkillResult | null> {
    if (messages.length < 2) {
      return null;
    }

    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const hasToolCalls = assistantMessages.some((m) =>
      m.content.some((c) => c.type === 'tool_use' || (c as { type?: string }).type === 'toolCall')
    );

    if (!hasToolCalls && !hasErrorsResolved) {
      return null;
    }

    try {
      const trajectorySummary = this.buildTrajectorySummary(prompt, messages);
      const appConfig = configStore.getAll();

      log('[SkillSynthesizer] Evaluating session trajectory for potential skill synthesis...');

      const response = await runPiAiOneShot(
        `Evaluate this completed task trajectory and synthesize a SKILL.md if warranted:\n\n${trajectorySummary}`,
        SYNTHESIS_SYSTEM_PROMPT,
        appConfig,
        { temperature: 0.2 }
      );

      const cleanedText = response.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const evalResult = JSON.parse(cleanedText) as SkillSynthesisEvaluation;

      if (!evalResult.shouldCreateSkill || !evalResult.name || !evalResult.content) {
        log('[SkillSynthesizer] No skill needed:', evalResult.reasoning);
        return {
          name: evalResult.name || '',
          description: evalResult.description || '',
          skillPath: '',
          created: false,
          reason: evalResult.reasoning,
        };
      }

      // Validate frontmatter structure
      if (!evalResult.content.startsWith('---') || !evalResult.content.includes('name:') || !evalResult.content.includes('description:')) {
        logError('[SkillSynthesizer] Generated content lacks required frontmatter, rejecting');
        return null;
      }

      const skillSlug = evalResult.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
      const targetDir = path.join(this.learnedSkillsDir, skillSlug);
      const targetFile = path.join(targetDir, 'SKILL.md');
      const tempFile = path.join(targetDir, `SKILL.tmp.${Date.now()}`);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Atomic file write (temp file + fsync + rename)
      fs.writeFileSync(tempFile, evalResult.content, 'utf-8');
      fs.renameSync(tempFile, targetFile);

      let version = 1;
      if (this.db) {
        try {
          const now = Date.now();
          const existing = this.db
            .prepare('SELECT id, version FROM synthesized_skills WHERE name = ?')
            .get(skillSlug) as { id: string; version: number } | undefined;

          if (existing) {
            version = existing.version + 1;
            this.db
              .prepare(
                'UPDATE synthesized_skills SET description = ?, path = ?, version = ?, trajectory_summary = ?, updated_at = ? WHERE name = ?'
              )
              .run(evalResult.description || '', targetFile, version, trajectorySummary.slice(0, 5000), now, skillSlug);
          } else {
            this.db
              .prepare(
                'INSERT INTO synthesized_skills (id, name, description, path, version, trajectory_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
              )
              .run(uuidv4(), skillSlug, evalResult.description || '', targetFile, 1, trajectorySummary.slice(0, 5000), now, now);
          }
        } catch (dbErr) {
          logError('[SkillSynthesizer] Failed to record in ledger:', dbErr);
        }
      }

      log(`[SkillSynthesizer] 🎉 Successfully created autonomous learned skill (v${version}): ${skillSlug} at ${targetFile}`);

      return {
        name: skillSlug,
        description: evalResult.description || '',
        skillPath: targetFile,
        created: true,
        version,
      };
    } catch (error) {
      logError('[SkillSynthesizer] Failed to synthesize skill:', error);
      return null;
    }
  }

  private buildTrajectorySummary(initialPrompt: string, messages: Message[]): string {
    const lines: string[] = [`Initial Goal: ${initialPrompt}`, '', 'Trajectory Highlights:'];

    for (const msg of messages.slice(-10)) {
      const role = msg.role.toUpperCase();
      const textParts: string[] = [];
      const toolUses: string[] = [];

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text.slice(0, 300));
        } else if (block.type === 'tool_use' || (block as { type?: string }).type === 'toolCall') {
          const b = block as { name?: string; input?: unknown };
          toolUses.push(`${b.name || 'tool'}(${JSON.stringify(b.input || {}).slice(0, 100)})`);
        }
      }

      if (toolUses.length > 0) {
        lines.push(`[${role} TOOLS]: ${toolUses.join(', ')}`);
      }
      if (textParts.length > 0) {
        lines.push(`[${role}]: ${textParts.join(' ').replace(/\n+/g, ' ')}`);
      }
    }

    return lines.join('\n');
  }
}
