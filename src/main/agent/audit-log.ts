/**
 * @module main/agent/audit-log
 *
 * Cowork 4.0 — Phase 5: append-only, exportable audit trail. Every action that
 * touches the workspace records its justification, the authorisation that
 * allowed it, the resulting diff and the verification evidence.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuditEntry, NewAuditEntry } from '../../shared/workflow-types';

export type { AuditAuthorization, AuditEntry, NewAuditEntry } from '../../shared/workflow-types';

/**
 * In-memory audit log. Persistence is intentionally the caller's concern so the
 * log stays testable and never blocks the main process on disk I/O.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  /**
   * Entries are identified across a log's whole life, not just within one
   * generation. It used to reset on clear(), so an id built from it collided
   * with an entry that had already been exported: two different
   * justifications, the same identifier, and an exported trail that could no
   * longer point at one of them unambiguously.
   */
  private idCounter = 0;

  constructor(
    private readonly logFilePath?: string,
    private readonly now: () => number = () => Date.now()
  ) {
    if (logFilePath) {
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
      // Replay entries from the NDJSON file so in-memory view survives restarts.
      this.replayFromFile();
    }
  }

  /** Load previously persisted entries from the NDJSON file (idempotent). */
  private replayFromFile(): void {
    if (!this.logFilePath) return;
    try {
      if (!fs.existsSync(this.logFilePath)) return;
      const raw = fs.readFileSync(this.logFilePath, 'utf-8');
      let maxCounter = 0;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as AuditEntry;
          if (parsed && typeof parsed.id === 'string' && typeof parsed.at === 'number') {
            this.entries.push(parsed);
            // Restore idCounter so new ids never collide with replayed ones.
            const parts = parsed.id.split('-');
            if (parts.length >= 2) {
              const n = parseInt(parts[1], 36);
              if (!isNaN(n) && n > maxCounter) maxCounter = n;
            }
          }
        } catch {
          // Skip malformed lines rather than aborting the whole replay.
        }
      }
      if (maxCounter > this.idCounter) this.idCounter = maxCounter;
    } catch {
      // File unreadable — start fresh, don't crash.
    }
  }

  public append(entry: NewAuditEntry): AuditEntry {
    this.idCounter += 1;
    const record: AuditEntry = {
      ...entry,
      // The counter is what makes the id unique; the timestamp keeps entries
      // sortable and readable in an export.
      id: 'audit-' + this.idCounter.toString(36) + '-' + this.now().toString(36),
      at: entry.at ?? this.now(),
    };
    this.entries.push(record);
    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, JSON.stringify(record) + '\n');
      } catch (e) {
        console.error('Failed to append to audit log file:', e);
      }
    }
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

  public flush(): void {
    if (this.logFilePath) {
      try {
        const jsonPath = this.logFilePath.replace('.ndjson', '.json');
        fs.writeFileSync(jsonPath, this.exportJson(), 'utf-8');
      } catch (e) {
        console.error('Failed to flush audit log:', e);
      }
    }
  }

  public clear(): void {
    this.entries = [];
    // idCounter deliberately survives: an id already handed out must never be
    // handed out again, even in a log that starts over.
  }

  /** Machine-readable export used by the 'Export audit log' action. */
  public exportJson(): string {
    return JSON.stringify(
      { version: 1, exportedAt: this.now(), entries: this.entries },
      null,
      2
    );
  }

  /** Newline-delimited JSON, for log shippers and SIEM ingestion. */
  public exportNdjson(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join('\n');
  }

  /** Flattened CSV (one row per entry), with RFC 4180 quoting. */
  public exportCsv(): string {
    const columns: Array<keyof AuditEntry> = [
      'id',
      'at',
      'action',
      'authorization',
      'capability',
      'matchedRuleId',
      'taskId',
      'justification',
      'files',
      'verification',
    ];
    const escape = (value: unknown): string => {
      const text = Array.isArray(value) ? value.join(' ') : value === undefined || value === null ? '' : String(value);
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const header = columns.join(',');
    const rows = this.entries.map((entry) =>
      columns.map((column) => escape(column === 'at' ? new Date(entry.at).toISOString() : entry[column])).join(',')
    );
    return [header, ...rows].join('\n');
  }
}
