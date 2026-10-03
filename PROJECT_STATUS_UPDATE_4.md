# Project Status Update 4 — Controlled machine access

**Date:** 2026-10-02
**Branch:** `fix/security-review-and-external-links` (not pushed — no push to `origin`)
**Baseline:** `PROJECT_STATUS_UPDATE_3.md` (2026-10-02)

Verified by `npm run check` (typecheck + lint + full suite):

```
Test Files  449 passed (449)
Tests       4326 passed | 2 skipped (4328)
```

New code coverage (`src/main/machine-access/`, all four metrics ≥ 80%):

```
Statements 93.30 % | Branches 81.61 % | Functions 94.94 % | Lines 95.30 %
```

---

## The shape of it

The app is local and belongs to the user, so the feature adds **no forbidden
zone**. What it adds is that every powerful action is _visible, explained,
logged and reversible_. One rule shapes everything:

> A dangerous or suspicious action is always explained and always asks for user
> approval — at every autonomy level, including "Allow everything" — and the
> agent can never answer that question itself.

Reference: `docs/machine-access-security.md`. Invariants that must not break:
the "Machine access invariants" section of `AGENTS.md`.

### The pipeline that enforces it

- `safe-path.ts` — `resolveSafePath`: NFC → `realpath` **before** containment →
  reject `..`/UNC/device names/over-long → grant, sensitivity, access level.
  `reverifySafePath` re-runs the check immediately before acting (TOCTOU).
- `sensitive-zones.ts` — system folders, **other users' folders**, keys,
  browser profiles, Cowork data, disk root, whole home, secret filenames.
  Returns `sensitive: true`; never refuses.
- `risk-assessor.ts` — `assessRisk` → `ordinaire` / `dangereux` / `suspect`
  with reasons. Doubt escalates.
- `approval-binding.ts` — sha256 over the exact action, 5-minute TTL,
  single-action. A changed action re-asks.
- `grant-store.ts` — `addGrant(input, origin)` **throws** unless
  `origin === 'user'`. The agent's only path is `requestAccess()`, which yields
  a request the UI shows.
- `fs-journal.ts` / `batch-plan.ts` / `project-rename.ts` /
  `command-runner.ts` / `machine-control.ts` / `injection-guard.ts` —
  the operational layers.
- `machine-access-service.ts` — the single assembly point.

### Tables

`access_grants`, `fs_operations`, `machine_approvals` — created with
`CREATE TABLE IF NOT EXISTS` in `database.ts`, so they are multi-process safe
and need no `ensureColumn` path.

---

## Status per capability — stated plainly

| Capability                                                            | Status                                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `resolveSafePath` + TOCTOU re-verification                            | **tested in unit** (real temp dirs, real symlinks)                                                              |
| Sensitive zones incl. other users' folders                            | **tested in unit**                                                                                              |
| `assessRisk`, every dangerous + suspicious category                   | **tested in unit**                                                                                              |
| Approval binding (exact action, expiry, single-action)                | **tested in unit**                                                                                              |
| Grants: user-only, revocation, expiry, sub-folders                    | **tested in unit**                                                                                              |
| fs tools, trash, journal, safe undo, divergence refusal               | **tested in unit**                                                                                              |
| Batches: preview == execution, drift, stop-on-error, cap, git roots   | **tested in unit**                                                                                              |
| Transactional project rename with rollback                            | **tested in unit** (same-volume)                                                                                |
| Command classification, scrubbed env, timeout, output cap, group kill | **tested in unit** (real processes; `sleep 5` killed in 300 ms)                                                 |
| GUI allow-list, rate limit, no password typing, emergency stop        | **tested in unit**                                                                                              |
| Injection guard + source-named reconfirmation                         | **tested in unit**                                                                                              |
| Settings panel + chat approval card                                   | **typechecked; never visually verified**                                                                        |
| **End-to-end: create → organize → rename → trash → undo**             | **proven on real conditions** (real files, real rename, real move-aside trash, real undo restoring exact bytes) |

---

## Bugs found in this pass, and fixed

