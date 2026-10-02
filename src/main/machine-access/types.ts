/**
 * @module main/machine-access/types
 *
 * Controlled machine-access model: folder grants, autonomy levels, risk
 * levels and approval cards. Pure types — no Electron, no I/O.
 */

export type GrantAccess = 'read' | 'read-write';
export type GrantScope = 'session' | 'project' | 'permanent';

export interface FolderGrant {
  id: string;
  /** Canonical real path (realpath resolved at grant creation), never a link. */
  path: string;
  access: GrantAccess;
  scope: GrantScope;
  expiresAt?: number;
  createdAt: number;
}

export type AutonomyLevel =
  | 'ask-always'
  | 'read-free'
  | 'extended-trust'
  | 'allow-all';

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 'ask-always';

export type RiskLevel = 'ordinaire' | 'dangereux' | 'suspect';

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

/** Fingerprint-bound user approval for one exact action. */
export interface ApprovalBinding {
  /** sha256 over the canonical action (command + paths). */
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  /** Single action only — never a group with ordinary actions. */
  singleAction: true;
}

export interface ApprovalCard {
  titleKey: string;
  what: string;
  why: string;
  worstCase: string;
  undo: string;
  origin: string;
  approveLabelKey: string;
  refuseLabelKey: string;
}
