---
title: "Skipping Git Hooks the Right Way: --no-verify, SKIP, and Keeping CI Honest"
date: 2032-05-06T09:00:00-05:00
draft: false
tags: ["Git", "Pre-commit", "CI/CD", "DevOps", "Hooks", "Version Control", "GitHub Actions", "Code Quality", "Branch Protection", "Engineering Practices"]
categories:
- Git
- DevOps
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "How to bypass Git pre-commit, commit-msg, and pre-push hooks with --no-verify, -n, and the pre-commit SKIP variable, and the engineering judgment around when that is acceptable versus harmful."
more_link: "yes"
url: "/git-commit-skip-pre-commit-hooks-no-verify/"
---

Every engineer who has worked in a repository with hooks has hit the wall: you stage a one-line change, type `git commit`, and the terminal scrolls a wall of linter output before refusing to commit anything. Sometimes the hook is right and you have a real problem to fix. Sometimes the hook itself is broken, the failure has nothing to do with your change, or production is on fire and a formatting rule is the last thing standing between you and a fix. Git gives you a clean escape hatch for exactly these moments, and a healthy engineering team treats that escape hatch as a documented tool rather than a dirty secret.

This article covers how to bypass Git's client-side hooks deliberately: the `--no-verify` flag and its `-n` short form, the per-hook `SKIP` variable from the pre-commit framework, how the same mechanisms apply to commits, merges, and pushes, and which hooks each one actually affects. It then covers the part most write-ups skip entirely: why a local bypass should never be able to reach `main`, and how to build server-side enforcement so a skipped local hook costs you nothing but a slightly slower feedback loop.

For an enterprise team the stakes are higher than one developer's convenience. Hooks are part of your quality and security posture: secret scanning, license checks, dependency policy, and commit-message conventions all tend to live there. If half the team has quietly learned to slap `--no-verify` on every commit because one hook is slow or flaky, those controls are providing a false sense of safety while doing nothing. The goal of this article is to make bypassing a precise, rare, auditable action rather than a reflex, and to put the real enforcement somewhere no client flag can touch.

<!--more-->

## What Git Hooks Run, and When

Before talking about skipping hooks, it helps to be precise about which ones exist and what triggers them. Git hooks are nothing more than executable scripts in a hooks directory; Git invokes them by name at fixed points in the commit and push lifecycle. The ones relevant to this discussion are the **client-side hooks** that fire on your laptop, not the server-side hooks that fire on a Git server.

A single `git commit` fires a sequence of hooks in a fixed order, and a single `git push` fires one more. Understanding that order is what lets you reason about exactly what `--no-verify` does and does not skip:

- **pre-commit** runs first, immediately after you invoke `git commit`, before the commit message editor opens. This is where linters, formatters, secret scanners, and fast unit tests usually live. A non-zero exit aborts the commit before you are even asked for a message.
- **prepare-commit-msg** runs next, after pre-commit succeeds but before the editor opens. It receives the path to the message file plus the message source (`message`, `template`, `merge`, `squash`, `commit`). Teams use it to *prefill* the message — injecting a ticket number from the branch name, adding a template, or appending a sign-off. It is not a validator; it shapes the draft you are about to edit.
- **commit-msg** runs after you write the message. It receives the path to the message file and is where commit-message linters (Conventional Commits enforcement, ticket-number requirements, line-length checks) live. A non-zero exit aborts the commit.
- **post-commit** runs last, after the commit object already exists. Its exit code is ignored — Git does not unwind a finished commit. It is purely for side effects: desktop notifications, updating a local index, kicking off a background task. Because it runs after the fact and cannot fail the commit, it is rarely something you need to skip.
- **pre-push** runs on a separate operation, `git push`, before any objects are transferred. This is the right place for slower, more expensive checks: the full test suite, a build, integration smoke tests. A non-zero exit aborts the push.

There are others — `pre-merge-commit`, `post-checkout`, `post-merge`, `pre-rebase` — but the five above cover the commit-and-push path that teams most often wire up and most often need to skip.

A `prepare-commit-msg` hook makes the prefill behavior concrete. This one extracts a ticket id like `PROJ-1234` from the branch name and prepends it to the message, but only for ordinary commits where Git did not already supply a message:

```bash
#!/usr/bin/env bash
# prepare-commit-msg: prefill the message before the editor opens.
# Args: $1=message file path, $2=commit source, $3=commit SHA (amend/squash).
set -euo pipefail

msg_file="$1"
source_type="${2:-}"

# Only prefill for an ordinary commit, not merges, squashes, or amends,
# where Git already supplies a message we should not clobber.
if [ "$source_type" = "" ]; then
  branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
  # Extract a JIRA-style ticket id from a branch like feature/PROJ-1234-desc
  ticket=$(printf '%s' "$branch" | grep -oE '[A-Z]+-[0-9]+' || true)
  if [ -n "$ticket" ] && ! grep -q "$ticket" "$msg_file"; then
    printf '%s\n\n%s' "$ticket:" "$(cat "$msg_file")" > "$msg_file"
  fi
fi
```

You can enumerate which of these are actually installed and executable in your clone, which is the first thing to check when a hook either is not running or is running when you did not expect it:

```bash
# Inspect every commit/push hook Git knows about and which are active
for h in pre-commit prepare-commit-msg commit-msg post-commit pre-push pre-merge-commit; do
  path="$(git rev-parse --git-path hooks)/$h"
  if [ -x "$path" ]; then
    echo "active: $h"
  fi
done
```

A repository can store hooks in one of two places, and knowing which one you are dealing with changes how you debug them. The classic location is `.git/hooks/`, which is local to your clone and never committed. The modern, team-shared approach points `core.hooksPath` at a tracked directory so the whole team gets the same hooks from a single source. The pre-commit framework manages an installed script in `.git/hooks/pre-commit` (or wherever `core.hooksPath` points) that delegates to the hooks declared in a committed config file.

