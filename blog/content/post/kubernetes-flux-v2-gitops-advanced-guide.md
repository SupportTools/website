---
title: "Kubernetes Flux v2 GitOps: Image Automation, Kustomize Overlays, and Multi-Tenant Deployments"
date: 2028-07-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flux", "GitOps", "Kustomize", "Image Automation"]
categories:
- Kubernetes
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Flux v2 covering image automation controllers, Kustomize overlay strategies, multi-tenant RBAC isolation, and advanced GitOps patterns for enterprise Kubernetes environments."
more_link: "yes"
url: "/kubernetes-flux-v2-gitops-advanced-guide/"
---

Flux v2 has matured into the production-grade GitOps engine of choice for organizations running Kubernetes at scale. Unlike its predecessor, Flux v2 decomposes reconciliation into discrete controllers — source, kustomize, helm, image-reflector, and image-automation — each independently tunable, observable, and restartable. This post covers the patterns that separate a toy GitOps setup from one that handles hundreds of services across dozens of clusters without operator intervention.

<!--more-->

# Kubernetes Flux v2 GitOps: Image Automation, Kustomize Overlays, and Multi-Tenant Deployments

## Section 1: Flux v2 Architecture and Bootstrap

### Controller Responsibilities

Understanding what each controller owns is critical before building complex pipelines:

- **source-controller**: Fetches and caches Git repos, Helm repos, OCI artifacts, and S3 buckets. Emits Artifact objects consumed by downstream controllers.
- **kustomize-controller**: Reads Kustomization objects and applies them via server-side apply. Handles health checking, dependency ordering, and garbage collection.
- **helm-controller**: Manages HelmRelease objects, driving Helm lifecycle operations.
- **image-reflector-controller**: Scans container registries and stores image metadata in ImageRepository and ImagePolicy objects.
- **image-automation-controller**: Writes updated image tags back to Git based on ImageUpdateAutomation policies.
- **notification-controller**: Emits and receives events via webhooks, Slack, PagerDuty, and other providers.

### Bootstrap with the Flux CLI

Install the CLI and bootstrap to a GitHub repository:

```bash
# Install Flux CLI
curl -s https://fluxcd.io/install.sh | sudo bash
flux version --client

# Pre-flight check
flux check --pre

# Bootstrap — this commits Flux manifests to the repo and applies them
export GITHUB_TOKEN=<your-pat>
flux bootstrap github \
  --owner=your-org \
  --repository=fleet-infra \
  --branch=main \
  --path=clusters/production \
  --personal=false \
  --reconcile \
  --components-extra=image-reflector-controller,image-automation-controller

# Verify all controllers are running
flux check
kubectl get pods -n flux-system
```

The bootstrap command is idempotent. Running it again with an updated `--components-extra` list adds controllers without disrupting existing reconciliation.

### Flux System Namespace Layout

After bootstrap, `clusters/production` in your Git repository will contain:

```
clusters/production/
  flux-system/
    gotk-components.yaml      # All CRDs and controller deployments
    gotk-sync.yaml            # GitRepository + Kustomization for this cluster
    kustomization.yaml        # Kustomize config tying the above together
```

For a fleet setup, mirror this under each cluster path:

```
clusters/
  production/
    flux-system/
  staging/
    flux-system/
  dev/
    flux-system/
```

---

## Section 2: GitRepository and Source Configuration

### Defining a GitRepository Source

```yaml
# infrastructure/sources/app-repo.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: app-repo
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/your-org/your-app
  ref:
    branch: main
  secretRef:
    name: app-repo-auth
  # Ignore generated files so Flux doesn't loop on its own writes
  ignore: |
    # Exclude CI artifacts
    .github/
    docs/
    tests/
  timeout: 60s
```

Create the secret for SSH or token auth:

```bash
# HTTPS token auth
flux create secret git app-repo-auth \
  --url=https://github.com/your-org/your-app \
  --username=git \
  --password=$GITHUB_TOKEN

# SSH key auth (preferred for production)
flux create secret git app-repo-ssh \
  --url=ssh://git@github.com/your-org/your-app \
  --ssh-key-algorithm=ecdsa \
  --ssh-ecdsa-curve=p521
# Then add the public key as a deploy key in GitHub
```

