---
title: "Multi-Tenant GitOps with ArgoCD: Enterprise Isolation and Automation"
date: 2027-11-27T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "Multi-Tenant", "Kubernetes", "Automation"]
categories:
- Kubernetes
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing multi-tenant GitOps with ArgoCD, covering Projects for tenant isolation, ApplicationSet generators, RBAC, SSO integration, app-of-apps patterns, sync waves, and automated drift detection."
more_link: "yes"
url: "/gitops-multi-tenant-argocd-guide/"
---

Running ArgoCD in a multi-tenant environment introduces unique challenges around isolation, access control, and automation. Without proper tenant separation, teams can accidentally deploy to each other's namespaces, administrative access leaks beyond intended boundaries, and the complexity of managing hundreds of applications becomes unmanageable. This guide covers the enterprise patterns that make multi-tenant ArgoCD scalable and secure.

<!--more-->

# Multi-Tenant GitOps with ArgoCD: Enterprise Isolation and Automation

## ArgoCD Architecture for Multi-Tenancy

ArgoCD's multi-tenancy model is built on three primary constructs:

- **AppProject**: Defines what repositories a tenant can deploy from, what clusters and namespaces they can deploy to, and what Kubernetes resources are allowed
- **Application**: A single deployment unit owned by a project
- **ApplicationSet**: A controller that generates Applications from templates using dynamic data sources

The key insight is that Projects are the security boundary. An Application in Project A cannot accidentally deploy to a namespace restricted to Project B, even if the ArgoCD admin makes a configuration mistake.

## Section 1: AppProject Configuration for Tenant Isolation

### Basic Tenant Project

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-payments
  namespace: argocd
  finalizers:
  - resources-finalizer.argocd.argoproj.io
spec:
  description: "Payments team - owns payments and billing services"

  # Which Git repos this project can deploy from
  sourceRepos:
  - "https://github.com/acme-corp/payments-services"
  - "https://github.com/acme-corp/shared-charts"
  - "registry.acme.corp/helm/*"

  # Which clusters and namespaces this project can deploy to
  destinations:
  - server: "https://production-cluster.acme.corp"
    namespace: "payments"
  - server: "https://production-cluster.acme.corp"
    namespace: "billing"
  - server: "https://staging-cluster.acme.corp"
    namespace: "payments-staging"
  - server: "https://staging-cluster.acme.corp"
    namespace: "billing-staging"
  # Wildcard namespace for dev cluster only
  - server: "https://dev-cluster.acme.corp"
    namespace: "payments-*"

  # Kubernetes resources this project can manage
  # Start restrictive and add as needed
  clusterResourceWhitelist:
  - group: ""
    kind: Namespace
  - group: "rbac.authorization.k8s.io"
    kind: ClusterRole
  - group: "rbac.authorization.k8s.io"
    kind: ClusterRoleBinding

  # Namespace-scoped resources (most common)
  namespaceResourceWhitelist:
  - group: "*"
    kind: "*"

  # Block specific dangerous resources
  namespaceResourceBlacklist:
  - group: ""
    kind: ResourceQuota
  - group: ""
    kind: LimitRange

  # Orphaned resources monitoring
  orphanedResources:
    warn: true
    ignore:
    - group: ""
      kind: ConfigMap
      name: kube-root-ca.crt

  # Sync windows - prevent deployments during business hours in production
  syncWindows:
  - kind: deny
    schedule: "0 9 * * 1-5"
    duration: 8h
    applications:
    - "*"
    namespaces:
    - payments
    - billing
    clusters:
    - "https://production-cluster.acme.corp"
    manualSync: true  # Allow manual override

  - kind: allow
    schedule: "0 18 * * 1-5"
    duration: 4h
    applications:
    - "*"

  # Roles for this project
  roles:
  - name: developer
    description: "Developers can view and sync applications"
    policies:
    - "p, proj:team-payments:developer, applications, get, team-payments/*, allow"
    - "p, proj:team-payments:developer, applications, sync, team-payments/*, allow"
    - "p, proj:team-payments:developer, applications, override, team-payments/*, allow"
    groups:
    - payments-team

  - name: deployer
    description: "CI/CD can create and update applications"
    policies:
    - "p, proj:team-payments:deployer, applications, *, team-payments/*, allow"
    groups:
    - payments-ci-service-accounts

  - name: viewer
    description: "Read-only access for auditors"
    policies:
    - "p, proj:team-payments:viewer, applications, get, team-payments/*, allow"
    groups:
    - security-audit-team
