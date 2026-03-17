---
title: "Kubernetes Flux v2 GitOps: Multi-Tenancy, Source Controllers, and Notification Automation"
date: 2030-10-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flux", "GitOps", "Multi-Tenancy", "Flagger", "Helm", "Kustomize"]
categories:
- Kubernetes
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Flux v2 guide covering GitRepository and HelmRepository sources, Kustomization reconciliation, multi-tenant lockdown with RBAC, image automation controllers, notification providers, and progressive delivery with Flagger."
more_link: "yes"
url: "/kubernetes-flux-v2-gitops-multi-tenancy-source-controllers-notification-automation/"
---

Flux v2 represents a complete rewrite of the original Flux operator, moving from a monolithic model to a composable toolkit of specialized controllers. For enterprise teams managing dozens of clusters and hundreds of services, understanding how each controller fits together — and how to lock them down for multi-tenant environments — is the difference between a maintainable platform and a configuration sprawl nightmare.

<!--more-->

## The Flux v2 Controller Architecture

Flux v2 is not a single binary. It is a set of Kubernetes controllers, each responsible for a narrow domain:

- **source-controller**: Fetches and caches source artifacts (Git, Helm, OCI, S3-compatible buckets)
- **kustomize-controller**: Applies Kustomize overlays from source artifacts
- **helm-controller**: Manages HelmRelease lifecycle
- **notification-controller**: Routes events to external providers (Slack, PagerDuty, Alertmanager)
- **image-reflector-controller**: Scans container registries for new image tags
- **image-automation-controller**: Writes updated image tags back to Git

This separation means each controller can be scaled, upgraded, and audited independently.

### Installing Flux v2 with the CLI

```bash
# Install flux CLI
curl -s https://fluxcd.io/install.sh | sudo bash

# Verify prerequisites
flux check --pre

# Bootstrap against a GitHub repository
flux bootstrap github \
  --owner=my-org \
  --repository=fleet-infra \
  --branch=main \
  --path=./clusters/production \
  --personal=false \
  --token-auth=false \
  --ssh-key-algorithm=ecdsa
```

The bootstrap command commits Flux manifests to the repository and then applies them to the cluster. From that point forward, the cluster reconciles itself from Git.

### Verifying the Installation

```bash
flux check

# Expected output:
# ► checking prerequisites
# ✔ Kubernetes 1.29.2 >=1.26.0-0
# ► checking controllers
# ✔ helm-controller: deployment ready
# ✔ image-automation-controller: deployment ready
# ✔ image-reflector-controller: deployment ready
# ✔ kustomize-controller: deployment ready
# ✔ notification-controller: deployment ready
# ✔ source-controller: deployment ready
# ► checking crds
# ✔ alerts.notification.toolkit.fluxcd.io/v1beta3
# ✔ buckets.source.toolkit.fluxcd.io/v1
# ✔ gitrepositories.source.toolkit.fluxcd.io/v1
# ✔ helmcharts.source.toolkit.fluxcd.io/v1
# ✔ helmreleases.helm.toolkit.fluxcd.io/v2
# ✔ helmrepositories.source.toolkit.fluxcd.io/v1
# ✔ kustomizations.kustomize.toolkit.fluxcd.io/v1
# ✔ ocirepositories.source.toolkit.fluxcd.io/v1
# ✔ receivers.notification.toolkit.fluxcd.io/v1
# ✔ all checks passed
```

---

## Source Controllers: GitRepository and HelmRepository

The source-controller is the foundation. It pulls artifacts from external systems and exposes them as in-cluster objects that downstream controllers consume.

### GitRepository Source

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: fleet-infra
  namespace: flux-system
spec:
  interval: 1m
  url: ssh://git@github.com/my-org/fleet-infra
  ref:
    branch: main
  secretRef:
    name: flux-system
  ignore: |
    # Ignore test directories
    /tests/
    # Ignore documentation
    /docs/
    *.md
```

For organizations using signed commits, Flux can verify GPG signatures:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: app-manifests
  namespace: flux-system
spec:
  interval: 1m
  url: ssh://git@github.com/my-org/app-manifests
  ref:
    branch: main
  verify:
    mode: head
    secretRef:
      name: pgp-public-keys
  secretRef:
    name: git-credentials
```

The PGP key secret:

