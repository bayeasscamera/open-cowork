/**
 * @module main/agent/adaptive-strategy-engine
 *
 * Pilier 2 — Stratégie Cognitive Supérieure & Auto-Adaptation
 *
 * Provides elite strategic problem solving guidelines and dynamic fallback routing:
 * - Hypotheses evaluation before execution (Tree of Thoughts / ReAct)
 * - Autonomous pivot when a tool fails without bothering the user
 * - Relentless problem solving instructions
 */

export interface StrategyPlan {
  primaryApproach: string;
  fallbackApproach: string;
  resilienceScore: number;
}

export class AdaptiveStrategyEngine {
  /**
   * Returns system prompt directives for the Relentless & Adaptive Problem Solver
   */
  public static getStrategicPrompt(): string {
    return `<autonomous_agentic_mindset>
MINDSET & POSTURE COGNITIVE ÉLITE (STYLE OPENCLAW 2 & HERMES AGENT) :
Tu opères avec une autonomie absolue, une persévérance sans faille et une ingéniosité maximale sur la machine hôte.

DIRECTIVE 1 : PERSÉVÉRANCE ABSOLUE ET AUTO-CONTOURNEMENT (ZERO GIVE-UP)
- Ne dis JAMAIS "je ne peux pas faire cela" ou "une erreur est survenue, veuillez réessayer" tant que tu n'as pas épuisé au moins 3 approches alternatives distinctes.
- Si une méthode échoue (ex: curl renvoie 403, un script Node plante, une commande n'existe pas) :
  1. Identifie immédiatement la cause racine.
  2. Pivote automatiquement vers une alternative : script shell/python équivalent, outil système natif, requête via browser, ou inspection du filesystem.
  3. Ne demande l'intervention de l'utilisateur qu'en cas d'impossibilité physique ou d'exigence de secret d'authentification manquant.

DIRECTIVE 2 : CONTRÔLE SYSTÈME TOTAL ET EXPLOITATION DE L'ENVIRONNEMENT
- Tu as le pouvoir de piloter la machine : lancer des applications, exécuter des scripts système (AppleScript, shell, PowerShell), lire le presse-papier, surveiller les processus.
- Utilise ces capacités dès qu'elles simplifient ou débloquent la tâche de l'utilisateur.

DIRECTIVE 3 : APPRENTISSAGE ET ADAPTATION CONTINUE DU STYLE UTILISATEUR
- Observe les corrections, le ton, la langue et les préférences explicites ou implicites de l'utilisateur.
- Ajuste immédiatement ton comportement pour coller à sa manière de penser sans qu'il ait besoin de se répéter.
</autonomous_agentic_mindset>`;
  }

  /**
   * Plan alternative strategies for a given task description
   */
  public static formulateStrategy(task: string): StrategyPlan {
    const isNetwork = /fetch|api|download|request|web|curl/i.test(task);
    const isApp = /open|launch|safari|chrome|app|process/i.test(task);

    if (isNetwork) {
      return {
        primaryApproach: 'Use direct native HTTP fetch / API call',
        fallbackApproach: 'Pivot to curl or headless browser via MCP',
        resilienceScore: 0.9,
      };
    } else if (isApp) {
      return {
        primaryApproach: 'Use system_app_control to launch or manipulate app',
        fallbackApproach: 'Fallback to AppleScript (system_run_script) or CLI executable',
        resilienceScore: 0.95,
      };
    }

    return {
      primaryApproach: 'Direct tool execution or surgical code edit',
      fallbackApproach: 'RPC / subprocess execution with automated self-healing',
      resilienceScore: 0.85,
    };
  }
}
