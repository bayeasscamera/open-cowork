# Open Cowork — Agent Instructions

These rules apply to ALL coding agents working on this repository
(Antigravity, Claude Code, Codex, Gemini, Cursor, etc.).

---

## Mandatory Workflow for Every Coding Task

Follow this cycle **without exception**, in this exact order:

### 1. Audit before editing
- Read the relevant code before touching it.
- Identify existing bugs, security issues, or improvement opportunities.
- Only proceed if the change is safe and beneficial.

### 2. Implement
- Make focused, minimal changes.
- No `console.log` left in production code.
- No `any` in TypeScript unless absolutely unavoidable (comment why).
- All new user-facing strings → added to `src/renderer/i18n/locales/en.json` AND `fr.json`.

### 3. Verify
- Run `npm run typecheck` — must exit 0.
- Run `npm run test` — must exit 0.
- Run `npm run lint` — must exit 0.
- Fix all errors before proceeding.

### 4. Commit (MANDATORY before delivering the report)
After every coding task, before writing the final summary to the user, commit:

```bash
git add -A
git commit -m "<type>(<scope>): <short description>"
```

Use Conventional Commits:
- `feat(settings): add Groq provider support`
- `fix(shutdown): prevent zombie process on window close`
- `refactor(api): remove double isCleaningUp guard`
- `test(provider): add Groq guidance test cases`

**Never deliver a report without committing first.**

### 5. Report
Only after the commit is done:
- Summarize what was changed and why.
- List files modified.
- Confirm tests pass.
- Suggest next improvements if any.

---

## Code Standards

| Rule | Detail |
|------|--------|
| Language | TypeScript strict (`strict: true`) |
| Style | ESLint + Prettier (auto via lint-staged) |
| Commits | Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.) |
| i18n | All UI strings in `en.json` + `fr.json` |
| Tests | Vitest — add/update tests for every behavior change |
| Security | No secrets in code, no unsafe IPC handlers |

## Project Structure (quick map)

```
src/
  main/          — Electron main process (Node.js)
  renderer/      — React UI
  shared/        — Types and utils shared between main/renderer
tests/           — Vitest unit tests (flat, co-located by feature)
.github/
  workflows/     — CI (lint+test), AI PR review (Codex/DeepSeek)
  ISSUE_TEMPLATE/— agent-task.yml for structured specs
```
