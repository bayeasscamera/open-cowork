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

---

## Robustness Rules (Non-Negotiable)

### Error handling
- Every `async` function that can fail must have a `try/catch`.
- Timeouts are mandatory for all external calls (use `withTimeout()` in `src/main/index.ts`).
- Electron IPC handlers must never throw uncaught exceptions — wrap in try/catch and send error back.
- Database operations must be wrapped in try/catch; never crash the main process.

### Security
- No user-controlled strings passed to `shell.openExternal()` without validation.
- No `webSecurity: false` in BrowserWindow config.
- All IPC channels must be declared in `src/preload/index.ts` — no dynamic channel names.
- Sandbox must be enabled for renderer (`sandbox: true`).
- Never log API keys, tokens, or passwords — use `[REDACTED]` in logs.

### Shutdown / lifecycle
- Any new cleanup resource must be registered in `cleanupSandboxResources()` in `src/main/index.ts`.
- Use `withTimeout()` with a max of 5000ms for every cleanup call.
- The `isCleaningUp` flag is set by `before-quit` — do NOT re-set it inside cleanup functions.

### Memory / context
- `MemoryManager` (in `src/main/memory/memory-manager.ts`) now has a real LLM-powered `compressContextAsync()`.
  Use it instead of the synchronous `compressContext()` when async context is available.
- Record errors in `MemoryManager.recordErrorPattern()` so future sessions avoid the same mistakes.
- Inject `formatErrorPatternsForContext(userPrompt)` into agent system prompts before sending to LLM.

### TypeScript
- `strict: true` enforced — no implicit `any`, no non-null assertions without comment.
- Prefer `unknown` over `any` for external data; narrow with type guards.
- Use `satisfies` operator to validate literal types without widening.

---

## Three-layer architecture (agent presets)

Three layers, and the boundaries are load-bearing — do not blur them.

| Layer | What it is | Where |
|---|---|---|
| **Core** | Tool registry, permissions, path guard, mods, database, sandbox. **Protected — never bypassed.** | `src/main/tools/`, `src/main/sandbox/`, `src/main/mods/`, `src/main/db/` |
| **Preset** | What an agent gets: allowed tools, persona, pruning and delegation limits, skill dirs, presentation mode. **Data, never code.** | `src/main/presets/` |
| **Presentation** | How the model sees the tools: one-by-one, or as a generated SDK driven by `run_code`. | `src/main/presets/tool-presenter.ts` |

### One execution funnel

`invokeTool()` (`src/main/tools/invoke.ts`) is the single entry point for
executing a tool, and it always runs the same gate in the same order:

```
validate args → preset allow-list → permissions → path-guard → mods pre
  → execute → mods post (secret redaction) → preset truncation
```

Two callers reach it: `invokeTool()` for calls the app executes itself
(sub-agents, the `run_code` bridge), and the pi SDK's `beforeToolCall` hook
(`src/main/agent/agent-hooks.ts`) for calls the SDK dispatches. **Both run the
same pipeline** (`src/main/tools/pipeline.ts`) — that shared implementation is
what makes "permissions and path confinement apply everywhere" structural
rather than a convention. If you add a check, add it to `runToolGate()`; do not
re-implement it in a caller.

The SDK's own built-in tools are executed by the SDK and cannot be routed
through `invokeTool()`; they reach the same gate through the hook. The
`.execute()` calls in `swarm-runner.ts` and the memory dispatchers are SDK-shaped
wrappers, not a bypass — do not "clean them up" without understanding why.

### Preset resolution order (the only order)

- **Sub-agent:** `criticality` → `perRole` → **preset** → sub-agent ConfigSet → inherited active profile.
- **Direct session:** project pin (`projects.preset_id`) → session override → `standard`.

Documented once, in `src/main/presets/preset-resolver.ts`. `NULL` in the
database means `standard`, so every pre-preset project keeps its exact previous
behaviour.

