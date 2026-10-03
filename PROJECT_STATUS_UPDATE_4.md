# Project Status Update 4 — Controlled machine access

**Date:** 2026-10-02
**Branch:** `fix/security-review-and-external-links` (not pushed — no push to `origin`)
**Baseline:** `PROJECT_STATUS_UPDATE_3.md` (2026-10-02)

Verified by `npm run check` (typecheck + lint + full suite):

```
Test Files  455 passed (455)
Tests       4377 passed | 2 skipped (4379)
```

New code coverage (`src/main/machine-access/`, all four metrics ≥ 80%):

```
Statements 93.26 % | Branches 82.26 % | Functions 95.38 % | Lines 95.14 %
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
  because nothing was pushed. `machine-access-windows-rules.test.ts` pins the
  platform rules (device names, UNC, drive root, case folding, reserved names,
  the Windows command vocabulary) and the output-cap test writes a command the
  host shell actually understands.
- **A real global-shortcut registration**: the shortcut logic is tested against
  a stubbed `globalShortcut`. Whether the OS actually grants
  `Cmd/Ctrl+Shift+.` to a packaged app is not verified here.
- **`shell.trashItem`** is wired and exercised through a faithful stand-in that
  records the call; the Electron call itself is not run in these tests.
- **The UI is verified by server rendering, not by looking at it.** Layout,
  spacing, colour contrast and responsiveness in a real window are unverified —
  no one has run the packaged app and looked at these screens.

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

1. Run the app and LOOK at the two screens. The components render correctly in
   tests; nobody has seen them in a window.
2. Push the branch so the existing `windows-latest` CI matrix actually runs this
   suite on real Windows — that is the only way to close the last platform gap.
3. Split the pre-commit fixups (`fix(security): drop unused origin…`, the
   control-regex lint comment) out of the feature commits they belong to.
4. Consider surfacing the batch preview table inside the chat, so a multi-file
   reorganization shows its before/after where the request was made, not only in
   Settings.
```
