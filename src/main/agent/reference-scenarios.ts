/**
 * @module main/agent/reference-scenarios
 *
 * Cowork 4.0 — Phase 0: a fixed suite of reference scenarios and the metric
 * model used to compare releases. The scenarios are data, not fixtures: a
 * harness runs them against the live agent and records `RunMetrics`.
 */

import type { EvidenceKind, TaskBudget } from '../../shared/task-contract';

export type ScenarioKind =
  | 'bugfix'
  | 'multi-file-feature'
  | 'security-audit'
  | 'long-task'
  | 'session-resume';

export interface ReferenceScenario {
  id: string;
  kind: ScenarioKind;
  title: string;
  description: string;
  /** Prompt handed to the agent. */
  prompt: string;
  /** Evidence kinds a successful run must produce. */
  expectedEvidence: EvidenceKind[];
  budget: TaskBudget;
  successCriteria: string[];
}

export const REFERENCE_SCENARIOS: readonly ReferenceScenario[] = Object.freeze([
  {
    id: 'bugfix-null-guard',
    kind: 'bugfix',
    title: 'Correction de bug ciblée',
    description: 'Reproduire puis corriger un bug de garde nulle dans un module existant.',
    prompt:
      'Un test échoue dans le module de parsing: accès à une propriété d\'un objet undefined. Reproduis, corrige au minimum et prouve-le avec le test.',
    expectedEvidence: ['test', 'diff'],
    budget: { maxTokens: 20000, maxDurationMs: 600_000, maxToolCalls: 40 },
    successCriteria: [
      'Le test qui échouait passe.',
      'Aucun fichier hors du module concerné n\'est modifié.',
    ],
  },
  {
    id: 'feature-multi-file',
    kind: 'multi-file-feature',
    title: 'Feature multi-fichiers',
    description: 'Ajouter une fonctionnalité traversant IPC, preload et UI.',
    prompt:
      'Ajoute un canal IPC typé, son exposition preload et un composant UI, avec tests.',
    expectedEvidence: ['test', 'diff', 'review'],
    budget: { maxTokens: 60000, maxDurationMs: 1_800_000, maxToolCalls: 120 },
    successCriteria: [
      'typecheck, lint et tests passent.',
      'Toutes les chaînes UI sont internationalisées (en + fr).',
    ],
  },
  {
    id: 'security-audit',
    kind: 'security-audit',
    title: 'Audit de sécurité',
    description: 'Chercher les failles d\'un périmètre sans modifier le code.',
    prompt:
      'Audite les handlers IPC et le shell: injections, validation d\'URL, fuites de secrets. Produis un rapport priorisé, sans écrire de code.',
    expectedEvidence: ['review', 'note'],
    budget: { maxTokens: 30000, maxDurationMs: 900_000, maxToolCalls: 60 },
    successCriteria: [
      'Chaque constat cite fichier + ligne + scénario d\'exploitation.',
      'Aucune écriture de fichier.',
    ],
  },
  {
    id: 'long-task-refactor',
    kind: 'long-task',
    title: 'Tâche longue',
    description: 'Refactor sur plus de 20 tours avec checkpoints intermédiaires.',
    prompt:
      'Refactore le module en tâches atomiques vérifiables, avec un checkpoint par tâche.',
    expectedEvidence: ['test', 'diff', 'command'],
    budget: { maxTokens: 120000, maxDurationMs: 3_600_000, maxToolCalls: 200 },
    successCriteria: [
      'Chaque tâche a une preuve attachée à son checkpoint.',
      'Aucune régression sur les tests existants.',
    ],
  },
  {
    id: 'session-resume',
    kind: 'session-resume',
    title: 'Reprise de session',
    description: 'Redémarrer et reprendre un plan interrompu.',
    prompt:
      'Reprends le plan interrompu: identifie l\'état courant, restaure le contexte et continue la tâche suivante.',
    expectedEvidence: ['note', 'diff'],
    budget: { maxTokens: 40000, maxDurationMs: 1_200_000, maxToolCalls: 80 },
    successCriteria: [
      'L\'état du plan est retrouvé sans re-demander les décisions déjà prises.',
      'Aucune tâche déjà acceptée n\'est rejouée.',
    ],
  },
]);

export interface RunMetrics {
  scenarioId: string;
  /** Overall success as judged by the scenario success criteria. */
  success: boolean;
  /** Number of agent turns. */
  turns: number;
  costUsd: number;
  durationMs: number;
  /** Number of test regressions introduced. */
  regressions: number;
  /** Number of times a human had to intervene. */
  humanInterventions: number;
  evidenceCount: number;
}

export interface MetricsSummary {
  runs: number;
  successRate: number;
  avgTurns: number;
  avgCostUsd: number;
  avgDurationMs: number;
  regressionRate: number;
  humanInterventionRate: number;
  avgEvidence: number;
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

export function summarizeMetrics(runs: RunMetrics[]): MetricsSummary {
  if (runs.length === 0) {
    return {
      runs: 0,
      successRate: 0,
      avgTurns: 0,
      avgCostUsd: 0,
      avgDurationMs: 0,
      regressionRate: 0,
      humanInterventionRate: 0,
      avgEvidence: 0,
    };
  }

  const sum = (pick: (run: RunMetrics) => number) =>
    runs.reduce((total, run) => total + pick(run), 0);

  return {
    runs: runs.length,
    successRate: safeRatio(runs.filter((run) => run.success).length, runs.length),
    avgTurns: sum((run) => run.turns) / runs.length,
    avgCostUsd: sum((run) => run.costUsd) / runs.length,
    avgDurationMs: sum((run) => run.durationMs) / runs.length,
    regressionRate: safeRatio(
      runs.filter((run) => run.regressions > 0).length,
      runs.length
    ),
    humanInterventionRate: safeRatio(
      runs.filter((run) => run.humanInterventions > 0).length,
      runs.length
    ),
    avgEvidence: sum((run) => run.evidenceCount) / runs.length,
  };
}

export interface MetricsDelta {
  successRate: number;
  avgTurns: number;
  avgCostUsd: number;
  avgDurationMs: number;
  regressionRate: number;
  humanInterventionRate: number;
  /** True when the candidate is not worse on any tracked axis. */
  noRegression: boolean;
}

/** Compare a candidate run set against a baseline (positive delta = better). */
export function compareMetrics(baseline: MetricsSummary, candidate: MetricsSummary): MetricsDelta {
  const delta: MetricsDelta = {
    successRate: candidate.successRate - baseline.successRate,
    avgTurns: baseline.avgTurns - candidate.avgTurns,
    avgCostUsd: baseline.avgCostUsd - candidate.avgCostUsd,
    avgDurationMs: baseline.avgDurationMs - candidate.avgDurationMs,
    regressionRate: baseline.regressionRate - candidate.regressionRate,
    humanInterventionRate: baseline.humanInterventionRate - candidate.humanInterventionRate,
    noRegression: false,
  };
  delta.noRegression =
    delta.successRate >= 0 &&
    delta.avgTurns >= 0 &&
    delta.avgCostUsd >= 0 &&
    delta.regressionRate >= 0 &&
    delta.humanInterventionRate >= 0;
  return delta;
}