### OCI Source for Helm-Free Distribution

Flux v2 supports pulling Kustomize bundles directly from OCI registries:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: OCIRepository
metadata:
  name: app-manifests
  namespace: flux-system
spec:
  interval: 5m
  url: oci://ghcr.io/your-org/app-manifests
  ref:
    semver: ">=1.0.0"
  secretRef:
    name: ghcr-credentials
  verify:
    provider: cosign
    secretRef:
      name: cosign-public-key
```

Push to the OCI registry as part of your CI pipeline:

```bash
# Build and push OCI artifact
flux push artifact oci://ghcr.io/your-org/app-manifests:$(git rev-parse --short HEAD) \
  --path=./k8s/base \
  --source=$(git remote get-url origin) \
  --revision=$(git rev-parse HEAD)

# Sign with cosign
cosign sign --key cosign.key ghcr.io/your-org/app-manifests:$(git rev-parse --short HEAD)
```

---

## Section 3: Kustomize Overlays for Environment Management

### Repository Layout

A practical monorepo layout for multi-environment GitOps:

```
k8s/
  base/
    namespace.yaml
    deployment.yaml
    service.yaml
    hpa.yaml
    kustomization.yaml
  overlays/
    dev/
      kustomization.yaml
      patches/
        deployment-resources.yaml
        replicas-patch.yaml
    staging/
      kustomization.yaml
      patches/
        deployment-resources.yaml
        ingress-patch.yaml
    production/
      kustomization.yaml
      patches/
        deployment-resources.yaml
        ingress-patch.yaml
        hpa-patch.yaml
```

### Base Kustomization

```yaml
# k8s/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: myapp
resources:
  - namespace.yaml
  - deployment.yaml
  - service.yaml
  - hpa.yaml
commonLabels:
  app.kubernetes.io/name: myapp
  app.kubernetes.io/managed-by: flux
```

```yaml
# k8s/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
        - name: myapp
          image: ghcr.io/your-org/myapp:latest  # {"$imagepolicy": "flux-system:myapp"}
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
```

### Production Overlay

```yaml
# k8s/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: myapp-production
namePrefix: prod-
resources:
  - ../../base
  - ingress.yaml
  - podDisruptionBudget.yaml
patchesStrategicMerge:
  - patches/deployment-resources.yaml
  - patches/hpa-patch.yaml
images:
  - name: ghcr.io/your-org/myapp
    newTag: 1.5.3  # managed by image-automation-controller
configMapGenerator:
  - name: app-config
    envs:
      - config.env
    options:
      disableNameSuffixHash: true
```

```yaml
# k8s/overlays/production/patches/deployment-resources.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  replicas: 5
  template:
    spec:
      containers:
        - name: myapp
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
          env:
            - name: ENVIRONMENT
              value: production
            - name: LOG_LEVEL
              value: warn
```

```yaml
# k8s/overlays/production/patches/hpa-patch.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp
spec:
  minReplicas: 5
  maxReplicas: 50
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70
```

### Flux Kustomization Object

```yaml
# clusters/production/apps/myapp.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: myapp
  namespace: flux-system
spec:
  interval: 10m
  retryInterval: 2m
  timeout: 5m
  sourceRef:
    kind: GitRepository
    name: app-repo
  path: ./k8s/overlays/production
  prune: true        # Delete resources removed from Git
  wait: true         # Wait for health before marking reconciled
  force: false       # Do not force-apply; respect SSA conflicts
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: prod-myapp
      namespace: myapp-production
  postBuild:
    substitute:
      CLUSTER_NAME: production
      REGION: us-east-1
    substituteFrom:
      - kind: ConfigMap
        name: cluster-vars
      - kind: Secret
        name: cluster-secrets
        optional: true
  dependsOn:
    - name: infrastructure-controllers
    - name: cert-manager
```

---

## Section 4: Image Automation

### ImageRepository: Scanning the Registry

```yaml
# clusters/production/image-policies/myapp-imagerepository.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: myapp
  namespace: flux-system