```bash
# Show the hooks Git looks for in this repository
ls -la .git/hooks/

# Find where Git is currently sourcing hooks from
git config --get core.hooksPath

# Print the active hooks directory regardless of override
git rev-parse --git-path hooks
```

If `core.hooksPath` returns a value, that directory wins and `.git/hooks/` is ignored entirely. This is the single most common source of "my hook isn't running" and "why is this hook running when it isn't in `.git/hooks/`" confusion. Always resolve the active hooks path before assuming anything.

For a team, the tracked-directory approach is the only sane way to distribute hooks, because `.git/hooks/` is never committed and therefore cannot be shared. A new clone starts with no hooks at all unless you do something to install them. The two durable patterns are: commit a hooks directory and have each developer point `core.hooksPath` at it, or adopt the pre-commit framework and have each developer run `pre-commit install`. Both require an explicit per-clone step, which is exactly why an enterprise team should automate it in onboarding or a bootstrap script rather than relying on people to remember.

```bash
# Team pattern: track hooks in .githooks and point Git at them
git config core.hooksPath .githooks

# Framework pattern: install all configured hook types in one shot
pre-commit install --hook-type pre-commit \
                   --hook-type commit-msg \
                   --hook-type pre-push
```

The crucial consequence for this whole discussion: because installing hooks is a voluntary per-clone action, *not installing them at all is the ultimate bypass*. A developer who never ran `pre-commit install` has effectively skipped every hook on every commit, silently, with no flag in their history. This is the strongest possible argument that local hooks cannot be your enforcement boundary — a missing install is indistinguishable from a clean run, and only the server gate notices the difference.

Here is a representative `pre-commit` hook so the rest of the article has something concrete to reason about. It runs `gofmt` against staged Go files and aborts the commit if any are unformatted:

```bash
#!/usr/bin/env bash
# A pre-commit hook that runs the formatter and aborts on failure
set -euo pipefail

# Only lint files that are actually staged for this commit
staged=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.go$' || true)
if [ -z "$staged" ]; then
  exit 0
fi

# Run the formatter check; any unformatted file blocks the commit
if [ -z "$(gofmt -l $staged)" ]; then
  exit 0
fi

echo "gofmt found unformatted files; run 'gofmt -w' before committing" >&2
exit 1
```

The hook is doing its job: it refuses to let unformatted code into a commit. Most of the time you want that. The rest of this article is about the minority of the time when you do not.

## The Core Escape Hatch: --no-verify

The single flag that bypasses client-side commit hooks is `--no-verify`. When you pass it to `git commit`, Git skips both the **pre-commit** and the **commit-msg** hooks for that one commit. Nothing else changes: the commit is created normally, lands in your history, and looks identical to any other commit.

To make the contrast concrete, here is what a normal blocked commit looks like when the pre-commit hook fails, followed by the same commit succeeding under `--no-verify`:

```text
$ git commit -m "wip: scaffolding"
gofmt found unformatted files; run 'gofmt -w' before committing
# (commit aborted; nothing recorded)

$ git commit -m "wip: scaffolding" --no-verify
[feature/scaffold 4f2a1c9] wip: scaffolding
 1 file changed, 12 insertions(+)
# (commit recorded; hook never ran)
```

The bypassed commit is indistinguishable in history from one that passed the hook cleanly — Git stores no flag indicating the hook was skipped. That invisibility is exactly why the audit and server-side enforcement covered later matter so much.

```bash
# Skip every client-side hook for a single commit
git commit -m "wip: scaffolding, tests not written yet" --no-verify

# -n is the exact short form of --no-verify
git commit -m "wip: scaffolding, tests not written yet" -n
```

`-n` and `--no-verify` are identical; there is no behavioral difference, and Git's own documentation lists them as aliases. The flag is per-invocation. There is no persistent "verification off" mode for commits — the next commit you make without the flag runs hooks again. That is a deliberate design choice and a good one: skipping is meant to be an exception you opt into each time, not a setting you flip and forget.

It is worth being precise about exactly which hooks `--no-verify` suppresses on a `git commit`, because it is more than just pre-commit:

| Hook | Runs on a normal `git commit` | Skipped by `git commit --no-verify` |
| --- | --- | --- |
| pre-commit | Yes | Yes |
| prepare-commit-msg | Yes | No (still runs) |
| commit-msg | Yes | Yes |
| post-commit | Yes | No (still runs) |

The two it skips are the two that can *block* the commit: `pre-commit` and `commit-msg`. It deliberately leaves `prepare-commit-msg` and `post-commit` alone, because those shape or react to the commit rather than gate it, and skipping them would change behavior without removing a barrier. So if a `prepare-commit-msg` hook is injecting a ticket prefix, `--no-verify` will not stop it — your message still gets the prefix even on a bypassed commit.

A subtle point that trips people up: `--no-verify` skips *both* gating hooks the commit lifecycle would normally run, not just pre-commit. If your `commit-msg` hook enforces Conventional Commits and you bypass it, your message format is no longer checked either. This matters when the *reason* you are skipping is a broken pre-commit hook but your commit message hook is perfectly fine — you lose the message validation as collateral. There is no built-in flag to skip only one of the two; for that granularity you need the pre-commit framework's `SKIP` variable, covered below.

For reference, here is the kind of `commit-msg` hook that bypass quietly disables. If your team relies on it to keep history machine-parseable, that reliance evaporates the moment someone passes `-n`:

```bash
#!/usr/bin/env bash
# commit-msg: validate the finished message. Arg $1 is the message file.
set -euo pipefail

msg_file="$1"
subject=$(head -n1 "$msg_file")

# Enforce a Conventional Commits subject line.
pattern='^(feat|fix|docs|refactor|test|chore|perf|build|ci)(\([a-z0-9-]+\))?!?: .+'
if ! printf '%s' "$subject" | grep -qE "$pattern"; then
  echo "commit-msg: subject must follow Conventional Commits" >&2
  echo "  got: $subject" >&2
  exit 1
fi
```

