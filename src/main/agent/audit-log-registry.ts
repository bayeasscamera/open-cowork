import { AuditLog } from './audit-log';

let _auditLog: AuditLog | null = null;

export function getGlobalAuditLog(): AuditLog | null {
  return _auditLog;
}

export function setGlobalAuditLog(log: AuditLog): void {
  _auditLog = log;
}
