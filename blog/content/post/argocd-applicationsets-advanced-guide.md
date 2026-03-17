---
title: "ArgoCD ApplicationSets: Advanced Multi-Cluster GitOps Patterns"
date: 2027-10-08T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "ApplicationSets", "Multi-Cluster", "Kubernetes"]
categories:
- GitOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into ArgoCD ApplicationSets for managing hundreds of applications across multi-cluster Kubernetes environments using generators, Go templates, progressive sync waves, and advanced rollout strategies."
more_link: "yes"
url: "/argocd-applicationsets-advanced-guide/"
---

ArgoCD ApplicationSets transform GitOps at scale by generating and managing hundreds of Application resources from a single manifest. Instead of maintaining individual Application definitions for each microservice, environment, or cluster combination, ApplicationSets use generators to derive application configuration dynamically. This guide covers every generator type, templating technique, progressive delivery integration, and operational pattern needed to manage large-scale multi-cluster GitOps deployments.

<!--more-->

# ArgoCD ApplicationSets: Advanced Multi-Cluster GitOps Patterns

## Section 1: ApplicationSet Controller Architecture

The ApplicationSet controller runs alongside ArgoCD and watches `ApplicationSet` resources. When it detects a change to an ApplicationSet or its generator sources, it reconciles the set of generated `Application` resources — creating new ones, updating changed ones, and deleting removed ones.

### Installation and Controller Configuration

```bash
# Verify ApplicationSet controller is running (included in ArgoCD >= 2.3)
kubectl -n argocd get deployment argocd-applicationset-controller

# Controller configuration options
kubectl -n argocd edit configmap argocd-cmd-params-cm
```

Key controller parameters:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmd-params-cm
  namespace: argocd
data:
  # Reconciliation interval for ApplicationSet generators
  applicationsetcontroller.requeueAfter: "3m"
  # Enable progressive rollouts (requires feature gate in older versions)
  applicationsetcontroller.enable.progressive.syncs: "true"
  # Concurrent reconciliation workers
  applicationsetcontroller.concurrent.reconciliations.max: "10"
  # Policy for handling Application deletion
  applicationsetcontroller.policy: "sync"
```

### RBAC for ApplicationSet Controller

The controller needs permission to create and manage Application resources:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: applicationset-controller
rules:
  - apiGroups: ["argoproj.io"]
    resources: ["applications", "applicationsets", "applicationsets/status", "applicationsets/finalizers"]
    verbs: ["create", "delete", "get", "list", "patch", "update", "watch"]
  - apiGroups: [""]
    resources: ["configmaps", "secrets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps", "extensions"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]
```

## Section 2: Generator Types

Generators are the core of ApplicationSets. They produce sets of parameters that the template section uses to render Application objects.

### List Generator