```

### Namespace-Based Tenant Isolation

For large organizations, each team gets their own ArgoCD namespace:

```yaml
# Create dedicated ArgoCD namespace for team
apiVersion: v1
kind: Namespace
metadata:
  name: argocd-payments-team
  labels:
    argocd.argoproj.io/managed-by: argocd
---
# Grant ArgoCD server access to manage this namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: argocd-server-payments
  namespace: argocd-payments-team
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
- kind: ServiceAccount
  name: argocd-server
  namespace: argocd
```

## Section 2: ApplicationSet Generators

ApplicationSet is the declarative way to manage hundreds of Applications without manual repetition. It uses generators to produce Application manifests from data sources.

### Cluster Generator

Deploy the same application to multiple clusters automatically:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-api-all-clusters
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]

  generators:
  - clusters:
      selector:
        matchLabels:
          environment: production
          region: us-east-1
      # Pass cluster metadata as template variables
      values:
        revision: "main"
        replicas: "3"

  template:
    metadata:
      name: "payments-api-{{.name}}"
      labels:
        app: payments-api
        cluster: "{{.name}}"
    spec:
      project: team-payments
      source:
        repoURL: "https://github.com/acme-corp/payments-services"
        targetRevision: "{{.values.revision}}"
        path: "charts/payments-api"
        helm:
          valueFiles:
          - "values.yaml"
          - "values-{{.metadata.labels.environment}}.yaml"
          parameters:
          - name: replicaCount
            value: "{{.values.replicas}}"
          - name: image.tag
            value: "{{.metadata.annotations.deployedVersion}}"
      destination:
        server: "{{.server}}"
        namespace: payments
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
        - PrunePropagationPolicy=foreground
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

### Git Generator - Directory-Based

Generate one Application per directory in a Git repository:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: microservices-git-dir
  namespace: argocd
spec:
  goTemplate: true

  generators:
  - git:
      repoURL: "https://github.com/acme-corp/platform-apps"
      revision: HEAD
      directories:
      - path: "services/*/production"
      - path: "services/*/staging"
      # Exclude directories that are not deployable
      - path: "services/deprecated/*"
        exclude: true

  template:
    metadata:
      # Extract service name and environment from path
      name: "{{.path.basename}}"
      annotations:
        argocd.argoproj.io/manifest-generate-paths: "{{.path}}"
    spec:
      project: platform
      source:
        repoURL: "https://github.com/acme-corp/platform-apps"
        targetRevision: HEAD
        path: "{{.path.path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{index .path.segments 1}}-{{index .path.segments 2}}"
      syncPolicy:
        automated:
          prune: false
          selfHeal: true
```

### Git Generator - File-Based

Use JSON/YAML config files as application definitions:

```yaml
# apps/team-payments/payments-api.json
# {
#   "service": "payments-api",
#   "environment": "production",
#   "namespace": "payments",
#   "cluster": "us-east-1-prod",
#   "imageTag": "v2.3.1",
#   "replicas": 5
# }

apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: file-based-apps
  namespace: argocd
spec:
  goTemplate: true

  generators:
  - git:
      repoURL: "https://github.com/acme-corp/app-registry"
      revision: HEAD
      files:
      - path: "apps/*/*.json"

  template:
    metadata:
      name: "{{.service}}-{{.environment}}"
    spec:
      project: "team-{{.team}}"
      source:
        repoURL: "https://github.com/acme-corp/services"
        targetRevision: "{{.imageTag}}"
        path: "charts/{{.service}}"
        helm:
          parameters:
          - name: replicaCount
            value: "{{.replicas}}"
          - name: image.tag
            value: "{{.imageTag}}"
      destination:
        name: "{{.cluster}}"
        namespace: "{{.namespace}}"
```

