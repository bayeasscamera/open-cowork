# Project Status Update 3 — Agent presets, `run_code`, and delegation

**Date:** 2026-10-02
**Branch:** `fix/security-review-and-external-links` (not pushed)
**Baseline:** `PROJECT_STATUS_UPDATE_2.md` (2026-09-22)

State after nine phases of work in ten commits, verified by
`npm run lint && npm run typecheck && npm run test`:

```
Test Files  420 passed (420)
Tests       4037 passed | 2 skipped (4039)
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

## Hardening pass: what changed after the first report

The first version of this report said `run_code` was inert and listed six gaps.
All six are now closed, and closing them surfaced a seventh problem that was
worse than any of them.

### Closed

| Gap | Resolution |
|---|---|
| `maxMemoryBytes` declared but never enforced | The child is started with `--max-old-space-size`; the value is clamped to 64–4096 MiB so a sub-MiB budget cannot round to zero and leave it uncapped. The child now reports its own heap limit at startup, and the host returns it, so enforcement is checkable instead of assumed. |
| `requestPermission` typed but never invoked | It is now called, composed *after* the session's static rules (a policy refusal is final and `allow` cannot override it) and it fails closed if it throws. The tool-use id is derived from the tool and a hash of its arguments, so a pipelined call is never labelled with another call's identity in a prompt a human is answering. |
| No OS sandbox | Seatbelt on macOS, bubblewrap on Linux, and a **refusal** where neither exists. Verified against real sandboxed processes: writes outside the workspace, opening any socket, and exec of anything but node are all refused. |
| Reads of credentials | Denied for `~/.ssh`, `~/.aws`, keychains, app data and similar. |
| Child never built or located | Built as its own bundle (`dist-electron/run-code-child/index.js`, 69 kB) and resolved at runtime, so production works with no caller-side wiring. |
| Presenter had no consumers | Wired into session tool assembly; it filters by the preset allow-list and picks the presentation mode. |

### The seventh problem, and why enabling code mode waited

`installPermissionHook` passed neither `allowedTools` nor `checkPath` to the
shared gate pipeline. The pipeline **skips a stage whose dependencies are
undefined**, so this was not "no restriction" — the preset allow-list and the
path-guard were silently not running for SDK-dispatched tool calls, which is how
the model actually calls tools. Only permissions and mods were applied.

Verified rather than inferred: `runToolGate` with `allowedTools` undefined allows
`bash`; with a list omitting it, the same call is refused at the `preset` stage.

This is why the code-mode switch was the *last* change and not the first. Before
the fix, enabling `run_code` would have inverted the invariant rather than
established it — calls from code preset-gated, direct calls not. Both paths now
get the same gate, built once by `createSessionGate()`.

### What the sandbox still is not

Reads are denied by path, not allowed by path, and this is a measured trade. A
read allow-list was built and node cannot boot under one: macOS resolves runtime
paths through firmlinks that land outside any top-level directory, so no such
list is complete, and an incomplete allow-list fails in the worst direction — it
looks configured while breaking the runtime. **A confined child can still read
ordinary files outside the workspace.** It is not a jail, and `AGENTS.md` says so.

Two things remain unbounded, and the timeout is what bounds both: CPU, and native
memory outside the V8 heap.

### Pre-existing test flakes found along the way

Neither is related to this work; both are recorded rather than fixed, because
they are outside its scope and both deserve their own change.

1. **`background-delegation-eviction`** — `listDelegations()` and the eviction
   pass both sort on `startedAt` with no tiebreaker, so two delegations created
   in the same millisecond have no defined order. Introduced 2026-09-20.
2. **`ollama-discovery`** — asserts a background revalidation lands inside
   `vi.waitFor`'s default timeout, which it does not under parallel load.

### Still true

- **`code-execution-rpc.ts` is gone.** It was the last `new Function` in the main
  process. The one that remains is in `run-code-child.ts`, and
  `tests/eval-isolation.test.ts` asserts it is unreachable from the main entry
  graph. Note that the main *bundle* also contains a `new Function` from a
  schema-validation dependency; it evaluates that library's own expressions, not
  model output, but it is worth knowing it is there.
- **The pi SDK's built-in tools cannot all be routed through `invokeTool()`.**
  They execute inside the SDK and reach the same gate through
  `beforeToolCall`.

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

## Verification pass: what was checked against reality, and what that found

Six claims about this work had never been exercised outside a unit test. Checking
them found **four real bugs**, three of them in the feature itself. None would
have failed a build, and none would have thrown at runtime — they produced a
feature that looked enabled and did nothing.

| Check | Method | Found |
|---|---|---|
| Packaged app | `electron-builder --dir --mac` → real 188 MB app | **2 bugs**: the child shipped *inside* the asar, which a plain `node` process cannot read; and `esbuild` was not shipped at all |
| Linux sandbox | real `bwrap` in a container | **1 bug**: `--ro-bind /lib64` fails where `/lib64` does not exist (Debian bookworm, Alpine) |
| Model-facing chain | the real chain, preset → assembly → presentation → `invokeTool` | **1 bug**: the presentation input excluded `run_code`, so a code-mode session was offered **no tools at all** |
| Packaged app launches | launched the built app | boots in 442 ms, clean shutdown, no crash |
| Test suite | full run, repeated | 2 pre-existing flakes, both now fixed at the cause |
| Main-bundle eval | traced to source | AJV via pi-ai; model output is data, MCP schemas are compiled |

### The pattern worth naming

Three of the four bugs were the same shape: **a step produced the right thing and
handed it to nobody.** `run_code` was allow-listed but never catalogued; the
generated SDK was returned but never appended to the prompt; the presentation
input was built from a list that did not contain the tool being presented. Each
looked complete in review and in tests, because every unit passed. Only walking
the actual chain — the one thing unit tests cannot do — surfaced them.

The consequence is a change in how this area should be tested: for a capability
that spans resolution, assembly, presentation and invocation, unit tests are not
enough, and `tests/run-code-e2e-chain.test.ts` now walks the whole thing.

### The read jail: closed, after the method changed

The remaining gap was that a confined child could read ordinary files outside the
workspace, because reads were refused by a list of known credential paths. That is
an argument from ignorance — it can only cover the locations somebody thought of.
The home directory is now closed instead, and it is closed *by directory*:

```
(allow file-read-data)                              ; general
(deny  file-read-data (subpath "<home>"))           ; close the home directory
(allow file-read-data (subpath "<workspace>"))      ; reopen — last rule wins
(allow file-read-data (subpath "<node install>"))   ; reopen the runtime
```

Seatbelt is last-rule-wins, so the exceptions placed after the deny reopen exactly
what the child needs and nothing else. Verified against real sandboxed processes:
an **ordinary** file in the home directory is refused, not only a secret; listing
the directory is refused; and a symlink the script plants in its own writable
workspace, pointing back into the home directory, is refused too.

Getting there required discarding an earlier conclusion. A read **allow-list** was
re-tested properly and does not work on macOS: `(allow file-read-data (subpath…))`
over node's install, `/System`, `/usr`, `/private`, `/dev`, `/etc`, `/var` and the
workspace leaves node unable to start, because dyld resolves library and
shared-cache paths through firmlinks that reduce to no enumerable subtree. The
first round of experiments reached a similar conclusion for the wrong reasons —
some of those profiles failed to *parse*, because `file-read-attributes` is not a
valid Seatbelt keyword on this macOS version — so the result was re-derived from
scratch before acting on it.

Two runtime paths had to be reopened for the child to work at all, and finding
them was empirical: the child's **own script** lives in the build output rather
than the workspace, and esbuild needs both its native binary *and* the JavaScript
package next to it, since the child does `import('esbuild')`. Missing either and
every script fails to compile, with no error that points at the sandbox.

On Linux the jail is structural: bubblewrap never mounts the home directory, so
there is nothing to allow.

### The four remaining points, closed

**1. Ordinary files outside `$HOME` are now unreadable too.** System locations
(`/etc`, `/tmp`, `/Library`, `/Applications`, `/bin`, `/sbin`, `/opt`, …) are
denied by default. Two Seatbelt semantics made this possible and both were
verified: umbrella `file-read*` denies do NOT override a specific-op
`file-read-data` allow, so every deny names the operation; and every deny was
checked individually, because `/var` breaks node at startup (`/var/folders`
holds the temp dir and getcwd). What stays readable is small and named:
`/System`, `/usr`, `/private`, `/dev`, node, esbuild, the child script, the
workspace. Metadata (existence, size) is still visible; contents are not.

**2. CPU and native memory are now enforced.** A host-side watchdog samples RSS
and cumulative CPU every 250 ms and kills the process group past budget, with a
distinct `resource_limit` status. `ulimit -t` was measured working on macOS but
would need spawning through a shell (widening process-exec); `ulimit -v` is
refused by Darwin outright. Sampling has inertia — observed 1.2 GB against a 300
MB cap — so the message says it is a backstop, not a precise limit.

**3. MCP schemas are guarded before AJV compiles them.** Size, depth, node caps
plus patterns that must compile and fit 200 chars; refusals drop the tool with a
logged reason. Backtracking detection is undecidable so nothing claims it; the
cap turns an unbounded hang into a bounded refusal.

**4. Windows is refused and the refusal is tested.** The platform is injectable,
so forcing `win32` exercises the whole host path with no spawn. No per-process
confinement exists there from a user process; failing closed manufactures no trust.

### Still true, and unchanged by this pass

- **The sandbox is not a jail against everything.** The home directory is closed,
  but a confined child can still read ordinary files *outside* the home directory
  and outside the workspace — `/etc` for instance, minus the individually denied
  paths. Reads are also jailed by directory rather than allow-listed, because a
  read allow-list cannot boot node on macOS at all.
- **CPU and native memory outside the V8 heap** are bounded by the timeout, not
  by a limit.
- **Windows is refused and untested** — no comparable confinement exists.
- **MCP tool schemas reach AJV's code generator.** Model output does not, and
  that is asserted; a malicious MCP server could, and that is documented rather
  than mitigated here.