The same flag works on operations that create commits implicitly:

```bash
# Bypass the commit-msg hook along with pre-commit
git commit -m "hotfix: revert bad migration" --no-verify

# The pre-merge-commit hook is also skipped by --no-verify on a merge
git merge --no-verify release/2032-05
```

On a merge, `--no-verify` skips the `pre-merge-commit` hook (and the `commit-msg` hook for the merge commit). This is occasionally necessary when a merge commit triggers a hook that assumes a normal single-parent commit and fails on the merge.

## Hooks During Rebase, Cherry-Pick, and Amend

Beyond a plain `git commit`, several common operations create commits and therefore interact with hooks in ways that surprise people. Knowing which ones run hooks — and how to skip them — saves a lot of confusion during history rewrites.

`git commit --amend` is a normal commit as far as hooks are concerned: it runs `pre-commit` and `commit-msg`, and `--no-verify` skips them just as it does for a fresh commit. If you are amending purely to fix a typo in a message, running the full pre-commit suite again is wasted work, and `--no-verify` on the amend is reasonable.

```bash
# Amend without re-running the pre-commit and commit-msg hooks
git commit --amend --no-verify -m "fix: corrected typo in subject"
```

`git rebase` is different and frequently misunderstood. A non-interactive rebase that simply replays commits does **not** run `pre-commit` or `commit-msg` for each replayed commit — Git is reapplying existing commits, not creating new ones through the commit hook path. An interactive rebase that *rewords* or *edits* commits, however, does run `commit-msg` (and `pre-commit` on an `edit` stop where you make a new commit). This is why a rebase across history that predates your current hooks can suddenly fail on a `reword` step even though the original commits were fine — today's stricter `commit-msg` rule is now being applied to an old message. The escape hatch is to disable hooks for the duration:

```bash
# Replay history without today's hooks blocking old commits
git -c core.hooksPath=/dev/null rebase -i main
```

Setting `core.hooksPath` to a path with no executable hooks for a single command is a clean, scoped way to neutralize all hooks for that one operation without touching your configuration. It is more surgical than uninstalling hooks because it lasts exactly one command.

`git cherry-pick` creates a new commit and therefore runs `commit-msg` (and `pre-commit` when it stops for conflicts and you commit), and `git merge` runs `pre-merge-commit` and `commit-msg` for the merge commit. The same `--no-verify` flag works on `git merge` and `git cherry-pick` to suppress those. The practical takeaway: any operation that materializes a *new* commit object can run the gating hooks, so when you are replaying or reconstructing history through old, non-compliant commits, expect to disable hooks for the run.

## Skipping the pre-push Hook

The commit-time flag does not help with `pre-push`, because pushing is a separate operation. `git push` honors its own `--no-verify` flag, which skips the `pre-push` hook:

```bash
# Skip the pre-push hook for one push only
git push --no-verify origin hotfix/payment-timeout

# The same flag works when pushing tags
git push --no-verify origin v2.14.1
```

This is the flag you reach for when `pre-push` runs the full test suite or a long build and you need to get a branch to the remote *now* — for a colleague to look at, for CI to pick up, or because the hook itself is hanging. As with commit, the flag is per-push; the next push runs the hook again. The push-time `--no-verify` skips exactly one hook, `pre-push`; there is no separate "post-push" gating hook to worry about.

A representative `pre-push` hook shows why this one is the most expensive to run and therefore the most tempting to skip. Git feeds it a line per ref being pushed on stdin, which lets a careful hook avoid wasted work on no-op pushes:

```bash
#!/usr/bin/env bash
# pre-push: gate the push on the full test suite and a build.
# Git feeds "<local ref> <local sha> <remote ref> <remote sha>" on stdin.
set -euo pipefail

# Skip work entirely when nothing is being pushed (e.g. delete refs).
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi
done

go build ./... || { echo "pre-push: build failed" >&2; exit 1; }
go test ./... || { echo "pre-push: tests failed" >&2; exit 1; }
```

A hook like this can easily run for minutes, which is precisely why teams reach for `git push --no-verify` and why the same checks must also exist server-side — covered later.

A useful mental model: `pre-commit` and `commit-msg` protect your *history*, while `pre-push` protects the *remote*. Skipping the first two means a questionable commit exists locally. Skipping the third means that commit reaches the server without local validation. Neither one bypasses anything on the server itself — and that distinction is the whole foundation of the safety argument later in this article.

## Per-Hook Skipping with the pre-commit Framework

The all-or-nothing nature of `--no-verify` is its biggest weakness. If a repository runs five hooks and exactly one of them is broken or irrelevant to your change, `--no-verify` throws out the other four with it. That is usually worse than running nothing, because the four good hooks were catching real problems.

The widely used **pre-commit framework** solves this with the `SKIP` environment variable. Hooks in pre-commit have an `id`, and `SKIP` takes a comma-separated list of ids to skip. Every other hook still runs.

Here is a representative `.pre-commit-config.yaml`. The `id` of each hook is exactly the token you pass to `SKIP`, and the `stages` key controls which Git hook each one binds to — `pre-commit`, `commit-msg`, or `pre-push`:

```yaml
# .pre-commit-config.yaml - hook ids are what you pass to SKIP
default_install_hook_types: [pre-commit, commit-msg, pre-push]
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: detect-private-key
  - repo: https://github.com/golangci/golangci-lint
    rev: v1.59.1
    hooks:
      - id: golangci-lint
        name: golangci-lint
  - repo: local
    hooks:
      - id: go-unit-tests
        name: go-unit-tests
        entry: go test ./...
        language: system
        pass_filenames: false
        stages: [pre-commit]
      - id: go-build
        name: go-build
        entry: go build ./...
        language: system
        pass_filenames: false
        stages: [pre-push]
      - id: conventional-commit
        name: conventional-commit
        entry: gitlint
        language: system
        stages: [commit-msg]
```

