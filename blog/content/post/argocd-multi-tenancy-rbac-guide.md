---
title: "Argo CD Multi-Tenancy: RBAC, Projects, and Access Control at Scale"
date: 2028-03-18T00:00:00-05:00
draft: false
tags: ["Argo CD", "GitOps", "RBAC", "Multi-Tenancy", "Kubernetes", "Platform Engineering", "SSO"]
categories: ["GitOps", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Argo CD multi-tenancy using AppProjects, RBAC policy syntax, SSO with Dex and LDAP/OIDC, CI automation tokens, ApplicationSets with cluster generators, and namespace isolation patterns at enterprise scale."
more_link: "yes"
url: "/argocd-multi-tenancy-rbac-guide/"
---

Running a shared Argo CD instance for multiple teams is operationally efficient but introduces risk: without proper access controls, one team can deploy to another team's namespace, view secrets across project boundaries, or trigger rollbacks in production from a development account. The AppProject CRD and Argo CD's RBAC engine together provide the isolation and access control primitives needed to safely serve multiple tenants from a single control plane.

This guide covers AppProject configuration, RBAC policy authoring, SSO integration with Dex, CI automation patterns, ApplicationSet cluster fleet management, and namespace isolation strategies.

<!--more-->

## AppProject: The Tenancy Boundary

Every Argo CD Application belongs to a project. AppProjects define:
- Which Git repositories are allowed as sources
- Which clusters and namespaces are allowed as destinations
- Which Kubernetes resource kinds are permitted to be deployed
- Which cluster-scoped resources are allowed

### AppProject Configuration

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-alpha
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io  # Prevents deletion with active apps
spec:
  description: "Team Alpha microservices deployment project"

  # Source repositories team-alpha may deploy from
  sourceRepos:
    - "https://github.com/support-tools/team-alpha-apps.git"
    - "https://github.com/support-tools/shared-charts.git"
    - "registry.support.tools/helm/*"  # OCI Helm charts

  # Target clusters and namespaces
  destinations:
    - server: "https://k8s-production.support.tools:6443"
      namespace: "prod-team-alpha"
    - server: "https://k8s-staging.support.tools:6443"
      namespace: "staging-team-alpha"
    - server: "https://kubernetes.default.svc"  # in-cluster
      namespace: "dev-team-alpha"

  # Cluster-scoped resources team-alpha CANNOT manage
  clusterResourceBlacklist:
    - group: ""
      kind: Namespace  # Teams cannot create namespaces directly
    - group: rbac.authorization.k8s.io
      kind: ClusterRole
    - group: rbac.authorization.k8s.io
      kind: ClusterRoleBinding
    - group: admissionregistration.k8s.io
      kind: ValidatingWebhookConfiguration
    - group: admissionregistration.k8s.io
      kind: MutatingWebhookConfiguration

  # Namespace-scoped resources this project can manage
  namespaceResourceWhitelist:
    - group: apps
      kind: Deployment
    - group: apps
      kind: StatefulSet
    - group: apps
      kind: DaemonSet
    - group: ""
      kind: Service
    - group: ""
      kind: ConfigMap
    - group: ""
      kind: ServiceAccount
    - group: networking.k8s.io
      kind: Ingress
    - group: autoscaling
      kind: HorizontalPodAutoscaler

  # Or use blacklist approach instead (allow all except listed)
  # namespaceResourceBlacklist:
  #   - group: ""
  #     kind: ResourceQuota
  #   - group: ""
  #     kind: LimitRange

  # Sync windows — restrict when automated sync is allowed
  syncWindows:
    - kind: allow
      schedule: "10 1 * * *"  # 1:10 AM UTC daily
      duration: 1h
      applications:
        - "*"
      timeZone: "America/New_York"
    - kind: deny
      schedule: "0 9 * * 5"  # Friday 9 AM — freeze deployments before weekend
      duration: 72h
      applications:
        - "*"
      manualSync: false  # Allow manual override

  # Project-level RBAC roles (additive to global RBAC)
  roles:
    - name: developer
      description: "Can sync non-production applications"
      policies:
        - p, proj:team-alpha:developer, applications, get, team-alpha/*, allow
        - p, proj:team-alpha:developer, applications, create, team-alpha/*, allow
        - p, proj:team-alpha:developer, applications, update, team-alpha/*, allow
        - p, proj:team-alpha:developer, applications, sync, team-alpha/dev-*, allow
      groups:
        - "ldap:team-alpha-developers"
    - name: deployer
      description: "CI/CD automation role — can sync any application"
      policies:
        - p, proj:team-alpha:deployer, applications, sync, team-alpha/*, allow
        - p, proj:team-alpha:deployer, applications, get, team-alpha/*, allow
```

### Orphan Resources Policy

```yaml
spec:
  orphanedResources:
    warn: true   # Emit warnings for resources not managed by any app
    ignore:
      - group: ""
        kind: ConfigMap
        name: kube-root-ca.crt  # Kubernetes-managed configmap
```

## RBAC Policy Syntax

Argo CD uses Casbin for RBAC. Policy rules follow the pattern:

```
p, <subject>, <resource>, <action>, <object>, <effect>
g, <user/group>, <role>
```

Where:
- **subject**: a username, SSO group, or role name
- **resource**: applications, applicationsets, clusters, repositories, projects, accounts, gpgkeys, logs, exec
- **action**: get, create, update, delete, sync, override, action, invoke
- **object**: `<project>/<app-name>` for applications, `*` for wildcard

### Global RBAC Configuration

```yaml
# argocd-rbac-cm ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly   # All authenticated users start with read-only
  policy.csv: |
    # Platform admin — full access to everything
    g, platform-admins, role:admin

    # Read-only access for all authenticated users (overridden by explicit rules below)
    p, role:readonly, applications, get, */*, allow
    p, role:readonly, clusters, get, *, allow
    p, role:readonly, repositories, get, *, allow
    p, role:readonly, projects, get, *, allow

    # Application operator — can sync but not modify app definitions
    p, role:app-operator, applications, get, */*, allow
    p, role:app-operator, applications, sync, */*, allow
    p, role:app-operator, applications, action/*, */*, allow

    # Team-level role assignments via LDAP groups
    g, ldap:platform-team, role:admin
    g, ldap:sre-team, role:app-operator

    # Per-project assignments
    g, ldap:team-alpha-lead, proj:team-alpha:developer
    g, ldap:team-alpha-ci, proj:team-alpha:deployer

    # Specific user overrides
    g, jane.smith@support.tools, proj:team-beta:developer

  # Use LDAP group membership as the group claim
  scopes: "[groups, email]"
```

## SSO Integration with Dex

Dex acts as an OIDC identity broker, federating authentication from LDAP, GitHub, Google, or any OIDC provider into Argo CD.

### Dex Configuration for LDAP

```yaml
# argocd-cm ConfigMap — Dex connector configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  url: "https://argocd.support.tools"

  dex.config: |
    connectors:
      - type: ldap
        id: ldap
        name: Corporate LDAP
        config:
          host: ldap.support.tools:636
          insecureNoSSL: false
          insecureSkipVerify: false
          rootCA: /etc/ssl/certs/corporate-ca.crt
          bindDN: "cn=argocd-bind,ou=service-accounts,dc=support,dc=tools"
          bindPW: "$LDAP_BIND_PASSWORD"  # Injected from secret
          usernamePrompt: "Corporate Email"
          userSearch:
            baseDN: "ou=users,dc=support,dc=tools"
            filter: "(objectClass=person)"
            username: mail
            idAttr: mail
            emailAttr: mail
            nameAttr: cn
          groupSearch:
            baseDN: "ou=groups,dc=support,dc=tools"
            filter: "(objectClass=groupOfNames)"
            userMatchers:
              - userAttr: DN
                groupAttr: member
            nameAttr: cn

    # Additional OIDC connector for external teams
    - type: oidc
      id: google
        name: Google Workspace
        config:
          issuer: "https://accounts.google.com"
          clientID: "oauth2-client-id-here"
          clientSecret: "$GOOGLE_OIDC_SECRET"
          redirectURI: "https://argocd.support.tools/api/dex/callback"
          scopes:
            - openid
            - email
            - profile
            - https://www.googleapis.com/auth/cloud-identity.groups.readonly
          userIDKey: email
          userNameKey: email
          claimMapping:
            groups: "groups"
```

### Dex LDAP Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: argocd-dex-server
  namespace: argocd
type: Opaque
stringData:
  LDAP_BIND_PASSWORD: "placeholder-replace-at-deploy-time"
  GOOGLE_OIDC_SECRET: "placeholder-replace-at-deploy-time"
```

## CI/CD Automation with Project Tokens

Project roles with JWT tokens allow CI pipelines to authenticate without a user account:

```bash
# Create a token for the deployer role in team-alpha project
argocd proj role create-token team-alpha deployer \
  --token-only \
  --expires-in 8760h  # 1 year; use shorter TTLs with rotation

# Store in CI/CD secrets manager, never in source code
# Use the token:
ARGOCD_AUTH_TOKEN="<token>" argocd app sync team-alpha/order-service \
  --server argocd.support.tools \
  --grpc-web

# Or via HTTP API
curl -X POST "https://argocd.support.tools/api/v1/applications/team-alpha-order-service/sync" \
  -H "Authorization: Bearer ${ARGOCD_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"revision": "v2.3.1"}'
```

### GitHub Actions Integration

```yaml
# .github/workflows/deploy.yaml
name: Deploy to Production

on:
  push:
    tags:
      - 'v*'

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Sync Argo CD Application
        run: |
          curl -sSL -o /usr/local/bin/argocd \
            https://github.com/argoproj/argo-cd/releases/download/v2.10.0/argocd-linux-amd64
          chmod +x /usr/local/bin/argocd

          argocd app sync team-alpha/order-service \
            --server argocd.support.tools \
            --auth-token "${{ secrets.ARGOCD_TOKEN }}" \
            --grpc-web \
            --timeout 300 \
            --revision "${{ github.ref_name }}"

          argocd app wait team-alpha/order-service \
            --server argocd.support.tools \
            --auth-token "${{ secrets.ARGOCD_TOKEN }}" \
            --grpc-web \
            --health \
            --timeout 300
```

## ApplicationSet for Fleet Management

ApplicationSet generates Application objects from templates, enabling consistent deployment across many clusters.

### Cluster Generator

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-services
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            argocd.argoproj.io/secret-type: cluster
            environment: production
        # Inject cluster metadata as template variables
        values:
          region: "{{metadata.annotations['cluster.support.tools/region']}}"
          tier: "{{metadata.annotations['cluster.support.tools/tier']}}"

  template:
    metadata:
      name: "{{name}}-platform-services"
      namespace: argocd
      labels:
        cluster: "{{name}}"
        environment: "production"
    spec:
      project: platform-ops
      source:
        repoURL: "https://github.com/support-tools/platform-charts.git"
        targetRevision: HEAD
        path: "platform-services"
        helm:
          valueFiles:
            - "values/common.yaml"
            - "values/regions/{{values.region}}.yaml"
          parameters:
            - name: cluster.name
              value: "{{name}}"
            - name: cluster.server
              value: "{{server}}"
      destination:
        server: "{{server}}"
        namespace: platform-system
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

### Git Directory Generator

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: team-apps
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          - git:
              repoURL: "https://github.com/support-tools/app-catalog.git"
              revision: HEAD
              directories:
                - path: "teams/*/apps/*"
              # Extracts: team=alpha, app=order-service from path structure
          - clusters:
              selector:
                matchExpressions:
                  - key: "environment"
                    operator: In
                    values: ["production", "staging"]

  template:
    metadata:
      name: "{{path.basenameNormalized}}-{{name}}"
    spec:
      project: "{{path[1]}}"  # team name from path segment
      source:
        repoURL: "https://github.com/support-tools/app-catalog.git"
        targetRevision: HEAD
        path: "{{path}}"
        helm:
          valueFiles:
            - values.yaml
            - "values-{{metadata.labels.environment}}.yaml"
      destination:
        server: "{{server}}"
        namespace: "{{metadata.labels.environment}}-{{path[1]}}"
```

## Audit Logging

```yaml
# Enable Argo CD audit logging
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  # Log all API calls to stdout (pick up by log aggregator)
  server.log.level: "info"
  server.log.format: "json"
```

Parse audit events in Loki:

```logql
# All sync operations in the last hour
{namespace="argocd"} |= "action=sync"
  | json
  | line_format "{{.time}} user={{.user}} app={{.application}} project={{.project}} action={{.action}}"

# Failed operations by user
{namespace="argocd"} |= "result=failed"
  | json
  | by_label_values("user")
```

## Namespace Isolation Patterns

### Argo CD Managed Namespaces (v2.5+)

```yaml
# Enable Argo CD to manage specific namespaces without cluster-admin
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  application.namespaces: "prod-team-*,staging-team-*,dev-team-*"
```

```yaml
# Grant Argo CD permission to manage the target namespace
# Apply this to each managed namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: argocd-application-controller
  namespace: prod-team-alpha
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
  - kind: ServiceAccount
    name: argocd-application-controller
    namespace: argocd
```

### AppProject Namespace Binding

```yaml
# Applications in this project can only be created in specific namespaces
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-alpha
  namespace: argocd
spec:
  sourceNamespaces:
    - prod-team-alpha   # Application objects must live in this namespace
    - staging-team-alpha
```

```yaml
# Team-alpha's Application lives in their namespace, not argocd
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: order-service
  namespace: prod-team-alpha  # Not the argocd namespace
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: team-alpha
  # ...
```

## Resource Tracking Customization

```yaml
# argocd-cm resource tracking mode
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # "label" (default) vs "annotation" vs "annotation+label"
  application.resourceTrackingMethod: "annotation+label"
  # annotation+label is recommended for clusters with many applications
  # to avoid label selector conflicts
```

## Production Checklist

```
AppProject Configuration
[ ] sourceRepos allowlist explicitly enumerates permitted repositories
[ ] destinations restrict to team namespaces only
[ ] clusterResourceBlacklist prevents namespace/RBAC creation by tenants
[ ] syncWindows block deployments during freeze periods
[ ] orphanedResources.warn enabled to detect drift

RBAC
[ ] policy.default is role:readonly (never empty, never admin)
[ ] LDAP/OIDC group claims used for role assignments
[ ] Project-level roles for fine-grained access within teams
[ ] CI tokens use project-scoped deployer role, not admin

SSO
[ ] Dex LDAP bind password stored in Kubernetes secret, not ConfigMap
[ ] TLS configured for LDAP connection (port 636)
[ ] Token expiry and rotation policy documented

ApplicationSet
[ ] Cluster secrets labeled correctly for cluster generators
[ ] Progressive sync enabled to roll out to clusters sequentially
[ ] ignoreDifferences configured for fields that drift (replicas, image tags)

Operations
[ ] Audit logs shipped to centralized log aggregation
[ ] Alerts on sync failure rates and health degradation
[ ] Application self-healing enabled for drift correction
[ ] Resource hook policies reviewed for sensitive operations
```

A properly configured Argo CD multi-tenancy model provides hard isolation between teams while enabling a self-service deployment experience. Platform teams manage the AppProject boundaries and RBAC policies; application teams operate within those boundaries with the same GitOps workflows regardless of the number of clusters they target.