The simplest generator — provides a static list of parameter sets:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: team-microservices
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - service: user-service
            namespace: platform
            replicaCount: "3"
            imageTag: v2.4.1
          - service: order-service
            namespace: platform
            replicaCount: "5"
            imageTag: v1.8.0
          - service: payment-service
            namespace: platform
            replicaCount: "2"
            imageTag: v3.1.0
  template:
    metadata:
      name: "{{.service}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/support-tools/platform-services.git
        targetRevision: HEAD
        path: "services/{{.service}}/helm"
        helm:
          values: |
            replicaCount: {{.replicaCount}}
            image:
              tag: {{.imageTag}}
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{.namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Git Generator — Directory Mode

Automatically discovers applications from directory structure:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: environment-apps
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/support-tools/gitops-config.git
        revision: HEAD
        directories:
          - path: "environments/*/apps/*"
          - path: "environments/*/apps/experimental"
            exclude: true
  template:
    metadata:
      name: "{{path.basenameNormalized}}"
      labels:
        environment: "{{path[1]}}"
        app: "{{path.basename}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/support-tools/gitops-config.git
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{path[1]}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

The `path` variable provides several sub-fields:
- `{{path}}` — full path like `environments/production/apps/frontend`
- `{{path.basename}}` — `frontend`
- `{{path.basenameNormalized}}` — `frontend` with special chars replaced
- `{{path[0]}}` — `environments`
- `{{path[1]}}` — `production`

### Git Generator — Files Mode

Generate parameters from JSON or YAML files in the repository:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: tenant-applications
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/support-tools/tenant-config.git
        revision: HEAD
        files:
          - path: "tenants/**/config.yaml"
  template:
    metadata:
      name: "{{tenant.name}}-{{tenant.environment}}"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-succeeded.slack: "{{tenant.slack_channel}}"
    spec:
      project: "{{tenant.project}}"
      source:
        repoURL: https://github.com/support-tools/app-charts.git
        targetRevision: "{{tenant.chartVersion}}"
        path: "charts/{{tenant.app}}"
        helm:
          values: |
            tenant: {{tenant.name}}
            environment: {{tenant.environment}}
            resources:
              requests:
                cpu: {{tenant.resources.cpu}}
                memory: {{tenant.resources.memory}}
      destination:
        server: "{{tenant.cluster}}"
        namespace: "{{tenant.namespace}}"
      syncPolicy:
        automated:
          prune: "{{tenant.autoPrune}}"
          selfHeal: true
```

Corresponding `tenants/acme-corp/config.yaml`:

```yaml
tenant:
  name: acme-corp
  environment: production
  project: acme
  app: webapp
  chartVersion: "1.5.2"
  cluster: https://prod-cluster.example.com
  namespace: acme-production
  slack_channel: acme-alerts
  autoPrune: true
  resources:
    cpu: "500m"
    memory: "512Mi"
```

### Cluster Generator

Generate applications for all registered ArgoCD clusters matching a label selector:

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
            cluster-type: production
          matchExpressions:
            - key: region
              operator: In
              values: [us-east-1, us-west-2, eu-west-1]
        values:
          # Additional values merged into generator output
          addonVersion: "1.2.0"
  template:
    metadata:
      name: "cluster-addons-{{name}}"
    spec:
      project: cluster-addons
      source:
        repoURL: https://github.com/support-tools/cluster-addons.git
        targetRevision: HEAD
        path: addons
        helm:
          values: |
            cluster:
              name: {{name}}
              server: {{server}}
              region: {{metadata.labels.region}}
            addonVersion: {{values.addonVersion}}
      destination:
        server: "{{server}}"
        namespace: cluster-addons
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

Register clusters as ArgoCD secrets with appropriate labels:

```bash
# Register a production cluster
argocd cluster add prod-us-east-1 \
  --name prod-us-east-1 \
  --label cluster-type=production \
  --label region=us-east-1 \
  --label tier=critical

argocd cluster add prod-us-west-2 \
  --name prod-us-west-2 \
  --label cluster-type=production \
  --label region=us-west-2 \
  --label tier=standard
```

### Matrix Generator

Combine two generators to create a Cartesian product of their outputs:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: multi-cluster-multi-env
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # First generator: cluster list
          - clusters:
              selector:
                matchLabels:
                  cluster-type: application
          # Second generator: environment configurations from git
          - git:
              repoURL: https://github.com/support-tools/environments.git
              revision: HEAD
              files:
                - path: "configs/*/values.yaml"
  template:
    metadata:
      name: "{{path.basename}}-{{name}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/support-tools/app-charts.git
        targetRevision: HEAD
        path: charts/application
        helm:
          valueFiles:
            - "../../environments/configs/{{path.basename}}/values.yaml"
          values: |
            cluster: {{name}}
      destination:
        server: "{{server}}"
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Merge Generator

Combine multiple generators, with later generators overriding earlier ones based on a merge key:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: merged-config
  namespace: argocd
spec:
  generators:
    - merge:
        mergeKeys:
          - server
        generators:
          # Base: all clusters with defaults
          - clusters:
              values:
                replicaCount: "2"
                imageTag: stable
          # Override: specific clusters with custom values from git files
          - git:
              repoURL: https://github.com/support-tools/cluster-overrides.git
              revision: HEAD
              files:
                - path: "overrides/*.yaml"
  template:
    metadata:
      name: "myapp-{{name}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/support-tools/myapp.git
        targetRevision: HEAD
        path: helm
        helm:
          values: |
            replicaCount: {{values.replicaCount}}
            image:
              tag: {{values.imageTag}}
      destination:
        server: "{{server}}"
        namespace: myapp
```

## Section 3: Go Template Engine

ApplicationSets support Go templates for more expressive parameter substitution than the default `{{param}}` syntax.

### Enabling Go Templates

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: go-template-example
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - list:
        elements:
          - cluster: production
            region: us-east-1
            weight: 100
          - cluster: staging
            region: us-west-2
            weight: 50
  template:
    metadata:
      name: "myapp-{{.cluster}}"
      labels:
        region: "{{.region}}"
      annotations:
        # Conditional annotation using Go template logic
        rollout-weight: "{{if eq .cluster \"production\"}}100{{else}}{{.weight}}{{end}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/support-tools/myapp.git
        targetRevision: HEAD
        path: "helm/{{.cluster}}"
        helm:
          values: |
            cluster: {{.cluster}}
            region: {{.region}}
            {{- if eq .cluster "production" }}
            highAvailability: true
            replicaCount: 3
            {{- else }}
            highAvailability: false
            replicaCount: 1
            {{- end }}
      destination:
        server: https://kubernetes.default.svc
        namespace: "myapp-{{.cluster}}"
```

### String Manipulation with Go Templates

```yaml
# Available template functions (Sprig library)
# .cluster | upper                     → PRODUCTION
# .cluster | title                     → Production
# .cluster | replace "-" "_"           → production_us
# printf "%s-%s" .cluster .region      → production-us-east-1
# trimSuffix "-prod" .cluster          → myapp
# .weight | int | mul 2                → 200 (integer operations)
# now | date "2006-01-02"              → current date
# .tags | join ","                     → "tag1,tag2,tag3"
```

### Conditional Sync Policies with Go Templates

```yaml
  template:
    spec:
      syncPolicy:
        {{- if eq .environment "production" }}
        automated:
          prune: false
          selfHeal: true
        {{- else }}
        automated:
          prune: true
          selfHeal: true
        {{- end }}
        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
          {{- if eq .environment "production" }}
          - ApplyOutOfSyncOnly=true
          {{- end }}
```

## Section 4: Progressive Sync with Waves and Hooks

Progressive sync allows ApplicationSets to deploy applications in ordered stages, waiting for each stage to become healthy before proceeding.

### RollingSync Strategy

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: progressive-rollout
  namespace: argocd
spec:
  strategy:
    type: RollingSync
    rollingSync:
      steps:
        # Step 1: Deploy to canary (5% of clusters)
        - matchExpressions:
            - key: environment
              operator: In
              values: [canary]
          maxUpdate: 1

        # Step 2: Deploy to staging clusters (all at once)
        - matchExpressions:
            - key: environment
              operator: In
              values: [staging]
          maxUpdate: "100%"

        # Step 3: Deploy to production, one at a time
        - matchExpressions:
            - key: environment
              operator: In
              values: [production]
          maxUpdate: 1
  generators:
    - clusters:
        selector:
          matchExpressions:
            - key: environment
              operator: In
              values: [canary, staging, production]
  template:
    metadata:
      name: "myapp-{{name}}"
      labels:
        environment: "{{metadata.labels.environment}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/support-tools/myapp.git
        targetRevision: HEAD
        path: helm
      destination:
        server: "{{server}}"
        namespace: myapp
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Sync Waves for Dependency Ordering

Within a single Application, sync waves control resource ordering:

```yaml
# Add sync wave annotations to resources within a Helm chart
# or Kustomize overlay:

# Wave 0: Namespaces and CRDs
apiVersion: v1
kind: Namespace
metadata:
  name: myapp
  annotations:
    argocd.argoproj.io/sync-wave: "0"
---
# Wave 1: Secrets and ConfigMaps
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  annotations:
    argocd.argoproj.io/sync-wave: "1"
---
# Wave 2: Database migrations (via Job)
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/sync-wave: "2"
    argocd.argoproj.io/hook: Sync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
---
# Wave 3: Application Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  annotations:
    argocd.argoproj.io/sync-wave: "3"
---
# Wave 4: Ingress (after app is healthy)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp-ingress
  annotations:
    argocd.argoproj.io/sync-wave: "4"
```

## Section 5: Cluster-Scoped vs Namespace-Scoped Deployments

### Namespace-Scoped ApplicationSet

When the ApplicationSet manages resources in a single namespace, restrict it accordingly:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: namespace-scoped-apps
  namespace: team-a-argocd
spec:
  # This ApplicationSet can only create Applications in its own namespace
  generators:
    - list:
        elements:
          - app: frontend
          - app: backend
          - app: worker
  template:
    metadata:
      name: "team-a-{{.app}}"
      namespace: team-a-argocd
    spec:
      project: team-a
      source:
        repoURL: https://github.com/support-tools/team-a.git
        targetRevision: HEAD
        path: "{{.app}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: team-a
```

### AppProject for Multi-Tenant Isolation

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-a
  namespace: argocd
spec:
  description: "Team A project with restricted access"
  sourceRepos:
    - "https://github.com/support-tools/team-a.git"
    - "https://charts.example.com/*"
  destinations:
    - namespace: team-a
      server: https://kubernetes.default.svc
    - namespace: team-a-staging
      server: https://kubernetes.default.svc
  clusterResourceWhitelist: []
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota
    - group: ""
      kind: LimitRange
  roles:
    - name: team-a-developer
      description: "Team A developer access"
      policies:
        - p, proj:team-a:team-a-developer, applications, get, team-a/*, allow
        - p, proj:team-a:team-a-developer, applications, sync, team-a/*, allow
        - p, proj:team-a:team-a-developer, applications, create, team-a/*, allow
      groups:
        - team-a
```

## Section 6: Notification Triggers

Configure ArgoCD notifications to alert on ApplicationSet-generated Application events:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  # Slack notification template for application sync
  template.app-sync-status: |
    message: |
      Application {{.app.metadata.name}} sync status: {{.app.status.sync.status}}
      Health: {{.app.status.health.status}}
      Revision: {{.app.status.sync.revision}}
    slack:
      attachments: |
        [{
          "title": "{{.app.metadata.name}}",
          "title_link": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}",
          "color": "{{if eq .app.status.sync.status \"Synced\"}}good{{else}}danger{{end}}",
          "fields": [
            {"title": "Sync Status", "value": "{{.app.status.sync.status}}", "short": true},
            {"title": "Health", "value": "{{.app.status.health.status}}", "short": true},
            {"title": "Revision", "value": "{{.app.status.sync.revision}}", "short": false}
          ]
        }]

  # Trigger: notify on sync failure
  trigger.on-sync-failed: |
    - when: app.status.sync.status == 'Unknown' || app.status.operationState.phase in ['Error', 'Failed']
      send: [app-sync-status]

  # Trigger: notify on degraded health
  trigger.on-health-degraded: |
    - when: app.status.health.status == 'Degraded'
      send: [app-sync-status]

  # Trigger: notify on successful sync for production only
  trigger.on-sync-succeeded-prod: |
    - when: >
        app.status.sync.status == 'Synced' &&
        app.metadata.labels["environment"] == "production"
      send: [app-sync-status]
```

Configure notifications for all ApplicationSet-generated applications via template annotations:

```yaml
  template:
    metadata:
      name: "{{.app}}-{{.environment}}"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-failed.slack: "platform-alerts"
        notifications.argoproj.io/subscribe.on-health-degraded.slack: "platform-alerts"
        notifications.argoproj.io/subscribe.on-sync-succeeded-prod.slack: "platform-deployments"
```

## Section 7: Managing Hundreds of Applications

### Repository Structure for Scale

At scale, a well-organized repository structure is essential. A common pattern separates environment configuration from application configuration:

```
gitops-config/
├── clusters/
│   ├── prod-us-east-1/
│   │   ├── cluster-values.yaml
│   │   └── apps/
│   │       ├── platform-addons/
│   │       └── tenant-apps/
│   ├── prod-us-west-2/
│   └── staging/
├── app-definitions/
│   ├── frontend/
│   │   ├── base/
│   │   └── overlays/
│   └── backend/
└── applicationsets/
    ├── cluster-addons.yaml
    ├── tenant-apps.yaml
    └── platform-services.yaml
```

### ApplicationSet for Entire Cluster Fleet

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: fleet-cluster-addons
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - matrix:
        generators:
          - clusters:
              selector:
                matchLabels:
                  managed-by: argocd
          - git:
              repoURL: https://github.com/support-tools/gitops-config.git
              revision: HEAD
              files:
                - path: "cluster-addons/*/addon.yaml"
  template:
    metadata:
      name: "{{.name}}-{{.path.basename}}"
      annotations:
        argocd.argoproj.io/managed-by: fleet-controller
    spec:
      project: cluster-addons
      source:
        repoURL: https://github.com/support-tools/gitops-config.git
        targetRevision: HEAD
        path: "{{.path}}"
        helm:
          values: |
            cluster:
              name: {{.name}}
              server: {{.server}}
              region: {{index .metadata.labels "region" | default "unknown"}}
      destination:
        server: "{{.server}}"
        namespace: "{{.addonNamespace | default \"cluster-addons\"}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

### Preventing ApplicationSet Deletion Cascade

By default, deleting an ApplicationSet deletes all generated Applications. Use the `preserveResourcesOnDeletion` policy to prevent this:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: critical-apps
  namespace: argocd
spec:
  syncPolicy:
    # Preserve generated Applications when ApplicationSet is deleted
    preserveResourcesOnDeletion: true
  generators:
    - list:
        elements:
          - app: payment-processor
            env: production
  template:
    metadata:
      name: "{{.app}}-{{.env}}"
    spec:
      project: critical
      source:
        repoURL: https://github.com/support-tools/services.git
        targetRevision: HEAD
        path: "{{.app}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{.app}}"
```

## Section 8: ApplicationSet RBAC and Security

### Limiting Generator Sources

Restrict which repositories and clusters an ApplicationSet can reference using AppProject boundaries:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: restricted-project
  namespace: argocd
spec:
  sourceRepos:
    # Only allow specific repos
    - "https://github.com/support-tools/approved-apps.git"
  destinations:
    # Only allow specific clusters and namespaces
    - server: https://prod-cluster.example.com
      namespace: "production-*"
  # Prevent ApplicationSets from targeting other projects
  roles:
    - name: applicationset-controller
      policies:
        - p, proj:restricted-project:applicationset-controller, applications, *, restricted-project/*, allow
```

### Audit ApplicationSet Generated Applications

```bash
# List all ApplicationSet-generated applications
kubectl -n argocd get applications \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.ownerReferences[0].name}{"\n"}{end}' \
  | sort -k2

# Count applications per ApplicationSet
kubectl -n argocd get applications \
  -o jsonpath='{range .items[*]}{.metadata.ownerReferences[0].name}{"\n"}{end}' \
  | sort | uniq -c | sort -rn

# Find applications that are out-of-sync
kubectl -n argocd get applications \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.sync.status}{"\n"}{end}' \
  | grep -v Synced
```

## Section 9: Rollout Strategies Across Environments

### Canary Rollout Pattern

Deploy new versions to a canary environment first, then progressively to production:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: canary-rollout
  namespace: argocd
spec:
  goTemplate: true
  strategy:
    type: RollingSync
    rollingSync:
      steps:
        - matchExpressions:
            - key: ring
              operator: In
              values: ["0"]   # canary ring: 1 cluster
          maxUpdate: 1

        - matchExpressions:
            - key: ring
              operator: In
              values: ["1"]   # early adopters: 3 clusters
          maxUpdate: 3

        - matchExpressions:
            - key: ring
              operator: In
              values: ["2"]   # general availability: all remaining
          maxUpdate: "100%"
  generators:
    - clusters:
        selector:
          matchLabels:
            app: myservice
        values:
          appVersion: "2.5.0"
  template:
    metadata:
      name: "myservice-{{.name}}"
      labels:
        ring: "{{index .metadata.labels \"ring\"}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/support-tools/myservice.git
        targetRevision: "v{{.values.appVersion}}"
        path: helm
        helm:
          values: |
            image:
              tag: {{.values.appVersion}}
            cluster: {{.name}}
      destination:
        server: "{{.server}}"
        namespace: myservice
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Environment Promotion Gate

Use a Git-based promotion workflow where merging to specific branches triggers deployment:

```yaml
# Branch-based promotion ApplicationSet
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: branch-promotion
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - environment: development
                  branch: develop
                  cluster: https://dev-cluster.example.com
                  autoSync: "true"
                - environment: staging
                  branch: staging
                  cluster: https://staging-cluster.example.com
                  autoSync: "true"
                - environment: production
                  branch: main
                  cluster: https://prod-cluster.example.com
                  autoSync: "false"
          - git:
              repoURL: https://github.com/support-tools/services.git
              revision: HEAD
              directories:
                - path: "services/*"
  template:
    metadata:
      name: "{{.path.basename}}-{{.environment}}"
    spec:
      project: "{{.environment}}"
      source:
        repoURL: https://github.com/support-tools/services.git
        targetRevision: "{{.branch}}"
        path: "{{.path}}"
      destination:
        server: "{{.cluster}}"
        namespace: "{{.path.basename}}-{{.environment}}"
      syncPolicy:
        {{- if eq .autoSync "true" }}
        automated:
          prune: true
          selfHeal: true
        {{- end }}
        syncOptions:
          - CreateNamespace=true
```

## Section 10: Observability and Debugging

### ApplicationSet Status Inspection

```bash
# Check ApplicationSet status conditions
kubectl -n argocd get applicationset fleet-cluster-addons \
  -o jsonpath='{.status.conditions}' | python3 -m json.tool

# Get events for an ApplicationSet
kubectl -n argocd get events \
  --field-selector reason=ResourceUpdated \
  | grep ApplicationSet

# View controller logs for a specific ApplicationSet
kubectl -n argocd logs deployment/argocd-applicationset-controller \
  | grep "fleet-cluster-addons"
```

### Dry-Run ApplicationSet Changes

```bash
# Preview generated Applications without applying
kubectl -n argocd apply \
  --dry-run=server \
  -f applicationset.yaml

# Use argocd CLI to render ApplicationSet
argocd appset generate applicationset.yaml
```

### Metrics for ApplicationSet Controller

```bash
# ApplicationSet controller exposes Prometheus metrics
kubectl -n argocd port-forward svc/argocd-applicationset-controller-metrics 8085:8085

# Key metrics
curl -s http://localhost:8085/metrics | grep -E "argocd_app_set|argocd_reconcile"
```

Key metrics to monitor:

```
argocd_appset_controller_reconcile_total
argocd_appset_controller_reconcile_duration_seconds
argocd_appset_controller_error_total
argocd_app_info{group="argoproj.io",kind="ApplicationSet"}
```

## Section 11: Practical Patterns for Large Deployments

### Monorepo with Selective Sync

For monorepos where changes to one service should not trigger syncs of unrelated services:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: monorepo-services
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/support-tools/monorepo.git
        revision: HEAD
        directories:
          - path: "services/*/k8s"
  template:
    metadata:
      name: "{{path[1]}}"
    spec:
      project: monorepo
      source:
        repoURL: https://github.com/support-tools/monorepo.git
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{path[1]}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          # Only sync resources that are out of sync
          - ApplyOutOfSyncOnly=true
```

### Helm Chart Version Pinning Across Clusters

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: ingress-nginx-fleet
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - clusters:
        selector:
          matchLabels:
            ingress-controller: nginx
        values:
          # Pin version per cluster tier via label
          chartVersion: "4.9.1"
  template:
    metadata:
      name: "ingress-nginx-{{.name}}"
    spec:
      project: cluster-addons
      source:
        repoURL: https://kubernetes.github.io/ingress-nginx
        chart: ingress-nginx
        targetRevision: "{{.values.chartVersion}}"
        helm:
          values: |
            controller:
              replicaCount: {{if eq (index .metadata.labels "tier") "critical"}}3{{else}}2{{end}}
              resources:
                requests:
                  cpu: 100m
                  memory: 90Mi
                limits:
                  cpu: 500m
                  memory: 512Mi
              metrics:
                enabled: true
                serviceMonitor:
                  enabled: true
      destination:
        server: "{{.server}}"
        namespace: ingress-nginx
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
```

### Cleanup and Orphan Detection

```bash
#!/bin/bash
# Find Applications no longer managed by any ApplicationSet

ALL_APPS=$(kubectl -n argocd get applications \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')

MANAGED_APPS=$(kubectl -n argocd get applications \
  -o jsonpath='{range .items[*]}{.metadata.ownerReferences[0].name}{"\t"}{.metadata.name}{"\n"}{end}' \
  | awk '$1 != "" {print $2}')

echo "Applications not managed by any ApplicationSet:"
comm -23 \
  <(echo "${ALL_APPS}" | sort) \
  <(echo "${MANAGED_APPS}" | sort)
```

This guide covers the full spectrum of ApplicationSet capabilities needed to manage multi-cluster GitOps deployments at enterprise scale. Starting with simple list generators and progressing to matrix generators with progressive sync strategies, these patterns allow teams to scale from tens to thousands of applications while maintaining clean separation of concerns and safe deployment sequencing.