spec:
  image: ghcr.io/your-org/myapp
  interval: 5m
  secretRef:
    name: ghcr-credentials
  # Scan only tags matching a pattern to reduce API calls
  exclusionList:
    - "^.*-SNAPSHOT$"
    - "^.*-dev$"
    - "^latest$"
```

### ImagePolicy: Selecting the Tag to Deploy

```yaml
# clusters/production/image-policies/myapp-imagepolicy.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: myapp
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: myapp
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"
  # For non-semver tags, use alphabetical or numerical
  # policy:
  #   alphabetical:
  #     order: asc
  # policy:
  #   numerical:
  #     order: asc
```

Check the selected tag:

```bash
flux get image policy myapp -n flux-system
# NAME    LATEST IMAGE                              READY   MESSAGE
# myapp   ghcr.io/your-org/myapp:1.5.3             True    Latest image tag for 'ghcr.io/your-org/myapp' updated from 1.5.2 to 1.5.3
```

### ImageUpdateAutomation: Writing Tags Back to Git

```yaml
# clusters/production/image-policies/automation.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 30m
  sourceRef:
    kind: GitRepository
    name: app-repo
    namespace: flux-system
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxbot@your-org.com
        name: Fluxbot
      messageTemplate: |
        chore(auto-update): update {{range .Updated.Images}}{{println .}}{{end}}

        Updated by Flux image-automation-controller
        Cluster: production
        Timestamp: {{now}}
    push:
      branch: main
      # For PR-based workflows, push to a separate branch:
      # branch: flux/image-updates
  update:
    path: ./k8s/overlays/production
    strategy: Setters
```

The `{"$imagepolicy": "flux-system:myapp"}` annotation comment in the deployment YAML is the marker the automation controller uses to locate and update image tags. It supports multiple formats:

```yaml
# Full image (registry + tag)
image: ghcr.io/your-org/myapp:1.5.2  # {"$imagepolicy": "flux-system:myapp"}

# Tag only (when using kustomization images field)
newTag: 1.5.2  # {"$imagepolicy": "flux-system:myapp:tag"}

# Name only
newName: ghcr.io/your-org/myapp  # {"$imagepolicy": "flux-system:myapp:name"}
```

---

## Section 5: Multi-Tenant Isolation

### Tenant Namespace Model

Flux v2 supports multi-tenancy by scoping controllers to specific namespaces using ServiceAccount impersonation. Each tenant's Kustomization runs as a ServiceAccount with limited RBAC, preventing cross-tenant access.

```yaml
# tenants/team-alpha/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha
  labels:
    toolkit.fluxcd.io/tenant: team-alpha
```

```yaml
# tenants/team-alpha/rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: team-alpha
  namespace: team-alpha
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-reconciler
  namespace: team-alpha
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin   # Scope down in practice
subjects:
  - kind: ServiceAccount
    name: team-alpha
    namespace: team-alpha
