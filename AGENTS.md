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
| **writes** | confined to the workspace by the OS; verified |
| **network** | refused at the socket layer, including localhost; verified |
| **subprocesses** | refused; verified |
| **reads** | the whole home directory is refused; verified |

**Reads are jailed by directory, not denied by list.** The policy is:

```
(allow file-read-data)                              ; general
(deny  file-read-data (subpath "<home>"))           ; close the home directory
(allow file-read-data (subpath "<workspace>"))      ; reopen — last rule wins
(allow file-read-data (subpath "<node install>"))   ; reopen the runtime
```

A deny-list of credential paths was the previous design and it was an argument
from ignorance: it could only cover the locations somebody thought of. Closing the
directory covers the ones nobody did. Verified against real sandboxed processes —
an ordinary file in the home directory is refused, not just a secret; listing the
directory is refused; and a symlink the script plants in its writable workspace
pointing back into the home directory is refused too.

**A read ALLOW-list is not available on macOS**, and that was measured rather than
assumed. `(allow file-read-data (subpath …))` over an enumerated set — node's
install, `/System`, `/usr`, `/private`, `/dev`, `/etc`, `/var`, the workspace —
leaves node unable to start: dyld resolves library and shared-cache paths through
firmlinks that do not reduce to any enumerable subtree. The general allow therefore
stays, and the narrowing is by directory. An allow-list that does not boot is
worse than none, because it looks configured.

On Linux the jail is structural rather than policy: bubblewrap only binds the
workspace writable and a few system directories, so the home directory is not
mounted at all and there is nothing to allow.

Still true: this is not a jail against *everything*. A confined child can read
ordinary files outside the workspace and outside the home directory — `/etc` for
instance, minus the paths denied individually. It is, however, no longer true that
it can read the user's own files, which is where the credentials are.

Two things this does not bound: CPU (the timeout does), and native memory
outside the V8 heap (also the timeout, eventually).

Approvals are the **session's**; `detachedAutoApprove` is deliberately never
inherited. The session's `requestPermission` handler is what a call from code
must satisfy, and a handler that throws fails the call closed rather than
allowing it by accident.

**On by default? No.** `standard` does not list `run_code`, so the path stays
unreachable until a user pins the `code-mode` preset — which is the only built-in
that grants it, and the only one using `presentation: 'code'`.

**Enabling it required a fix first.** `installPermissionHook` in `agent-runner`
was passing neither `allowedTools` nor `checkPath` to the shared pipeline, and
the pipeline *skips a stage whose deps are undefined* — so SDK-dispatched tool
calls, which is how the model actually calls tools, ran permissions and mods but
**not** the preset allow-list and **not** the path-guard. Turning on code mode
before fixing that would have inverted the invariant: calls from code gated,
direct calls ungated. Both paths now get the same gate, built once by
`createSessionGate()`.

An agent may `propose_preset` but never load one. Proposals are data, live in a
directory the loader never reads, and need explicit human approval — with an
extra consent gate for `presentation: 'code'` and `allowFork: true`.

---

## The one `new Function` in the main bundle, and who owns it

