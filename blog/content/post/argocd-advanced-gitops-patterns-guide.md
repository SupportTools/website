---
title: "ArgoCD Advanced GitOps Patterns: Multi-Cluster, App-of-Apps, and ApplicationSets"
date: 2027-06-19T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "Kubernetes", "CI/CD", "Multi-Cluster"]
categories:
- ArgoCD
- GitOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade deep dive into ArgoCD's most powerful patterns: App-of-Apps hierarchy, ApplicationSet generators, multi-cluster deployment, sync waves, RBAC projects, SSO integration, and notification routing for enterprise GitOps workflows."
more_link: "yes"
url: "/argocd-advanced-gitops-patterns-guide/"
---

ArgoCD has become the de facto GitOps engine for Kubernetes, but most teams barely scratch the surface of its capabilities. The gap between a basic single-cluster ArgoCD installation and a production-grade, multi-tenant, multi-cluster GitOps platform is wide. This guide bridges that gap by covering the architectural patterns and operational techniques that make ArgoCD scale to hundreds of clusters and thousands of applications.

<!--more-->

# ArgoCD Advanced GitOps Patterns

## Section 1: ArgoCD Architecture Deep Dive

Understanding ArgoCD's internal architecture is a prerequisite for tuning it at scale. ArgoCD consists of several components that each play a distinct role.

### Core Components

**argocd-server** is the API server and UI backend. It authenticates users, serves the web dashboard, and exposes the gRPC and REST APIs consumed by the CLI and webhook receivers.

**argocd-application-controller** is the heart of ArgoCD. It runs a reconciliation loop that continuously compares the desired state (Git) with the live state (Kubernetes). It is stateful and shards across replicas using consistent hashing keyed on cluster name.

**argocd-repo-server** handles all Git and Helm operations. It clones repositories, renders manifests (Helm, Kustomize, Jsonnet, plain YAML), and caches rendered output. This component is often the bottleneck at scale due to CPU-intensive manifest generation.

**argocd-dex-server** provides OIDC/OAuth2 integration by embedding Dex. It bridges external identity providers (GitHub, Okta, Azure AD) to ArgoCD's RBAC system.

**argocd-redis** is the shared in-memory cache used by all components for rendered manifests, cluster state snapshots, and webhook event deduplication.

### High-Availability Configuration

For production deployments, run multiple replicas of stateless components and configure application controller sharding:

```yaml
# argocd-application-controller StatefulSet env vars
- name: ARGOCD_CONTROLLER_REPLICAS
  value: "3"
- name: ARGOCD_ENABLE_PROGRESSIVE_SYNCS
  value: "true"
```

```yaml
# argocd-cm ConfigMap — enable sharding
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # Application controller sharding algorithm
  application.instanceLabelKey: argocd.argoproj.io/app-name
  controller.sharding.algorithm: round-robin
```

The repo server benefits from horizontal scaling with a shared Redis cache:

```yaml
# argocd-repo-server Deployment
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: argocd-repo-server
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "2Gi"
        env:
        - name: ARGOCD_REPO_SERVER_PARALLELISM_LIMIT
          value: "10"
```

## Section 2: App-of-Apps Pattern

The App-of-Apps pattern is the foundational technique for managing ArgoCD at scale. It uses a single "root" Application that points to a directory of Application manifests, creating a self-managing hierarchy.

### Basic App-of-Apps Structure

```
gitops-repo/
├── apps/                          # Root app points here
│   ├── production/
│   │   ├── core-infra.yaml        # ArgoCD Application manifests
│   │   ├── monitoring.yaml
│   │   └── workloads.yaml
│   └── staging/
│       ├── core-infra.yaml
│       └── workloads.yaml
└── manifests/                     # Actual Kubernetes manifests
    ├── core-infra/
    ├── monitoring/
    └── workloads/
```

The root Application manifest:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root-app
  namespace: argocd
  finalizers:
  - resources-finalizer.argocd.argoproj.io
spec:
  project: platform
  source:
    repoURL: https://github.com/org/gitops-repo.git
    targetRevision: main
    path: apps/production
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

One of the child Application manifests (`apps/production/monitoring.yaml`):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: monitoring-stack
  namespace: argocd
  finalizers:
  - resources-finalizer.argocd.argoproj.io
