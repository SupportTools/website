---
title: "Flux v2 GitOps Enterprise: OCI Sources, Multi-Tenancy, and Progressive Delivery"
date: 2027-06-20T00:00:00-05:00
draft: false
tags: ["Flux", "GitOps", "Kubernetes", "CI/CD", "OCI"]
categories:
- Flux
- GitOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Flux v2 covering OCI artifact sources, multi-tenancy patterns, Flagger progressive delivery, SOPS secrets management, drift detection, and webhook-driven instant reconciliation for enterprise Kubernetes platforms."
more_link: "yes"
url: "/flux-v2-gitops-enterprise-guide/"
---

Flux v2 takes a fundamentally different approach to GitOps than ArgoCD, decomposing the reconciliation pipeline into discrete Kubernetes controllers that each handle one concern. This composable architecture makes Flux exceptionally powerful for multi-tenancy and progressive delivery scenarios, but it requires a deeper understanding of the component model to use effectively. This guide covers the patterns and configurations that matter at enterprise scale.

<!--more-->

# Flux v2 GitOps Enterprise Guide

## Section 1: Flux Architecture and Component Model

Flux v2 is built as a set of independent Kubernetes controllers that communicate through Custom Resources stored in etcd. Understanding each controller's responsibility is essential for diagnosing issues and building advanced workflows.

### Core Controllers

**source-controller** manages connections to external sources: Git repositories, Helm repositories, OCI registries, S3-compatible buckets, and Helm charts. It produces versioned artifacts that other controllers consume.

