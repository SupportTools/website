---
title: "ArgoCD Sync Waves and Hooks: Ordered Multi-Component Application Deployment"
date: 2029-02-01T00:00:00-05:00
draft: false
tags: ["ArgoCD", "GitOps", "Kubernetes", "CI/CD", "Deployment"]
categories:
- ArgoCD
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical enterprise guide to ArgoCD sync waves and resource hooks for deploying complex multi-component applications in dependency order, including database migrations, service mesh configuration, and post-deployment verification."
more_link: "yes"
url: "/argocd-sync-waves-hooks-ordered-deployment/"
---

Complex applications rarely consist of a single component. A typical enterprise service deployment might require: database schema migrations to complete before the API starts, secrets to exist before pods consume them, CRDs to be established before operators create custom resources, and post-deployment smoke tests to verify the rollout before updating the promotion status. ArgoCD sync waves and resource hooks provide the primitives to encode these ordering constraints declaratively in Git.

This guide covers the mechanics of sync waves, the lifecycle of resource hooks, and production-ready patterns for ordered deployment of multi-component systems — database migrations, service mesh configuration, and observability stack bootstrapping.

<!--more-->

## Sync Wave Fundamentals

ArgoCD processes resources in waves ordered by the `argocd.argoproj.io/sync-wave` annotation. Resources in wave 0 are applied first, then ArgoCD waits for all wave-0 resources to be healthy before starting wave 1, and so on.

Wave numbers can be any integer — negative values run before the default wave 0, allowing infrastructure resources (Namespaces, CRDs, RBAC) to precede application resources.

```
Wave -5: Namespaces, CRDs
Wave -2: RBAC (ClusterRoles, ClusterRoleBindings)
Wave  0: Secrets, ConfigMaps (default, no annotation needed)
Wave  1: PersistentVolumeClaims, Services
Wave  2: Database migrations (Jobs)
Wave  3: Application Deployments
Wave  4: HorizontalPodAutoscalers, PodDisruptionBudgets
Wave  5: Smoke test Jobs, monitoring configuration
```

The key behavior: ArgoCD considers a wave "healthy" when all resources in it reach their healthy state as defined by their health check. A Job must complete successfully. A Deployment must have all replicas ready. A Service must exist (no health check blocks Services).

## Application Structure for Ordered Deployment

```bash
# Repository structure for a multi-component application
apps/payments-service/
├── Chart.yaml
└── templates/
    ├── 00-namespace.yaml         # wave -5
    ├── 01-crds.yaml              # wave -5
    ├── 02-rbac.yaml              # wave -2
    ├── 03-secrets.yaml           # wave  0
    ├── 04-configmap.yaml         # wave  0
    ├── 05-pvc.yaml               # wave  1
    ├── 06-services.yaml          # wave  1
    ├── 07-db-migration-job.yaml  # wave  2 (hook-based)
    ├── 08-deployment.yaml        # wave  3
    ├── 09-hpa.yaml               # wave  4
    ├── 10-pdb.yaml               # wave  4
    └── 11-smoke-test-job.yaml    # wave  5 (hook-based)
```

### Namespace and CRD Wave (Wave -5)

```yaml
# 00-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    istio-injection: enabled
    platform.company.com/team: payments
    platform.company.com/env: production
  annotations:
    argocd.argoproj.io/sync-wave: "-5"
---
# 01-crds.yaml — Installing a CRD that the operator in wave 3 will use
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: paymentprocessors.payments.company.com
  annotations:
    argocd.argoproj.io/sync-wave: "-5"
spec:
  group: payments.company.com
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                provider:
                  type: string
                  enum: ["stripe", "braintree", "adyen"]
                webhookSecret:
                  type: string
  scope: Namespaced
  names:
    plural: paymentprocessors
    singular: paymentprocessor
    kind: PaymentProcessor
```

### RBAC Wave (Wave -2)

```yaml
# 02-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payments-service
  namespace: payments
  annotations:
    argocd.argoproj.io/sync-wave: "-2"
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/payments-service-production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: payments-service
  namespace: payments
  annotations:
    argocd.argoproj.io/sync-wave: "-2"
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["payments-db-credentials", "stripe-webhook-secret"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-service
  namespace: payments
  annotations:
    argocd.argoproj.io/sync-wave: "-2"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: payments-service
subjects:
  - kind: ServiceAccount
    name: payments-service
    namespace: payments
```

## Database Migration Hook

Database migrations are the canonical use case for ArgoCD sync hooks. The migration Job must complete before the application starts — otherwise the new application code may find a schema that doesn't match its expectations.