---
# Prevent team-alpha from reading other namespaces' secrets
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: team-alpha-flux-runner
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: flux-runner      # Custom role defined below
subjects:
  - kind: ServiceAccount
    name: team-alpha
    namespace: team-alpha
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: flux-runner
rules:
  - apiGroups: [""]
    resources: ["namespaces", "resourcequotas", "limitranges"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["*"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["*"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses", "networkpolicies"]
    verbs: ["*"]
```

```yaml
# tenants/team-alpha/kustomization.yaml (the Flux object)
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: team-alpha
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: team-alpha-repo
  path: ./deploy/production
  prune: true
  serviceAccountName: team-alpha    # Run as this SA — critical for isolation
  targetNamespace: team-alpha       # Restrict resource creation to this namespace
  namespaceSelectors:
    - matchLabels:
        toolkit.fluxcd.io/tenant: team-alpha
```

### Tenant Repository Bootstrap

Platform teams often let tenant teams manage their own Flux objects in a sub-path:

```yaml
# clusters/production/tenants/team-alpha.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: tenant-team-alpha
  namespace: flux-system
spec:
  interval: 1m
  sourceRef:
    kind: GitRepository
    name: fleet-infra   # The platform Git repo
  path: ./tenants/team-alpha
  prune: true
  dependsOn:
    - name: infrastructure-controllers
```

---

## Section 6: Notification and Alerting

### Slack Provider

```yaml
# infrastructure/notifications/slack-provider.yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack-alerts
  namespace: flux-system
spec:
  type: slack
  channel: "#platform-alerts"
  secretRef:
    name: slack-webhook-url
  # Optional: filter severity
```

```bash
kubectl create secret generic slack-webhook-url \
  --from-literal=address=https://hooks.slack.com/services/xxx/yyy/zzz \
  -n flux-system
```

### Alert Object

```yaml
# infrastructure/notifications/alert.yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: production-alerts
  namespace: flux-system
spec:
  summary: "Production cluster Flux alert"
  providerRef:
    name: slack-alerts
  eventSeverity: error    # info | warning | error
  eventSources:
    - kind: GitRepository
      name: "*"           # All GitRepositories
    - kind: Kustomization
      name: "*"           # All Kustomizations
    - kind: HelmRelease
      name: "*"
  inclusionList:
    - ".*failed.*"
    - ".*error.*"
```

### GitHub Commit Status Provider

```yaml
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: github-status
  namespace: flux-system
spec:
  type: github
  address: https://github.com/your-org/your-app
  secretRef:
    name: github-token
---
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
      name: myapp
```

---

## Section 7: Helm Release Management with Flux

### HelmRepository Source

```yaml
apiVersion: source.toolkit.fluxcd.io/v1beta2
kind: HelmRepository
metadata:
  name: bitnami
  namespace: flux-system
spec:
  interval: 12h
  url: https://charts.bitnami.com/bitnami
  timeout: 3m
```

### HelmRelease with Values Override

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: redis
  namespace: flux-system
spec:
  interval: 1h
  chart:
    spec:
      chart: redis
      version: ">=18.0.0 <19.0.0"
      sourceRef:
        kind: HelmRepository
        name: bitnami
      interval: 12h
  targetNamespace: redis
  install:
    remediation:
      retries: 3
    createNamespace: true
  upgrade:
    remediation:
      retries: 3
      remediateLastFailure: true
    cleanupOnFail: true
  rollback:
    timeout: 10m
    cleanupOnFail: true
  values:
    auth:
      enabled: true
      existingSecret: redis-password
    replica:
      replicaCount: 3
    metrics:
      enabled: true
      serviceMonitor:
        enabled: true
        namespace: monitoring
  # Override values from ConfigMap/Secret in cluster
  valuesFrom:
    - kind: ConfigMap
      name: redis-config
      valuesKey: values.yaml
    - kind: Secret
      name: redis-secrets
      valuesKey: values.yaml
      optional: true
```

---

## Section 8: Dependency Management and Ordering

Complex environments require explicit dependency chains. Flux supports `dependsOn` across Kustomization objects:

```yaml
# Install CRDs first
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: crds
  namespace: flux-system
spec:
  interval: 1h
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./infrastructure/crds
  prune: false    # Never prune CRDs automatically
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infrastructure-controllers
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: fleet-infra
  path: ./infrastructure/controllers
  prune: true
  dependsOn:
    - name: crds   # Wait for CRDs before applying controllers
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: applications
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: app-repo
  path: ./k8s/overlays/production
  prune: true
  dependsOn:
    - name: infrastructure-controllers
    - name: cert-manager
    - name: ingress-nginx
```

---

## Section 9: Troubleshooting and Observability

### Common Debugging Commands

```bash
# Get all Flux resources and their status
flux get all -n flux-system

# Watch reconciliation in real time
flux get kustomizations --watch

# Force immediate reconciliation
flux reconcile kustomization myapp --with-source

# Suspend reconciliation (e.g., during manual interventions)
flux suspend kustomization myapp
# Resume
flux resume kustomization myapp

# View detailed reconciliation events
flux events --for Kustomization/myapp

# View logs from specific controller
kubectl logs -n flux-system deploy/kustomize-controller -f

# Check why an image policy hasn't updated
flux get image policy myapp -v
flux get image repository myapp

# Export all Flux objects for backup
flux export --all > flux-backup.yaml
```

### Prometheus Metrics

All Flux controllers expose Prometheus metrics. Key ones to alert on:

```yaml
# Key metrics
# gotk_reconcile_duration_seconds - reconciliation latency per controller
# gotk_reconcile_condition - current ready/stalled/reconciling status
# gotk_resource_info - metadata about all managed resources

# Useful PromQL
# Reconciliation failure rate
rate(gotk_reconcile_condition{type="Ready",status="False"}[5m]) > 0

# Stalled resources
gotk_reconcile_condition{type="Stalled",status="True"} > 0

# Slow reconciliations
histogram_quantile(0.99, rate(gotk_reconcile_duration_seconds_bucket[5m])) > 60
```

### Flux Grafana Dashboard

Import dashboard ID `16714` from Grafana.com, which provides:
- Reconciliation success/failure rates per controller
- Source sync latency
- HelmRelease upgrade history
- Image update activity

### Recovery Procedures

```bash
# Controller crashloop — restart it
kubectl rollout restart deploy/kustomize-controller -n flux-system

# Corrupted state — suspend, delete resources, re-apply
flux suspend kustomization myapp
kubectl delete -n myapp-production deploy/prod-myapp   # Manual cleanup
flux resume kustomization myapp

# Force re-sync from scratch (nuclear option)
flux suspend kustomization myapp
kubectl delete gitrepository app-repo -n flux-system
kubectl apply -f infrastructure/sources/app-repo.yaml
flux resume kustomization myapp
```

---

## Section 10: Progressive Delivery with Flagger Integration

Flux integrates naturally with Flagger for canary deployments:

```yaml
# Add Flagger via HelmRelease in Flux
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
      version: ">=1.30.0"
      sourceRef:
        kind: HelmRepository
        name: flagger
  targetNamespace: flagger-system
  values:
    meshProvider: nginx
    metricsServer: http://prometheus:9090
    slack:
      user: flagger
      channel: "#deployments"
      webhookURL: ""
```

```yaml
# Canary resource managed alongside Flux Kustomization
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp
  namespace: myapp-production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: prod-myapp
  progressDeadlineSeconds: 120
  service:
    port: 80
    targetPort: 8080
  analysis:
    interval: 1m
    threshold: 5
    maxWeight: 50
    stepWeight: 10
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        thresholdRange:
          max: 500
        interval: 30s
    webhooks:
      - name: load-test
        url: http://flagger-loadtester.test/
        timeout: 5s
        metadata:
          cmd: "hey -z 1m -q 10 -c 2 http://myapp-canary.myapp-production/"
```

---

## Section 11: Production Best Practices Checklist

1. **Pin controller versions**: In `gotk-components.yaml`, pin to a specific Flux release rather than `latest`.
2. **Enable Cosign verification**: Use `spec.verify` on OCIRepository objects for supply chain security.
3. **Separate state from config**: Keep Flux system manifests (`clusters/`) separate from app manifests (`k8s/`).
4. **Use prune carefully**: Set `prune: false` for CRD Kustomizations to prevent accidental deletions.
5. **Scope service accounts**: Never run tenant Kustomizations as `cluster-admin`.
6. **Set resource limits on controllers**: Flux controllers are stateful; give them predictable resources.
7. **Backup SOPS keys**: If using SOPS for secret encryption, the key is the only thing not in Git.
8. **Test overlays locally**: `kustomize build k8s/overlays/production | kubectl apply --dry-run=client -f -`.
9. **Set reconciliation retries**: Configure `retryInterval` and retry counts on all Kustomizations.
10. **Monitor with alerting**: Connect Prometheus alerts to PagerDuty for reconciliation failures.

```bash
# Validate all Kustomize overlays locally before pushing
for env in dev staging production; do
  echo "Validating $env..."
  kustomize build k8s/overlays/$env | kubectl apply --dry-run=client -f -
done
```

Flux v2's composable architecture means you can incrementally adopt its features — start with basic GitRepository + Kustomization sync, then layer in image automation and multi-tenancy as your platform matures. The key is consistency: every resource in production should be traceable to a Git commit.
