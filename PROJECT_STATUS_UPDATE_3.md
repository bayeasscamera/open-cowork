# Project Status Update 3 — Agent presets, `run_code`, and delegation

**Date:** 2026-10-02
**Branch:** `fix/security-review-and-external-links` (not pushed)
**Baseline:** `PROJECT_STATUS_UPDATE_2.md` (2026-09-22)

State after nine phases of work in ten commits, verified by
`npm run lint && npm run typecheck && npm run test`:

```
Test Files  416 passed (416)
Tests       3954 passed | 2 skipped (3956)
```

---

## What is genuinely finished

### Presets are data, and the data is validated

`src/main/presets/` is a new layer between the protected core and the model. A
preset says *what an agent gets* — its allowed tools, persona, tool-output
trimming budget, delegation depth, extra skill directories, presentation mode —
and nothing else. It is never evaluated.

The schema (`preset-schema.ts`) is **strict**: unknown keys are rejected. A typo
like `maxDepht` fails loudly at load instead of silently leaving a field at its
default, because a preset that appears to configure something it does not is
worse than one that refuses to load.

Constraints are enforced in code, not documented and hoped for:

| Rule | Enforced how |
|---|---|
| no `'*'` in `tools.allow` | schema — a wildcard would make "which tools may this agent use?" unanswerable |
| every named tool must exist | checked against the live registry |
| `headChars + tailChars < thresholdChars` | schema — otherwise truncation would not shorten anything |
| `maxDepth ≤ 2`, `maxRounds ≤ 64` | schema |
| `extraDirs` cannot escape the preset directory | checked lexically **and** through `realpath`, so a symlink cannot escape either |
| a user preset cannot shadow a built-in id | loader |

A preset that fails to load is **listed with its reason** in Settings → Presets.
Nothing is dropped silently.

### One execution funnel

`invokeTool()` (`src/main/tools/invoke.ts`) is the single entry point for
executing a tool, and it always runs the same gate in the same order:

```
validate args → preset allow-list → permissions → path-guard → mods pre
  → execute → mods post (secret redaction) → preset truncation
```

Two callers reach it: direct calls, and the pi SDK's `beforeToolCall` hook
(`src/main/agent/agent-hooks.ts`). Both run the **same implementation**
(`src/main/tools/pipeline.ts`). That shared code is what makes "permissions and
path confinement apply everywhere" structural rather than a convention — a new
check added to `runToolGate()` cannot be forgotten by the next caller.

### The trimmer actually shrinks

The compaction pruner keeps `headChars` from the start and `tailChars` from the
end of a tool result, and states how many characters were dropped. This is the
only thing in the change set that reduces prompt size; the memory
compressors (`compressContext()` / `compressContextAsync()`) summarise messages
and are unrelated to size.

### Fork mode, off by default

A sub-agent can inherit the parent's model, ConfigSet and conversation, so the
provider's prompt cache is reused instead of paying to re-send the prefix. It is
consent-gated and snapshot-based, and the whole forest is bounded by a
semaphore. Off unless explicitly enabled.

### Proposing, never loading

An agent may `propose_preset`. It may not load one. Proposals are data, live in a
directory the loader never reads, and require explicit human approval. Code
mode and forking each add a **second, separate** consent gate, and the UI renders
the preset's own stated reasons rather than a generic warning — the user consents
to the specific capability being granted.

### `run_code` — tested, gated, and not reachable

Model-written code never runs in the main process. It is transpiled **by the
child** (the main process does not even parse untrusted source) and executed in a
child `node` process with no tool implementation, no credentials and no
authority. Every `tools.*()` call is a JSONL request the main process answers
through `invokeTool()`, so a call made from code is subject to the same preset,
permission, path-guard and mods checks as a direct call. It cannot obtain a
capability a direct call could not.

Enforced by the host: 60 s wall clock killing the whole **process group** (so a
script that spawns its own subprocess cannot outlive the limit), 50 tool calls,
1 MB of protocol output, 64 000 chars per tool result, and an environment
stripped of anything secret **by pattern** rather than by an allow-list of
names. Approvals are the session's — `detachedAutoApprove` is deliberately never
inherited, because that flag exists for unattended background delegation.

17 of these tests spawn real child processes and assert on real wall-clock
behaviour, not on mocked timers.

---

## What is **not** finished

Stated plainly, because the code is written and tested but not reachable by a
user, and describing it as "done" would be false.

`run_code` is currently **inert in the shipping app**. All three of these are
true:

1. **The child runtime is never built or wired.** `runCode()` requires a
   `childScript` path; only tests supply one, and there is no bundler entry and
   no production caller. Without it the call fails closed with
   "no child runtime is configured", which is the correct failure but means the
   feature is dark.
2. **The presenter has no consumers.** `presentToolsForPreset()` is fully
   implemented and unit-tested, but `pi-session-tools.ts` does not call it, so
   the generated-SDK presentation never reaches a real session.