```yaml
# 07-db-migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: payments-db-migrate
  namespace: payments
  annotations:
    # Run as a PreSync hook AND in wave 2 for non-hook syncs
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
    argocd.argoproj.io/sync-wave: "2"
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 300
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        app: payments-db-migrate
        version: "3.2.1"
    spec:
      restartPolicy: Never
      serviceAccountName: payments-service
      initContainers:
        - name: wait-for-db
          image: registry.company.com/tools/wait-for:1.0.0
          command:
            - /wait-for
            - --timeout=60s
            - postgres-primary.payments.svc.cluster.local:5432
      containers:
        - name: migrate
          image: registry.company.com/payments/api:3.2.1
          command:
            - /app/payments-api
            - migrate
            - --direction=up
            - --verbose
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: payments-db-credentials
                  key: url
            - name: MIGRATION_TIMEOUT
              value: "240s"
            - name: DRY_RUN
              value: "false"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
```

### Hook Delete Policies

Three delete policies control when ArgoCD removes hook resources:

| Policy | When Deleted |
|---|---|
| `HookSucceeded` | After successful completion |
| `HookFailed` | After failed completion |
| `BeforeHookCreation` | Before creating the hook on the next sync |

For migration jobs, `BeforeHookCreation` is the safest choice: the previous job (with its logs) remains visible in the cluster until the next sync, giving operators time to investigate failures.

```yaml
# Annotation combinations for different scenarios

# Migration job: keep for debugging, replace on next sync
argocd.argoproj.io/hook: PreSync
argocd.argoproj.io/hook-delete-policy: BeforeHookCreation

# Smoke test: delete after success, keep on failure for debugging
argocd.argoproj.io/hook: PostSync
argocd.argoproj.io/hook-delete-policy: HookSucceeded

# Cleanup job: always delete (e.g., secret scrubbing)
argocd.argoproj.io/hook: PostSync
argocd.argoproj.io/hook-delete-policy: HookSucceeded,HookFailed
```

## Application Deployment Wave (Wave 3)

```yaml
# 08-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments
  labels:
    app: payments-api
    version: "3.2.1"
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payments-api
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: payments-api
        version: "3.2.1"
      annotations:
        # Force pod restart when configmap changes (hash populated at deploy time)
        checksum/config: "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6"
        # Force pod restart when secret changes (hash populated at deploy time)
        checksum/secret: "b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9"
    spec:
      serviceAccountName: payments-service
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payments-api
      containers:
        - name: api
          image: registry.company.com/payments/api:3.2.1
          ports:
            - name: http
              containerPort: 8080
            - name: grpc
              containerPort: 50051
            - name: metrics
              containerPort: 9090
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: payments-db-credentials
                  key: url
            - name: STRIPE_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: stripe-webhook-secret
                  key: api-key
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: 1000m
              memory: 1Gi
```

## Post-Sync Smoke Test Hook

After all components are deployed, a post-sync hook validates end-to-end functionality before ArgoCD marks the sync as complete.

```yaml
# 11-smoke-test-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: payments-smoke-test
  namespace: payments
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 120
  template:
    metadata:
      labels:
        app: payments-smoke-test
    spec:
      restartPolicy: Never
      serviceAccountName: payments-service
      containers:
        - name: smoke-test
          image: registry.company.com/tools/http-checker:2.1.0
          command:
            - /bin/sh
            - -c
            - |
              set -e
              BASE_URL="http://payments-api.payments.svc.cluster.local:8080"

              echo "=== Checking health endpoint ==="
              curl -sf --max-time 10 "${BASE_URL}/healthz" | jq .

              echo "=== Checking readiness endpoint ==="
              curl -sf --max-time 10 "${BASE_URL}/readyz" | jq .

              echo "=== Checking API version ==="
              VERSION=$(curl -sf --max-time 10 "${BASE_URL}/version" | jq -r '.version')
              echo "Running version: ${VERSION}"

              echo "=== Checking database connectivity ==="
              curl -sf --max-time 15 "${BASE_URL}/v1/health/db" | jq .

              echo "=== All smoke tests passed ==="
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 100m
              memory: 128Mi
```

## ArgoCD Application Configuration

The Application resource ties everything together with the correct sync options.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-service
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: payments-team
  source:
    repoURL: https://github.com/company/platform-config.git
    targetRevision: HEAD
    path: apps/payments-service
    helm:
      valueFiles:
        - values.yaml
        - values-production.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: payments
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=true
      - PruneLast=true
      - RespectIgnoreDifferences=true
      - ApplyOutOfSyncOnly=true
    retry:
      limit: 3
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
  revisionHistoryLimit: 10
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas  # HPA manages this
    - group: autoscaling
      kind: HorizontalPodAutoscaler
      jqPathExpressions:
        - '.spec.metrics[] | select(.type == "Resource")'