### Matrix Generator - Cross-Product

The matrix generator creates the Cartesian product of two generators. Use it to deploy all services to all environments:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: services-all-environments
  namespace: argocd
spec:
  goTemplate: true

  generators:
  - matrix:
      generators:
      # First generator: list of environments
      - list:
          elements:
          - environment: dev
            cluster: dev-cluster
            namespace_suffix: "-dev"
            auto_sync: "true"
            replicas: "1"
          - environment: staging
            cluster: staging-cluster
            namespace_suffix: "-staging"
            auto_sync: "true"
            replicas: "2"
          - environment: production
            cluster: prod-cluster
            namespace_suffix: ""
            auto_sync: "false"
            replicas: "5"
      # Second generator: services from Git
      - git:
          repoURL: "https://github.com/acme-corp/platform"
          revision: HEAD
          directories:
          - path: "services/*"

  template:
    metadata:
      name: "{{.path.basename}}-{{.environment}}"
    spec:
      project: platform
      source:
        repoURL: "https://github.com/acme-corp/platform"
        targetRevision: "{{if eq .environment \"production\"}}main{{else}}{{.environment}}{{end}}"
        path: "services/{{.path.basename}}/chart"
        helm:
          valueFiles:
          - values.yaml
          - "values-{{.environment}}.yaml"
          parameters:
          - name: replicaCount
            value: "{{.replicas}}"
          - name: environment
            value: "{{.environment}}"
      destination:
        name: "{{.cluster}}"
        namespace: "{{.path.basename}}{{.namespace_suffix}}"
      syncPolicy:
        automated:
          prune: "{{eq .auto_sync \"true\"}}"
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

### SCM Provider Generator - GitHub Organizations

Generate Applications from all repositories in a GitHub organization:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: github-org-apps
  namespace: argocd
spec:
  goTemplate: true

  generators:
  - scmProvider:
      github:
        organization: acme-corp
        # Only repos with this topic tag
        allBranches: false
      filters:
      - repositoryMatch: "^svc-.*"
        branchMatch: "^main$"
        pathsExist:
        - "chart/Chart.yaml"

  template:
    metadata:
      name: "{{.repository}}-{{.branch}}"
    spec:
      project: platform
      source:
        repoURL: "{{.url}}"
        targetRevision: "{{.branch}}"
        path: chart
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{.repository}}"
```

## Section 3: RBAC Configuration

ArgoCD RBAC controls what users and service accounts can do with Applications and AppProjects.

### RBAC Policy Structure

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: "role:readonly"
  policy.csv: |
    # Platform administrators - full access
    p, role:admin, applications, *, */*, allow
    p, role:admin, clusters, *, *, allow
    p, role:admin, repositories, *, *, allow
    p, role:admin, projects, *, *, allow
    p, role:admin, accounts, *, *, allow
    p, role:admin, gpgkeys, *, *, allow
    p, role:admin, logs, get, */*, allow
    p, role:admin, exec, create, */*, allow

    # Team lead role - manage own project applications
    p, role:team-lead, applications, get, */*, allow
    p, role:team-lead, applications, create, */*, allow
    p, role:team-lead, applications, update, */*, allow
    p, role:team-lead, applications, delete, */*, allow
    p, role:team-lead, applications, sync, */*, allow
    p, role:team-lead, applications, override, */*, allow
    p, role:team-lead, repositories, get, *, allow
    p, role:team-lead, projects, get, *, allow

    # Developer role - sync and view
    p, role:developer, applications, get, */*, allow
    p, role:developer, applications, sync, */*, allow
    p, role:developer, applications, override, */*, allow
    p, role:developer, logs, get, */*, allow
    p, role:developer, repositories, get, *, allow

    # Read-only auditor
    p, role:auditor, applications, get, */*, allow
    p, role:auditor, clusters, get, *, allow
    p, role:auditor, repositories, get, *, allow
    p, role:auditor, projects, get, *, allow
    p, role:auditor, logs, get, */*, allow

    # CI service account - deploy to specific projects
    p, role:ci-deployer, applications, get, team-payments/*, allow
    p, role:ci-deployer, applications, create, team-payments/*, allow
    p, role:ci-deployer, applications, update, team-payments/*, allow
    p, role:ci-deployer, applications, sync, team-payments/*, allow

    # Group to role mappings (SSO groups)
    g, platform-admins, role:admin
    g, payments-team-leads, role:team-lead
    g, payments-developers, role:developer
    g, security-auditors, role:auditor
    g, payments-ci, role:ci-deployer

  scopes: "[groups, email]"
```

