---
title: "Kubernetes ArgoCD RBAC: Projects, AppProject Policies, and Multi-Team Access"
date: 2029-02-28T00:00:00-05:00
draft: false
tags: ["ArgoCD", "Kubernetes", "RBAC", "GitOps", "Multi-Team", "Security"]
categories:
- Kubernetes
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep-dive into ArgoCD RBAC, AppProject scoping, and multi-team access patterns for enterprise GitOps deployments at scale."
more_link: "yes"
url: "/argocd-rbac-appproject-policies-multi-team-deep-dive/"
---

Enterprise GitOps deployments inevitably reach a point where a single ArgoCD instance must serve dozens of teams, each with distinct permission boundaries, source repository restrictions, and destination cluster access. ArgoCD's RBAC model—built on top of Casbin—provides the primitives to enforce these boundaries, but translating business requirements into correct `AppProject` policies, role definitions, and SSO group mappings requires detailed knowledge of how each layer interacts. This post covers that model end-to-end, from cluster-scoped bootstrap through per-team namespace isolation and cross-cluster promotion gates.

<!--more-->

## ArgoCD RBAC Architecture Overview

ArgoCD implements a two-tier permission system:

1. **AppProject** — scopes _what_ resources an application can deploy to and from what sources
2. **RBAC policies** — controls _who_ can perform operations on ArgoCD objects (apps, projects, repositories, clusters)

These two tiers are orthogonal. An AppProject can restrict a team to a single namespace on a single cluster, but an RBAC policy still governs whether a user can create, sync, or delete applications within that project. Getting production security right requires configuring both correctly.

### The Casbin Policy Model

ArgoCD uses Casbin with a custom model:

```
p, <role/user>, <resource>, <action>, <object>
g, <user/group>, <role>
```

Resources include: `applications`, `applicationsets`, `clusters`, `repositories`, `projects`, `accounts`, `gpgkeys`, `logs`, `exec`.

Actions include: `get`, `create`, `update`, `delete`, `sync`, `override`, `action/*`.

The `object` field follows the pattern `<project>/<name>` for applications and bare names for global resources.

## Default Roles and Their Scope

ArgoCD ships with two built-in roles:

| Role | Effective Permissions |
|------|-----------------------|
| `role:readonly` | `get` on all resources |
| `role:admin` | All actions on all resources |

These are defined in the `argocd-rbac-cm` ConfigMap and should not be used as-is in production. Instead, derive project-scoped roles.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    # Platform engineering team — full admin
    p, role:platform-admin, applications, *, */*, allow
    p, role:platform-admin, clusters, *, *, allow
    p, role:platform-admin, repositories, *, *, allow
    p, role:platform-admin, projects, *, *, allow
    p, role:platform-admin, accounts, *, *, allow
    p, role:platform-admin, gpgkeys, *, *, allow
    g, platform-engineering, role:platform-admin

    # Readonly viewer for all projects
    p, role:global-viewer, applications, get, */*, allow
    p, role:global-viewer, projects, get, *, allow
    g, sre-oncall, role:global-viewer
  scopes: '[groups, email]'
