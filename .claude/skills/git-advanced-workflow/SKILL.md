---
name: git-advanced-workflow
description: Advanced Git operations for production repositories — clean history (rebase, squash, cherry-pick), safe recovery (reflog, bisect), and hotfix flows. Use when the user asks for history cleanup, bisecting a regression, recovering lost commits, or preparing a hotfix branch.
---

# Git Advanced Workflow

## Safe history rewrite (never rewrite shared/pushed branches without explicit confirmation)
1. `git fetch --all --prune` first; verify with `git log --oneline origin/main..HEAD` what is local-only.
2. Interactive squash: `git rebase -i origin/main` — keep the first commit as `pick`, fold the rest with `fixup`/`squash`.
3. If a conflict blocks the rebase: `git rebase --abort` is always safe; never force through.

## Recovering "lost" work
1. `git reflog --date=iso` — every HEAD move is listed; find the last good entry.
2. `git branch rescue <hash>` to pin it, inspect with `git show`, then merge or cherry-pick.
3. Uncommitted changes lost? `git fsck --lost-found` lists dangling blobs/commits.

## Bisecting a regression
1. `git bisect start <bad-ref> <good-ref>`
2. At each step, reproduce the failure; mark with `git bisect bad|good`.
3. Automate when a command reproduces it: `git bisect run <cmd>`; end with `git bisect reset`.

## Hotfix flow
1. Branch from the last release tag: `git checkout -b hotfix/<ticket> <tag>`.
2. Minimal change + regression test in the same commit.
3. Verify: full test suite, not just the touched area. Then cherry-pick or merge back to main and the release branch separately.

## Rules
- Never `push --force` on shared branches; use `--force-with-lease` only on your own feature branches.
- Commit message convention: Conventional Commits (`feat|fix|refactor|chore(scope): summary`).
- Before any destructive operation, print what will be lost (`git log --oneline -10`, `git status`) and get explicit confirmation.
