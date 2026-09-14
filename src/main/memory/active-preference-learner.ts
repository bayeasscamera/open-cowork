/**
 * @module main/memory/active-preference-learner
 *
 * Pilier 3 — Apprentissage Actif & Dialectique des Préférences Utilisateur
 *
 * Automatically inspects the conversation history after each turn:
 * - Detects user preferences (preferred languages, coding frameworks, tone, response style, shortcuts)
 * - Persists them into SQLite `user_preferences` via MemoryManager
 * - Ensures future sessions proactively adapt without user reminding
 */

import { log, logError } from '../utils/logger';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { configStore } from '../config/config-store';
import type { Message } from '../../shared/types';
import type { MemoryManager } from './memory-manager';

const PREFERENCE_EXTRACTION_PROMPT = `You are the Dialectic User Preference Extractor for Open Cowork (Hermes Agent / Honcho inspired).
Analyze the user's latest inputs and interaction trajectory to extract lasting user habits, preferences, conventions, or constraints.

WHAT TO EXTRACT:
- Preferred language (e.g. "French", "English")
- Tone & brevity style (e.g. "caveman compressed", "concise technical", "elaborate")
- Tech preferences (e.g. "TypeScript strict", "Bun over npm", "Vitest", "Tailwind", specific paths)
- Explicit instructions like "always do X" or "never do Y"

OUTPUT FORMAT:
Respond with a strict JSON array of extracted preferences, or an empty array [] if none detected:
[
  {
    "key": "short_kebab_case_key",
    "value": "clear, actionable statement of the preference",
    "confidence": 0.8
  }
]
Only return the valid JSON array, without markdown wrapping or backticks.`;

export class ActivePreferenceLearner {
  constructor(private readonly memoryManager: MemoryManager) {}

  /**
   * Run background non-blocking preference extraction on turn completion
   */
  async extractAndRecord(messages: Message[]): Promise<number> {
    if (messages.length < 2) return 0;

    const userMessages = messages
      .filter((m) => m.role === 'user')
      .slice(-3);

    if (userMessages.length === 0) return 0;

    const userTextSample = userMessages
      .map((m) =>
        m.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { text: string }).text)
          .join(' ')
      )
      .join('\n---\n');

    // Skip if input is trivial (e.g. "ok", "yes", single word)
    if (userTextSample.trim().length < 15) return 0;

    try {
      const appConfig = configStore.getAll();
      const response = await runPiAiOneShot(
        `User inputs to analyze for preferences:\n${userTextSample}`,
        PREFERENCE_EXTRACTION_PROMPT,
        appConfig,
        { temperature: 0.1 }
      );

      const cleaned = response.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const list = JSON.parse(cleaned) as Array<{ key: string; value: string; confidence?: number }>;

      if (!Array.isArray(list) || list.length === 0) return 0;

      let recorded = 0;
      for (const item of list) {
        if (item.key && item.value) {
          this.memoryManager.recordUserPreference(item.key, item.value, item.confidence || 0.85);
          recorded++;
        }
      }

      if (recorded > 0) {
        log(`[ActivePreferenceLearner] 🧠 Actively learned ${recorded} user preference(s) from conversation.`);
      }

      return recorded;
    } catch (err) {
      logError('[ActivePreferenceLearner] Failed to extract preferences:', err);
      return 0;
    }
  }
}
