/**
 * @module main/machine-access/schema
 *
 * SQLite DDL for controlled machine access. Uses CREATE TABLE IF NOT EXISTS
 * (multi-process safe) — no ensureColumn needed for new tables.
 */

export const MACHINE_ACCESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  access TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_grants_path ON access_grants(path);

CREATE TABLE IF NOT EXISTS fs_operations (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  destination TEXT,
  backup_ref TEXT,
  checksum_before TEXT,
  checksum_after TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fs_operations_batch ON fs_operations(batch_id);

CREATE TABLE IF NOT EXISTS machine_approvals (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  risk TEXT NOT NULL,
  origin TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_machine_approvals_fingerprint ON machine_approvals(fingerprint);
`;
