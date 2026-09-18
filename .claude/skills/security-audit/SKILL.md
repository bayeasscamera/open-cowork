---
name: security-audit
description: Focused security audit of a codebase — dependency vulnerabilities, hardcoded secrets, injection risks (SQL, command, path traversal), unsafe IPC/Electron patterns, and missing input validation. Use when the user asks for a security review, pre-release audit, or hardening pass.
---

# Security Audit

## 1. Dependencies
- `npm audit --omit=dev` for production reachability; distinguish fixable vs manual (check advisories before `npm audit fix` — breaking majors need review).
- Flag dependencies with install scripts (`postinstall`) that touch the network.

## 2. Secrets
- Scan tracked files: API key/token patterns (`sk-`, `ghp_`, `AKIA`, long base64 in assignments).
- Check git history for leaked secrets: `git log -p | grep -iE "api[_-]?key|secret|token"` on suspicious paths.
- Confirm config files with credentials are encrypted or ignored by git.

## 3. Injection classes
- SQL: any string concatenation into queries — parameterized only. Dynamic identifiers (table/column names) must pass an allowlist validator.
- Command execution: `spawn/exec` with interpolated user input — reject; prefer argv arrays with `shell: false`.
- Path traversal: user-supplied paths must resolve (realpath) under an allowlisted root — lexical checks alone miss symlinks.
- XSS: any `innerHTML`/`dangerouslySetInnerHTML` — must be sanitized or proven static.

## 4. Electron specifics (if applicable)
- No `nodeIntegration: true` / `webSecurity: false` in BrowserWindow configs; `contextIsolation` and sandbox on.
- Every `ipcMain.handle` validates its inputs (types, ranges, allowlists) and never returns raw errors containing credentials.
- `shell.openExternal` only with validated http/https URLs; no dynamic protocol handlers without validation.

## 5. Reporting format
Classify findings: CRITICAL (exploitable now) / HIGH (requires conditions) / MEDIUM (defense in depth) / LOW (hygiene).
For each: file:line evidence, exploit path, and the minimal fix. Never include real secrets in the report — show `[REDACTED]` and the pattern that matched.