### Project-Level RBAC

Project roles provide fine-grained control within a specific project:

```yaml
# In AppProject spec.roles:
roles:
- name: production-deployer
  description: "Can deploy to production - requires 2FA"
  policies:
  - "p, proj:team-payments:production-deployer, applications, sync, team-payments/payments-api-prod, allow"
  - "p, proj:team-payments:production-deployer, applications, get, team-payments/*, allow"
  # JWTs for this role expire after 1 hour
  jwtTokens:
  - iat: 1694000000
    exp: 1694003600
    id: prod-deploy-token-v1

- name: staging-deployer
  description: "Can deploy to staging freely"
  policies:
  - "p, proj:team-payments:staging-deployer, applications, *, team-payments/*-staging, allow"
  - "p, proj:team-payments:staging-deployer, applications, get, team-payments/*, allow"
  groups:
  - payments-developers
  - payments-ci-service-accounts
```

## Section 4: SSO Integration with Dex and OIDC

### Dex Configuration for OIDC Federation

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # Application URL for OIDC callbacks
  url: "https://argocd.acme.corp"

  # Dex OIDC configuration
  dex.config: |
    connectors:
    # GitHub OAuth connector
    - type: github
      id: github
      name: GitHub
      config:
        clientID: $GITHUB_CLIENT_ID
        clientSecret: $GITHUB_CLIENT_SECRET
        redirectURI: https://argocd.acme.corp/api/dex/callback
        orgs:
        - name: acme-corp
          teams:
          - platform-admins
          - payments-team
          - security-audit
        # Load GitHub org teams as groups
        loadAllGroups: false
        teamNameField: slug
        useLoginAsID: false

    # Okta SAML connector
    - type: saml
      id: okta
      name: Okta SSO
      config:
        ssoURL: https://acme.okta.com/app/saml/123456/sso/saml
        caData: LS0tLS1CRUdJTi...
        redirectURI: https://argocd.acme.corp/api/dex/callback
        usernameAttr: email
        emailAttr: email
        groupsAttr: groups
        nameIDPolicyFormat: emailAddress

    oauth2:
      skipApprovalScreen: true
      responseTypes:
      - code

    staticClients:
    - id: argocd-cli
      name: ArgoCD CLI
      public: true
      redirectURIs:
      - http://localhost:8085/auth/callback
```

### ArgoCD OIDC Integration (without Dex)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  url: "https://argocd.acme.corp"

  oidc.config: |
    name: Okta
    issuer: https://acme.okta.com/oauth2/v1
    clientID: 0oa1234567890abcdef
    clientSecret: $oidc.okta.clientSecret
    requestedScopes:
    - openid
    - profile
    - email
    - groups
    requestedIDTokenClaims:
      groups:
        essential: true
    # Map OIDC groups claim to ArgoCD groups
    groupsClaim: groups
    # User ID attribute
    userIDKey: email
    # User name attribute
    userNameKey: name
```

### Storing OIDC Secrets Securely