The `default_install_hook_types` line is the part teams most often forget. By default `pre-commit install` only installs the `pre-commit` Git hook; your `commit-msg` and `pre-push` stage hooks silently never run until you install those hook types too. Declaring them in config (or running `pre-commit install --hook-type pre-push --hook-type commit-msg`) is what wires the whole config into Git.

With that config in place, you can surgically skip exactly the hook that is in your way:

```bash
# Skip a single hook by id, leaving every other hook active
SKIP=golangci-lint git commit -m "wip: refactor in progress"

# Skip several hooks at once with a comma-separated list
SKIP=golangci-lint,go-unit-tests git commit -m "wip: large rename"

# The same variable is honored on push-stage hooks
SKIP=go-build git push origin feature/new-billing
```

This is almost always the better tool. If `golangci-lint` is throwing a false positive on a generated file and blocking your commit, skipping just that hook keeps your secret scanner, your formatter, and your message linter all running. You give up the minimum amount of safety required to get unblocked. The `SKIP` variable also works at the push stage, so a slow build hook can be skipped while a fast lint hook still runs.

`SKIP` is strictly more precise than `--no-verify`, but it is also framework-specific. It only works because the pre-commit framework reads the variable; a hand-rolled shell hook in `.git/hooks/pre-commit` knows nothing about it. If your repository uses raw Git hooks rather than the framework, `--no-verify` is your only built-in option, and you would need to bake your own opt-out into the hook script to get per-hook granularity.

### --no-verify Versus SKIP: When to Reach for Each

When you are using the pre-commit framework, you effectively have two bypass mechanisms with very different blast radii, and choosing the right one is the difference between a surgical exception and throwing out every check at once.

- **`SKIP=hookid` is a scalpel.** It tells the framework to skip the named hook (or comma-separated list of ids) and run everything else. Use it when one specific hook is broken, slow, or irrelevant to the change in front of you. Because it is framework-aware, it understands the same hook ids whether they are bound to the commit stage or the push stage.
- **`--no-verify` is a sledgehammer.** It tells Git to skip running the framework's installed hook script *at all*, which means every hook in that stage is skipped together. Use it only when the framework itself is the problem — a corrupt environment, a hang during bootstrap, or a situation where you cannot get the framework to run at all.

There is one important asymmetry: `SKIP` only reaches hooks the framework manages. `--no-verify` reaches *any* hook in that stage, framework-managed or not. If your repository mixes a framework `pre-commit` hook with a separate hand-written hook in the same stage, `SKIP` only affects the framework's hooks while `--no-verify` skips the framework script entirely (any independent hook in a different file is a separate question — Git only ever runs one script per hook name, so in practice the framework's installed script is the single entry point). The practical rule for a team: prefer `SKIP` by default, document the specific hook id you skipped, and reserve `--no-verify` for the rare case where the framework cannot run.

### Running the Same Hooks in CI

The cleanest way to guarantee CI enforces exactly what the local hooks check is to run the *same* pre-commit config in CI. There is no drift between "what the hook does" and "what the gate enforces" because they are the same definition. The framework runs all hooks across all files in CI mode, which is precisely what a server-side gate wants:

```yaml
# .github/workflows/pre-commit.yaml - run the identical hook config server-side
name: pre-commit
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  pre-commit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
      - name: Run all hooks on all files
        run: |
          pip install pre-commit
          pre-commit run --all-files --show-diff-on-failure
```

With this in place, a developer who runs `SKIP=golangci-lint git commit` locally gets unblocked instantly, but `golangci-lint` still runs in CI on the same config, and the PR cannot merge if it fails. The local skip cost them nothing and bought back zero safety from the team's perspective, which is exactly the property you want: local hooks are a fast feedback loop, the identical config in CI is the gate, and `--show-diff-on-failure` makes a CI failure as actionable as a local one.

### Other Hook Managers: Husky and Lefthook

The pre-commit framework is dominant in Python and polyglot repositories, but JavaScript and TypeScript teams frequently use **Husky**, and many teams use **Lefthook**. The bypass surface is similar but the per-tool knobs differ, which is worth knowing on a mixed-language team:

- **Husky** installs standard Git hooks that call into your `package.json` scripts (usually via lint-staged). Because they are ordinary Git hooks, `git commit --no-verify` skips them exactly as it does any hook. Husky also honors the `HUSKY=0` environment variable, which disables Husky hooks for the duration of a command — the Husky-specific analogue to neutralizing hooks without `--no-verify`.
- **Lefthook** reads a `lefthook.yml` and supports skipping individual commands or whole hooks via a `LEFTHOOK=0` environment variable and per-command `skip` rules in config, plus the standard `git commit --no-verify` to skip everything.

```bash
# Husky: disable hooks for a single command without --no-verify
HUSKY=0 git commit -m "wip: experimenting"

# Lefthook: disable all hooks for a single command
LEFTHOOK=0 git commit -m "wip: experimenting"
```

The mechanics vary, but the architecture argument does not change one bit. Whatever manages your local hooks, those hooks run on developer machines and can be turned off; the enforcing gate still has to live on the server. Pick the manager that fits your stack, make its hooks fast, and never let it be the only place a check exists.

## Diagnosing a Broken Hook Before You Skip It

Reaching for `--no-verify` reflexively is a habit worth resisting. Often the right first move is to figure out whether the hook is broken or your code is broken. With the pre-commit framework you can run hooks manually, outside the commit flow, which separates "the hook is misconfigured" from "my change is genuinely failing the check":

```bash
# Run the full pre-commit suite by hand without committing anything
pre-commit run --all-files

# Run one hook against the whole tree to confirm it is broken, not your code
pre-commit run golangci-lint --all-files

# Temporarily uninstall the framework hook, fix it, reinstall
pre-commit uninstall
pre-commit install
```

If `pre-commit run --all-files` fails on files you never touched, the hook is the problem and skipping it for your commit is reasonable — but the real fix is to repair the hook for everyone, not to skip it forever. If it fails only on your files, the hook is doing its job and you should fix the code.

