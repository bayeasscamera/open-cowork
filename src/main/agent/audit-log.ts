/**
 * @module main/agent/audit-log
 *
 * Cowork 4.0 — Phase 5: append-only, exportable audit trail. Every action that
 * touches the workspace records its justification, the authorisation that
 * allowed it, the resulting diff and the verification evidence.
 */

import type { AuditEntry, NewAuditEntry } from '../../shared/workflow-types';

export type { AuditAuthorization, AuditEntry, NewAuditEntry } from '../../shared/workflow-types';

/**
 * In-memory audit log. Persistence is intentionally the caller's concern so the
 * log stays testable and never blocks the main process on disk I/O.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private sequence = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  public append(entry: NewAuditEntry): AuditEntry {
    this.sequence += 1;
    const record: AuditEntry = {
      ...entry,
      id: 'audit-' + this.sequence.toString(36) + '-' + this.now().toString(36),
      at: entry.at ?? this.now(),
    };
    this.entries.push(record);
    return record;
  }

  public list(): readonly AuditEntry[] {
    return this.entries;
  }

  public forTask(taskId: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.taskId === taskId);
  }

  public size(): number {
    return this.entries.length;
  }

  public clear(): void {
    this.entries = [];
    this.sequence = 0;
  }

  /** Machine-readable export used by the 'Export audit log' action. */
  public exportJson(): string {
    return JSON.stringify(
      { version: 1, exportedAt: this.now(), entries: this.entries },
      null,
      2
    );
  }
}