spec:
  project: platform
  source:
    repoURL: https://github.com/org/gitops-repo.git
    targetRevision: main
    path: manifests/monitoring
  destination:
    server: https://kubernetes.default.svc
    namespace: monitoring
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ServerSideApply=true
```

### Sync Waves for Ordered Deployment

Sync waves control the order in which resources are applied within a single sync operation. Lower wave numbers sync first. This is critical for ordering CRD installation before CR creation, or namespace creation before workload deployment.

```yaml
# CRDs — wave -1 ensures they sync before everything else
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: prometheuses.monitoring.coreos.com
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
```

```yaml
# Namespace — wave 0
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  annotations:
    argocd.argoproj.io/sync-wave: "0"
```

```yaml
# Operator deployment — wave 1
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus-operator
  namespace: monitoring
  annotations:
    argocd.argoproj.io/sync-wave: "1"
```

```yaml
# Prometheus CR — wave 2, after operator is running
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: kube-prometheus
  namespace: monitoring
  annotations:
    argocd.argoproj.io/sync-wave: "2"
```

### Sync Hooks for Pre/Post Actions

Hooks execute Jobs at specific points in the sync lifecycle:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migration
  namespace: myapp
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: migrate
        image: myapp:v2.3.0
        command: ["./migrate", "--up"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: url
```

Available hook types:
- `PreSync` — runs before the sync begins
- `Sync` — runs during sync alongside regular resources
- `PostSync` — runs after all resources are healthy
- `SyncFail` — runs if the sync fails
- `Skip` — resource is ignored during sync

## Section 3: ApplicationSet Generators

ApplicationSets are ArgoCD's templating engine for Application objects. A single ApplicationSet can generate hundreds of Applications based on data from various sources.

### Cluster Generator

The cluster generator creates one Application per registered cluster. This is the backbone of fleet management:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-addons
  namespace: argocd
spec:
  generators:
  - clusters:
      selector:
        matchLabels:
          environment: production
  template:
    metadata:
      name: "{{name}}-cluster-addons"
      annotations:
        argocd.argoproj.io/manifest-generate-paths: .
    spec:
      project: platform
      source:
        repoURL: https://github.com/org/gitops-repo.git
        targetRevision: main
        path: "cluster-addons/{{metadata.labels.region}}"
        helm:
          parameters:
          - name: clusterName
            value: "{{name}}"
          - name: clusterRegion
            value: "{{metadata.labels.region}}"
          - name: environment
            value: "{{metadata.labels.environment}}"
      destination:
        server: "{{server}}"
        namespace: kube-system
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Git Generator

The git generator discovers applications by listing directories or files in a repository:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: microservices
  namespace: argocd
spec:
  generators:
  - git:
      repoURL: https://github.com/org/gitops-repo.git
      revision: main
      directories:
      - path: "services/*/helm"
      - path: "services/legacy/*"
        exclude: true
  template:
    metadata:
      name: "{{path.basename}}"
    spec:
      project: workloads
      source:
        repoURL: https://github.com/org/gitops-repo.git
        targetRevision: main
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{path[1]}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

The git file generator reads JSON/YAML configuration files:

```yaml
# generators using config files
generators:
- git:
    repoURL: https://github.com/org/gitops-repo.git
    revision: main
    files:
    - path: "environments/*/config.json"
```

With each `config.json` providing values:

```json
{
  "environment": "production",
  "region": "us-east-1",
  "cluster_url": "https://prod-cluster.example.com",
  "replica_count": 3,
  "resources": {
    "cpu_request": "500m",
    "memory_request": "512Mi"
  }
}
```

### List Generator

The list generator is the simplest option, providing an inline list of parameter sets:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: regional-ingress
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - cluster: prod-us-east-1
        url: https://prod-use1.example.com
        region: us-east-1
        acmCertArn: arn:aws:acm:us-east-1:123456789012:certificate/abc123
      - cluster: prod-eu-west-1
        url: https://prod-euw1.example.com
        region: eu-west-1
        acmCertArn: arn:aws:acm:eu-west-1:123456789012:certificate/def456
      - cluster: prod-ap-southeast-1
        url: https://prod-apse1.example.com
        region: ap-southeast-1
        acmCertArn: arn:aws:acm:ap-southeast-1:123456789012:certificate/ghi789
  template:
    metadata:
      name: "ingress-nginx-{{cluster}}"
    spec:
      project: infrastructure
      source:
        repoURL: https://kubernetes.github.io/ingress-nginx
        chart: ingress-nginx
        targetRevision: "4.10.1"
        helm:
          values: |
            controller:
              replicaCount: 3
              service:
                annotations:
                  service.beta.kubernetes.io/aws-load-balancer-ssl-cert: "{{acmCertArn}}"
                  service.beta.kubernetes.io/aws-load-balancer-backend-protocol: http
      destination:
        server: "{{url}}"
        namespace: ingress-nginx
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Matrix Generator

