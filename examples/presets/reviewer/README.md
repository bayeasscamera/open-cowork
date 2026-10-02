# Example user preset — `reviewer`

A **read-only** agent: it can look at code and report findings, but it cannot
change a file. This is the smallest useful preset, and it is the one to copy
when writing your own.

## Install

Copy this directory into your presets folder:

```
<userData>/presets/reviewer/
```

On macOS `<userData>` is `~/Library/Application Support/Open Cowork`; on Windows
`%APPDATA%\Open Cowork`; on Linux `~/.config/Open Cowork`. The preset then
appears in **Settings → Presets** and can be pinned on a project.

## Why `preset.json` has no comments

A preset is validated by a **strict** schema: unknown keys are *rejected*, not
ignored. That is deliberate — a typo like `maxDepht` would otherwise leave the
field silently at its default, and a preset that appears to configure something
it does not is worse than one that refuses to load.

So the commentary lives here instead of inside the JSON.

## What each block does

| Field | Meaning |
|---|---|
| `id` | `[a-z0-9-]`, must equal the directory name, and can never shadow a built-in id (`standard`, `code-mode`, `long-context`). |
| `label` / `description` | Shown in the UI. |
| `tools.allow` | A **concrete subset** of the tool registry. `'*'` is rejected: a wildcard would make "which tools may this agent use?" unanswerable, which is the one question a preset exists to answer. Listing a tool that does not exist is refused rather than silently dropped. |
| `presentation` | `direct` (one tool per call, the default) or `code` (tools driven through a generated SDK inside `run_code`). `code` requires explicit consent. |
| `pruner` | How tool output is trimmed. `headChars + tailChars` **must** be strictly less than `thresholdChars`, or truncation would not shorten anything. Output keeps its start and end and states how many characters were dropped. |
| `delegation.maxDepth` | Sub-agent depth, hard-capped at `2`. |
| `delegation.allowFork` | Lets a subtask inherit this session's model and conversation, so the provider prompt cache is reused. Requires explicit consent. |
| `delegation.maxRounds` | Correction-loop budget, hard-capped at `64`. |
| `skills.extraDirs` | Directories relative to **this** folder. `..` and absolute paths are rejected, and the loader re-checks through `realpath`, so a symlink cannot escape either. |
| `modelHint` | Optional ConfigSet / model suggestion. It never overrides an explicit project or session model pin. |

## A preset is data, never code

Nothing in a preset is evaluated. Loading one cannot execute JavaScript, and
there is no `require`, `entry` or `script` field. If a file grows a field that
looks like code, the schema rejects it.

## If the preset does not appear

Open **Settings → Presets** and look at the "presets that could not be loaded"
section: the exact reason is listed there (bad JSON, an unknown key, a tool that
does not exist, an `extraDir` that escapes, or an id that collides with a
built-in). Nothing is dropped silently.