3. **`run_code` is in no allow-list.** Neither `standard` nor `code-mode` lists
   it, so the preset gate refuses it even if 1 and 2 were fixed. `code-mode`
   currently has identical tool access to `standard`, which is misleading given
   its description.

Consequently **no user-facing risk exists today** — the path is closed at three
independent points. But the honest status is "built and tested, not shipped".

### Security gaps inside `run_code` itself

Even once wired, two limits are weaker than the table in `AGENTS.md` implies:

- **`maxMemoryBytes` (512 MB) is declared but never enforced.** It is resolved
  into the limits object and then ignored; the child is spawned with no
  `execArgv`, so there is no `--max-old-space-size`. The "child memory" row in
  `AGENTS.md` is currently a design intent, not a fact. The OOM test proves only
  that the host survives the child dying, not that the child is capped.
- **There is no OS-level sandbox.** The child is plain `node` with `cwd` set; it
  can `import('node:fs')`, read outside the working directory, and open sockets.
  `cwd` is not a security boundary. The architecture comment claiming
  confinement should not be read as claiming a sandbox.
- **`requestPermission` is declared and typed but never invoked** by the host, so
  interactive approval for a permission-gated tool called from code is not
  actually requested; the gate's base decision is returned instead.

I have left the memory and permission rows in `AGENTS.md` in place because they
describe the intended contract, but the gap list above is the truth until they
are implemented.

### Deliberate non-fixes

- **`src/main/agent/code-execution-rpc.ts:76` still contains
  `new Function(...)` in the main process.** It is dead code, unreachable, and
  deliberately not removed in this change set because the brief listed it under
  "do not touch" items. It should be deleted in a dedicated, separately
  reviewed commit — a removal of an eval path deserves its own diff.
- **The pi SDK's built-in tools cannot all be routed through `invokeTool()`.**
  They execute inside the SDK. They reach the same gate through the
  `beforeToolCall` hook, but "every tool call in the app goes through
  `invokeTool()`" is not literally true and should not be claimed. The four
  remaining `.execute()` sites in `memory-service.ts`, `memory-files-tools.ts`
  and `swarm-runner.ts` are SDK-shaped wrappers, not bypasses.

### Corrections to premises in the brief

- **`SubAgentsView` was not rendered in two places.** The brief asked me to avoid
  introducing a duplicate, but `e7053bb` had already replaced the in-Settings
  copy with a link panel that navigates to the single view in `App.tsx`. There
  was no duplication to fix, and I did not invent one.
- **`compressContext`/`compressContextAsync` were the wrong site for the size
  fix.** They summarise messages. The character budget belongs to
  `pruneToolOutputs()`, which is where it was implemented.

### Test-suite side effect

`tests/subagents-view-navigation.test.ts` pinned the entire Model tab array
(`tabs: ['api', 'sandbox', 'subagents']`). Adding `presets` to that group broke
it. I rewrote that single assertion to assert the sub-agents tab is a *member*
of the group — which is what the test was actually about — rather than
weakening the test or reordering tabs to dodge it. The other 7 cases in that
file are unchanged.

---

## Commits

| Commit | Phase |
|---|---|
| `bcac050` | migrations idempotent and safe across processes |
| `c6b2256` | tool registry, shared gate pipeline, `invokeTool()` funnel |
| `c54f29c` | presets as validated data, one resolution order |
| `a4014fa` | pruner budget and extra skill dirs wired into the session |
| `ef6cd91` | `ToolPresenter` with a deterministic generated TypeScript SDK |
| `7844276` | fork mode — a sub-agent inheriting the parent's model |
| `6406bdf` | `run_code` in a child process, gated and quota'd |
| `9b802fe` | `propose_preset` — the safe version of self-modification |
| `6eb7ebc` | Settings → Presets, approval UI, project preset pin |
| this one | `AGENTS.md`, the `reviewer` example preset, this report |

A loadable example lives in `examples/presets/reviewer/`, with the field
reference in its `README.md` and a test asserting the shipped JSON still
validates — so the example cannot rot into something that fails to load.

---

## Recommended next steps, in order

1. **Delete `code-execution-rpc.ts`** in its own commit. It is the last `eval`
   path in the main process and it is dead.
2. **Enforce `maxMemoryBytes`** by spawning the child with
   `execArgv: ['--max-old-space-size=…']`, and add a test that asserts the cap
   rather than asserting the host survives an OOM.
3. **Wire `requestPermission`** so a permission-gated tool called from code
   actually prompts, instead of silently taking the base decision.
4. **Add a real sandbox**, or stop describing the child as confined. On macOS a
   seatbelt profile or a container is the honest answer; a `cwd` alone is not.
5. **Bundle the child and call `presentToolsForPreset()`** from
   `pi-session-tools.ts`; add `run_code` to `code-mode`'s allow-list **last**,
   once 2–4 are done — that is the moment the feature actually becomes
   reachable, and it should be a deliberate, separately reviewed act.