The matrix generator produces the Cartesian product of two generators, enabling powerful combinatorial templating:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: service-per-cluster
  namespace: argocd
spec:
  generators:
  - matrix:
      generators:
      # First generator: all production clusters
      - clusters:
          selector:
            matchLabels:
              tier: production
      # Second generator: all microservices
      - git:
          repoURL: https://github.com/org/gitops-repo.git
          revision: main
          directories:
          - path: "services/*"
  template:
    metadata:
      name: "{{path.basename}}-{{name}}"
    spec:
      project: workloads
      source:
        repoURL: https://github.com/org/gitops-repo.git
        targetRevision: main
        path: "{{path}}"
        helm:
          parameters:
          - name: clusterName
            value: "{{name}}"
          - name: replicaCount
            value: "{{metadata.labels.replicaCount}}"
      destination:
        server: "{{server}}"
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Pull Request Generator

The PR generator creates ephemeral preview environments for each open pull request:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: preview-environments
  namespace: argocd
spec:
  generators:
  - pullRequest:
      github:
        owner: org
        repo: app-repo
        tokenRef:
          secretName: github-token
          key: token
        labels:
        - preview
      requeueAfterSeconds: 60
  template:
    metadata:
      name: "preview-{{branch_slug}}"
    spec:
      project: preview
      source:
        repoURL: https://github.com/org/app-repo.git
        targetRevision: "{{head_sha}}"
        path: helm/app
        helm:
          parameters:
          - name: image.tag
            value: "{{head_sha}}"
          - name: ingress.host
            value: "preview-{{branch_slug}}.preview.example.com"
          - name: environment
            value: preview
      destination:
        server: https://staging-cluster.example.com
        namespace: "preview-{{branch_slug}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
  syncPolicy:
    # Clean up preview namespaces when PRs are closed
    preserveResourcesOnDeletion: false
```

## Section 4: RBAC and Projects

ArgoCD Projects provide multi-tenancy by scoping which source repositories, destination clusters/namespaces, and resource types a team can manage.

### Project Definition

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-payments
  namespace: argocd
spec:
  description: "Payments team applications"

  # Allowed source repositories
  sourceRepos:
  - "https://github.com/org/payments-*.git"
  - "https://charts.example.com/*"

  # Allowed destination clusters and namespaces
  destinations:
  - server: https://prod-cluster.example.com
    namespace: "payments-*"
  - server: https://staging-cluster.example.com
    namespace: "payments-*"

  # Cluster-scoped resource allow/deny lists
  clusterResourceWhitelist:
  - group: ""
    kind: Namespace

  # Namespace-scoped resource allow list
  namespaceResourceWhitelist:
  - group: "apps"
    kind: Deployment
  - group: "apps"
    kind: StatefulSet
  - group: ""
    kind: Service
  - group: ""
    kind: ConfigMap
  - group: ""
    kind: Secret
  - group: "networking.k8s.io"
    kind: Ingress
  - group: "autoscaling"
    kind: HorizontalPodAutoscaler

  # Explicit deny list (takes precedence over whitelist)
  namespaceResourceBlacklist:
  - group: ""
    kind: ResourceQuota
  - group: ""
    kind: LimitRange

  # Orphaned resource monitoring
  orphanedResources:
    warn: true

  # Sync windows — restrict when syncs can occur
  syncWindows:
  - kind: allow
    schedule: "10 1 * * *"
    duration: 1h
    applications:
    - "*"
    namespaces:
    - "payments-*"
    clusters:
    - https://prod-cluster.example.com
    timeZone: America/New_York
  - kind: deny
    schedule: "0 22 * * 5"   # Friday 10pm
    duration: 60h             # Through Monday 10am
    applications:
    - "*"
    manualSync: true          # Block even manual syncs

  # RBAC roles scoped to this project
  roles:
  - name: developer
    description: "Read and sync access for developers"
    policies:
    - p, proj:team-payments:developer, applications, get, team-payments/*, allow
    - p, proj:team-payments:developer, applications, sync, team-payments/*, allow
    groups:
    - org:payments-developers

  - name: lead
    description: "Full management access for tech leads"
    policies:
    - p, proj:team-payments:lead, applications, *, team-payments/*, allow
    groups:
    - org:payments-leads
```