```yaml
# Use Kubernetes secrets for OIDC credentials
apiVersion: v1
kind: Secret
metadata:
  name: argocd-secret
  namespace: argocd
type: Opaque
stringData:
  # Reference in argocd-cm as $oidc.okta.clientSecret
  oidc.okta.clientSecret: "actual-secret-here"
  # GitHub OAuth app secret
  dex.github.clientSecret: "github-oauth-secret"
  # Admin password (bcrypt)
  admin.password: "$2a$10$rRyBsGSHK6.ufMUdgFVhyOZmP2xT5mgxSUxDgkj6E..."
  admin.passwordMtime: "2024-01-15T00:00:00Z"
```

## Section 5: App-of-Apps Pattern

The app-of-apps pattern uses a root Application to manage other Applications. This enables declarative management of ArgoCD's own state.

### Root Application

```yaml
# This Application manages all other Applications
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root-apps
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "-10"
  finalizers:
  - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: "https://github.com/acme-corp/argocd-apps"
    targetRevision: HEAD
    path: "clusters/production"
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
```

### Repository Structure for App-of-Apps

```
argocd-apps/
  clusters/
    production/
      infrastructure/
        cert-manager.yaml
        external-secrets.yaml
        ingress-nginx.yaml
        prometheus-stack.yaml
      namespaces/
        payments-ns.yaml
        billing-ns.yaml
      teams/
        payments-project.yaml
        payments-apps.yaml
        billing-project.yaml
        billing-apps.yaml
    staging/
      ...
  charts/
    payments-api/
      ...
  config/
    argocd-cm.yaml
    argocd-rbac-cm.yaml
```

### Team Application Bundle

```yaml
# clusters/production/teams/payments-apps.yaml
# This Application generates all payments team Applications
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-team-apps
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  project: team-payments
  source:
    repoURL: "https://github.com/acme-corp/payments-services"
    targetRevision: HEAD
    path: "argocd/applications"
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Section 6: Sync Waves and Resource Hooks

Sync waves control the order in which resources are applied during a sync operation. Resource hooks run scripts at specific points in the sync lifecycle.

### Sync Wave Ordering

```yaml
# Wave -2: Create namespaces and infrastructure first
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  annotations:
    argocd.argoproj.io/sync-wave: "-2"
---
# Wave -1: Deploy secrets and configmaps
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-db-secret
  namespace: payments
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: payments-db-credentials
  data:
  - secretKey: password
    remoteRef:
      key: secret/payments/database
      property: password
---
# Wave 0: Deploy the application (default)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments
  annotations:
    argocd.argoproj.io/sync-wave: "0"
---
# Wave 1: Deploy after application is running
apiVersion: batch/v1
kind: Job
metadata:
  name: payments-db-migrate
  namespace: payments
  annotations:
    argocd.argoproj.io/sync-wave: "1"
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: migrate
        image: payments-api:v2.3.1
        command: ["./migrate", "--up"]
        envFrom:
        - secretRef:
            name: payments-db-credentials
---
# Wave 2: Deploy ingress last (after app is healthy)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payments-api
  namespace: payments
  annotations:
    argocd.argoproj.io/sync-wave: "2"
```

### Resource Hooks

```yaml
# PreSync hook - runs before any resources are synced
apiVersion: batch/v1
kind: Job
metadata:
  name: pre-deploy-check
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: check
        image: curlimages/curl:7.87.0
        command:
        - sh
        - -c
        - |
          echo "Checking downstream dependencies..."
          curl -sf http://database-health-check.payments.svc.cluster.local/ready || exit 1
          echo "All checks passed"
---
# PostSync hook - runs after all resources are synced and healthy
apiVersion: batch/v1
kind: Job
metadata:
  name: post-deploy-smoke-test
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: HookFailed
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: smoke-test
        image: payments-api-tests:v2.3.1
        command: ["./smoke-test.sh"]
        env:
        - name: BASE_URL
          value: "http://payments-api.payments.svc.cluster.local"