```

The `scopes` field controls which OIDC token claims ArgoCD uses for group membership. For Azure AD and Okta, this is typically `groups`. For GitHub OAuth, it may need to be adjusted to match team slugs.

## AppProject Design for Multi-Team Environments

### Namespace-Per-Team Pattern

The most common enterprise pattern allocates one or more namespaces to each team and creates a corresponding AppProject that restricts deployments to those namespaces.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments-team
  namespace: argocd
spec:
  description: "Payment processing services — PCI scope"

  # Allowed source repositories
  sourceRepos:
    - "https://github.com/acme-corp/payments-*"
    - "https://charts.bitnami.com/bitnami"
    - "registry-1.docker.io/bitnamicharts/*"

  # Allowed destination clusters and namespaces
  destinations:
    - server: https://prod-payments.k8s.acme.internal:6443
      namespace: payments-prod
    - server: https://prod-payments.k8s.acme.internal:6443
      namespace: payments-prod-jobs
    - server: https://staging.k8s.acme.internal:6443
      namespace: payments-staging

  # Cluster-scoped resources this project may NOT create
  clusterResourceBlacklist:
    - group: ""
      kind: Namespace
    - group: "rbac.authorization.k8s.io"
      kind: ClusterRole
    - group: "rbac.authorization.k8s.io"
      kind: ClusterRoleBinding

  # Namespace-scoped resources allowed (whitelist approach)
  namespaceResourceWhitelist:
    - group: "apps"
      kind: Deployment
    - group: "apps"
      kind: StatefulSet
    - group: "apps"
      kind: DaemonSet
    - group: ""
      kind: Service
    - group: ""
      kind: ConfigMap
    - group: ""
      kind: Secret
    - group: ""
      kind: ServiceAccount
    - group: "networking.k8s.io"
      kind: Ingress
    - group: "batch"
      kind: CronJob
    - group: "batch"
      kind: Job
    - group: "autoscaling"
      kind: HorizontalPodAutoscaler
    - group: "policy"
      kind: PodDisruptionBudget

  # Roles scoped to this project
  roles:
    - name: payments-developer
      description: "Deploy and sync applications in payments project"
      policies:
        - p, proj:payments-team:payments-developer, applications, get, payments-team/*, allow
        - p, proj:payments-team:payments-developer, applications, create, payments-team/*, allow
        - p, proj:payments-team:payments-developer, applications, update, payments-team/*, allow
        - p, proj:payments-team:payments-developer, applications, sync, payments-team/*, allow
        - p, proj:payments-team:payments-developer, applications, delete, payments-team/*, deny
      groups:
        - payments-developers

    - name: payments-lead
      description: "Full access to payments project including deletion"
      policies:
        - p, proj:payments-team:payments-lead, applications, *, payments-team/*, allow
        - p, proj:payments-team:payments-lead, repositories, get, *, allow
      groups:
        - payments-leads
        - payments-architects

  # Sync windows — prevent deployments during business hours on Fridays
  syncWindows:
    - kind: deny
      schedule: "0 16 * * 5"
      duration: 8h
      applications:
        - "*"
      namespaces:
        - payments-prod
      clusters:
        - https://prod-payments.k8s.acme.internal:6443
      manualSync: false

    - kind: allow
      schedule: "0 2 * * 1-4"
      duration: 4h
      applications:
        - "*"
      namespaces:
        - payments-prod

  # Orphaned resources monitoring
  orphanedResources:
    warn: true
    ignore:
      - group: ""
        kind: ConfigMap
        name: kube-root-ca.crt
```

### Multi-Cluster AppProject with Promotion Gates

For organizations running dedicated clusters per environment (common in PCI or HIPAA environments), AppProjects must be configured to express promotion topology explicitly:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: data-platform
  namespace: argocd