The three from the first pass remain fixed (`validateAppName` separators,
other-users' sensitive zones, missing `fs` import). Working through the "not
done" list surfaced **five more real defects**:

4. **`addApp` / `removeApp` IPC handlers had no try/catch.** An exception in
   them would have propagated into the renderer instead of coming back as an
   error. Every handler in this surface is now wrapped.
5. **A workspace reached through a symlink was refused entirely.** The
   containment check compared a `realpath`-ed target against a _lexical_
   workspace root. On macOS the temp root is `/var/folders/...`, a symlink to
   `/private/var/...`, so EVERY file in such a workspace reported a false
   escape. The root is now canonicalized before the comparison — the same class
   of bug I had found in `NativeExecutor` in phase 1, now closed here too.
6. **Null bytes were silently stripped from paths.** Stripping makes `a\0b`
   collide with `ab`, hiding exactly the path confusion a NUL is used for. They
   are now REFUSED (as `path-containment` already did), returning a refusal
   rather than throwing into the model loop. The test that "covered" this was
   passing for the wrong reason — fix #5 exposed it.
7. **The real permission probe blocked the IPC call.** `system_profiler` takes
   seconds, so `machineAccess.getState` would have stalled the settings page.
   The result is now cached for 60 s and can be invalidated.
8. **`classifyLevel` only knew POSIX vocabulary.** `dir`, `type`, `del`, `md`,
   `where`, `powershell` were unclassified on Windows. Both vocabularies are
   now recognised on either platform, and dangerous wins over every other class
   (`sudo rm` is not merely a "write").

## Deliberate non-behaviour worth naming

- **A grant's access level governs the granted folders only.** The project
  working folder is always writable. This surprised me mid-implementation and I
  corrected the test, not the rule.
- **Batch fingerprints pin member order.** Reordering a batch changes the
  fingerprint, so a reordered plan reads as drift and re-asks. My first test
  asserted order-independence; that assertion was wrong, and the behaviour is
  the safer one.
- **`resolveSafePath` is lexical for a not-yet-existing target**, resolved
  against its nearest existing ancestor. Combined with `reverifySafePath`, this
  is why every caller must re-verify immediately before acting.

---

## Not verified — stated without inflation

- **Windows**: `ci.yml` already runs a `windows-latest` matrix, so this suite
  runs on real Windows on every PR — but **I have not observed such a run**,
  because nothing was pushed. I did harden what I could reason about:
  `machine-access-windows-rules.test.ts` pins device names, UNC, drive roots,
  case folding, reserved names and the Windows command set, and the output-cap
  test now writes a command the host shell actually understands (`yes | head`
  would have failed under PowerShell).
- **Real macOS Accessibility / Screen Recording / Automation**: Screen Recording
  and Accessibility are now genuinely probed. Automation has **no macOS
  read-back API at all**, so it reports `known: false` and can never claim
  granted. On this machine the probe correctly detected Screen Recording as
  granted — which is how I know it works rather than assume it.
- **`shell.trashItem`** is now wired through the real Electron API; the test
  suite still substitutes a faithful stand-in, so the Electron call itself is
  unverified.
- **UI never visually verified.** The components typecheck and are
  i18n-complete with parity asserted by test, but nobody has looked at them
  rendering, and they are not mounted yet.

## What is now wired

The IPC surface exists and is registered at boot: `src/main/ipc/machine-access-handlers.ts`
(twelve `machineAccess.*` channels), exposed through `src/preload/index.ts`
against a contract declared once in `src/shared/machine-access-contract.ts`.
`tests/machine-access-ipc-wiring.test.ts` asserts every exposed channel has a
handler, that the exposed set is EXACTLY those channels, and that there is
deliberately no channel to self-grant a folder or to answer an approval card.

`machineAccess.setAutonomy` is bound to the live sandbox mode: under
WSL/Lima/SSH/Daytona the service is null and the UI reports machine access as
inactive rather than implying it works.

## Still not wired

The agent-runner integration (feeding `assessRisk` / the approval flow into the
SDK tool-call path through `invokeTool`) and the renderer store that populates
`SettingsMachineAccess` are still absent. The two UI components receive their
props from a caller that does not exist yet, so the tab renders nothing.

## Commits (this work)

```
004e7b7  test(security): NativeExecutor + PathGuard characterization tests
ac2e625  feat(security): machine-access core (safe path, sensitive zones, risk, approval binding)
2a6cffc  feat(security): user-only folder grants and per-project autonomy levels
1f59989  feat(security): file tools with system trash, journal and safe undo
527a816  feat(security): batched file ops with preview, drift check and stop-on-error
f753c8a  feat(security): transactional project rename with reference preview and rollback
e1df8d8  feat(security): confined command runner with classification, scrubbed env, group kill
4a30d7c  fix(security): drop unused origin parameter from runCommand
d42bc06  feat(security): app scaffolding with port detection and typosquat checks
3daebc4  test(security): accept either rejection path for crafted scaffold names
01ed78a  feat(security): visible machine control, permission states and emergency stop
750b15b  feat(security): prompt-injection guard with source-named reconfirmation
204d95a  fix(security): document and silence control-regex lint in injection guard
1b870ed  feat(security): machine-access settings panel and chat approval card
a5e372c  feat(security): machine-access service and end-to-end test on real files
8e4e045  test(security): close branch coverage for machine-access modules
33e37da  docs(security): document controlled machine access invariants and status
dfeadac  feat(security): wire machine-access IPC, preload surface and shared contract
52ad5fe  feat(security): probe real macOS permissions, make cross-device rename testable
e1185ee  fix(security): canonicalize workspace root, refuse null bytes, widen command vocabulary
```

004e7b7 test(security): NativeExecutor + PathGuard characterization tests
ac2e625 feat(security): machine-access core (safe path, sensitive zones, risk, approval binding)
2a6cffc feat(security): user-only folder grants and per-project autonomy levels
1f59989 feat(security): file tools with system trash, journal and safe undo
527a816 feat(security): batched file ops with preview, drift check and stop-on-error
f753c8a feat(security): transactional project rename with reference preview and rollback
e1df8d8 feat(security): confined command runner with classification, scrubbed env, group kill
4a30d7c fix(security): drop unused origin parameter from runCommand
d42bc06 feat(security): app scaffolding with port detection and typosquat checks
3daebc4 test(security): accept either rejection path for crafted scaffold names
01ed78a feat(security): visible machine control, permission states and emergency stop
750b15b feat(security): prompt-injection guard with source-named reconfirmation
204d95a fix(security): document and silence control-regex lint in injection guard
1b870ed feat(security): machine-access settings panel and chat approval card
a5e372c feat(security): machine-access service and end-to-end test on real files
8e4e045 test(security): close branch coverage for machine-access modules

```

---

## Suggested next steps

1. Wire the IPC surface + preload + renderer store, then look at the two new UI
   surfaces in the running app.
2. Split the single pre-commit fixup (`fix(security): drop unused origin…`) out
   of the feature commit it belongs to.
3. On a Windows host, run the machine-access suite for real.
4. Replace the standing "grant access level does not affect the workspace"
   surprise with an explicit statement in the Settings copy.
```
