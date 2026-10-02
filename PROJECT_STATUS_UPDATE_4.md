# Project Status Update 4 — Controlled machine access

**Date:** 2026-10-02
**Branch:** `fix/security-review-and-external-links` (not pushed — no push to `origin`)
**Baseline:** `PROJECT_STATUS_UPDATE_3.md` (2026-10-02)

Verified by `npm run check` (typecheck + lint + full suite):

```
Test Files  445 passed (445)
Tests       4297 passed | 2 skipped (4299)
```

New code coverage (`src/main/machine-access/`, all four metrics ≥ 80%):

```
Statements 91.63 % | Branches 80.18 % | Functions 94.18 % | Lines 93.57 %
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

## Bugs the tests found (and I fixed)

Three were real defects in my own code, not test noise:

1. **`validateAppName` accepted path separators.** `a/b` and `../../escape`
   passed validation. Under `allow-all` a crafted name could then write outside
   the granted folder, because the scaffold forwarded autonomy into the
   resolution. Fixed: separators rejected, and the scaffold **never** forwards
   autonomy — a project must always land inside a granted folder.
2. **"Other users' folders" was not implemented.** Spec 2.2 requires it; the
   first version only knew secret sub-segments of _your_ home. Now `/Users/<x>`
   and `/home/<x>` are sensitive when `x` is not the current user.
3. **`app-scaffold.ts` never imported `fs`.** Latent until a guard started
   calling `fs.statSync`; the failure was reported as "granted root does not
   exist", which would have been a confusing diagnostic in production.

Also fixed while testing: `validateAppName` missed `\\`; the injection detector
only matched phrases with spaces, so `ignore_all_previous_instructions.txt` read
as an ordinary filename.

---

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

- **Windows**: exercised only through platform-parameterized unit tests
  (`CON`/`NUL`, UNC, case folding, `taskkill`). Never run on a real Windows host.
- **Real macOS system permissions**: Accessibility, Screen Recording and
  Automation are _reported and explained_, never requested or probed. No real
  grant was ever obtained from the OS.
- **Cross-device project rename** (copy + verify + trash source) could not be
  exercised on a single volume; the code path exists and is written defensively,
  but it is untested. Same-device rename is tested.
- **The Electron system trash** was replaced in tests by a faithful stand-in
  (move aside + restorable backup). `shell.trashItem` itself is unverified.
- **UI never visually verified.** `SettingsMachineAccess.tsx` and
  `MachineApprovalCard.tsx` typecheck and are i18n-complete (en/fr/zh, parity
  asserted by test), but nobody has looked at them rendering.

---

## Not wired into the running app

The modules are complete, tested and documented. The **IPC surface, renderer
store wiring and agent-runner integration are not implemented**: the service is
constructed in tests, not by `src/main/index.ts`. Until that wiring exists,
these capabilities are not reachable from the UI, and the Settings tab renders
nothing until `machineAccessProps` is supplied. I chose not to guess the IPC
channel shape and preload contract in this pass.

---

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