### RBAC Policy Configuration

The global RBAC policy in `argocd-rbac-cm`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    # Platform team gets full admin
    g, org:platform-admins, role:admin

    # SRE team gets full access to all applications but cannot manage ArgoCD itself
    p, role:sre, applications, *, */*, allow
    p, role:sre, clusters, get, *, allow
    p, role:sre, repositories, get, *, allow
    g, org:sre-team, role:sre

    # Namespace-scoped roles inherit project definitions
    # Project-level roles are defined in AppProject resources

  scopes: "[groups, email]"
```

## Section 5: SSO Integration

### Dex with GitHub OAuth

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  url: https://argocd.example.com

  dex.config: |
    connectors:
    - type: github
      id: github
      name: GitHub
      config:
        clientID: $dex-github-client-id
        clientSecret: $dex-github-client-secret
        redirectURI: https://argocd.example.com/api/dex/callback
        orgs:
        - name: myorg
          teams:
          - platform-admins
          - sre-team
          - payments-developers
          - payments-leads
        loadAllGroups: false
        teamNameField: slug
        useLoginAsID: false
```

### Dex with Okta OIDC

```yaml
  dex.config: |
    connectors:
    - type: oidc
      id: okta
      name: Okta
      config:
        issuer: https://dev-12345678.okta.com/oauth2/default
        clientID: $okta-client-id
        clientSecret: $okta-client-secret
        redirectURI: https://argocd.example.com/api/dex/callback
        scopes:
        - openid
        - profile
        - email
        - groups
        getUserInfo: true
        userNameKey: email
        groupsKey: groups
        insecureSkipEmailVerified: false
```

The corresponding Secret with credentials:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: argocd-secret
  namespace: argocd
type: Opaque
stringData:
  dex-github-client-id: "<github-oauth-app-client-id>"
  dex-github-client-secret: "<github-oauth-app-client-secret>"
  okta-client-id: "<okta-app-client-id>"
  okta-client-secret: "<okta-app-client-secret>"
```

## Section 6: Notifications

ArgoCD Notifications sends alerts to various channels when application state changes.

### Notification Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  # Slack notification template
  template.app-deployed: |
    message: |
      Application {{.app.metadata.name}} has been deployed successfully.
      Revision: {{.app.status.sync.revision}}
      Environment: {{.app.metadata.labels.environment}}
    slack:
      attachments: |
        [{
          "color": "#18be52",
          "title": "{{.app.metadata.name}} deployed",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Revision", "value": "{{.app.status.sync.revision}}", "short": true},
            {"title": "Author", "value": "{{(call .repo.GetCommitMetadata .app.status.sync.revision).Author}}", "short": true},
            {"title": "Message", "value": "{{(call .repo.GetCommitMetadata .app.status.sync.revision).Message}}", "short": false}
          ]
        }]

  template.app-sync-failed: |
    message: |
      Application {{.app.metadata.name}} sync FAILED.
      Error: {{.app.status.operationState.message}}
    slack:
      attachments: |
        [{
          "color": "#E96D76",
          "title": "Sync Failed: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "fields": [
            {"title": "Error", "value": "{{.app.status.operationState.message}}", "short": false}
          ]
        }]

  template.app-health-degraded: |
    message: |
      Application {{.app.metadata.name}} health is DEGRADED.
    slack:
      attachments: |
        [{
          "color": "#f4c030",
          "title": "Health Degraded: {{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"
        }]

  # Trigger definitions
  trigger.on-deployed: |
    - description: Notify when application is synced and healthy
      send:
      - app-deployed
      when: app.status.operationState.phase in ['Succeeded'] and app.status.health.status == 'Healthy'

  trigger.on-sync-failed: |
    - description: Notify when application sync fails
      send:
      - app-sync-failed
      when: app.status.operationState.phase in ['Error', 'Failed']

  trigger.on-health-degraded: |
    - description: Notify when application health degrades
      send:
      - app-health-degraded
      when: app.status.health.status == 'Degraded'

  # Default subscriptions — apply to all applications
  subscriptions: |
    - recipients:
      - slack:platform-alerts
      triggers:
      - on-sync-failed
      - on-health-degraded
```

The Slack service Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: argocd-notifications-secret
  namespace: argocd
type: Opaque
stringData:
  slack-token: "<bot-oauth-token>"
```

Per-application notification annotation:

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-deployed.slack: "deployments-channel"
    notifications.argoproj.io/subscribe.on-sync-failed.slack: "platform-alerts"
    notifications.argoproj.io/subscribe.on-health-degraded.pagerduty: "payments-oncall"
```

## Section 7: Resource Health Checks and Diff Customization

### Custom Health Checks

ArgoCD's built-in health checks cover standard Kubernetes resources, but custom resources require custom Lua scripts:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  resource.customizations.health.certmanager.io_Certificate: |
    hs = {}
    if obj.status ~= nil then
      if obj.status.conditions ~= nil then
        for i, condition in ipairs(obj.status.conditions) do
          if condition.type == "Ready" then
            if condition.status == "False" then
              hs.status = "Degraded"
              hs.message = condition.message
              return hs
            end
            if condition.status == "True" then
              hs.status = "Healthy"
              hs.message = condition.message
              return hs
            end
          end
        end
      end
    end
    hs.status = "Progressing"
    hs.message = "Waiting for certificate issuance"
    return hs

  resource.customizations.health.argoproj.io_Rollout: |
    hs = {}
    if obj.status ~= nil then
      if obj.status.phase == "Degraded" then
        hs.status = "Degraded"
        hs.message = obj.status.message
        return hs
      end
      if obj.status.phase == "Paused" then
        hs.status = "Suspended"
        hs.message = "Rollout is paused"
        return hs
      end
      if obj.status.readyReplicas == obj.spec.replicas then
        hs.status = "Healthy"
        return hs
      end
    end
    hs.status = "Progressing"
    hs.message = "Waiting for rollout to complete"
    return hs
```

### Diff Customization

Certain fields should be ignored during diff calculation to prevent spurious out-of-sync states:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # Ignore specific fields globally
  resource.customizations.ignoreDifferences.all: |
    jqPathExpressions:
    - .spec.template.metadata.annotations."kubectl.kubernetes.io/last-applied-configuration"

  # Ignore MutatingWebhookConfiguration caBundle (injected by cert-manager)
  resource.customizations.ignoreDifferences.admissionregistration.k8s.io_MutatingWebhookConfiguration: |
    jqPathExpressions:
    - .webhooks[].clientConfig.caBundle

  # Ignore Deployment replica count (managed by HPA)
  resource.customizations.ignoreDifferences.apps_Deployment: |
    jsonPointers:
    - /spec/replicas
```

Application-level ignore differences:

```yaml
spec:
  ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers:
    - /spec/replicas
  - group: ""
    kind: Secret
    name: argocd-secret
    jsonPointers:
    - /data
  - group: "autoscaling"
    kind: HorizontalPodAutoscaler
    jqPathExpressions:
    - .spec.metrics[].resource.target.averageUtilization
```

## Section 8: Multi-Cluster Fleet Management

### Registering External Clusters

```bash
# Using argocd CLI
argocd cluster add prod-us-east-1 \
  --name prod-us-east-1 \
  --label environment=production \
  --label region=us-east-1 \
  --label tier=production \
  --system-namespace argocd \
  --kubeconfig ~/.kube/config

# List registered clusters
argocd cluster list

# Check cluster connection status
argocd cluster get prod-us-east-1
```

Clusters can also be registered declaratively via Secrets:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: prod-us-east-1
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    environment: production
    region: us-east-1
    tier: production
type: Opaque
stringData:
  name: prod-us-east-1
  server: https://prod-use1-apiserver.example.com
  config: |
    {
      "bearerToken": "<service-account-token>",
      "tlsClientConfig": {
        "insecure": false,
        "caData": "<base64-encoded-ca-cert>"
      }
    }
```

### Cluster Bootstrapping with ApplicationSets

A complete cluster bootstrapping pattern that installs all required components when a new cluster is registered:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-bootstrap
  namespace: argocd
spec:
  generators:
  - clusters:
      selector:
        matchExpressions:
        - key: environment
          operator: In
          values: [production, staging]
  template:
    metadata:
      name: "bootstrap-{{name}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/org/gitops-repo.git
        targetRevision: main
        path: bootstrap/{{metadata.labels.environment}}
        helm:
          values: |
            global:
              clusterName: {{name}}
              environment: {{metadata.labels.environment}}
              region: {{metadata.labels.region}}
      destination:
        server: "{{server}}"
        namespace: argocd
      syncPolicy:
        automated:
          prune: false   # Never auto-prune bootstrap components
          selfHeal: true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

## Section 9: Performance Tuning and Operational Best Practices

### Repository Server Caching

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # How long to cache rendered manifests
  app.kubernetes.io/cache-expiry: "24h"

  # Timeout for git operations
  timeout.reconciliation: "180s"

  # Concurrent reconciliation per replica
  reposerver.parallelism.limit: "10"

  # Status processors
  application.instanceLabelKey: argocd.argoproj.io/app-name
```

### Reducing Reconciliation Load

For clusters with many applications, tune the reconciliation loop:

```yaml
# argocd-application-controller flags
- --status-processors=20
- --operation-processors=10
- --app-hard-resync=0              # Disable hard resync (rely on webhooks)
- --self-heal-timeout-seconds=5
- --app-resync-period=300          # 5-minute resync instead of 3-minute default
```

### Webhook Configuration for Instant Reconciliation

Relying solely on polling creates lag. Configure webhooks for near-instant reconciliation:

```bash
# GitHub — add webhook to repository settings
# URL: https://argocd.example.com/api/webhook
# Content-Type: application/json
# Secret: <webhook-secret>
# Events: Push events, Pull request events
```

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: argocd-secret
  namespace: argocd
stringData:
  webhook.github.secret: "<random-webhook-secret>"
  webhook.gitlab.secret: "<random-webhook-secret>"
```

### Resource Exclusion

Exclude high-churn resources that should not be tracked:

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
    - apiGroups:
      - "coordination.k8s.io"
      kinds:
      - Lease
    - apiGroups:
      - "metrics.k8s.io"
      kinds:
      - "*"
    clusters:
    - "*"
```

## Section 10: Troubleshooting Common Issues

### Debugging Sync Failures

```bash
# Get application sync status
argocd app get myapp --show-operation

# Force a refresh (bypasses cache)
argocd app get myapp --refresh

# Get detailed diff
argocd app diff myapp --local ./manifests

# View sync operation logs
argocd app logs myapp --follow

# Manual sync with pruning
argocd app sync myapp --prune --force

# Sync a specific resource
argocd app sync myapp --resource apps:Deployment:myapp-backend
```

### Checking Application Controller Logs

```bash
# Application controller logs (useful for reconciliation errors)
kubectl logs -n argocd \
  -l app.kubernetes.io/name=argocd-application-controller \
  --since=1h | grep -E "ERROR|WARN|failed"

# Repo server logs (useful for manifest generation errors)
kubectl logs -n argocd \
  -l app.kubernetes.io/name=argocd-repo-server \
  --since=30m | grep -E "ERROR|helm|kustomize"

# Check Redis connectivity
kubectl exec -n argocd \
  deploy/argocd-application-controller \
  -- argocd-application-controller --redis argocd-redis:6379 --check
```

### Common Sync Issues and Resolutions

**Out-of-sync due to server-side defaulting**: Resources mutated by admission webhooks or defaulting controllers will always appear out of sync. Fix with `ignoreDifferences` or enable `ServerSideApply=true`.

**Stuck in Progressing**: A resource health check is returning `Progressing` indefinitely. Check custom health check Lua scripts or add a timeout.

**Unknown resources**: CRDs not yet installed. Use sync wave -1 for CRDs and ensure the application controller has RBAC access to the CRD group.

**ComparisonError**: The repo server cannot clone or render manifests. Check repository credentials and Helm/Kustomize versions.

```bash
# Verify repo server can access repository
argocd repo get https://github.com/org/repo.git

# Test manifest generation locally
argocd app manifests myapp --revision HEAD
```

This guide covers the patterns needed to build a production-grade ArgoCD installation that scales from a handful of applications to a fleet of hundreds of clusters. The combination of App-of-Apps hierarchy, ApplicationSet generators, project-based RBAC, and sync waves provides the flexibility to support any organizational structure while maintaining operational correctness.