When a hook environment itself is corrupted — a stale virtualenv, a tool version that no longer resolves — reinstalling the framework hooks often clears it faster than fighting the symptom:

```bash
# Reinstall hooks cleanly to reproduce what a teammate sees
rm -rf .git/hooks
git init
pre-commit install --install-hooks
```

The `git init` here is safe in an existing repository; it reinitializes Git metadata without touching your working tree or history, which is enough to let `pre-commit install` lay down fresh hook scripts.

A few more diagnostic moves separate a hook problem from a code problem quickly. You can run a single stage's hooks, which is useful when a `pre-push` hook is failing and you want to reproduce it without actually pushing, and you can run hooks against just the files staged in your commit to see exactly what the commit-time hook would see:

```bash
# Reproduce the push-stage checks without pushing anything
pre-commit run --hook-stage pre-push --all-files

# Run hooks against only the currently staged files (what the commit sees)
pre-commit run

# Confirm which hooks directory Git is actually using right now
git config --get core.hooksPath || git rev-parse --git-path hooks
```

The last command matters more than it looks. A surprising number of "the hook isn't running" reports come down to `core.hooksPath` pointing somewhere unexpected, or the framework hook never having been installed in this clone at all. Resolving the active hooks directory first turns a confusing problem into an obvious one. If `pre-commit run` passes by hand but your commit still fails, the framework hook is not installed; if both fail identically, the check is real and your code needs fixing; if the manual run fails on untouched files, the hook is broken and the fix belongs to whoever owns the hook.

## When Skipping Is Defensible

Bypassing hooks is not inherently wrong. There are legitimate, recurring situations where it is the correct engineering decision:

- **A broken hook unrelated to your change.** A hook that fails because of a tool upgrade, a network-dependent check, or a bug in the hook itself should not block unrelated work. Skip it, get unblocked, and file the fix for the hook.
- **An emergency hotfix.** When an incident is active and every minute of downtime has a dollar cost, spending ten minutes satisfying a formatting linter is the wrong trade. Commit the fix, ship it, and clean up afterward.
- **Genuine work-in-progress commits.** On a personal feature branch, committing half-finished code so you can switch context or back up your work is normal. Requiring those commits to pass the full suite is friction with no payoff, because the branch will be squashed or cleaned up before it merges.
- **Bisecting or rebasing through historically broken commits.** When you are reconstructing or replaying history that predates current hooks, forcing each intermediate commit through today's checks is pointless and sometimes impossible.

The common thread is that the *commit* is allowed to be imperfect because something downstream will catch real problems before they reach a shared branch. That "something downstream" is the load-bearing part of the whole argument.

### The Anti-Patterns: When Skipping Is Wrong

The same flag, used in the wrong situations, is how teams quietly let quality and security controls rot. These are the bypasses that should set off alarms:

- **Skipping a hook because your code genuinely fails the check.** If the linter is flagging a real problem and you `--no-verify` past it, you have not solved anything — you have moved a known defect downstream and made it someone else's problem at review or in CI. The hook was right; fix the code.
- **Skipping the secret scanner.** A `detect-private-key` or credential-scanning hook is the one you must never reflexively bypass. A leaked secret in history is expensive and sometimes impossible to fully remediate, because once it is pushed it may be cloned, mirrored, or indexed before you notice. If a secret scanner is blocking you, investigate the finding; do not skip it to "deal with it later."
- **Routine, habitual bypassing on `main` or a shared branch.** Skipping on a personal branch that will be squashed is fine. Skipping directly on a long-lived shared branch means the unverified commit is now everyone's problem and there is no cleanup step coming.
- **Bypassing to defeat a control you disagree with.** If you think a hook is wrong, the move is to raise it with the team and change or remove the hook, not to personally opt out while everyone else still pays the cost. A control that some people silently ignore is worse than no control, because it creates a false belief that the check is enforced.
- **Skipping because the hook is slow, every single time.** This is the most common anti-pattern and the clearest signal of a process defect. The fix is not discipline; it is making the hook fast, covered later.

The distinction between the defensible list and this one always comes back to a single question: after you skip, is something downstream still going to catch a real problem before it reaches production? If yes, the skip bought you speed at no cost. If no, the skip *is* the problem.

## Making Hooks Fast Enough That Nobody Wants to Skip

The single biggest driver of habitual `--no-verify` use is latency. A pre-commit hook that adds five or ten seconds to every commit trains the whole team to bypass it, because committing is something engineers do dozens of times a day and the friction compounds. If you want bypassing to stay rare, the hook has to be fast enough that running it is the path of least resistance.

The most effective single change is to lint and test only what changed, not the entire tree, on the commit-time hook. The pre-commit framework does this automatically: it passes only the staged files to each hook by default, so a formatter or linter sees three files instead of three thousand. When you write raw hooks, replicate that — operate on the staged set, not the whole repository:

```bash
# Fast pre-commit: operate only on staged files, exit early when none apply
set -euo pipefail
staged=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.go$' || true)
[ -z "$staged" ] && exit 0
gofmt -l $staged
```

Beyond scoping, a few structural choices keep hooks fast:

- **Put cheap checks on commit and expensive checks on push.** Formatting, secret scanning, and a quick syntax pass belong on `pre-commit` where they run constantly. The full test suite, race detector, and build belong on `pre-push` where they run far less often and a longer wait is acceptable. The config above does exactly this with `stages: [pre-commit]` versus `stages: [pre-push]`.
- **Cache aggressively.** Tool environments (`pre-commit`'s own virtualenvs, Go's build cache, a linter's analysis cache) should persist between runs. A cold first run can be slow; every run after that should be near-instant. If your hooks rebuild a toolchain on every commit, that is the bug to fix before you blame developers for bypassing.
- **Fail fast and loud.** A hook that prints a clear, copy-pasteable remediation (`run 'gofmt -w .'`) and exits immediately on the first failure respects the developer's time far more than one that runs all checks and buries the actionable line in a wall of output. People bypass hooks they cannot quickly understand.
- **Measure the real cost.** Time your hooks on a representative change. If `pre-commit` regularly exceeds a second or two, or `pre-push` is so slow people skip it before every push, treat that as a defect with an owner, not an immutable fact of life.

The framework gives you a couple of config knobs that directly support these goals. `fail_fast` stops the run at the first failing hook so a broken formatter does not make you wait for the linter and tests behind it, and `default_stages` lets you set a sensible default so you are not annotating every hook individually:

```yaml
# .pre-commit-config.yaml - tuning for speed and clear failures
default_stages: [pre-commit]
fail_fast: true
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: detect-private-key   # cheap, security-critical: keep on commit
      - id: trailing-whitespace
  - repo: local
    hooks:
      - id: go-test-race
        name: go-test-race
        entry: go test -race ./...
        language: system
        pass_filenames: false
        stages: [pre-push]       # expensive: push only, not every commit
```

A fast, accurate hook is one nobody has a reason to skip. That is a far more durable control than any policy telling people not to use `--no-verify`.

## Why Skipping Is a Smell — and How to Make It Safe

If skipping hooks is routine in your team, that is a signal worth investigating. The most common root causes are a hook that is too slow (so everyone bypasses it to stay productive), a hook that produces false positives (so everyone learns to ignore it), or a hook that duplicates a check CI already runs (so it is pure friction). The fix is to repair the hook — make it fast, make it accurate, or delete it — not to normalize bypassing it. A hook that everyone skips is providing zero protection while still costing time and eroding trust in the toolchain.

Treating each symptom with the matching fix is far more effective than a blanket "stop skipping" directive:

| Symptom | Likely root cause | The fix |
| --- | --- | --- |
| Everyone bypasses one specific hook | It is slow, or it runs on every commit when it belongs on push | Scope it to staged files; move it to `pre-push`; cache its toolchain |
| Bypasses cluster around one rule | The hook produces false positives | Tighten or configure the rule; suppress it on known-clean paths |
| Bypasses are constant and undirected | The whole suite is too slow | Profile it; split cheap commit checks from expensive push checks |
| New hires never run hooks | No automated install step | Add `pre-commit install` to onboarding or a bootstrap script |
| A check exists only as a hook | It duplicates nothing in CI, so skipping it has real consequence | Add the same check to CI so the hook becomes advisory, not load-bearing |

The last row is the most important. If a check exists *only* as a local hook, then skipping it genuinely lets unverified code through, which is the one situation where a bypass is dangerous. The remedy is never to forbid the bypass; it is to make the check exist somewhere unskippable so the bypass stops mattering.

But the deeper principle is this: **local hooks are a convenience, not a security boundary.** They run on developer machines, they can be skipped with a single flag, and they can be removed entirely by deleting `.git/hooks/`. You cannot build a quality guarantee on something every engineer can turn off without leaving a trace on the server. Any check that genuinely *must* pass before code reaches `main` has to be enforced on the server, where no client-side flag can reach it.

That means the real gate is CI, running the same checks the hooks run, on a runner nobody can `--no-verify` past:

```yaml
# .github/workflows/ci.yaml - the real gate, server-side
name: ci
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
      - name: Format check
        run: test -z "$(gofmt -l .)"
      - name: Lint
        run: golangci-lint run ./...
      - name: Test
        run: go test -race ./...
      - name: Build
        run: go build ./...
```

This workflow runs on every pull request and every push to `main`. It does not care whether the developer ran the pre-commit hook, skipped it, or deleted it — the checks run on a clean checkout server-side. A local skip now costs the developer nothing but a slightly later failure signal, because the same failure that the hook would have caught locally is caught in CI minutes later. The hook becomes a fast local convenience; CI becomes the authority.

The final piece is making CI's verdict mandatory. A green-or-red CI run is useless if anyone can merge a red PR. **Branch protection** (or the equivalent ruleset on your platform) ties the merge to the CI result:

```yaml
# GitHub branch protection expressed as an API payload (illustrative)
required_status_checks:
  strict: true
  contexts:
    - "ci / verify"
enforce_admins: true
required_pull_request_reviews:
  required_approving_review_count: 1
restrictions: null
```

With `required_status_checks` set to the `ci / verify` check, GitHub refuses to merge any pull request where that job has not passed. `strict: true` additionally requires the branch to be up to date with `main` before merging, which closes the gap where two PRs each pass CI in isolation but break when combined. `enforce_admins: true` is the detail teams most often omit and most often regret — without it, repository admins can bypass the very protection they configured, which recreates the same "trusted humans can skip the gate" problem one level up.

With this in place, the local hook and the server gate play different roles. The local hook gives a developer feedback in seconds and is fully skippable. CI gives the team a guarantee in minutes and is not skippable by anyone. The local skip is no longer dangerous, because the thing it skips is re-run somewhere that cannot be skipped. That is the entire point: **make local hooks skippable on purpose, and make the server gate the only thing that actually decides what reaches `main`.**

### Server-Side Hooks: The Gate Below the Gate

Branch protection and required status checks live at the forge layer (GitHub, GitLab, Bitbucket) and cover the workflows those platforms understand: pull requests and merges. For policies that must hold on *every* push regardless of platform features — or when you run your own Git server — there is a layer beneath that: the server-side `pre-receive` hook. It runs on the Git server the instant a push arrives, before any ref is updated, and there is nothing a client can do to skip it. `git push --no-verify` only suppresses the *client's* `pre-push` hook; it has no effect whatsoever on the server's `pre-receive`. Deleting `.git/hooks` locally does nothing to it. This is the genuine enforcement boundary.

A `pre-receive` hook reads one line per ref being pushed on stdin in the form `<old-sha> <new-sha> <ref-name>`, and a non-zero exit rejects the entire push. Here is one that enforces Conventional Commits on every commit pushed to `main`, server-side, where no developer flag can reach it:

```bash
#!/usr/bin/env bash
# pre-receive: server-side gate. Runs on the Git server before refs are
# accepted. Nothing a client passes (--no-verify, deleting .git/hooks) can
# reach this. stdin: "<old-sha> <new-sha> <ref-name>" per ref.
set -euo pipefail

protected_branch="refs/heads/main"
zero="0000000000000000000000000000000000000000"

while read -r old_sha new_sha ref_name; do
  # Only enforce policy on pushes to the protected branch.
  if [ "$ref_name" != "$protected_branch" ]; then
    continue
  fi

  # Allow branch deletion to pass through untouched.
  if [ "$new_sha" = "$zero" ]; then
    continue
  fi

  # Determine the commit range being introduced by this push.
  if [ "$old_sha" = "$zero" ]; then
    range="$new_sha"
  else
    range="$old_sha..$new_sha"
  fi

  # Reject any commit whose subject is not Conventional Commits compliant.
  while read -r sha; do
    subject=$(git log -1 --format=%s "$sha")
    if ! printf '%s' "$subject" | grep -qE '^(feat|fix|docs|refactor|test|chore|perf|build|ci)(\(.+\))?!?: .+'; then
      echo "pre-receive: rejected $sha" >&2
      echo "  non-conforming subject: $subject" >&2
      exit 1
    fi
  done < <(git rev-list "$range")
done
```

The key property is that this hook enforces the *exact same rule* a developer can skip locally with `--no-verify` or `SKIP=conventional-commit`, but here it is unskippable. A bypassed local commit-msg check is harmless because the server re-runs the equivalent check and rejects anything that does not comply. Note the handling of the zero SHA (`0000...`) for branch creation and deletion, and the up-front filter to the protected branch — a `pre-receive` hook that rejects work on feature branches would just push developers to bypass elsewhere.

On a managed forge you usually cannot install raw `pre-receive` hooks (GitHub Enterprise calls these "pre-receive hooks" and restricts them to site admins; GitLab offers "server hooks" and "push rules"; cloud GitHub relies on branch protection and required checks instead). The principle is identical across all of them: **the enforcing check must live somewhere the client cannot turn off.** Whether that is a `pre-receive` hook, a GitLab push rule, or a required GitHub status check is a deployment detail; the architecture — advisory local hook, mandatory server gate — is the same.

The specific mechanism you reach for depends on the platform, but every major forge offers an equivalent enforcement layer:

| Platform | Per-push enforcement | Merge enforcement |
| --- | --- | --- |
| GitHub (cloud) | Rulesets (commit message, author, required signatures) | Branch protection / rulesets: required status checks, required reviews |
| GitHub Enterprise Server | Pre-receive hooks (admin-installed) plus rulesets | Same as cloud |
| GitLab | Server hooks and push rules (regex on messages, file size, secrets) | Merge request approval rules, required pipelines |
| Bitbucket | Pre-receive hooks / merge checks (via apps) | Merge checks: required builds, minimum approvals |

The common thread: pick the layer that runs on the server, make it enforce the same rules your local hooks check, and make it impossible for a developer to disable from their machine. A local `--no-verify` then becomes a non-event, because the rule it skipped is re-evaluated on the server where the skip has no reach.

## An End-to-End Emergency Workflow

Putting it together, here is what a defensible hotfix looks like under pressure. The local hooks are skipped for speed, the change is pushed immediately, and CI plus branch protection still enforce correctness before anything merges:

```bash
# Emergency hotfix flow: commit fast, then make the change auditable
git switch -c hotfix/payment-timeout
git commit -am "hotfix: bump payment gateway timeout to 30s" --no-verify
git push --no-verify origin hotfix/payment-timeout

# Open the pull request; CI re-runs every check the local skip bypassed
gh pr create --base main --head hotfix/payment-timeout \
  --title "Hotfix: payment gateway timeout" \
  --body "Bypassed local hooks for speed; CI is the gate. See INC-4471."
```

Notice what this flow gets right. The skip is on a dedicated branch, never on `main`. The pull request body says explicitly that hooks were bypassed and why, with an incident reference, so the next reviewer is not guessing. And the merge still depends on CI going green — the `--no-verify` bought speed on the developer's machine, not a way past the server gate. If `gofmt` or the tests genuinely fail, the PR cannot merge, hotfix or not. Speed and safety are both satisfied because they are enforced in different places.

The flow does not end at the merge. A defensible emergency bypass carries a cleanup obligation: once the incident is resolved, go back and address whatever the skipped hooks would have caught. In practice that means re-running the checks locally on the merged result, fixing anything they surface in a follow-up commit, and — if the hook itself was the reason you skipped — filing the fix for the hook so the next person under pressure does not hit the same wall.

```text
Post-incident checklist after a bypassed hotfix:
  [ ] Re-run the skipped checks locally on the merged code
  [ ] Open a follow-up PR for anything they flag
  [ ] If a hook was broken, file/fix it so the next person isn't blocked
  [ ] Confirm the incident reference is recorded on the hotfix PR
```

This is the difference between a bypass that is a controlled exception and one that is the first crack in an eroding control. The emergency justified skipping speed-limiting checks *temporarily*; it did not justify shipping unverified code *permanently*. Closing the loop is what keeps the exception from quietly becoming the norm.

## A Team Policy That Actually Holds

For an enterprise team, "use `--no-verify` responsibly" is not a policy; it is a wish. A policy that holds is one where the architecture makes the right behavior easy and the wrong behavior either impossible or visible. Pulling together everything above, a durable setup has four layers that each do one job:

- **Fast, accurate local hooks** that give sub-second feedback on the common case. These are advisory and fully skippable on purpose. Their job is developer convenience, not enforcement.
- **An automated install step** in onboarding or a repository bootstrap script, so hooks are present without anyone remembering to run `pre-commit install`. A hook nobody installed is a hook nobody runs.
- **A mandatory server gate** — required CI status checks plus branch protection with `enforce_admins`, and a `pre-receive` hook or forge push rule for any policy that must hold on every push. This is the only layer that actually decides what reaches `main`, and it re-runs the same checks the local hooks run.
- **A visible audit trail** so deliberate bypasses are documented and habitual bypasses are detectable. The PR body explains the why; server-side logs record the what.

The reason to separate these explicitly is that each failure mode has a different fix. If developers are bypassing constantly, layer one is too slow or inaccurate — fix the hook. If unverified commits reach `main`, layer three is missing or misconfigured — tighten the gate. If you cannot tell justified emergencies from routine erosion, layer four is absent — add the audit. Conflating them ("just stop using `--no-verify`") fixes none of them.

The cultural payoff is significant: once the server gate is unskippable and the local hooks are fast, you can stop policing `--no-verify` entirely. It becomes what it should always have been — a speed optimization on a developer's own machine, with zero ability to weaken what the team actually ships. Engineers stop feeling like the tooling is fighting them, and the controls that matter become stronger, not weaker, because they live where they cannot be turned off.

## Keeping Skips Visible

Because a `--no-verify` commit is indistinguishable from a normal one in Git's history, the only practical way to keep an eye on skips is through convention and review. A team that allows bypasses should make them auditable: require a note in the PR description, lean on commit-message conventions for work-in-progress commits, and periodically scan history for the patterns that bypasses tend to leave behind.

```bash
# Find commits whose messages hint that hooks were skipped
git log --grep="wip" --grep="hotfix" -i --oneline --since="30 days ago"

# List recent commits with committer and ISO timestamp for an audit window
git log --since="7 days ago" --pretty="%h %an %cI %s"

# Surface commits whose subject would fail the commit-msg rule, implying
# the commit-msg hook was bypassed when they were created
git log --since="30 days ago" --pretty="%h %s" | \
  grep -vE ': (feat|fix|docs|refactor|test|chore|perf|build|ci)' || true
```

These commands do not prove a hook was skipped — Git records no such fact — but they surface the `wip:` and `hotfix:` commits where skipping is most likely, and the third one specifically catches commits whose message would never have passed a `commit-msg` hook, which is strong circumstantial evidence the hook was bypassed. That is enough to spot a pattern of routine bypassing that signals a hook needs fixing. If you find yourself running these and seeing the same hook skipped over and over, that is your cue to repair or delete that hook, not to keep skipping it.

For an enterprise team, build the audit into something durable rather than running these by hand. The most reliable signal lives on the server: a `pre-receive` hook (or your forge's audit log) can record every rejected push and every non-conforming commit that slipped through earlier, giving you a tamper-resistant trail that client-side history cannot provide. Pair that with a lightweight social contract — every bypassed-hooks commit references an incident or explains itself in the PR body — and you get both the data and the context to tell a justified emergency apart from an eroding control. The combination of an unskippable server gate, a fast local hook, and a visible audit trail is what turns `--no-verify` from a liability into a documented, rarely-needed tool.

## Conclusion

Skipping Git hooks is a normal, legitimate part of working in a hook-equipped repository, as long as you treat it as a deliberate exception backed by a server-side safety net rather than a way to make checks disappear. The mechanics are simple; the judgment around them is what separates a healthy workflow from a broken one.

The throughline of this entire article is a single architectural decision: local hooks are advisory, the server is authoritative. Once you internalize that, every other question answers itself. You can let developers bypass freely on their own machines because the bypass cannot reach `main`. You invest in making hooks fast because their value is feedback speed, not enforcement. You put the controls that genuinely matter — secret scanning, required tests, message conventions — on the server where no flag can disable them. A team that gets this right spends no energy policing `--no-verify` and still ships verified code every time.

Key takeaways:

- **Know the hook sequence.** A `git commit` fires `pre-commit`, `prepare-commit-msg`, `commit-msg`, then `post-commit`; a `git push` fires `pre-push`. Only the gating hooks can abort the operation, and those are the ones a bypass targets.
- **`--no-verify` (or `-n`) on `git commit` skips the two gating hooks — `pre-commit` and `commit-msg`** — for that one commit, while `prepare-commit-msg` and `post-commit` still run. The same flag on `git push` skips `pre-push`. It is always per-invocation; there is no persistent off switch.
- **The pre-commit framework's `SKIP` variable is more precise than `--no-verify`** — it skips named hooks by `id` while leaving every other hook running, so you give up the minimum safety needed to get unblocked. Reach for `SKIP` by default and reserve `--no-verify` for when the framework itself cannot run.
- **Diagnose before you skip.** Use `pre-commit run --all-files` to tell a broken hook apart from broken code, and fix the hook for everyone rather than skipping it forever.
- **Skipping is defensible** for broken unrelated hooks, active incidents, work-in-progress commits, and replaying historical commits — situations where something downstream will still catch real problems.
- **Make hooks fast so people do not want to skip them.** Lint only staged files, put cheap checks on commit and expensive checks on push, cache toolchains, and fail fast with clear remediation. Latency is the number-one cause of habitual bypassing.
- **Routine skipping is a smell.** A hook everyone bypasses is protecting nothing; make it fast, make it accurate, or delete it.
- **Local hooks are convenience, not a boundary.** They run on developer machines and can be skipped or deleted without a trace. Enforce the checks that truly matter where the client cannot reach them.
- **Make the server the real gate.** Use branch protection with required status checks, `strict` up-to-date branches, and `enforce_admins` so no one — not even an admin — can merge past a failing build, and a `pre-receive` hook (or your forge's push rules) for policy that must hold on every push. Once the server gate is solid, a local skip costs nothing but a slightly slower feedback loop.
- **Audit bypasses on purpose.** History does not record a skip, so surface the likely candidates with `git log` patterns, record rejections server-side, and require a PR note or incident reference for any deliberate bypass.