```bash
# Export GPG public key
gpg --export --armor <KEY_ID> > pubkey.asc

# Create the secret
kubectl create secret generic pgp-public-keys \
  --namespace=flux-system \
  --from-file=pubkey.asc
```

### HelmRepository Source

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: bitnami
  namespace: flux-system
spec:
  interval: 30m
  url: https://charts.bitnami.com/bitnami
  timeout: 60s
```

For private Helm repositories with authentication:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: internal-charts
  namespace: flux-system
spec:
  interval: 5m
  url: https://charts.internal.example.com
  secretRef:
    name: helm-registry-creds
  timeout: 60s
---
apiVersion: v1
kind: Secret
metadata:
  name: helm-registry-creds
  namespace: flux-system
type: Opaque
stringData:
  username: chart-reader
  password: <helm-registry-password>
```

### OCI Repository Source

Flux v2 supports OCI artifacts stored in container registries, enabling Helm charts and raw manifests to be distributed alongside container images:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: podinfo
  namespace: flux-system
spec:
  interval: 5m
  url: oci://ghcr.io/stefanprodan/manifests/podinfo
  ref:
    tag: latest
  verify:
    provider: cosign
    secretRef:
      name: cosign-public-key
```

---

## Kustomization Reconciliation

The kustomize-controller watches for new source artifacts and applies Kustomize overlays to the cluster.

### Basic Kustomization

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infrastructure
  namespace: flux-system
spec:
  interval: 10m
  retryInterval: 1m
  timeout: 5m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./infrastructure
  prune: true
  wait: true
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: nginx-ingress-controller
      namespace: ingress-nginx
    - apiVersion: apps/v1
      kind: Deployment
      name: cert-manager
      namespace: cert-manager
```

### Kustomization with Dependencies

Order matters in enterprise deployments. CRDs must exist before resources that use them:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: cert-manager-crds
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./infrastructure/cert-manager/crds
  prune: false
  wait: true
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: cert-manager
  namespace: flux-system
spec:
  interval: 10m
  dependsOn:
    - name: cert-manager-crds
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./infrastructure/cert-manager
  prune: true
  wait: true
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: applications
  namespace: flux-system
spec:
  interval: 5m
  dependsOn:
    - name: cert-manager
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./apps/production
  prune: true
```

### Post-Build Variable Substitution

Flux Kustomizations support variable substitution at reconciliation time, which avoids encoding environment-specific values into Git:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./apps
  prune: true
  postBuild:
    substitute:
      CLUSTER_NAME: production-us-east-1
      CLUSTER_REGION: us-east-1
      ENVIRONMENT: production
    substituteFrom:
      - kind: ConfigMap
        name: cluster-vars
      - kind: Secret
        name: cluster-secrets
```

The referenced ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-vars
  namespace: flux-system
data:
  CLUSTER_DOMAIN: prod.example.com
  MONITORING_NAMESPACE: monitoring
  ALERT_EMAIL: platform-alerts@example.com
```

In the application manifests, variables are referenced with `${VAR_NAME}` syntax:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-gateway
spec:
  rules:
    - host: api.${CLUSTER_DOMAIN}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-gateway
                port:
                  number: 80
```

---

## Multi-Tenant Lockdown with RBAC

The most critical aspect of running Flux in a shared cluster is ensuring that tenant Kustomizations cannot escalate privileges or reach outside their namespace boundaries.

### Tenant Isolation Architecture

The recommended pattern is to create a dedicated ServiceAccount per tenant and restrict the kustomize-controller to impersonate that account:

```yaml
# Tenant namespace and service account
apiVersion: v1
kind: Namespace
metadata:
  name: tenant-alpha
  labels:
    toolkit.fluxcd.io/tenant: alpha
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: flux-reconciler
  namespace: tenant-alpha
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: flux-reconciler
  namespace: tenant-alpha
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: flux-reconciler
    namespace: tenant-alpha
```

The tenant Kustomization references the per-tenant service account:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: tenant-alpha-apps
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: tenant-alpha-repo
  path: ./apps
  prune: true
  serviceAccountName: flux-reconciler
  targetNamespace: tenant-alpha
```

### Restricting Source Access with NetworkPolicy

Prevent tenant controllers from reaching arbitrary external repositories:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-external-source-fetch
  namespace: tenant-alpha
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/part-of: flux
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: flux-system
      ports:
        - protocol: TCP
          port: 9090
```