### Writing a preset

A preset is **pure data**. It is validated by a strict Zod schema
(`preset-schema.ts`) that **rejects unknown keys** — a typo fails loudly instead
of silently leaving a field at its default. See
`examples/presets/reviewer/` for a commented, loadable example and the full
field reference.

Rules that are enforced, not conventions: no `'*'` in `tools.allow`; every named
tool must exist in the registry; `headChars + tailChars < thresholdChars`;
`maxDepth ≤ 2`; `maxRounds ≤ 64`; `extraDirs` can never leave the preset
directory (checked lexically *and* through `realpath`, so a symlink cannot
escape). A user preset can never shadow a built-in id.

### `run_code` limits (mode code)

Model-written code **never runs in the main process**. It is transpiled and run
in a child `node` process that has no tool implementation, no credentials and no
authority: every `tools.*()` call is a JSONL request that the main process
answers through `invokeTool()`, so code can never obtain a capability a direct
call could not.

Enforced by the host (`src/main/agent/run-code-host.ts`):

| Limit | Default |
|---|---|
| wall clock | 60 s (kills the whole **process group**) |
| tool calls | 50 per execution |
| protocol output | 1 MB |
| single tool result | 64 000 chars |
| child memory | 512 MB (V8 old space, enforced via `--max-old-space-size`) |
| environment | secrets stripped by pattern, not by an allow-list of names |

Approvals are the **session's**; `detachedAutoApprove` is deliberately never
inherited. **Off by default**: the shipped `standard` preset does not list
`run_code`, so the whole path is unreachable until a user picks code mode.

An agent may `propose_preset` but never load one. Proposals are data, live in a
directory the loader never reads, and need explicit human approval — with an
extra consent gate for `presentation: 'code'` and `allowFork: true`.

---

## Project Brain — Architecture Map

### Electron Main Process (`src/main/`)

| Module | Role |
|--------|------|
| `index.ts` | App bootstrap, lifecycle and the generic `client-invoke`/`client-event` entry points. **Critical: all cleanup via `cleanupSandboxResources()`** |
| `ipc/*.ts` | Domain IPC modules (`registerXxxIpcHandlers(context)`): client event dispatch, config, skills/plugins, sandbox, remote, schedule, memory, window/shell, logs, mods, artifacts, MCP |
| `agent/agent-runner.ts` | Core agent execution loop. Orchestrates LLM calls, tool execution, compaction |
| `agent/elite-coding-intelligence.ts` | System prompt for elite engineering. `EliteCodingIntelligence.getElitePrompt()` |
| `agent/self-healing-runner.ts` | Retry & self-repair loop on agent failures |
| `agent/model-router.ts` | Routes tasks to cheapest capable model |
| `agent/multi-agent-coordinator.ts` | Coordinates parallel sub-agents |
| `memory/memory-manager.ts` | **The brain**: LLM summaries, causal error-pattern memory, context compression |
| `memory/memory-service.ts` | Experience + core memory service with embedding-based retrieval |
| `memory/memory-retriever.ts` | Semantic search across sessions (progressive retrieval) |
| `memory/memory-llm-client.ts` | LLM & embedding client for memory operations |
| `memory/codegraph-indexer.ts` | Codebase graph indexer for structural awareness |
| `session/session-manager.ts` | Session CRUD, message queuing, title generation |
| `config/config-store.ts` | App config store (provider, API key, model, memory settings) |
| `mcp/` | MCP server management — spawning, shutdown, tool routing |
| `sandbox/` | WSL/Lima sandbox management for safe code execution |
| `skills/` | Skills discovery, installation, storage monitoring |
| `schedule/` | Scheduled task manager |
| `remote/` | Remote control (VM/SSH) |
| `db/database.ts` | SQLite database init and migrations |

### Renderer (`src/renderer/`)

