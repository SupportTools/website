---
title: "Kubernetes GitOps Security: Signed Commits, Policy Enforcement, and Audit Trails"
date: 2029-07-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GitOps", "Security", "ArgoCD", "Flux", "OPA", "GPG", "Audit"]
categories: ["Kubernetes", "Security", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to securing GitOps pipelines with GPG/SSH commit signing, Flux and ArgoCD policy gates, OPA policies on GitOps repositories, and audit log analysis for compliance."
more_link: "yes"
url: "/kubernetes-gitops-security-signed-commits-policy-enforcement-audit-trails/"
---

GitOps has become the dominant deployment model for Kubernetes at scale, but its security posture is only as strong as the trust chain from developer commit to cluster state. A misconfigured GitOps pipeline is a direct path from a compromised developer workstation to production cluster compromise. This guide covers every layer of GitOps security hardening: commit signing with GPG and SSH keys, policy gates in Flux and ArgoCD, OPA policies that enforce constraints on the GitOps repository itself, and audit trail analysis that satisfies SOC 2 and PCI DSS requirements.

<!--more-->

# Kubernetes GitOps Security: Signed Commits, Policy Enforcement, and Audit Trails

## The GitOps Trust Problem

In a traditional CI/CD model, the deployment pipeline is a stateful system with access controls at each stage. In GitOps, the Git repository is the single source of truth, and the reconciliation controller has elevated cluster permissions. This creates a specific attack surface: anyone who can push to the repository — or who can forge a commit that appears to come from a trusted author — can potentially deploy arbitrary workloads.

The threat model includes:
- **Credential compromise**: A developer's Git credentials are stolen, allowing unauthorized commits
- **Supply chain attacks**: A dependency or build artifact is compromised, and a malicious commit updates the repository to pull it
- **Insider threat**: A legitimate team member makes unauthorized changes to production-targeted manifests
- **MITM attacks**: A man-in-the-middle intercepts and modifies Git traffic (less common with HTTPS/SSH but worth addressing)

The solution is a defense-in-depth approach: sign every commit cryptographically, enforce signature verification before reconciliation, apply policy gates that validate manifest content, and maintain audit trails that are tamper-evident.

## GPG Commit Signing for GitOps Repositories

GPG signing creates a cryptographic chain of custody for every commit. When the reconciler verifies signatures, it ensures that only commits from known, trusted keys can trigger cluster changes.

### Setting Up GPG Keys for Team Members

Each team member should have a dedicated GPG key for commit signing. For GitOps repositories, treat these keys as high-value secrets:

```bash
# Generate a 4096-bit RSA key (or use ed25519 for smaller, faster keys)
gpg --full-generate-key

# For automated systems, generate without interactive prompts
cat > /tmp/gpg-params <<EOF
%echo Generating GitOps signing key
Key-Type: eddsa
Key-Curve: ed25519
Key-Usage: sign
Name-Real: GitOps Bot
Name-Email: gitops-bot@company.com
Expire-Date: 1y
%commit
EOF

gpg --batch --generate-key /tmp/gpg-params

# Export the public key
gpg --armor --export gitops-bot@company.com > gitops-bot.pub.asc

# Export the private key (store in Vault or similar)
gpg --armor --export-secret-keys gitops-bot@company.com > gitops-bot.priv.asc
```

Configure Git to sign all commits automatically:

```bash
# Get your key ID
gpg --list-secret-keys --keyid-format=long

# Configure git globally
git config --global user.signingkey <KEY_ID>
git config --global commit.gpgsign true
git config --global tag.gpgsign true

# Verify a signed commit
git log --show-signature -1
```

### SSH Commit Signing (Git 2.34+)

SSH key signing is simpler to manage at scale because most teams already have SSH infrastructure. Git 2.34 introduced native SSH signing support:

```bash
# Configure SSH signing
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub

# For agents/CI systems using a specific key
git config --global user.signingkey /path/to/signing-key.pub

# Create allowed signers file (used for verification)
cat > ~/.config/git/allowed_signers <<EOF
gitops-bot@company.com namespaces="git" ssh-ed25519 AAAA... gitops-bot
alice@company.com namespaces="git" ssh-ed25519 AAAA... alice
bob@company.com namespaces="git" ssh-ed25519 AAAA... bob
EOF

git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers

# Verify a commit
git verify-commit HEAD
```

### Managing the Allowed Signers Registry

For enterprise deployments, the allowed signers file should be managed as infrastructure:

```yaml
# k8s/gitops/allowed-signers-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gitops-allowed-signers
  namespace: flux-system
  labels:
    app.kubernetes.io/part-of: gitops-security
data:
  allowed_signers: |
    # Format: email namespaces="git" key-type key-material comment
    gitops-ci@company.com namespaces="git" ssh-ed25519 AAAA...CI_KEY gitops-ci-system
    platform-team@company.com namespaces="git" ssh-ed25519 AAAA...PLATFORM platform-team-shared
    # Individual keys are managed via LDAP sync - see sync-signers CronJob
```

```bash
# sync-signers.sh - runs as a CronJob to pull keys from LDAP/GitHub
#!/bin/bash
set -euo pipefail

GITHUB_ORG="${GITHUB_ORG:-mycompany}"
OUTPUT_FILE="/tmp/allowed_signers"

# Pull SSH keys from GitHub for org members
gh api "orgs/${GITHUB_ORG}/members" --jq '.[].login' | while read -r username; do
  email=$(gh api "users/${username}" --jq '.email // empty')
  if [[ -n "$email" ]]; then
    gh api "users/${username}/keys" --jq '.[] | .key' | while read -r key; do
      echo "${email} namespaces=\"git\" ${key}" >> "$OUTPUT_FILE"
    done
  fi
done

kubectl create configmap gitops-allowed-signers \
  --from-file=allowed_signers="$OUTPUT_FILE" \
  --namespace flux-system \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Flux CD: Signature Verification Configuration

Flux's GitRepository source controller supports commit signature verification natively.

### Configuring GitRepository with Signature Verification

```yaml
# flux/sources/app-repo.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: app-manifests
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/company/k8s-manifests
  ref:
    branch: main
  verification:
    mode: HEAD
    secretRef:
      name: gitops-signing-keys
  secretRef:
    name: github-credentials
```

```yaml
# flux/sources/gitops-signing-keys-secret.yaml
# Create this from the GPG public keyring
# gpg --export --armor <key-ids> > public-keys.asc
apiVersion: v1
kind: Secret
metadata:
  name: gitops-signing-keys
  namespace: flux-system
type: Opaque
stringData:
  # Paste the armored public key block
  "public.asc": |
    -----BEGIN PGP PUBLIC KEY BLOCK-----
    ... (key material) ...
    -----END PGP PUBLIC KEY BLOCK-----
```

For SSH-signed commits, Flux 2.3+ uses a different format:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: app-manifests
  namespace: flux-system
spec:
  interval: 1m
  url: ssh://git@github.com/company/k8s-manifests
  ref:
    branch: main
  verification:
    mode: HEAD
    secretRef:
      name: ssh-allowed-signers
```

```bash
# Create the SSH allowed signers secret
kubectl create secret generic ssh-allowed-signers \
  --from-file=allowed_signers=/path/to/allowed_signers \
  --namespace flux-system
```

### Flux Notification Controller for Policy Violations

Configure Flux to alert on signature verification failures:

```yaml
# flux/alerts/signature-failure-alert.yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: signature-verification-failure
  namespace: flux-system
spec:
  providerRef:
    name: slack-security-channel
  eventSeverity: error
  eventSources:
    - kind: GitRepository
      name: '*'
  inclusionList:
    - ".*verification.*failed.*"
    - ".*signature.*invalid.*"
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-security-channel
  namespace: flux-system
spec:
  type: slack
  channel: "#security-alerts"
  secretRef:
    name: slack-webhook-url
```

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: slack-webhook-url
  namespace: flux-system
type: Opaque
stringData:
  address: "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"
```

## ArgoCD: Policy Gates and RBAC Configuration

ArgoCD's policy model is more granular than Flux's, allowing fine-grained control over who can sync what to which environments.

### ArgoCD RBAC for GitOps Security

```yaml
# argocd-rbac-cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    # Platform team can manage all applications
    p, role:platform-admin, applications, *, */*, allow
    p, role:platform-admin, clusters, *, *, allow
    p, role:platform-admin, repositories, *, *, allow

    # App teams can sync their own namespace applications
    p, role:app-team-alpha, applications, get, alpha/*, allow
    p, role:app-team-alpha, applications, sync, alpha/*, allow
    p, role:app-team-alpha, applications, override, alpha/*, deny

    # Production requires manual sync (no auto-sync override)
    p, role:app-team-alpha, applications, sync, production/*, deny

    # CI system can sync non-production
    p, role:ci-system, applications, sync, dev/*, allow
    p, role:ci-system, applications, sync, staging/*, allow
    p, role:ci-system, applications, sync, production/*, deny

    # Group assignments
    g, company:platform-team, role:platform-admin
    g, company:alpha-team, role:app-team-alpha
    g, ci-system, role:ci-system

  scopes: '[groups, email]'
```

### ArgoCD Application with Sync Policy Gates

```yaml
# argocd/apps/production-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: production-app
  namespace: argocd
  annotations:
    # Require manual sync approval for production
    argocd.argoproj.io/sync-options: "Validate=true"
spec:
  project: production
  source:
    repoURL: https://github.com/company/k8s-manifests
    targetRevision: HEAD
    path: apps/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    # No automated sync for production - require manual approval
    automated: null
    syncOptions:
      - Validate=true
      - CreateNamespace=false
      - PrunePropagationPolicy=foreground
      - ApplyOutOfSyncOnly=true
    retry:
      limit: 3
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

```yaml
# argocd/projects/production-project.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: production
  namespace: argocd
spec:
  description: Production environment - requires signed commits and manual sync

  sourceRepos:
    - https://github.com/company/k8s-manifests

  destinations:
    - namespace: production
      server: https://production-cluster.company.com
    - namespace: monitoring
      server: https://production-cluster.company.com

  # Deny cluster-scoped resources in production project
  clusterResourceWhitelist:
    - group: ''
      kind: Namespace

  # Namespace-scoped resource allowlist
  namespaceResourceWhitelist:
    - group: 'apps'
      kind: Deployment
    - group: 'apps'
      kind: StatefulSet
    - group: ''
      kind: Service
    - group: ''
      kind: ConfigMap
    - group: ''
      kind: Secret
    - group: 'networking.k8s.io'
      kind: Ingress

  # Deny dangerous resources
  namespaceResourceBlacklist:
    - group: ''
      kind: ResourceQuota
    - group: 'rbac.authorization.k8s.io'
      kind: ClusterRoleBinding

  roles:
    - name: production-deployer
      description: Can sync production applications
      policies:
        - p, proj:production:production-deployer, applications, sync, production/*, allow
      groups:
        - company:release-managers
```

### ArgoCD Commit Signature Verification via Pre-Sync Hooks

ArgoCD doesn't natively verify commit signatures, but you can enforce this via pre-sync hooks:

```yaml
# manifests/pre-sync-verify.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: verify-commit-signature
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: argocd-hook-sa
      initContainers:
        - name: clone-repo
          image: alpine/git:latest
          command:
            - sh
            - -c
            - |
              git clone --depth=1 https://github.com/company/k8s-manifests /workspace/repo
              git -C /workspace/repo log --show-signature -1 HEAD > /workspace/sig-output.txt
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: git-credentials
              mountPath: /root/.git-credentials
              subPath: credentials
      containers:
        - name: verify-signature
          image: company/gitops-verifier:latest
          command:
            - sh
            - -c
            - |
              cat /workspace/sig-output.txt
              if grep -q "Good signature" /workspace/sig-output.txt; then
                echo "Commit signature verified successfully"
                exit 0
              else
                echo "ERROR: Commit signature verification failed"
                cat /workspace/sig-output.txt
                exit 1
              fi
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      volumes:
        - name: workspace
          emptyDir: {}
        - name: git-credentials
          secret:
            secretName: github-credentials
```

## OPA Policies for GitOps Repository Enforcement

Open Policy Agent (OPA) with Gatekeeper can enforce policies on manifests before they are applied. For GitOps, this means catching policy violations at the repository level before they ever reach the reconciler.

### Gatekeeper Constraint Templates for GitOps

```yaml
# gatekeeper/templates/require-resource-limits.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireresourcelimits
spec:
  crd:
    spec:
      names:
        kind: RequireResourceLimits
      validation:
        openAPIV3Schema:
          type: object
          properties:
            exemptImages:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requireresourcelimits

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not has_resource_limits(container)
          not is_exempt(container.image, input.parameters.exemptImages)
          msg := sprintf("Container '%v' must have resource limits set", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.initContainers[_]
          not has_resource_limits(container)
          msg := sprintf("Init container '%v' must have resource limits set", [container.name])
        }

        has_resource_limits(container) {
          container.resources.limits.cpu
          container.resources.limits.memory
        }

        is_exempt(image, exemptImages) {
          startswith(image, exemptImages[_])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireResourceLimits
metadata:
  name: require-resource-limits
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
      - production
      - staging
  parameters:
    exemptImages:
      - "gcr.io/distroless/"
```

```yaml
# gatekeeper/templates/no-latest-tag.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: nolatesttag
spec:
  crd:
    spec:
      names:
        kind: NoLatestTag
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package nolatesttag

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          endswith(container.image, ":latest")
          msg := sprintf("Container '%v' uses 'latest' tag. Use a specific version tag.", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not contains(container.image, ":")
          msg := sprintf("Container '%v' has no image tag. Specify an explicit version.", [container.name])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: NoLatestTag
metadata:
  name: no-latest-tag-production
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
      - production
```

### OPA Conftest for Pre-Commit Repository Validation

Conftest allows you to run OPA policies against Kubernetes manifests locally and in CI before they reach the cluster:

```bash
# Install conftest
brew install conftest
# or
curl -L https://github.com/open-policy-agent/conftest/releases/download/v0.50.0/conftest_0.50.0_Linux_x86_64.tar.gz | tar xz
```

```rego
# policy/gitops/deny-privileged.rego
package main

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  container.securityContext.privileged == true
  msg := sprintf("Deployment '%v' has a privileged container '%v'. This is not allowed.", [
    input.metadata.name,
    container.name
  ])
}

deny[msg] {
  input.kind == "Deployment"
  input.spec.template.spec.hostNetwork == true
  msg := sprintf("Deployment '%v' uses hostNetwork. This is not allowed in GitOps-managed resources.", [
    input.metadata.name
  ])
}

deny[msg] {
  input.kind == "Deployment"
  input.spec.template.spec.hostPID == true
  msg := sprintf("Deployment '%v' uses hostPID. This is not allowed.", [input.metadata.name])
}

warn[msg] {
  input.kind == "Deployment"
  not input.spec.template.spec.securityContext.runAsNonRoot
  msg := sprintf("Deployment '%v' does not set runAsNonRoot. Consider setting it to true.", [
    input.metadata.name
  ])
}
```

```rego
# policy/gitops/require-labels.rego
package main

required_labels := {
  "app.kubernetes.io/name",
  "app.kubernetes.io/version",
  "app.kubernetes.io/managed-by",
  "app.kubernetes.io/part-of",
}

deny[msg] {
  input.kind == "Deployment"
  label := required_labels[_]
  not input.metadata.labels[label]
  msg := sprintf("Deployment '%v' is missing required label '%v'", [
    input.metadata.name,
    label
  ])
}

deny[msg] {
  input.kind == "Deployment"
  input.metadata.labels["app.kubernetes.io/managed-by"] != "flux"
  input.metadata.labels["app.kubernetes.io/managed-by"] != "argocd"
  msg := sprintf("Deployment '%v' must have managed-by set to 'flux' or 'argocd'", [
    input.metadata.name
  ])
}
```

```yaml
# .conftest.yaml - configuration at repo root
policy:
  - policy/gitops

namespace: main

# Run against all YAML files in the manifests directory
data:
  - data/
```

```bash
# Run conftest in CI
conftest test manifests/ --policy policy/gitops/

# Test a specific file
conftest test apps/production/deployment.yaml

# Output in multiple formats
conftest test manifests/ --output=json > conftest-results.json
conftest test manifests/ --output=tap
```

### Pre-Commit Hook Integration

```bash
# .git/hooks/pre-commit
#!/bin/bash
set -euo pipefail

echo "Running GitOps policy checks..."

# Find changed YAML files
CHANGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\.yaml$' || true)

if [[ -z "$CHANGED_FILES" ]]; then
  echo "No YAML files changed, skipping policy checks"
  exit 0
fi

# Run conftest on changed files
echo "$CHANGED_FILES" | xargs conftest test --policy policy/gitops/

# Verify no secrets are being committed
if command -v detect-secrets >/dev/null 2>&1; then
  git diff --cached | detect-secrets-hook --baseline .secrets.baseline
fi

echo "All policy checks passed"
```

### GitHub Actions Workflow for GitOps Policy Enforcement

```yaml
# .github/workflows/gitops-policy-check.yaml
name: GitOps Policy Enforcement

on:
  pull_request:
    branches:
      - main
    paths:
      - 'manifests/**'
      - 'apps/**'
      - 'infrastructure/**'

jobs:
  policy-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - name: Install conftest
        run: |
          CONFTEST_VERSION="0.50.0"
          curl -L "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_x86_64.tar.gz" | tar xz
          sudo mv conftest /usr/local/bin/

      - name: Run OPA policies
        run: |
          conftest test manifests/ apps/ infrastructure/ \
            --policy policy/gitops/ \
            --output=json | tee policy-results.json

          # Fail if any violations
          violations=$(jq '[.[] | select(.failures | length > 0)] | length' policy-results.json)
          if [[ "$violations" -gt 0 ]]; then
            echo "Policy violations found:"
            jq '.[] | select(.failures | length > 0) | .filename, (.failures[] | .msg)' policy-results.json
            exit 1
          fi

      - name: Verify commit signatures
        run: |
          # Check all commits in the PR are signed
          git log origin/main..HEAD --format="%H %G?" | while read commit status; do
            if [[ "$status" != "G" ]] && [[ "$status" != "U" ]]; then
              echo "ERROR: Commit $commit is not signed (status: $status)"
              exit 1
            fi
            echo "Commit $commit: signature OK"
          done

      - name: Upload policy results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: policy-results
          path: policy-results.json

      - name: Comment policy results on PR
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const results = JSON.parse(fs.readFileSync('policy-results.json', 'utf8'));
            const violations = results.filter(r => r.failures && r.failures.length > 0);

            let comment = '## Policy Violations Found\n\n';
            violations.forEach(v => {
              comment += `### ${v.filename}\n`;
              v.failures.forEach(f => {
                comment += `- ${f.msg}\n`;
              });
              comment += '\n';
            });

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: comment
            });
```

## Audit Trail Analysis

A complete GitOps audit trail spans Git history, reconciler events, Kubernetes audit logs, and application-level logs.

### Kubernetes Audit Policy for GitOps

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Capture all writes from GitOps controllers
  - level: RequestResponse
    verbs: ["create", "update", "patch", "delete"]
    users:
      - "system:serviceaccount:flux-system:kustomize-controller"
      - "system:serviceaccount:flux-system:helm-controller"
      - "system:serviceaccount:argocd:argocd-application-controller"
    omitStages:
      - RequestReceived

  # Capture RBAC changes
  - level: RequestResponse
    resources:
      - group: "rbac.authorization.k8s.io"
        resources: ["clusterroles", "clusterrolebindings", "roles", "rolebindings"]
    verbs: ["create", "update", "patch", "delete"]

  # Capture secret access (metadata only for security)
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Default - log metadata for everything else
  - level: Metadata
    omitStages:
      - RequestReceived
```

### Parsing and Analyzing Audit Logs

```python
#!/usr/bin/env python3
# audit-analyzer.py - Analyze Kubernetes audit logs for GitOps events

import json
import sys
from datetime import datetime
from collections import defaultdict
from typing import Any

def parse_audit_log(filename: str) -> list[dict[str, Any]]:
    events = []
    with open(filename) as f:
        for line in f:
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events

def extract_gitops_events(events: list[dict]) -> dict:
    gitops_sa_prefixes = [
        "system:serviceaccount:flux-system:",
        "system:serviceaccount:argocd:",
    ]

    gitops_events = defaultdict(list)

    for event in events:
        user = event.get("user", {}).get("username", "")
        if not any(user.startswith(prefix) for prefix in gitops_sa_prefixes):
            continue

        verb = event.get("verb", "")
        resource = event.get("objectRef", {}).get("resource", "")
        namespace = event.get("objectRef", {}).get("namespace", "")
        name = event.get("objectRef", {}).get("name", "")
        timestamp = event.get("requestReceivedTimestamp", "")

        gitops_events[user].append({
            "timestamp": timestamp,
            "verb": verb,
            "resource": resource,
            "namespace": namespace,
            "name": name,
            "status": event.get("responseStatus", {}).get("code"),
        })

    return gitops_events

def detect_anomalies(events: list[dict]) -> list[str]:
    anomalies = []

    for event in events:
        user = event.get("user", {}).get("username", "")
        verb = event.get("verb", "")
        resource = event.get("objectRef", {}).get("resource", "")

        # Flag direct secret writes from non-GitOps users
        if resource == "secrets" and verb in ["create", "update"] and \
           not "serviceaccount:flux-system" in user and \
           not "serviceaccount:argocd" in user:
            anomalies.append(f"Direct secret write by {user}: {event.get('objectRef', {})}")

        # Flag RBAC changes outside platform team
        if resource in ["clusterroles", "clusterrolebindings"] and verb != "get":
            groups = event.get("user", {}).get("groups", [])
            if "company:platform-team" not in groups:
                anomalies.append(f"RBAC change by non-platform-team user {user}: {resource}")

        # Flag namespace creation
        if resource == "namespaces" and verb == "create":
            anomalies.append(f"Namespace created by {user}: {event.get('objectRef', {}).get('name')}")

    return anomalies

def generate_report(audit_file: str) -> None:
    events = parse_audit_log(audit_file)
    gitops_events = extract_gitops_events(events)
    anomalies = detect_anomalies(events)

    print("=== GitOps Audit Report ===\n")
    print(f"Total audit events: {len(events)}")
    print(f"GitOps controller events: {sum(len(v) for v in gitops_events.values())}")
    print(f"Anomalies detected: {len(anomalies)}\n")

    print("--- GitOps Controller Activity ---")
    for controller, activity in gitops_events.items():
        print(f"\n{controller}:")
        resource_counts = defaultdict(int)
        for event in activity:
            resource_counts[f"{event['verb']} {event['resource']}"] += 1
        for action, count in sorted(resource_counts.items()):
            print(f"  {action}: {count}")

    if anomalies:
        print("\n--- ANOMALIES ---")
        for anomaly in anomalies:
            print(f"  [!] {anomaly}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: audit-analyzer.py <audit-log-file>")
        sys.exit(1)
    generate_report(sys.argv[1])
```

### Flux Event Audit Collection

```yaml
# flux/audit-notification.yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: gitops-audit-all-events
  namespace: flux-system
spec:
  providerRef:
    name: audit-log-sink
  eventSeverity: info
  eventSources:
    - kind: Kustomization
      name: '*'
    - kind: HelmRelease
      name: '*'
    - kind: GitRepository
      name: '*'
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: audit-log-sink
  namespace: flux-system
spec:
  type: generic-hmac
  address: https://audit-collector.company.com/flux-events
  secretRef:
    name: audit-hmac-key
```

### Tamper-Evident Audit Log Storage

For compliance, audit logs must be stored in a way that prevents retroactive modification:

```yaml
# audit-log-shipper.yaml - Using Vector to ship to immutable storage
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: audit-log-shipper
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: audit-log-shipper
  template:
    metadata:
      labels:
        app: audit-log-shipper
    spec:
      serviceAccountName: audit-log-shipper
      containers:
        - name: vector
          image: timberio/vector:0.36.0-distroless-libc
          args: ["--config", "/etc/vector/vector.toml"]
          env:
            - name: AWS_REGION
              value: us-east-1
          volumeMounts:
            - name: audit-logs
              mountPath: /var/log/kubernetes/audit
              readOnly: true
            - name: vector-config
              mountPath: /etc/vector
      volumes:
        - name: audit-logs
          hostPath:
            path: /var/log/kubernetes/audit
        - name: vector-config
          configMap:
            name: vector-audit-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: vector-audit-config
  namespace: kube-system
data:
  vector.toml: |
    [sources.audit_logs]
    type = "file"
    include = ["/var/log/kubernetes/audit/*.log"]

    [transforms.parse_audit]
    type = "remap"
    inputs = ["audit_logs"]
    source = '''
    . = parse_json!(.message)
    .shipped_at = now()
    .cluster = "production"
    '''

    [sinks.s3_immutable]
    type = "aws_s3"
    inputs = ["parse_audit"]
    bucket = "company-k8s-audit-logs"
    key_prefix = "{{ cluster }}/{{ timestamp(\"%Y/%m/%d\") }}/"
    compression = "gzip"

    [sinks.s3_immutable.encoding]
    codec = "ndjson"

    # Enable Object Lock (WORM) on the bucket via bucket policy
    # aws s3api put-object-lock-configuration \
    #   --bucket company-k8s-audit-logs \
    #   --object-lock-configuration Mode=COMPLIANCE,Days=365
```

## Branch Protection and Repository Hardening

The Git repository itself must be hardened to prevent direct pushes that bypass review:

```bash
# GitHub repository settings via gh CLI
gh api repos/company/k8s-manifests/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["policy-check","signature-verify"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":2,"dismiss_stale_reviews":true,"require_code_owner_reviews":true}' \
  --field restrictions='{"users":[],"teams":["platform-team"]}' \
  --field required_linear_history=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false \
  --field required_conversation_resolution=true
```

```yaml
# CODEOWNERS file for GitOps repository
# .github/CODEOWNERS

# Production manifests require platform team approval
/apps/production/  @company/platform-team @company/release-managers
/infrastructure/   @company/platform-team

# Gatekeeper policies require security team review
/policy/           @company/security-team @company/platform-team

# RBAC changes always require security review
/infrastructure/rbac/  @company/security-team

# Everything else needs at least one team lead review
*                  @company/team-leads
```

## Summary

Securing a GitOps pipeline requires addressing the full trust chain:

1. **Commit signing** (GPG or SSH) ensures that every change to the GitOps repository can be traced to a verified identity
2. **Flux/ArgoCD signature verification** prevents unsigned or invalidly-signed commits from being reconciled
3. **OPA/Conftest policies** catch policy violations at the repository level before they reach the cluster
4. **Gatekeeper constraints** provide a last line of defense at admission time
5. **Kubernetes audit logs** with tamper-evident storage satisfy compliance requirements
6. **Branch protection rules** prevent the bypass of all the above controls

The combination of these controls creates a GitOps security posture where each commit is verified, each manifest is policy-checked, and every cluster change is auditable — end to end.