### Admission Control for Tenant Resources

Use OPA Gatekeeper or Kyverno to prevent tenants from deploying HostPath volumes, privileged containers, or NodePort services:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-host-path
spec:
  validationFailureAction: Enforce
  rules:
    - name: restrict-host-path
      match:
        resources:
          kinds:
            - Pod
          namespaceSelector:
            matchLabels:
              toolkit.fluxcd.io/tenant: alpha
      validate:
        message: "HostPath volumes are not permitted for tenant workloads."
        deny:
          conditions:
            any:
              - key: "{{ request.object.spec.volumes[].hostPath | length(@) }}"
                operator: GreaterThan
                value: "0"
```

---

## HelmRelease Management

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: podinfo
  namespace: tenant-alpha
spec:
  interval: 5m
  chart:
    spec:
      chart: podinfo
      version: ">=6.0.0 <7.0.0"
      sourceRef:
        kind: HelmRepository
        name: podinfo
        namespace: flux-system
      interval: 10m
  values:
    replicaCount: 2
    resources:
      limits:
        cpu: 200m
        memory: 128Mi
      requests:
        cpu: 100m
        memory: 64Mi
    ingress:
      enabled: true
      className: nginx
      hosts:
        - host: podinfo.${CLUSTER_DOMAIN}
          paths:
            - path: /
              pathType: Prefix
  valuesFrom:
    - kind: ConfigMap
      name: podinfo-common-values
      optional: true
    - kind: Secret
      name: podinfo-secret-values
      optional: true
  upgrade:
    remediation:
      remediateLastFailure: true
      retries: 3
      strategy: rollback
  rollback:
    timeout: 5m
    cleanupOnFail: true
  test:
    enable: true
    ignoreFailures: false
```

### Helm Chart Testing

Flux can run `helm test` after each deployment:

```yaml
spec:
  test:
    enable: true
    ignoreFailures: false
  install:
    remediation:
      retries: 3
  upgrade:
    remediation:
      retries: 3
      remediateLastFailure: true
      strategy: rollback
```

---

## Image Automation Controllers

Image automation is one of Flux's most powerful differentiators. Rather than relying on CI pipelines to update image tags in Git, the image-reflector and image-automation controllers handle this automatically.

### ImageRepository: Scanning for New Tags

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: podinfo
  namespace: flux-system
spec:
  image: ghcr.io/stefanprodan/podinfo
  interval: 5m
  secretRef:
    name: ghcr-credentials
```

### ImagePolicy: Filtering Tags

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: podinfo
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: podinfo
  policy:
    semver:
      range: ">=6.0.0 <7.0.0"
```

For non-semver tags using alphabetical ordering (common for date-stamped images):

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: app-staging
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: app-staging
  filterTags:
    pattern: "^main-[0-9]+-[a-z0-9]+"
    extract: "$timestamp"
  policy:
    alphabetical:
      order: asc
```

### ImageUpdateAutomation: Writing Back to Git

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 30m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxcdbot@example.com
        name: Flux Image Automation
      messageTemplate: |
        chore: update images

        Updated by Flux image-automation-controller.

        {{- range .Updated.Images }}
        - {{ .Repository }}: {{ .Identifier }}
        {{- end }}
    push:
      branch: main
  update:
    strategy: Setters
    path: ./apps
```

In the Kubernetes deployment manifest, annotate the field that should be updated:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: podinfo
  namespace: tenant-alpha
spec:
  template:
    spec:
      containers:
        - name: podinfo
          image: ghcr.io/stefanprodan/podinfo:6.3.6 # {"$imagepolicy": "flux-system:podinfo"}
```

---

## Notification Providers

The notification-controller handles event routing. It subscribes to events from all Flux controllers and forwards them to external systems.

### Slack Provider

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-flux-alerts
  namespace: flux-system
spec:
  type: slack
  channel: "#platform-alerts"
  secretRef:
    name: slack-webhook
---
apiVersion: v1
kind: Secret
metadata:
  name: slack-webhook
  namespace: flux-system
type: Opaque
stringData:
  address: https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>
```

### PagerDuty Provider

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: pagerduty-platform
  namespace: flux-system
spec:
  type: pagerduty
  secretRef:
    name: pagerduty-token