---
# SyncFail hook - runs when sync fails (for notifications/rollback)
apiVersion: batch/v1
kind: Job
metadata:
  name: sync-failure-notify
  annotations:
    argocd.argoproj.io/hook: SyncFail
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: notify
        image: curlimages/curl:7.87.0
        command:
        - sh
        - -c
        - |
          curl -X POST "$SLACK_WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "{\"text\":\"Deployment failed for payments-api in production\"}"
        env:
        - name: SLACK_WEBHOOK_URL
          valueFrom:
            secretKeyRef:
              name: slack-webhook
              key: url
```

## Section 7: Automated Drift Detection

ArgoCD continuously monitors deployed applications against their desired state in Git. Configure alerting and automated remediation for drift.

### Notification Controller Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  # Service configurations
  service.slack: |
    token: $slack-token
    username: ArgoCD
    icon: https://argo-cd.readthedocs.io/en/stable/assets/logo.png

  service.pagerduty: |
    token: $pagerduty-token

  service.webhook.github-status: |
    url: https://api.github.com/repos/acme-corp/{{.app.spec.source.repoURL | call .repo.RepoURLToHTTPS | trimPrefix "https://github.com/"}}/statuses/{{.app.status.operationState.syncResult.revision}}
    headers:
    - name: Authorization
      value: token $github-token
    - name: Content-Type
      value: application/json

  # Trigger definitions
  trigger.on-sync-succeeded: |
    - when: app.status.operationState.phase in ['Succeeded']
      send: [app-sync-succeeded]

  trigger.on-sync-failed: |
    - when: app.status.operationState.phase in ['Error', 'Failed']
      send: [app-sync-failed]
      oncePer: app.status.operationState.syncResult.revision

  trigger.on-health-degraded: |
    - when: app.status.health.status == 'Degraded'
      send: [app-health-degraded]
      oncePer: app.status.observedAt

  trigger.on-deployed: |
    - when: app.status.operationState.phase in ['Succeeded'] and app.status.health.status == 'Healthy'
      send: [app-deployed]
      oncePer: app.status.sync.revision

  trigger.on-out-of-sync: |
    - when: app.status.sync.status == 'OutOfSync'
      send: [app-out-of-sync]
      oncePer: app.status.observedAt

  # Template definitions
  template.app-sync-succeeded: |
    message: |
      Application {{.app.metadata.name}} synced successfully.
      Revision: {{.app.status.sync.revision}}
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#18be52",
          "fields": [{
            "title": "Sync Status",
            "value": "Succeeded",
            "short": true
          }, {
            "title": "Revision",
            "value": "{{.app.status.sync.revision | truncate 7 \"\"}}",
            "short": true
          }]
        }]
      deliveryPolicy: Post
      groupingKey: "{{.app.metadata.name}}-sync"
      notifyBroadcast: false

  template.app-sync-failed: |
    message: |
      Application {{.app.metadata.name}} sync FAILED.
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}} sync failed",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "#E96D76",
          "fields": [{
            "title": "Error",
            "value": "{{.app.status.operationState.message}}",
            "short": false
          }]
        }]

  template.app-out-of-sync: |
    message: |
      Application {{.app.metadata.name}} is out of sync.
      Diff detected at {{.app.status.observedAt}}.
    slack:
      attachments: |
        [{
          "title": "Drift Detected: {{.app.metadata.name}}",
          "color": "#f4c030",
          "fields": [{
            "title": "Sync Status",
            "value": "{{.app.status.sync.status}}",
            "short": true
          }]
        }]

  # Default subscriptions
  subscriptions: |
    - recipients:
      - slack:platform-alerts
      triggers:
      - on-sync-failed
      - on-health-degraded
    - recipients:
      - slack:deployments
      triggers:
      - on-deployed
      - on-out-of-sync
```

### Annotating Applications for Notifications

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-api-prod
  namespace: argocd
  annotations:
    # Subscribe to notifications for this specific app
    notifications.argoproj.io/subscribe.on-sync-failed.slack: "payments-alerts"
    notifications.argoproj.io/subscribe.on-health-degraded.pagerduty: "payments-oncall"
    notifications.argoproj.io/subscribe.on-deployed.slack: "deployments"
    # Custom notification context
    notifications.argoproj.io/subscribe.on-sync-succeeded.github-status: ""
```

## Section 8: ApplicationSet for Environment Promotion

Implement GitOps-driven environment promotion using ApplicationSet with a promotion controller pattern:

```yaml
# Promotion ApplicationSet that reads promotion state from Git
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-promotion
  namespace: argocd
spec:
  goTemplate: true

  generators:
  - git:
      repoURL: "https://github.com/acme-corp/deployment-state"
      revision: HEAD
      files:
      - path: "services/payments-api/*/deployment.yaml"

  template:
    metadata:
      name: "payments-api-{{.environment}}"
      annotations:
        deployment.version: "{{.version}}"
        deployment.promoted_at: "{{.promoted_at}}"
        deployment.promoted_by: "{{.promoted_by}}"
    spec:
      project: team-payments
      source:
        repoURL: "https://github.com/acme-corp/payments-services"
        targetRevision: "{{.version}}"
        path: "chart"
        helm:
          parameters:
          - name: image.tag
            value: "{{.version}}"
          - name: environment
            value: "{{.environment}}"
          - name: replicaCount
            value: "{{.replicas}}"
      destination:
        name: "{{.cluster}}"
        namespace: "{{.namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - RespectIgnoreDifferences=true
```

### Promotion State Files

```yaml
# services/payments-api/production/deployment.yaml
version: "v2.3.1"
environment: production
cluster: prod-us-east-1
namespace: payments
replicas: 5
promoted_at: "2024-01-15T14:30:00Z"
promoted_by: "john.doe@acme.corp"
previous_version: "v2.3.0"
rollback_allowed: true
```

## Section 9: Repository Structure Best Practices

### Recommended GitOps Repository Layout

```
# Config repository (GitOps state)
platform-gitops/
  clusters/
    prod-us-east-1/
      infrastructure/
        cert-manager/
          app.yaml          # ArgoCD Application
          values.yaml       # Helm values for this cluster
        ingress-nginx/
          app.yaml
          values.yaml
      teams/
        payments/
          project.yaml      # AppProject
          apps/
            payments-api.yaml
            payments-worker.yaml
      cluster-config/
        namespaces.yaml
        resource-quotas.yaml
    staging-us-east-1/
      ...
  shared/
    policies/
      network-policies.yaml
      pod-security-policies.yaml
    monitoring/
      prometheus-rules.yaml
      grafana-dashboards.yaml
  scripts/
    promote.sh
    validate.sh

# Application repository (source code + chart)
payments-services/
  src/
    payments-api/
    payments-worker/
  chart/
    Chart.yaml
    values.yaml
    values-production.yaml
    values-staging.yaml
    templates/
      deployment.yaml
      service.yaml
      hpa.yaml
```

### Validation in CI/CD

```yaml
# .github/workflows/validate-gitops.yml
name: Validate GitOps Manifests
on:
  pull_request:
    paths:
    - 'clusters/**'
    - 'shared/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Install tools
      run: |
        curl -sSL https://github.com/yannh/kubeconform/releases/latest/download/kubeconform-linux-amd64.tar.gz | tar xz
        sudo mv kubeconform /usr/local/bin/

    - name: Validate Kubernetes manifests
      run: |
        find clusters/ -name '*.yaml' | xargs kubeconform \
          -strict \
          -ignore-missing-schemas \
          -schema-location default \
          -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

    - name: Validate ArgoCD Applications
      run: |
        find clusters/ -name '*.yaml' | xargs grep -l 'kind: Application' | \
        while read file; do
          echo "Validating: $file"
          argocd app lint "$file" --ignore-normalizer-error || exit 1
        done

    - name: Check for hardcoded secrets
      run: |
        if grep -rn 'password:\|secret:\|token:' clusters/ | grep -v '.enc.yaml\|SecretKeyRef\|secretRef'; then
          echo "Potential hardcoded secret detected"
          exit 1
        fi
```

## Section 10: ArgoCD High Availability Configuration

```yaml
# High-availability ArgoCD installation
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  # Application controller sharding for large-scale deployments
  controller.sharding.algorithm: "consistent-hashing"

  # Increase cache size for large number of applications
  reposerver.parallelism.limit: "20"

  # Enable git submodules
  reposerver.enable.git.submodules: "true"

  # Application controller settings
  application.instanceLabelKey: "argocd.argoproj.io/app-name"

  # Server settings
  server.insecure: "false"
  server.log.level: "info"

  # Redis settings for HA (using Redis Sentinel or Cluster)
  redis.server: "argocd-redis-ha-haproxy:6379"
---
# Increase replica counts for HA
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argocd-server
  namespace: argocd
spec:
  replicas: 3
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argocd-repo-server
  namespace: argocd
spec:
  replicas: 3
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: argocd-application-controller
  namespace: argocd
spec:
  replicas: 3
```

## Section 11: Operational Runbooks

### Recovering from a Failed Sync

```bash
#!/bin/bash
# recover-argocd-app.sh - Force recover a stuck ArgoCD application

APP_NAME="${1:?Usage: $0 <app-name> [namespace]}"
ARGOCD_NS="${2:-argocd}"

echo "Recovering ArgoCD application: $APP_NAME"

# Check current status
argocd app get "$APP_NAME" --grpc-web

# Terminate any running operation
argocd app terminate-op "$APP_NAME" --grpc-web

# Clear any error annotations
kubectl annotate application "$APP_NAME" -n "$ARGOCD_NS" \
  argocd.argoproj.io/refresh- \
  --overwrite

# Force refresh from Git
argocd app get "$APP_NAME" --refresh --grpc-web

# Check for resource health issues
argocd app resources "$APP_NAME" --grpc-web | grep -v Healthy

# Sync with force flag if needed
echo "Starting forced sync..."
argocd app sync "$APP_NAME" \
  --grpc-web \
  --force \
  --prune \
  --apply-out-of-sync-only \
  --timeout 300

echo "Watching sync status..."
argocd app wait "$APP_NAME" \
  --grpc-web \
  --health \
  --timeout 300
```

### Mass Sync After GitOps Incident

```bash
#!/bin/bash
# mass-sync.sh - Sync all out-of-sync applications in a project

PROJECT="${1:?Usage: $0 <project-name>}"

echo "Finding out-of-sync applications in project: $PROJECT"

# Get all out-of-sync apps in the project
OUT_OF_SYNC=$(argocd app list \
  --project "$PROJECT" \
  --sync-status OutOfSync \
  --grpc-web \
  -o name)

if [ -z "$OUT_OF_SYNC" ]; then
  echo "All applications are in sync"
  exit 0
fi

echo "Out-of-sync applications:"
echo "$OUT_OF_SYNC"

# Sync each app in parallel with a limit
echo "$OUT_OF_SYNC" | xargs -P 5 -I{} \
  argocd app sync {} \
  --grpc-web \
  --apply-out-of-sync-only \
  --timeout 120

# Wait for all to be healthy
echo "$OUT_OF_SYNC" | xargs -P 5 -I{} \
  argocd app wait {} \
  --grpc-web \
  --health \
  --timeout 300

echo "Mass sync complete"
```

## Summary

Multi-tenant ArgoCD at enterprise scale requires careful attention to:

1. AppProject boundaries enforce tenant isolation at the API level, not just by convention
2. ApplicationSet generators eliminate the operational overhead of managing individual Applications
3. RBAC policies should follow the principle of least privilege, with project-scoped roles for team autonomy
4. SSO integration via Dex or direct OIDC allows group-based access from your identity provider
5. Sync waves and resource hooks provide ordered, reliable deployments with pre/post validation
6. Notification controllers close the feedback loop by routing deployment events to the right channels
7. The app-of-apps pattern enables GitOps management of ArgoCD's own configuration

The patterns in this guide have been tested in environments managing 500+ applications across 20+ clusters. The key to scaling ArgoCD is treating it as infrastructure code rather than a UI tool—everything should be declarative, version-controlled, and automatically reconciled.
