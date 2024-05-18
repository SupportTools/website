---
title: "Triggering GitHub Actions from a Different Repository"
date: 2024-05-18T19:26:00-05:00
draft: true
tags: ["GitHub Actions", "CI/CD"]
categories:
- DevOps
- GitHub Actions
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to trigger GitHub Actions workflows in one repository from another repository."
more_link: "yes"
url: "/triggering-github-actions-from-different-repository/"
---

Learn how to trigger GitHub Actions workflows in one repository from another repository. This guide provides step-by-step instructions to set up repository dispatch triggers and Personal Access Tokens.

<!--more-->

# [Triggering GitHub Actions from a Different Repository](#triggering-github-actions-from-a-different-repository)

## [Background](#background)

At work, I’m working on a project that spans multiple GitHub repositories. I need to trigger a job in one repository from a different repository. Let’s assume we have two repositories: `the-tests` and `the-app`. Whenever I make a change to `the-app` (the “source”), I want to run a workflow in `the-tests` (the “target”).

## [Repository Dispatch](#repository-dispatch)

GitHub provides a `repository_dispatch` trigger to trigger a workflow. Add it to `the-tests` repository:

```yaml
# .github/workflows/integration-tests.yaml
name: "Integration Tests"

on:
  repository_dispatch:
    types:
      - integration-tests

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Integration Tests
        run: ./integration-tests.sh
```

You can add this to an existing workflow file:

```yaml
# .github/workflows/main.yaml
on:
  push:
    branches: ["main"]
  pull_request:
    branches: ["main"]
  repository_dispatch:
    types:
      - integration-tests
# ...
```

## [Triggering with curl](#triggering-with-curl)

Use `curl` to trigger this workflow via the `dispatches` REST endpoint. Example:

```bash
curl -qs \
  --fail-with-body \
  -L \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/$TARGET_REPO_OWNER/$TARGET_REPO/dispatches \
  -d '{"event_type":"integration-tests"}'
```

- `$BEARER_TOKEN`: Fine-grained Personal Access Token (PAT).
- `$TARGET_REPO_OWNER`: Owner of the target repository.
- `$TARGET_REPO`: Name of the target repository.

## [Personal Access Token](#personal-access-token)

Generate a Fine-grained Personal Access Token:

1. Click your profile picture in GitHub and select "Settings".
2. Click "Developer settings" at the bottom-left of the settings page.
3. Click "Personal access tokens" / "Fine-grained tokens" on the left-hand side.
4. Click "Generate new token".
5. Name it and give it a sensible description.
6. Under "Repository access", choose "Only select repositories" and select the target repository.
7. Under "Repository permissions", choose "Contents: Read and write".
8. Click "Generate token" and copy the token (starts with `github_pat_`).

## [Triggering from the Source Repository](#triggering-from-the-source-repository)

Create a workflow in `the-app` to include the `curl` command:

```yaml
# .github/workflows/trigger-integration-tests.yaml
name: "Trigger Integration Tests"

on:
  push:
    branches: ["main"]

jobs:
  trigger-integration-tests:
    name: "Trigger Integration Tests"
    runs-on: ubuntu-latest

    steps:
      - name: "Trigger Integration Tests"
        run: |
          target_repo=the-tests
          curl -qs \
            --fail-with-body \
            -L \
            -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer ${{ secrets.THE_TESTS_PAT }}" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            https://api.github.com/repos/$GITHUB_REPOSITORY_OWNER/$target_repo/dispatches \
            -d '{"event_type":"integration-tests"}'
```

## [Secrets](#secrets)

To store the Personal Access Token as a secret:

1. In `the-app` repository, click "Settings".
2. Click "Secrets and variables" under "Security".
3. Click "Actions".
4. Click "New repository secret".
5. Name it `THE_TESTS_PAT` and paste the PAT from earlier.
6. Click "Add secret".

## [Conclusion](#conclusion)

Now, any push to `main` in `the-app` should trigger the "Run Integration Tests" workflow in `the-tests`. You can extend this so that multiple repositories trigger the integration tests.

## [What’s Missing?](#whats-missing)

- Triggering `the-tests` for pull requests against dependencies.
- Triggering integration tests only if all actions in `the-app` succeed.

## [What’s Annoying?](#whats-annoying)

- Multiple dependencies require the triggering workflow in each.
- Multiple pushes trigger multiple times without waiting for everything to quiet down.

## [References](#references)

- [Using GitHub Actions to Trigger Actions Across Repos](https://www.amaysim.technology/blog/using-github-actions-to-trigger-actions-across-repos)
- [Triggering Workflows in Another Repository with GitHub Actions](https://medium.com/hostspaceng/triggering-workflows-in-another-repository-with-github-actions-4f581f8e0ceb)