---
apiVersion: v1
kind: Secret
metadata:
  name: pagerduty-token
  namespace: flux-system
type: Opaque
stringData:
  token: <pagerduty-integration-key>
```

### Alerting on Reconciliation Failures

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: critical-failures
  namespace: flux-system
spec:
  summary: "Flux reconciliation failure in production cluster"
  providerRef:
    name: pagerduty-platform
  eventSeverity: error
  eventSources:
    - kind: Kustomization
      namespace: flux-system
      name: "*"
    - kind: HelmRelease
      namespace: "*"
      name: "*"
  exclusionList:
    - "error.*lookup"
    - "error.*connection refused"
```

### GitHub Commit Status Provider

For pull-request-driven workflows, Flux can post status checks back to GitHub:

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: github-status
  namespace: flux-system
spec:
  type: githubdispatch
  address: https://github.com/my-org/fleet-infra
  secretRef:
    name: github-token
---
apiVersion: v1
kind: Secret
metadata:
  name: github-token
  namespace: flux-system
type: Opaque
stringData:
  token: <github-personal-access-token>
```

### Receiver for Webhook-Triggered Reconciliation

Instead of polling on an interval, Flux can be triggered immediately by webhook:

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1
kind: Receiver
metadata:
  name: github-receiver
  namespace: flux-system
spec:
  type: github
  events:
    - "ping"
    - "push"
  secretRef:
    name: receiver-token
  resources:
    - apiVersion: source.toolkit.fluxcd.io/v1
      kind: GitRepository
      name: fleet-infra
      namespace: flux-system
```

```bash
# Get the webhook URL
kubectl get receiver github-receiver -n flux-system \
  -o jsonpath='{.status.webhookPath}'

# Output: /hook/sha256sum-of-token
# Register this at: https://github.com/my-org/fleet-infra/settings/hooks
```

---

## Progressive Delivery with Flagger

Flagger extends Flux's GitOps model with automated canary analysis. When a new image tag is reconciled into the cluster, Flagger routes traffic progressively to the new version and rolls back automatically if SLOs are violated.

### Installing Flagger

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: flagger
  namespace: flagger-system
spec:
  interval: 1h
  chart:
    spec:
      chart: flagger
      version: ">=1.30.0 <2.0.0"
      sourceRef:
        kind: HelmRepository
        name: flagger
        namespace: flux-system
  values:
    meshProvider: nginx
    metricsServer: http://prometheus-operated.monitoring:9090
    slack:
      user: flagger
      channel: "#deployments"
      webhookURL:
        secretKeyRef:
          name: flagger-slack
          key: address
    podMonitor:
      enabled: true
      namespace: flagger-system
      interval: 15s
      podLabel: app
      additionalLabels:
        release: prometheus
```

### Canary Resource Definition

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: podinfo
  namespace: tenant-alpha
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: podinfo
  progressDeadlineSeconds: 60
  service:
    port: 9898
    targetPort: 9898
    gateways:
      - public-gateway.istio-system.svc.cluster.local
    hosts:
      - podinfo.${CLUSTER_DOMAIN}
    trafficPolicy:
      tls:
        mode: ISTIO_MUTUAL
    retries:
      attempts: 3
      perTryTimeout: 1s
      retryOn: "gateway-error,connect-failure,refused-stream"
  analysis:
    interval: 1m
    threshold: 5
    maxWeight: 50
    stepWeight: 5
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        thresholdRange:
          max: 500
        interval: 1m
    webhooks:
      - name: acceptance-test
        type: pre-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 30s
        metadata:
          type: bash
          cmd: "curl -sd 'test' http://podinfo-canary.tenant-alpha:9898/token | grep token"
      - name: load-test
        url: http://flagger-loadtester.flagger-system/
        timeout: 5s
        metadata:
          cmd: "hey -z 1m -q 10 -c 2 http://podinfo-canary.tenant-alpha:9898/"
```

### Canary Promotion Workflow

When a deployment is updated, Flagger automatically creates a canary deployment and begins traffic shifting:

```bash
# Watch canary progress
watch -n 5 flux get kustomizations -A

# Check Flagger canary status
kubectl describe canary podinfo -n tenant-alpha

# Manually promote (override analysis)
kubectl annotate canary podinfo -n tenant-alpha \
  flagger.app/action=promote

# Force rollback
kubectl annotate canary podinfo -n tenant-alpha \
  flagger.app/action=rollback
```

