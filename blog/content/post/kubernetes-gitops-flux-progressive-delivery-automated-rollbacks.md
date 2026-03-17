---
title: "Kubernetes GitOps with Flux: Progressive Delivery and Automated Rollbacks"
date: 2029-10-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flux", "GitOps", "Progressive Delivery", "Flagger", "Automated Rollbacks", "Canary"]
categories: ["Kubernetes", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to production GitOps with Flux v2: Kustomization health checks, automated image updates, notification controller setup, Flagger integration for canary deployments, and automated rollback on metric failures."
more_link: "yes"
url: "/kubernetes-gitops-flux-progressive-delivery-automated-rollbacks/"
---

Flux v2 has matured into a full GitOps platform that goes well beyond simple manifest synchronization. Progressive delivery with Flagger allows teams to release changes incrementally, automatically rolling back when SLO metrics degrade. This guide covers the full production stack: Flux Kustomization health checks that block promotions when resources degrade, automated image update policies that create Git commits for new container images, and Flagger-managed canary deployments that use Prometheus metrics to determine whether a release should proceed or roll back.

<!--more-->

# Kubernetes GitOps with Flux: Progressive Delivery and Automated Rollbacks

## Section 1: Flux v2 Architecture

Flux v2 is structured as a set of independent controllers:

- **source-controller**: Watches GitRepository, HelmRepository, OCIRepository, and Bucket sources. Downloads and makes artifacts available.
- **kustomize-controller**: Applies Kustomization resources to the cluster by rendering Kustomize/plain manifests.
- **helm-controller**: Manages HelmRelease resources.
- **notification-controller**: Routes events to external systems (Slack, PagerDuty, GitHub).
- **image-reflector-controller**: Scans container registries and reflects image metadata.
- **image-automation-controller**: Updates image tags in Git based on policies.

```bash
# Install Flux
flux install --namespace=flux-system \
    --components=source-controller,kustomize-controller,helm-controller,notification-controller,image-reflector-controller,image-automation-controller \
    --network-policy=false

# Bootstrap to a GitHub repository
flux bootstrap github \
    --owner=example \
    --repository=fleet-infra \
    --branch=main \
    --path=clusters/production \
    --personal=false \
    --token-auth
```

## Section 2: GitRepository and Source Configuration

```yaml
# clusters/production/flux-system/flux-sources.yaml
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: fleet-infra
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/example/fleet-infra
  branch: main
  ref:
    branch: main
  secretRef:
    name: github-token
  # Verify signed commits
  verification:
    mode: HEAD
    secretRef:
      name: cosign-public-key

---
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: app-configs
  namespace: flux-system
spec:
  interval: 30s
  url: https://github.com/example/app-configs
  branch: main
  secretRef:
    name: github-token
  ignore: |
    # Ignore non-Kubernetes files
    **/*.md
    **/*.sh
    **/tests/
    .github/
```

## Section 3: Kustomization Health Checks

Flux Kustomizations can be configured to wait for health checks before marking a sync as successful. This is essential for blocking dependent deployments when an upstream service is degraded.

```yaml
# clusters/production/apps/api-gateway.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: api-gateway
  namespace: flux-system
spec:
  interval: 5m
  path: ./apps/api-gateway
  prune: true
  sourceRef:
    kind: GitRepository
    name: app-configs

  # Wait for all resources to be healthy before marking as ready
  wait: true
  timeout: 5m

  # Health checks for specific resources
  # Flux waits for all of these to be healthy
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: api-gateway
      namespace: production

    - apiVersion: apps/v1
      kind: Deployment
      name: api-gateway-worker
      namespace: production

    - apiVersion: batch/v1
      kind: Job
      name: api-gateway-migrations
      namespace: production

  # Dependencies: only reconcile after these Kustomizations are healthy
  dependsOn:
    - name: infrastructure-controllers
    - name: cert-manager
    - name: database-migrations

  # Post-build variable substitution
  postBuild:
    substitute:
      ENVIRONMENT: "production"
      REPLICAS: "3"
      IMAGE_TAG: "${IMAGE_TAG}"
    substituteFrom:
      - kind: ConfigMap
        name: cluster-vars
        optional: false
      - kind: Secret
        name: cluster-secrets
        optional: false

  # Force-apply (skip dry-run for speed, use with caution)
  force: false

  # Target namespace for all resources in this Kustomization
  targetNamespace: production
```

### Health Check Custom Rules

Flux uses the `status.conditions` field to determine health. For custom resources, implement the `Ready` condition:

```yaml
# For a custom resource to be considered healthy by Flux:
status:
  conditions:
    - type: Ready
      status: "True"
      reason: ReconciliationSucceeded
```

Custom health check assertions using the newer v1 API:

```yaml
spec:
  healthCheckExprs:
    - apiVersion: apps/v1
      kind: Deployment
      # Custom expression using CEL
      current: |
        status.readyReplicas >= 1
      failed: |
        status.unavailableReplicas > 0 and
        status.conditions.exists(c, c.type == 'Available' and c.status == 'False')
```

### Dependency Chains

```yaml
# infrastructure layer
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infrastructure-controllers
  namespace: flux-system
spec:
  interval: 10m
  path: ./infrastructure/controllers
  prune: true
  wait: true
  timeout: 10m
  sourceRef:
    kind: GitRepository
    name: fleet-infra

---
# cert-manager depends on infrastructure
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: cert-manager
  namespace: flux-system
spec:
  interval: 10m
  path: ./infrastructure/cert-manager
  prune: true
  wait: true
  timeout: 5m
  dependsOn:
    - name: infrastructure-controllers
  sourceRef:
    kind: GitRepository
    name: fleet-infra

---
# Applications depend on cert-manager
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 5m
  path: ./apps/production
  prune: true
  wait: true
  dependsOn:
    - name: cert-manager
    - name: sealed-secrets
  sourceRef:
    kind: GitRepository
    name: fleet-infra
```

## Section 4: Automated Image Updates

The image-automation-controller scans registries, updates image tags in Git, and creates commits automatically.

### Image Repository Scanning

```yaml
# Infrastructure for automated image updates
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: api-gateway
  namespace: flux-system
spec:
  image: registry.example.com/api-gateway
  interval: 1m
  # Authentication for private registry
  secretRef:
    name: registry-credentials
  # Exclude specific tags
  exclusionList:
    - "^.*\\.sig$"  # Exclude cosign signatures
    - "^latest$"    # Never auto-update to latest

---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-gateway
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-gateway
  # Only update to semver releases (no pre-release)
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"

---
# Alternative: update to latest image in a specific prefix
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-gateway-main
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-gateway
  policy:
    # Match tags like: main-abc1234-20290101120000
    alphabetical:
      order: asc
  filterTags:
    pattern: '^main-[a-f0-9]+-(?P<ts>[0-9]+)'
    extract: '$ts'
```

### Image Update Automation

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 1m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
    namespace: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: flux@example.com
        name: Flux Image Automation
      messageTemplate: |
        chore(images): update {{range .Updated.Images}}`{{.ReflectedImage}}` to `{{.NewImage}}`
        {{end}}

        Updated by Flux image-automation-controller.
        {{range .Updated.Objects}}
        - {{.Kind}} {{.Namespace}}/{{.Name}}
        {{end}}
    push:
      branch: main
  update:
    path: ./apps
    strategy: Setters
```

### Marking Deployments for Auto-Update

Add a marker comment in your deployment manifests:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: production
spec:
  template:
    spec:
      containers:
      - name: api-gateway
        # The marker tells image-automation-controller which policy to use
        image: registry.example.com/api-gateway:1.2.3 # {"$imagepolicy": "flux-system:api-gateway"}
```

When a new image matches the policy, Flux creates a commit updating `1.2.3` to the new tag.

### Multi-Environment Image Update Strategy

```yaml
# Staging: auto-update to latest main branch build
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-gateway-staging
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-gateway
  filterTags:
    pattern: '^main-[a-f0-9]+-(?P<ts>[0-9]+)'
    extract: '$ts'
  policy:
    alphabetical:
      order: asc

---
# Production: only semver tags, promoted manually
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-gateway-production
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-gateway
  policy:
    semver:
      range: ">=1.0.0"
```

## Section 5: Notification Controller

Route Flux events to external systems:

```yaml
# clusters/production/flux-system/notifications.yaml
---
# Alert provider: Slack
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-ops-alerts
  namespace: flux-system
spec:
  type: slack
  channel: ops-alerts
  secretRef:
    name: slack-webhook-secret

---
# Alert provider: GitHub commit status
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: github-status
  namespace: flux-system
spec:
  type: github
  address: https://github.com/example/app-configs
  secretRef:
    name: github-token

---
# Alert: notify on any error
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: on-error
  namespace: flux-system
spec:
  providerRef:
    name: slack-ops-alerts
  eventSeverity: error
  eventSources:
    - kind: GitRepository
      name: "*"
    - kind: Kustomization
      name: "*"
    - kind: HelmRelease
      name: "*"
  exclusionList:
    - ".*upgrade retried.*"

---
# Alert: notify on successful deployments
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: on-deploy-success
  namespace: flux-system
spec:
  providerRef:
    name: slack-ops-alerts
  eventSeverity: info
  eventSources:
    - kind: Kustomization
      name: "apps"
  summary: "Production deployment completed"

---
# Alert: update GitHub commit status
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: github-commit-status
  namespace: flux-system
spec:
  providerRef:
    name: github-status
  eventSeverity: info
  eventSources:
    - kind: Kustomization
      name: apps
```

## Section 6: Flagger Integration for Progressive Delivery

Flagger extends Flux to support canary deployments, A/B testing, and automated rollbacks.

### Flagger Installation via Flux

```yaml
# infrastructure/flagger/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: flagger
  namespace: flux-system
spec:
  interval: 10m
  chart:
    spec:
      chart: flagger
      version: "1.x"
      sourceRef:
        kind: HelmRepository
        name: flagger
        namespace: flux-system
  values:
    meshProvider: "kubernetes"  # or istio, linkerd, appmesh
    metricsServer: "http://prometheus.monitoring.svc.cluster.local:9090"
    slack:
      user: flagger
      channel: deployments
      webhookURL: ""  # Set via secretRef
    logLevel: info
    podMonitor:
      enabled: true
```

### Canary Resource

```yaml
# apps/api-gateway/canary.yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: api-gateway
  namespace: production
spec:
  # Reference to the Deployment to canary
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway

  # How traffic is split
  # For plain Kubernetes, uses Kubernetes Nginx or similar
  service:
    port: 80
    targetPort: 8080
    portName: http
    portDiscovery: true
    gateways:
      - istio-system/public-gateway  # For Istio
    headers:
      request:
        add:
          x-canary: "true"

  # Flagger analysis configuration
  analysis:
    # How often to check metrics
    interval: 1m

    # Max iterations before promotion
    threshold: 10

    # Max time to wait for a canary iteration to complete
    stepWeightPromotion: 10  # Increase traffic 10% per step

    # Stop analysis if metrics breach this many consecutive times
    stepWeight: 10
    maxWeight: 50
    # traffic goes: 0% → 10% → 20% → 30% → 40% → 50% → promote or rollback

    # Metrics that must pass for promotion
    metrics:
      # Error rate from Prometheus
      - name: error-rate
        thresholdRange:
          max: 1  # Max 1% error rate
        interval: 1m

      # Request duration p99 from Prometheus
      - name: latency
        thresholdRange:
          max: 500  # Max 500ms p99
        interval: 30s

      # Custom metric: database connection pool exhaustion
      - name: db-connections
        templateRef:
          name: db-pool-metric
          namespace: flagger-system
        thresholdRange:
          max: 80  # Max 80% pool utilization
        interval: 1m

    # Webhooks called during analysis
    webhooks:
      # Pre-rollout smoke test
      - name: smoke-test
        type: pre-rollout
        url: http://flagger-loadtester.production/
        timeout: 30s
        metadata:
          type: cmd
          cmd: "hey -z 15s -q 10 -c 2 http://api-gateway-canary.production/"

      # Load test during analysis
      - name: load-test
        url: http://flagger-loadtester.production/
        timeout: 5s
        metadata:
          type: cmd
          cmd: "hey -z 1m -q 100 -c 10 http://api-gateway.production/"

      # Notification on rollback
      - name: notify-rollback
        type: rollback
        url: https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>
        timeout: 15s
        metadata:
          payload: |
            {
              "text": "Canary rollback triggered for api-gateway"
            }
```

### Custom Metric Templates

```yaml
# infrastructure/flagger/metric-templates.yaml
---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: error-rate
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring.svc.cluster.local:9090
  query: |
    sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)",
          status=~"5.*"
        }[{{ interval }}]
      )
    ) /
    sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
        }[{{ interval }}]
      )
    ) * 100

---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: latency
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring.svc.cluster.local:9090
  query: |
    histogram_quantile(
      0.99,
      sum(
        rate(
          http_request_duration_seconds_bucket{
            namespace="{{ namespace }}",
            pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
          }[{{ interval }}]
        )
      ) by (le)
    ) * 1000

---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: db-pool-metric
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring.svc.cluster.local:9090
  query: |
    avg(
      go_db_open_connections{
        namespace="{{ namespace }}",
        pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
      } /
      go_db_max_open_connections{
        namespace="{{ namespace }}",
        pod=~"{{ target }}-[0-9a-zA-Z]+(-[0-9a-zA-Z]+)"
      }
    ) * 100
```

## Section 7: Automated Rollback Configuration

### Rollback on Metric Failures

Flagger automatically rolls back when:
1. A metric threshold is breached `threshold` consecutive times
2. A webhook returns a non-2xx status code
3. The analysis timeout is exceeded

```yaml
spec:
  analysis:
    # If error rate exceeds 5% twice in a row, rollback
    threshold: 2
    metrics:
      - name: error-rate
        thresholdRange:
          max: 5
        interval: 1m

    # Alerts on rollback
    alerts:
      - name: "Canary rollback"
        severity: error
        providerRef:
          name: slack
          namespace: flagger-system
```

### Flux Kustomization Rollback

Flux itself doesn't do rollbacks, but you can implement them via Git:

```bash
#!/bin/bash
# scripts/flux-rollback.sh
# Rolls back a Kustomization to the previous revision

set -euo pipefail

KUSTOMIZATION="${1}"
NAMESPACE="${2:-flux-system}"

# Get the last successful revision
LAST_APPLIED=$(flux get kustomization "$KUSTOMIZATION" -n "$NAMESPACE" \
    --output=json | jq -r '.status.lastAppliedRevision')

echo "Current revision: $LAST_APPLIED"

# Get the previous commit
PREVIOUS_COMMIT=$(git log --format="%H" -n 2 | tail -1)
echo "Rolling back to: $PREVIOUS_COMMIT"

# Create a revert commit
git revert --no-commit HEAD
git commit -m "revert: rollback $KUSTOMIZATION due to health failure

Reverting to: $PREVIOUS_COMMIT
Previous state: $LAST_APPLIED"

git push origin main

echo "Rollback commit pushed. Flux will reconcile within 1 minute."
```

### Automated Flux Suspend/Resume for Maintenance

```yaml
# Suspend automation during maintenance windows
apiVersion: batch/v1
kind: CronJob
metadata:
  name: flux-maintenance-window
  namespace: flux-system
spec:
  # Suspend every Tuesday 02:00 UTC
  schedule: "0 2 * * 2"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: flux-ops
            image: ghcr.io/fluxcd/flux-cli:v2.x
            command:
              - /bin/sh
              - -c
              - |
                flux suspend kustomization apps --namespace flux-system
                # Perform maintenance
                sleep 3600
                flux resume kustomization apps --namespace flux-system
          serviceAccountName: flux-ops
          restartPolicy: OnFailure
```

## Section 8: Multi-Cluster Fleet Management

```yaml
# clusters/production-eu/flux-system/cluster-sync.yaml
# Each cluster syncs from a cluster-specific path
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: cluster-sync
  namespace: flux-system
spec:
  interval: 1m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./clusters/production-eu  # Cluster-specific overrides
  prune: true
  wait: true
```

Repository structure for multi-cluster:

```
fleet-infra/
├── clusters/
│   ├── production-us/
│   │   ├── flux-system/
│   │   │   └── kustomization.yaml
│   │   └── apps/
│   │       └── kustomization.yaml  # Patches production-us-specific values
│   └── production-eu/
│       ├── flux-system/
│       └── apps/
│           └── kustomization.yaml
├── apps/
│   ├── base/              # Base app configs
│   └── overlays/
│       ├── production/    # Production values
│       └── staging/       # Staging values
└── infrastructure/
    ├── controllers/
    └── configs/
```

## Section 9: Flux Health Monitoring

```bash
# CLI status commands
flux get all -A                    # All resources across namespaces
flux get kustomizations -A         # All Kustomizations
flux get helmreleases -A           # All HelmReleases
flux get images all -A             # Image policies and automations

# Check for reconciliation errors
flux get all -A --status-selector=ready=false

# Force immediate reconciliation
flux reconcile kustomization apps --with-source

# Tail Flux logs
flux logs --follow --level=error

# Check source status
flux get sources git -A
flux get sources helm -A
```

### Prometheus Metrics for Flux

```yaml
# PodMonitor for Flux controllers
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: flux-system
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - flux-system
  selector:
    matchExpressions:
      - key: app
        operator: In
        values:
          - source-controller
          - kustomize-controller
          - helm-controller
          - notification-controller
          - image-reflector-controller
          - image-automation-controller
  podMetricsEndpoints:
    - port: http-prom
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_label_app]
          targetLabel: controller
```

Key Flux metrics:

```promql
# Reconciliation errors
sum by (exported_namespace, name, kind) (
  gotk_reconcile_condition{type="Ready",status="False"}
) > 0

# Reconciliation duration
histogram_quantile(0.99,
  rate(gotk_reconcile_duration_seconds_bucket[5m])
) by (kind, namespace)

# Suspensions (should be zero in normal operation)
sum by (kind, namespace, name) (
  gotk_suspend_status == 1
)
```

## Conclusion

Flux v2 with Flagger provides a complete GitOps progressive delivery platform. The key insight is that health checks and dependency chains transform Flux from a simple sync tool into an orchestration platform: a failing database migration blocks the application Kustomization from reconciling, preventing broken deployments from being applied. Flagger's metric-driven promotion and automatic rollback close the feedback loop between deployment and observability.

Key takeaways:
- Use `wait: true` and `healthChecks` on all Kustomizations to catch failures before they propagate
- Dependency chains (`dependsOn`) enforce deployment ordering without external orchestration
- Image update automation eliminates the toil of updating tags in every PR
- Flagger's `threshold` parameter controls sensitivity: lower values roll back faster but are more susceptible to transient blips
- Custom MetricTemplates allow Flagger to evaluate any Prometheus query for promotion decisions