| Module | Role |
|--------|------|
| `components/ChatView.tsx` | Main chat interface |
| `components/settings/SettingsAPI.tsx` | API/provider settings (key visibility toggle, all providers) |
| `components/settings/SettingsGeneral.tsx` | General settings + system info cards |
| `hooks/useApiConfigState.ts` | Config state hook |
| `i18n/locales/en.json` + `fr.json` | All user-facing strings — always update both |

### Shared (`src/shared/`)

| Module | Role |
|--------|------|
| `api-provider-guidance.ts` | Provider setup guides (Anthropic, OpenAI, Groq, Mistral, Together, Ollama…) |
| `api-model-presets.ts` | Model presets per provider |

### Tests (`tests/` — flat, 230+ files)

Naming convention: `<feature>-<behavior>.test.ts`
Examples: `provider-guidance.test.ts`, `session-manager-crud.test.ts`

### CI/CD (`.github/workflows/`)

| Workflow | Trigger | What it does |
|----------|---------|---------------|
| `ci.yml` | PR / push to main/dev | lint + tsc + test + coverage upload |
| `codex-pr-review.yml` | PR opened/updated | Codex/DeepSeek AI review, posts comment |
| `release.yml` | Tag push | Build & publish release |

### Git Hooks (`.husky/`)

| Hook | What it checks |
|------|---------------|
| `pre-commit` | lint-staged + `npm run check` (typecheck + lint + tests) |
| `pre-push` | `npm run check` (typecheck + lint + tests) |
| `commit-msg` | Conventional Commits format |

---

## When Adding a New Provider

1. Add type to `CommonProviderSetupId` in `src/shared/api-provider-guidance.ts`
2. Add `CommonProviderSetup` object with URL matchers and guidance steps
3. Add i18n keys in `src/renderer/i18n/locales/en.json` AND `fr.json`
4. Add test case in `tests/provider-guidance.test.ts`
5. Run `npm run typecheck` + `npm run test`
6. Commit: `feat(providers): add <name> provider support`

## When Adding a New IPC Channel

1. Declare in `src/preload/index.ts` — expose via `contextBridge`
2. Register the handler in the matching `src/main/ipc/*.ts` module — wrap in try/catch; only app bootstrap/lifecycle stays in `src/main/index.ts`
3. Use typed events — update `src/renderer/types/index.ts` if needed
4. Never use dynamic channel names

## When Adding a New Cleanup Resource

1. Add shutdown call inside `cleanupSandboxResources()` in `src/main/index.ts`
2. Wrap with `withTimeout(yourCleanup(), 5000, 'YourModule shutdown')`
3. Catch and log errors — never throw from cleanup

---

## Intelligence Tips for Agents

- **Before touching any file**: search for all usages of the symbol you're changing.
  Large refactors without ripple-effect analysis cause cascading test failures.
- **On TypeScript errors**: read the full error message. Don't guess — the type system knows more than you.
- **On test failures**: read the test name AND the assertion message before touching any code.
- **On import errors**: check the actual export name in the source file. Barrel re-exports can lie.
- **MemoryManager causal memory**: when you encounter a recurring bug pattern, call
  `memoryManager.recordErrorPattern(pattern, rootCause, fix, context)` so future
  sessions can skip straight to the fix.

---

## Consignes agent (FR)

- Lance `npm run check` (typecheck + lint + tests) après chaque modification.
- Ne supprime rien sans demander (code, fichier, dépendance).
- Ne touche pas aux fichiers hors de la tâche en cours.
- Fais un commit avant chaque tâche pour pouvoir tout annuler.
- [`main` / `preload` / `renderer`] : garde bien séparés le processus principal
  (`src/main`), le `preload` (`src/preload`) et l'interface (`src/renderer`).
- Teste en priorité les fonctions critiques (traitement photo, appels aux
  providers d'images) : c'est là qu'une erreur coûte le plus cher.
- TypeScript est en mode strict (`"strict": true`) : ne le désactive pas.
