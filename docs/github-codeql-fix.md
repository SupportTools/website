# CodeQL Code Scanning Configuration

## Current setup

This repository uses **GitHub's CodeQL default setup** (repository Settings >
Code security and analysis > Code scanning > Default setup). Default setup
scans `actions`, `go` and `javascript-typescript` and needs no workflow file.

There is intentionally **no** advanced CodeQL workflow in
`.github/workflows/`. Do not add one back.

## Why

GitHub does not process an advanced-configuration CodeQL upload while default
setup is enabled for the same repository. The advanced workflow that used to
live at `.github/workflows/codeql.yml` failed on every push, pull request and
weekly scheduled run with:

```
Code Scanning could not process the submitted SARIF file: CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled
```

The PM decision (TaskForge taskforge-2825) was to delete the advanced workflow
and keep default setup, which already covers more languages than the workflow
did (it scanned only `go`).

## If you need a custom configuration

Switching to an advanced workflow means disabling default setup in the
repository settings first, in the same change window as adding the workflow.
That is a repository-settings decision, so file a task for it rather than
re-adding a workflow file.