spec:
  description: "Data engineering platform — all environments"
  sourceRepos:
    - "https://github.com/acme-corp/data-platform"
    - "https://github.com/acme-corp/data-platform-config"

  destinations:
    # Development — any namespace
    - server: https://dev.k8s.acme.internal:6443
      namespace: "*"
    # Staging — specific namespaces only
    - server: https://staging.k8s.acme.internal:6443
      namespace: "data-*"
    # Production — locked down to specific namespaces
    - server: https://prod.k8s.acme.internal:6443
      namespace: data-prod
    - server: https://prod.k8s.acme.internal:6443
      namespace: data-prod-workers

  clusterResourceWhitelist:
    - group: "storage.k8s.io"
      kind: StorageClass

  roles:
    - name: data-developer
      policies:
        - p, proj:data-platform:data-developer, applications, *, data-platform/dev-*, allow
        - p, proj:data-platform:data-developer, applications, get, data-platform/staging-*, allow
        - p, proj:data-platform:data-developer, applications, sync, data-platform/staging-*, allow
        - p, proj:data-platform:data-developer, applications, *, data-platform/prod-*, deny
      groups:
        - data-engineers

    - name: data-release-manager
      policies:
        - p, proj:data-platform:data-release-manager, applications, *, data-platform/*, allow
      groups:
        - data-platform-release-managers
```

## Configuring OIDC Integration for Group-Based RBAC

### Dex Configuration (Built-in OIDC Proxy)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  url: "https://argocd.acme.internal"
  dex.config: |
    connectors:
      - type: microsoft
        id: microsoft
        name: Acme Corp AD
        config:
          clientID: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
          clientSecret: $dex-microsoft-client-secret
          tenant: "acme-corp.onmicrosoft.com"
          redirectURI: "https://argocd.acme.internal/api/dex/callback"
          groups:
            - platform-engineering
            - payments-developers
            - payments-leads
            - payments-architects
            - data-engineers
            - data-platform-release-managers
            - sre-oncall
          useGroupsAsRoles: false
          groupNameFormat: "name"
```

### Direct OIDC Without Dex (Okta)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  url: "https://argocd.acme.internal"
  oidc.config: |
    name: Okta
    issuer: https://acme.okta.com/oauth2/ausXXXXXXXXXXXXXX/v1
    clientID: 0oa1b2c3d4e5f6g7h8i9
    clientSecret: $oidc.okta.clientSecret
    requestedScopes:
      - openid
      - profile
      - email
      - groups
    requestedIDTokenClaims:
      groups:
        essential: true
    logoutURL: "https://acme.okta.com/oauth2/ausXXXXXXXXXXXXXX/v1/logout?id_token_hint={{token}}&post_logout_redirect_uri=https://argocd.acme.internal"
```

Then in `argocd-rbac-cm`:

```yaml
data:
  policy.default: role:readonly
  scopes: '[groups, email]'
  policy.csv: |
    g, "payments-developers", proj:payments-team:payments-developer
    g, "payments-leads", proj:payments-team:payments-lead
    g, "data-engineers", proj:data-platform:data-developer
    g, "data-platform-release-managers", proj:data-platform:data-release-manager
    g, "platform-engineering", role:platform-admin
    g, "sre-oncall", role:global-viewer
```

## ApplicationSet with Project Constraints

When using ApplicationSets to template many apps, bind each generated Application to the correct project:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-services
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/acme-corp/payments-platform-config
        revision: main
        directories:
          - path: "services/*"
  template:
    metadata:
      name: "payments-{{path.basename}}"
    spec:
      project: payments-team
      source:
        repoURL: https://github.com/acme-corp/payments-platform-config
        targetRevision: main
        path: "{{path}}"
      destination:
        server: https://prod-payments.k8s.acme.internal:6443
        namespace: payments-prod
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=false
          - PrunePropagationPolicy=foreground
          - PruneLast=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

## Resource Exclusions and Inclusions at the Global Level

Some resources (like `Event`, `EndpointSlice`) generate excessive API traffic. Exclude them globally:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.exclusions: |
    - apiGroups:
        - ""
      kinds:
        - Event
        - EndpointSlice
      clusters:
        - "*"
    - apiGroups:
        - "metrics.k8s.io"
      kinds:
        - "*"
      clusters:
        - "*"
    - apiGroups:
        - "kyverno.io"
      kinds:
        - AdmissionReport
        - BackgroundScanReport
        - ClusterAdmissionReport
        - ClusterBackgroundScanReport
      clusters:
        - "*"
  resource.inclusions: |
    - apiGroups:
        - "argoproj.io"
      kinds:
        - "*"
      clusters:
        - "*"
```

## Auditing and Compliance

### Verifying Effective Permissions

Use the ArgoCD CLI `proj role` subcommands to inspect effective permissions:

```bash
# List all roles in a project
argocd proj role list payments-team

# Show the token list for a role
argocd proj role list-tokens payments-team payments-developer

# Test RBAC policy with argocd-util
argocd-util rbac validate \
  --policy-file /tmp/policy.csv \
  --policy-csv-strict

# Can "payments-developers" group sync production apps?
argocd-util rbac can \
  payments-developers \
  sync \
  applications \
  'payments-team/payments-api-prod'
```

### Exporting Project and RBAC Configuration

```bash
#!/bin/bash
# Export all AppProjects and RBAC config for audit trail
set -euo pipefail

EXPORT_DIR="/tmp/argocd-audit-$(date +%Y%m%d)"
mkdir -p "${EXPORT_DIR}"

# Export all AppProjects
kubectl get appprojects -n argocd -o yaml > "${EXPORT_DIR}/appprojects.yaml"

# Export RBAC ConfigMaps
kubectl get configmap argocd-rbac-cm -n argocd -o yaml > "${EXPORT_DIR}/argocd-rbac-cm.yaml"
kubectl get configmap argocd-cm -n argocd -o yaml > "${EXPORT_DIR}/argocd-cm.yaml"

# Export ApplicationSets
kubectl get applicationsets -n argocd -o yaml > "${EXPORT_DIR}/applicationsets.yaml"

echo "Audit export complete: ${EXPORT_DIR}"
```

## Sync Windows for Change Management Integration

Sync windows integrate ArgoCD with enterprise change management workflows:

```yaml
# In AppProject spec
syncWindows:
  # Block all automated syncs during business hours
  - kind: deny
    schedule: "0 9 * * 1-5"
    duration: 8h
    applications:
      - "*"
    namespaces:
      - "*"
    clusters:
      - "*"
    manualSync: false  # Block even manual syncs

  # Allow automated syncs during maintenance windows
  - kind: allow
    schedule: "0 2 * * 2,4"
    duration: 2h
    applications:
      - "*"
    namespaces:
      - payments-prod
    clusters:
      - https://prod-payments.k8s.acme.internal:6443
    manualSync: true

  # Emergency exception — manual syncs always allowed for hotfixes
  - kind: allow
    schedule: "* * * * *"
    duration: 525960h  # Effectively forever
    applications:
      - "*-hotfix"
    namespaces:
      - "*"
    clusters:
      - "*"
    manualSync: true
```

## Common Misconfigurations and Remediation

### Wildcard Source Repository Bypass

**Problem:** Setting `sourceRepos: ["*"]` on an AppProject defeats the purpose of project isolation. Any user with access to the project can deploy from any repository, including external ones that may contain malicious Helm charts.

**Remediation:**

```bash
# Find all AppProjects with wildcard source repos
kubectl get appprojects -n argocd -o json | \
  jq -r '.items[] | select(.spec.sourceRepos[] == "*") | .metadata.name'
```

Fix by enumerating allowed repositories explicitly.

### ClusterResourceWhitelist Escalation

**Problem:** Allowing `ClusterRole` or `ClusterRoleBinding` creation in an AppProject grants effective cluster-admin escalation to any team member who can commit to the GitOps repository.

**Remediation:**

```bash
# Audit ClusterResourceWhitelist entries across all projects
kubectl get appprojects -n argocd -o json | \
  jq -r '.items[] |
    .metadata.name as $proj |
    .spec.clusterResourceWhitelist[]? |
    select(.kind == "ClusterRole" or .kind == "ClusterRoleBinding") |
    [$proj, .group, .kind] | join(" | ")'
```

### Destination Namespace Wildcard on Production Clusters

**Problem:** `namespace: "*"` on a production cluster server allows teams to deploy to `kube-system` and other sensitive namespaces.

```bash
# Find AppProjects with wildcard namespace on non-dev clusters
kubectl get appprojects -n argocd -o json | \
  jq -r '.items[] |
    .metadata.name as $proj |
    .spec.destinations[]? |
    select(.namespace == "*" and (.server | test("prod|prd|stg|staging"))) |
    [$proj, .server, .namespace] | join(" | ")'
```

## Helm-Based AppProject Management with Gitops

Managing AppProjects via Helm charts ensures version-controlled, reviewable changes to permission boundaries:

```yaml
# helm/argocd-projects/templates/payments-team.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: {{ .Release.Name }}-payments
  namespace: {{ .Values.argocd.namespace | default "argocd" }}
  annotations:
    project.argoproj.io/team: payments
    project.argoproj.io/owner: payments-platform@acme.internal
    project.argoproj.io/security-tier: "pci"
spec:
  description: {{ .Values.payments.description | quote }}
  sourceRepos:
    {{- range .Values.payments.sourceRepos }}
    - {{ . | quote }}
    {{- end }}
  destinations:
    {{- range .Values.payments.destinations }}
    - server: {{ .server | quote }}
      namespace: {{ .namespace | quote }}
    {{- end }}
  clusterResourceBlacklist:
    {{- toYaml .Values.global.clusterResourceBlacklist | nindent 4 }}
  namespaceResourceWhitelist:
    {{- toYaml .Values.payments.namespaceResourceWhitelist | nindent 4 }}
```

## Summary

ArgoCD's RBAC system provides production-grade multi-tenancy when configured correctly:

- **AppProject** defines _scope_: what repos, clusters, and namespaces a team can target, and what Kubernetes resource types they can manage
- **RBAC policies** in `argocd-rbac-cm` define _capability_: what ArgoCD operations each user or group can perform
- **Sync windows** integrate with change management, preventing unauthorized deployments outside approved maintenance windows
- **SSO group mapping** eliminates manual role assignment and ensures access tracks HR/identity system changes automatically
- **Resource whitelists over blacklists** is the safer posture for namespace-scoped permissions in projects that do not require cluster-scoped resource management

Regular audits using `argocd-util rbac can` and automated scanning of AppProject configurations for wildcards should be part of every enterprise platform team's security runbook.