---

## Monitoring Flux Health

### Prometheus Metrics

Flux exports metrics for all controllers. A useful recording rule:

```yaml
groups:
  - name: flux
    interval: 30s
    rules:
      - record: flux:reconciliation:failures_total
        expr: |
          sum by (kind, namespace, name) (
            increase(gotk_reconcile_error_total[5m])
          )
      - record: flux:source:duration_seconds
        expr: |
          histogram_quantile(0.99,
            sum by (le, kind, name) (
              rate(gotk_reconcile_duration_seconds_bucket[5m])
            )
          )
```

### Grafana Dashboard Queries

```promql
# Reconciliation lag
gotk_reconcile_duration_seconds{kind="Kustomization"}

# Failed reconciliations
increase(gotk_reconcile_error_total[1h])

# Source fetch failures
increase(gotk_source_artifact_request_total{status="failure"}[30m])
```

---

## Operational Runbook

### Forcing a Reconciliation

```bash
# Reconcile a specific Kustomization immediately
flux reconcile kustomization infrastructure --with-source

# Reconcile all kustomizations in the flux-system namespace
flux reconcile kustomization --all -n flux-system

# Reconcile a HelmRelease
flux reconcile helmrelease podinfo -n tenant-alpha
```

### Suspending and Resuming

```bash
# Suspend automated reconciliation (for manual intervention)
flux suspend kustomization applications -n flux-system

# Make manual changes to the cluster...

# Resume
flux resume kustomization applications -n flux-system
```

### Debugging Reconciliation Failures

```bash
# Check conditions on a Kustomization
kubectl get kustomization applications -n flux-system -o yaml \
  | yq '.status.conditions'

# Stream logs from the kustomize-controller
kubectl logs -n flux-system deploy/kustomize-controller -f \
  --since=1h | grep -E "(ERROR|WARN|name=applications)"

# Get the rendered Kustomize output for local inspection
flux build kustomization applications \
  --path ./apps/production \
  --kustomization-file ./clusters/production/apps.yaml
```

---

## Multi-Cluster Management with Fleet

For teams managing multiple clusters, the recommended pattern is a management cluster that holds the fleet inventory:

```
fleet-infra/
├── clusters/
│   ├── production-us-east-1/
│   │   ├── flux-system/           # Flux bootstrap manifests
│   │   ├── infrastructure.yaml    # Kustomization pointing to ./infrastructure
│   │   └── apps.yaml              # Kustomization pointing to ./apps/production
│   ├── production-eu-west-1/
│   │   ├── flux-system/
│   │   ├── infrastructure.yaml
│   │   └── apps.yaml
│   └── staging/
│       ├── flux-system/
│       ├── infrastructure.yaml
│       └── apps.yaml
├── infrastructure/
│   ├── cert-manager/
│   ├── ingress-nginx/
│   └── monitoring/
└── apps/
    ├── base/
    ├── production/
    └── staging/
```

Each cluster bootstraps independently from its own directory, but shares common infrastructure and application base layers through Kustomize inheritance.

---

## Security Hardening Checklist

Before promoting Flux to production, verify the following:

```bash
# 1. Confirm all controllers run as non-root
kubectl get pods -n flux-system -o json | \
  jq '.items[].spec.containers[].securityContext'

# 2. Verify no wildcard RBAC exists for tenant service accounts
kubectl auth can-i --list \
  --as=system:serviceaccount:tenant-alpha:flux-reconciler \
  -n kube-system

# 3. Check that tenant Kustomizations use targetNamespace
kubectl get kustomizations -A -o json | \
  jq '.items[] | select(.spec.targetNamespace == null) | .metadata'

# 4. Verify source-controller is not exposed externally
kubectl get svc -n flux-system source-controller -o json | \
  jq '.spec.type'

# 5. Confirm image automation only pushes to expected branches
kubectl get imageupdateautomation -A -o json | \
  jq '.items[].spec.git.push.branch'
```

---

Flux v2 provides a production-grade GitOps foundation that scales from a single team to hundreds of tenants across dozens of clusters. The key to success is treating each controller as an independent building block with well-defined boundaries, establishing per-tenant RBAC from day one, and integrating notification providers early so that reconciliation failures surface immediately rather than silently degrading cluster state.