**kustomize-controller** reads Kustomization objects (Flux's `Kustomization`, not native Kustomize) and applies the manifests from a source artifact to the cluster. It handles decryption, health checks, and garbage collection.

**helm-controller** reads HelmRelease objects and drives the Helm lifecycle (install, upgrade, rollback, uninstall) using chart artifacts produced by the source controller.

**notification-controller** sends events to external systems (Slack, Teams, PagerDuty, generic webhooks) and receives webhook triggers from Git providers for instant reconciliation.

**image-reflector-controller** scans container registries and reflects available image tags into `ImageRepository` and `ImagePolicy` objects.

**image-automation-controller** updates Git repositories with new image tags discovered by the image reflector, enabling automated image promotion.

### Installation with Flux Bootstrap

Flux bootstrap installs all controllers and commits their manifests to Git, making the Flux installation itself GitOps-managed:

```bash
# Bootstrap to GitHub
flux bootstrap github \
  --owner=org \
  --repository=fleet-gitops \
  --branch=main \
  --path=clusters/production \
  --personal=false \
  --token-auth=false \
  --components-extra=image-reflector-controller,image-automation-controller

# Bootstrap to GitLab
flux bootstrap gitlab \
  --owner=org \
  --repository=fleet-gitops \
  --branch=main \
  --path=clusters/production \
  --token-auth=true \
  --components-extra=image-reflector-controller,image-automation-controller

# Bootstrap with custom tolerations (for dedicated GitOps nodes)
flux bootstrap github \
  --owner=org \
  --repository=fleet-gitops \
  --branch=main \
  --path=clusters/production \
  --toleration-keys=dedicated \
  --image-pull-secret=registry-credentials
```

### Verify Installation

```bash
# Check all Flux components are running
flux check

# List all Flux resources
flux get all -A

# Expected output:
# NAME                           REVISION        SUSPENDED  READY  MESSAGE
# gitrepository/flux-system      main/abc1234    False      True   stored artifact for revision 'main/abc1234'
# kustomization/flux-system      main/abc1234    False      True   Applied revision: main/abc1234
```

## Section 2: Source Configuration

### GitRepository Sources

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: platform-gitops
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/org/platform-gitops.git
  ref:
    branch: main
  secretRef:
    name: platform-gitops-credentials
  # Ignore specific paths to reduce reconciliation triggers
  ignore: |
    # exclude all
    /*
    # include only the clusters directory
    !/clusters/
    !/infrastructure/
  timeout: 60s
  recurseSubmodules: false
```

SSH-based authentication:

```bash
# Generate deploy key
flux create secret git platform-gitops-credentials \
  --url=ssh://git@github.com/org/platform-gitops.git \
  --ssh-key-algorithm=ecdsa \
  --ssh-ecdsa-curve=p384

# The command outputs the public key — add it to GitHub as a deploy key
```

### OCI Sources

OCI registries can store Kubernetes manifests and Helm charts as OCI artifacts, enabling supply chain security features like signing and attestation. This is one of Flux v2's most powerful differentiators.

```yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: OCIRepository
metadata:
  name: platform-manifests
  namespace: flux-system
spec:
  interval: 5m
  url: oci://ghcr.io/org/platform-manifests
  ref:
    tag: latest
  # Verify OCI artifact signature with Cosign
  verify:
    provider: cosign
    secretRef:
      name: cosign-public-key
  layerSelector:
    mediaType: "application/vnd.cncf.flux.content.v1.tar+gzip"
    operation: extract
```

The Cosign public key Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cosign-public-key
  namespace: flux-system
type: Opaque
data:
  cosign.pub: |
    LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0K...  # base64-encoded cosign public key
```

Publishing manifests as OCI artifacts in a CI pipeline:

```bash
# Package and push manifests as OCI artifact
flux push artifact oci://ghcr.io/org/platform-manifests:v1.2.3 \
  --path=./manifests \
  --source="$(git config --get remote.origin.url)" \
  --revision="$(git rev-parse HEAD)"

# Tag as latest
flux tag artifact oci://ghcr.io/org/platform-manifests:v1.2.3 \
  --tag latest

# Sign the artifact with Cosign (keyless)
cosign sign \
  --yes \
  oci://ghcr.io/org/platform-manifests:v1.2.3
```

Using an OCI repository as a Kustomization source:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: platform-manifests
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: OCIRepository
    name: platform-manifests
  path: ./production
  prune: true
  wait: true
  timeout: 5m
```

### HelmRepository Sources

```yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: HelmRepository
metadata:
  name: prometheus-community
  namespace: flux-system
spec:
  interval: 1h
  url: https://prometheus-community.github.io/helm-charts
  type: oci   # For OCI-based Helm registries like ghcr.io

---
# OCI Helm repository
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: HelmRepository
metadata:
  name: internal-charts
  namespace: flux-system
spec:
  interval: 1h
  url: oci://ghcr.io/org/helm-charts
  type: oci
  secretRef:
    name: ghcr-credentials
```

## Section 3: Kustomization Configuration

### Advanced Kustomization

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infrastructure-controllers
  namespace: flux-system
spec:
  interval: 10m
  retryInterval: 1m
  timeout: 5m
  sourceRef:
    kind: GitRepository
    name: platform-gitops
  path: ./infrastructure/controllers
  prune: true

  # Health checks — Kustomization waits until all these are healthy
  healthChecks:
  - apiVersion: apps/v1
    kind: Deployment
    name: cert-manager
    namespace: cert-manager
  - apiVersion: apps/v1
    kind: Deployment
    name: ingress-nginx-controller
    namespace: ingress-nginx

  # Ordered dependencies — this waits for CRDs before applying CRs
  dependsOn:
  - name: infrastructure-crds

  # Substitute variables from ConfigMaps and Secrets
  postBuild:
    substitute:
      cluster_name: production-us-east-1
      cluster_region: us-east-1
    substituteFrom:
    - kind: ConfigMap
      name: cluster-config
    - kind: Secret
      name: cluster-secrets
      optional: true

  # Force apply (equivalent to kubectl apply --force-conflicts)
  force: false

  # Server-side apply
  patches:
  - patch: |-
      - op: replace
        path: /metadata/annotations/meta.helm.sh~1release-namespace
        value: "infrastructure"
    target:
      kind: HelmRelease
      labelSelector: "app.kubernetes.io/managed-by=Helm"
```

### Variable Substitution

Variable substitution in Kustomizations allows environment-specific configuration without duplicating manifests:

```yaml
# ConfigMap providing cluster-specific values
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-config
  namespace: flux-system
data:
  cluster_name: production-us-east-1
  cluster_region: us-east-1
  ingress_class: nginx
  storage_class: gp3
  node_selector_key: node-role
  node_selector_value: workload
```

In the referenced manifests, use `${variable_name}` syntax:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: myapp
data:
  CLUSTER_NAME: "${cluster_name}"
  CLUSTER_REGION: "${cluster_region}"
  STORAGE_CLASS: "${storage_class}"
```

## Section 4: Multi-Tenancy

Flux's multi-tenancy model uses separate namespaces per tenant, each with scoped RBAC and source repositories. The platform team manages the tenant onboarding; tenants manage their own applications.

### Tenant Structure

```
clusters/
└── production/
    ├── flux-system/           # Platform bootstrap
    │   ├── gotk-components.yaml
    │   └── gotk-sync.yaml
    ├── tenants/               # Tenant onboarding manifests
    │   ├── kustomization.yaml
    │   ├── team-payments.yaml
    │   └── team-inventory.yaml
    └── infrastructure/        # Shared infrastructure
        ├── controllers/
        └── configs/
```

### Tenant Onboarding

The platform team creates a namespace and a `GitRepository` source scoped to the tenant's repository:

```yaml
# tenants/team-payments.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    toolkit.fluxcd.io/tenant: team-payments
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payments-reconciler
  namespace: payments
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-reconciler
  namespace: payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: payments-reconciler
  namespace: payments
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: payments-gitops
  namespace: payments
spec:
  interval: 1m
  url: https://github.com/org/payments-gitops.git
  ref:
    branch: main
  secretRef:
    name: payments-gitops-credentials
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: payments-apps
  namespace: payments
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: payments-gitops
    namespace: payments
  path: ./production
  prune: true
  # CRITICAL: scope the service account so tenant cannot access other namespaces
  serviceAccountName: payments-reconciler
  # Restrict to tenant's namespace
  targetNamespace: payments
```

### Tenant Repository Structure

The tenant's repository is self-contained:

```
payments-gitops/
├── production/
│   ├── kustomization.yaml
│   ├── deployments/
│   │   ├── payment-api.yaml
│   │   └── payment-worker.yaml
│   ├── services/
│   └── configs/
└── staging/
    └── ...
```

### Cross-Namespace Source References

For shared Helm repositories, tenants reference sources in `flux-system` but are blocked from creating cluster-scoped resources:

```yaml
# HelmRelease in tenant namespace referencing shared HelmRepository
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: payment-api
  namespace: payments
spec:
  interval: 10m
  chart:
    spec:
      chart: payment-api
      version: ">=1.0.0"
      sourceRef:
        kind: HelmRepository
        name: internal-charts
        namespace: flux-system  # Cross-namespace reference requires allow-cross-namespace-refs
```

Enable cross-namespace source references in the Flux configuration:

```yaml
# kustomize-controller args
- --default-service-account=kustomize-controller
- --allow-namespace-cross-references=true
```

## Section 5: HelmRelease Management

### Complete HelmRelease Example

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: kube-prometheus-stack
  namespace: monitoring
spec:
  interval: 1h
  releaseName: kube-prometheus-stack
  chart:
    spec:
      chart: kube-prometheus-stack
      version: ">=57.0.0 <58.0.0"
      sourceRef:
        kind: HelmRepository
        name: prometheus-community
        namespace: flux-system
      # Verify chart signature
      verify:
        provider: cosign

  # Upgrade strategy
  install:
    createNamespace: true
    remediation:
      retries: 3
  upgrade:
    cleanupOnFail: true
    remediation:
      retries: 3
      remediateLastFailure: true
      strategy: rollback
  rollback:
    timeout: 10m
    cleanupOnFail: true
    recreate: false

  # Drift detection — reconcile on any drift
  driftDetection:
    mode: enabled
    ignore:
    - paths: ["/spec/replicas"]
      target:
        kind: Deployment

  # Values from multiple sources (later sources override earlier)
  valuesFrom:
  - kind: ConfigMap
    name: prometheus-common-values
    optional: false
  - kind: Secret
    name: prometheus-secret-values
    optional: true

  # Inline values (lowest priority — overridden by valuesFrom)
  values:
    grafana:
      enabled: true
      adminPassword: "${grafana_admin_password}"
      ingress:
        enabled: true
        ingressClassName: nginx
        hosts:
        - grafana.example.com
    prometheus:
      prometheusSpec:
        retention: 30d
        replicas: 2
        shards: 1
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: 2
            memory: 8Gi
        storageSpec:
          volumeClaimTemplate:
            spec:
              storageClassName: gp3
              accessModes: [ReadWriteOnce]
              resources:
                requests:
                  storage: 100Gi

  # Post-renderer for final manifest transformation
  postRenderers:
  - kustomize:
      patches:
      - target:
          kind: Deployment
          labelSelector: "app.kubernetes.io/name=grafana"
        patch: |-
          - op: add
            path: /spec/template/spec/tolerations/-
            value:
              key: "monitoring"
              operator: "Equal"
              value: "true"
              effect: "NoSchedule"
```

## Section 6: Secrets Management with SOPS

Flux integrates with Mozilla SOPS for encrypting secrets in Git repositories. Encrypted secrets are decrypted at apply time using keys from a KMS provider or a Kubernetes Secret.

### SOPS with Age Encryption

```bash
# Generate age key pair
age-keygen -o age.agekey

# Store the private key in Kubernetes
cat age.agekey |
kubectl create secret generic sops-age \
  --namespace=flux-system \
  --from-file=age.agekey=/dev/stdin

# Configure .sops.yaml at the root of the repository
cat > .sops.yaml << 'EOF'
creation_rules:
  - path_regex: .*/production/.*\.yaml
    age: age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  - path_regex: .*/staging/.*\.yaml
    age: age1yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
  - path_regex: .*/secrets/.*\.yaml
    age: >-
      age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,
      age1yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
EOF
```

Encrypting a Secret:

```bash
# Create a plain secret YAML
cat > secret.yaml << 'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: myapp
type: Opaque
stringData:
  username: myapp_user
  password: SuperSecretPassword123
EOF

# Encrypt with SOPS
sops --encrypt --in-place secret.yaml

# The encrypted file can now be committed to Git
git add secret.yaml
git commit -m "feat: add encrypted db credentials"
```

The decryption configuration in the Kustomization:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: myapp-secrets
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: platform-gitops
  path: ./production/secrets
  prune: true
  decryption:
    provider: sops
    secretRef:
      name: sops-age  # The Secret containing the age private key
```

### SOPS with AWS KMS

```yaml
# .sops.yaml for AWS KMS
creation_rules:
  - path_regex: .*/production/.*\.yaml
    kms: arn:aws:kms:us-east-1:123456789012:key/mrk-1234567890abcdef1234567890abcdef
  - path_regex: .*/staging/.*\.yaml
    kms: arn:aws:kms:us-east-1:123456789012:key/mrk-abcdef1234567890abcdef1234567890
```

The Flux kustomize-controller needs IAM permissions to call KMS. Use IRSA or Workload Identity:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kustomize-controller
  namespace: flux-system
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/flux-kms-decrypt
```

## Section 7: Progressive Delivery with Flagger

Flagger extends Flux with automated canary deployments, A/B testing, and blue/green deployments with automatic rollback based on metrics.

### Flagger Installation

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: flagger
  namespace: flux-system
spec:
  interval: 1h
  chart:
    spec:
      chart: flagger
      version: ">=1.36.0"
      sourceRef:
        kind: HelmRepository
        name: flagger
        namespace: flux-system
  values:
    meshProvider: nginx          # or istio, linkerd, appmesh
    metricsServer: http://prometheus:9090
    slack:
      user: flagger
      channel: deployments
      url: ""   # Configure via Kubernetes Secret
    podMonitorSelector:
      matchLabels:
        app.kubernetes.io/managed-by: flagger
```

### Canary Resource

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: payment-api
  namespace: payments
spec:
  # Target deployment (Flagger manages its rollout)
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-api

  # Autoscaler integration
  autoscalerRef:
    apiVersion: autoscaling/v2
    kind: HorizontalPodAutoscaler
    name: payment-api

  # Progressive delivery configuration
  progressDeadlineSeconds: 600
  service:
    port: 8080
    targetPort: 8080
    gateways:
    - public-gateway.istio-system.svc.cluster.local
    hosts:
    - payments.example.com
    retries:
      attempts: 3
      perTryTimeout: 1s
      retryOn: "gateway-error,connect-failure,refused-stream"

  analysis:
    # Canary step interval
    interval: 1m
    # Maximum number of failed checks before rollback
    threshold: 5
    # Maximum traffic weight routed to canary
    maxWeight: 50
    # Traffic weight increment per step
    stepWeight: 5

    # Custom metrics from Prometheus
    metrics:
    - name: request-success-rate
      interval: 1m
      thresholdRange:
        min: 99
      query: |
        sum(
          rate(
            http_requests_total{
              namespace="{{ namespace }}",
              service="{{ service }}",
              status!~"5.*"
            }[1m]
          )
        )
        /
        sum(
          rate(
            http_requests_total{
              namespace="{{ namespace }}",
              service="{{ service }}"
            }[1m]
          )
        ) * 100

    - name: request-duration
      interval: 1m
      thresholdRange:
        max: 500
      query: |
        histogram_quantile(
          0.99,
          sum(
            rate(
              http_request_duration_seconds_bucket{
                namespace="{{ namespace }}",
                service="{{ service }}"
              }[1m]
            )
          ) by (le)
        ) * 1000

    # Load testing webhook
    webhooks:
    - name: load-test
      url: http://flagger-loadtester.testing/
      timeout: 5s
      metadata:
        type: cmd
        cmd: "hey -z 1m -q 10 -c 2 http://payment-api-canary.payments/"

    # Acceptance test webhook
    - name: acceptance-test
      type: pre-rollout
      url: http://flagger-loadtester.testing/
      timeout: 30s
      metadata:
        type: bash
        cmd: |
          curl -sf http://payment-api-canary.payments/health | \
          jq -e '.status == "healthy"'
```

### Monitoring Canary Rollouts

```bash
# Watch canary progression
kubectl get canary -n payments -w

# Get detailed status
kubectl describe canary payment-api -n payments

# Flux CLI — watch HelmRelease
flux get helmreleases -n payments -w

# View Flagger events
kubectl get events -n payments \
  --field-selector reason=Synced \
  --sort-by='.lastTimestamp'
```

## Section 8: Notifications and Alerts

### Notification Configuration

```yaml
# Provider (Slack)
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-platform
  namespace: flux-system
spec:
  type: slack
  channel: platform-gitops
  secretRef:
    name: slack-webhook-platform

---
# Provider (GitHub status checks)
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: github-status
  namespace: flux-system
spec:
  type: githubdispatch
  address: https://github.com/org/platform-gitops
  secretRef:
    name: github-token

---
# Alert for sync failures
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: platform-sync-failures
  namespace: flux-system
spec:
  summary: "Platform GitOps sync failure"
  providerRef:
    name: slack-platform
  eventSeverity: error
  eventSources:
  - kind: GitRepository
    name: "*"
  - kind: Kustomization
    name: "*"
  - kind: HelmRelease
    name: "*"
  exclusionList:
  - "^Dependencies do not meet ready condition"

---
# Alert for successful deployments
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: platform-deployments
  namespace: flux-system
spec:
  summary: "Platform deployment completed"
  providerRef:
    name: slack-platform
  eventSeverity: info
  eventSources:
  - kind: Kustomization
    name: "*"
    namespace: "*"
  inclusionList:
  - ".*Applied revision.*"
```

The Slack webhook Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: slack-webhook-platform
  namespace: flux-system
type: Opaque
stringData:
  address: "https://hooks.slack.com/services/TXXXXXXXXX/BXXXXXXXXX/REPLACE_WITH_YOUR_WEBHOOK_TOKEN"
```

## Section 9: Webhook Receivers for Instant Reconciliation

Flux can receive webhook events from Git providers to trigger immediate reconciliation, eliminating polling lag.

### GitHub Webhook Receiver

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
    name: github-webhook-token
  resources:
  - apiVersion: source.toolkit.fluxcd.io/v1
    kind: GitRepository
    name: platform-gitops
    namespace: flux-system
```

Generate a random token and create the Secret:

```bash
TOKEN=$(head -c 12 /dev/urandom | shasum | head -c 20)
echo $TOKEN

kubectl create secret generic github-webhook-token \
  --from-literal=token=${TOKEN} \
  --namespace flux-system
```

Get the receiver URL to configure in GitHub:

```bash
kubectl get receiver github-receiver -n flux-system -o jsonpath='{.status.webhookPath}'
# Output: /hook/sha256sum...

# Full URL: https://flux-webhook.example.com/hook/sha256sum...
```

### GitLab Webhook Receiver

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1
kind: Receiver
metadata:
  name: gitlab-receiver
  namespace: flux-system
spec:
  type: gitlab
  events:
  - "Push Hook"
  - "Tag Push Hook"
  secretRef:
    name: gitlab-webhook-token
  resources:
  - apiVersion: source.toolkit.fluxcd.io/v1
    kind: GitRepository
    name: platform-gitops
  - apiVersion: source.toolkit.fluxcd.io/v1beta2
    kind: HelmRepository
    name: internal-charts
```

Expose the receiver through an Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: flux-webhook
  namespace: flux-system
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - flux-webhook.example.com
    secretName: flux-webhook-tls
  rules:
  - host: flux-webhook.example.com
    http:
      paths:
      - path: /hook/
        pathType: Prefix
        backend:
          service:
            name: webhook-receiver
            port:
              number: 80
```

## Section 10: Drift Detection and Remediation

Flux's drift detection continuously reconciles the cluster state back to Git, providing automatic remediation of manual changes.

### Kustomization Drift Detection

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: production-workloads
  namespace: flux-system
spec:
  interval: 5m         # Reconcile every 5 minutes
  retryInterval: 30s
  timeout: 3m
  sourceRef:
    kind: GitRepository
    name: platform-gitops
  path: ./production/workloads
  prune: true          # Delete resources removed from Git

  # Force reconciliation even if source hasn't changed
  force: false

  # Wait for resources to become healthy before marking done
  wait: true
  healthChecks:
  - apiVersion: apps/v1
    kind: Deployment
    name: "*"
    namespace: "production-*"
```

### Suspending and Resuming Reconciliation

```bash
# Suspend reconciliation for maintenance
flux suspend kustomization production-workloads
flux suspend helmrelease -n monitoring kube-prometheus-stack

# Suspend all HelmReleases in a namespace
flux suspend helmrelease --all -n monitoring

# Resume after maintenance
flux resume kustomization production-workloads
flux resume helmrelease -n monitoring kube-prometheus-stack

# Force immediate reconciliation (bypasses interval)
flux reconcile source git platform-gitops
flux reconcile kustomization production-workloads --with-source
flux reconcile helmrelease -n monitoring kube-prometheus-stack
```

## Section 11: Image Automation

Image automation enables fully automated updates when new container images are published.

### Image Scanning Configuration

```yaml
# Scan image repository for new tags
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: payment-api
  namespace: payments
spec:
  image: ghcr.io/org/payment-api
  interval: 5m
  secretRef:
    name: ghcr-credentials

---
# Policy to select the latest semver tag
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: payment-api
  namespace: payments
spec:
  imageRepositoryRef:
    name: payment-api
  policy:
    semver:
      range: ">=1.0.0"
  # Filter by tag prefix
  filterTags:
    pattern: "^v[0-9]+\\.[0-9]+\\.[0-9]+$"
    extract: "$timestamp"
```

### Image Automation Update

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: payment-api-automation
  namespace: payments
spec:
  interval: 1m
  sourceRef:
    kind: GitRepository
    name: platform-gitops
    namespace: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@example.com
        name: Flux Bot
      messageTemplate: |
        chore(automation): update {{range .Updated.Images}}{{.}}{{end}} to latest

        Updated by Flux image automation controller.
    push:
      branch: main

  update:
    path: ./production
    strategy: Setters
```

Mark the image field in the deployment for automated updates:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: payments
spec:
  template:
    spec:
      containers:
      - name: payment-api
        image: ghcr.io/org/payment-api:v1.2.3 # {"$imagepolicy": "payments:payment-api"}
```

## Section 12: Troubleshooting and Operational Tips

### Common Diagnostic Commands

```bash
# Check source controller for sync issues
flux get sources git -A
flux logs --level=error --kind=GitRepository

# Check kustomization reconciliation
flux get kustomizations -A
flux logs --level=error --kind=Kustomization --name=production-workloads --namespace=flux-system

# Check HelmRelease status
flux get helmreleases -A
flux logs --level=error --kind=HelmRelease -n monitoring

# Get detailed reconciliation events
kubectl describe kustomization production-workloads -n flux-system | tail -30

# View all Flux events in the last hour
kubectl get events -n flux-system \
  --sort-by='.lastTimestamp' | tail -30
```

### Debugging HelmRelease Failures

```bash
# Get the rendered Helm values actually applied
kubectl get helmrelease -n monitoring kube-prometheus-stack \
  -o jsonpath='{.status.lastAppliedRevision}'

# Check Helm release history
helm history kube-prometheus-stack -n monitoring

# Get the Helm release state managed by Flux
kubectl get helmrelease kube-prometheus-stack -n monitoring \
  -o jsonpath='{.status.conditions}' | jq .

# Force Helm release re-reconciliation
flux reconcile helmrelease kube-prometheus-stack -n monitoring --reset
```

### Resetting a Failed HelmRelease

When a HelmRelease enters a failed state and remediation is exhausted:

```bash
# Suspend the HelmRelease
flux suspend helmrelease kube-prometheus-stack -n monitoring

# Manually fix the issue
helm rollback kube-prometheus-stack 5 -n monitoring

# Resume and force reconciliation
flux resume helmrelease kube-prometheus-stack -n monitoring
flux reconcile helmrelease kube-prometheus-stack -n monitoring
```

Flux v2's composable architecture, OCI source support, native SOPS integration, and deep Flagger integration make it an exceptionally capable GitOps platform for enterprises that need multi-tenancy, supply chain security, and progressive delivery as first-class concerns rather than bolt-on features.