```

## Complex Multi-App Orchestration with App of Apps

For systems spanning multiple ArgoCD Applications, the app-of-apps pattern with sync waves coordinates across application boundaries.

```yaml
# Parent application that deploys child apps in order
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-platform
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/company/platform-config.git
    targetRevision: HEAD
    path: platforms/payments
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
---
# Child app: infrastructure (wave -5)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-infrastructure
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "-5"
spec:
  project: payments-team
  source:
    repoURL: https://github.com/company/platform-config.git
    targetRevision: HEAD
    path: apps/payments-infrastructure
  destination:
    server: https://kubernetes.default.svc
    namespace: payments
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
---
# Child app: database (wave 0)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-database
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  project: payments-team
  source:
    repoURL: https://github.com/company/platform-config.git
    targetRevision: HEAD
    path: apps/payments-database
  destination:
    server: https://kubernetes.default.svc
    namespace: payments
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
---
# Child app: API services (wave 3)
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments-api
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec:
  project: payments-team
  source:
    repoURL: https://github.com/company/platform-config.git
    targetRevision: HEAD
    path: apps/payments-service
  destination:
    server: https://kubernetes.default.svc
    namespace: payments
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Monitoring Sync Wave Progress

```bash
# Watch sync status in real time
argocd app get payments-service --watch

# Get detailed sync status with hook information
argocd app get payments-service -o json | jq '
  .status.operationState |
  {
    phase: .phase,
    message: .message,
    startedAt: .startedAt,
    finishedAt: .finishedAt,
    syncResult: .syncResult.resources | map(select(.hookPhase != null)) | map({
      name: .name,
      kind: .kind,
      hookPhase: .hookPhase,
      status: .status
    })
  }'

# List all hook resources
argocd app resources payments-service | grep -E "Hook|Job"

# Force resync with pruning
argocd app sync payments-service --prune --force

# Sync a specific resource only
argocd app sync payments-service --resource apps:Deployment:payments-api

# Check sync history
argocd app history payments-service

# Roll back to previous version
argocd app rollback payments-service 2

# Get operation details for the last sync
argocd app get payments-service -o json | \
  jq '.status.operationState.syncResult.resources[] | {name, kind, status, message}'
```

## Handling Sync Failures

When a sync fails mid-wave, ArgoCD stops at the failed resource. Understanding the failure modes helps with recovery.

```bash
# Common failure: Migration job fails
# 1. Check the migration job logs
kubectl logs -n payments -l app=payments-db-migrate --tail=100

# 2. The failed hook remains in the cluster (BeforeHookCreation policy)
kubectl describe job -n payments payments-db-migrate

# 3. Fix the migration issue in code, push a new commit
# 4. The next ArgoCD sync will delete the old job before creating a new one

# Common failure: Deployment not becoming healthy (readiness probe failing)
kubectl describe deployment -n payments payments-api
kubectl get events -n payments --sort-by='.lastTimestamp' | tail -20

# Debug a specific pod
kubectl logs -n payments -l app=payments-api --previous
kubectl describe pod -n payments $(kubectl get pods -n payments -l app=payments-api -o name | head -1)

# Force an application to become healthy (last resort — use carefully)
argocd app set payments-service --sync-option "Force=true"
```

## Sync Window Configuration

Sync windows prevent ArgoCD from automatically syncing during high-traffic periods or maintenance windows.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: payments-team
  namespace: argocd
spec:
  description: "Payments platform applications"
  syncWindows:
    - kind: deny
      schedule: "0 12 * * 1-5"  # Block syncs during peak hours: noon Mon-Fri
      duration: 4h
      applications:
        - "*"
      namespaces:
        - payments
      clusters:
        - production-us-east-1
    - kind: allow
      schedule: "0 2 * * *"     # Allow syncs at 2am daily
      duration: 2h
      applications:
        - "*"
      namespaces:
        - payments
      clusters:
        - production-us-east-1
      manualSync: true
  sourceRepos:
    - "https://github.com/company/platform-config.git"
  destinations:
    - namespace: payments
      server: https://kubernetes.default.svc
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota
```

Sync waves, resource hooks, and the app-of-apps pattern together provide a complete framework for encoding complex deployment dependencies declaratively. The key principle: application ordering logic belongs in Git, not in scripts, not in CI/CD pipeline YAML that exists outside the GitOps system.