No first-party source evaluates anything in the main process. The main *bundle*
still contains a `new Function`, and it belongs to **AJV**, which compiles JSON
Schema into JavaScript and evaluates the result. AJV arrives through
`@mariozechner/pi-ai` (validating tool arguments), `electron-store`/`conf` (the
app's own config schema) and `electron-builder` (build time only).

The distinction that matters is **schema versus data**:

| Input | Role | Reaches `new Function`? |
|---|---|---|
| Model output | the DATA being validated | **No** — it is validated against a schema, never compiled as one |
| Our tool schemas | app-authored TypeBox, declared in source | Yes — it is our own trusted schema |
| **MCP server schemas** | supplied by a third-party server we run | **Yes** |

So a malicious or compromised MCP server can reach AJV's code generator, at
validation time and therefore ahead of any permission check. Two things bound
this in practice. First, MCP schemas arrive as JSON, and JSON has no functions:
a server cannot inject code into the generated validator, only shapes that make
validation expensive (a pathological `pattern` hanging every call, a megabyte of
schema). Second, `mcp-schema-guard.ts` now checks every server-provided schema
BEFORE it becomes a tool — 64 KiB, 10 levels, 2000 nodes, patterns that compile
and fit 200 chars — and a refusal drops the tool with a logged reason rather
than silently dropping its schema (a schema-less tool cannot be validated at
all, which is worse). Detecting catastrophic backtracking in general is
undecidable, so no heuristic claims to; the length cap plus compilation is what
turns an unbounded hang into a bounded refusal.

`tests/main-bundle-eval-provenance.test.ts` asserts the invariant that matters for
the agent threat model — model output is the data and never the schema — so
feeding model output into a compiling position fails loudly.

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
| `machine-access/` | **Controlled machine access.** `safe-path.ts` (`resolveSafePath` — one resolution used by every file tool), `sensitive-zones.ts` (flagged, never blocked), `risk-assessor.ts` (`assessRisk` → ordinaire/dangereux/suspect), `approval-binding.ts` (fingerprint-bound, expiring approval), `grant-store.ts` (user-only grants + autonomy), `fs-tools.ts` / `fs-journal.ts` / `batch-plan.ts` (tools, trash, journal, undo, batches), `project-rename.ts` (transactional rename), `command-runner.ts` (scrubbed env, timeout, process-group kill), `machine-control.ts` (GUI allow-list, rate limit, emergency stop), `injection-guard.ts`, `machine-access-service.ts` (assembly), `runtime.ts` (**the one shared service** — one instance for IPC and the gate; null in WSL/Lima/SSH/Daytona), `emergency-stop.ts` (global `Cmd/Ctrl+Shift+.` stop) |
| `agent/machine-access-gate.ts` | Machine access as a stage of the SHARED tool gate — so the SDK hook and `run_code` bridge cannot diverge. Refuses `allow_always` for dangerous/sensitive actions and fails closed when no prompt can be shown |

### Renderer (`src/renderer/`)

| Module | Role |
|--------|------|
| `components/ChatView.tsx` | Main chat interface |
| `components/settings/SettingsAPI.tsx` | API/provider settings (key visibility toggle, all providers) |
| `components/settings/SettingsGeneral.tsx` | General settings + system info cards |
| `components/settings/SettingsMachineAccess.tsx` | Machine access: allowed folders, autonomy, allowed apps, system permission state, operation history with Undo, emergency stop |
| `components/MachineApprovalCard.tsx` | Chat confirmation card (exact command, risk level, before/after rows, source-named reconfirmation). No "always approve" for dangerous/suspicious actions |
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

## Machine access invariants (do not break these)

The feature in `src/main/machine-access/` is governed by one rule: **a
dangerous or suspicious action is always explained and always asks for user
approval, at every autonomy level including "allow-all", and the agent can
never answer that question itself.** `docs/machine-access-security.md` is the
reference; these are the load-bearing points.

1. **Grants are user-only.** `GrantStore.addGrant(input, origin)` throws unless
   `origin === 'user'`. There is deliberately no agent-facing "allow" path; the
   agent uses `requestAccess()`, which produces a request the UI shows.
2. **Sensitive zones are flagged, never blocked.** Callers get
   `sensitive: true` and must route to an approval card. Do not convert a
   sensitive-zone check into a refusal.
3. **Deletion goes to the trash, always.** Use `fs_trash` / `backupFile`; never
   `unlink`, never `rm -rf`. Undo refuses rather than destroying user data when
   the current state diverges from the journal.
4. **Approval binds to the exact action.** `createBinding` / `isBindingValid`
   fingerprint the command and paths and expire in 5 minutes. A changed action
   re-asks; it must never reuse a card.
5. **Paths resolve before they are checked.** `resolveSafePath` calls
   `realpath` BEFORE the containment test, and callers re-verify
   (`reverifySafePath`) immediately before acting (TOCTOU).
6. **Doubt escalates.** `assessRisk` classifies to the HIGHER level when
   uncertain. Do not add a branch that lowers a classification.
7. **Untrusted content is data.** Contents and file names are sanitized before
   display; a destructive action after untrusted reading forces a reconfirmation
   naming the source — including under "allow-all".
8. **Machine access is native-mode only.** `machine-access/runtime.ts` returns
   `null` in WSL/Lima/SSH/Daytona; never imply machine access is active when it
   is not.
9. **One service, one truth.** `runtime.ts` owns the singleton. Never construct a
   `MachineAccessService` anywhere else: two instances would let a grant revoked
   in Settings still be honoured by a tool call.
10. **The gate is a stage, not a side-channel.** Machine-access checks belong in
   `runToolGate` (via `createSessionGate`), never inside a tool body only — a
   tool-only check is skipped by the call path that re-enters through
   `invokeTool`.

Tests: `tests/machine-access-*.test.ts` (behaviour), `*-branches*.test.ts` and
`machine-access-coverage.test.ts` (branch closure, held at ≥80%), plus
`machine-access-e2e.test.ts` for the real-files path. Locked defaults are
asserted; if you change one, the test must change with it and say why.

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
