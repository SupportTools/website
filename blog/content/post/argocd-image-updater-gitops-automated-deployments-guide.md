---
title: "ArgoCD Image Updater: Automated Container Image Updates in GitOps"
date: 2027-02-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ArgoCD", "GitOps", "CI/CD", "Automation"]
categories:
- Kubernetes
- GitOps
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to ArgoCD Image Updater for automated container image updates in GitOps workflows, covering update strategies, registry authentication, Git write-back modes, and production monitoring."
more_link: "yes"
url: "/argocd-image-updater-gitops-automated-deployments-guide/"
---

Automating container image updates is one of the most operationally tedious aspects of running Kubernetes at scale. Every time a CI pipeline produces a new image, a human must update an image tag in a Git repository before ArgoCD picks up the change. **ArgoCD Image Updater** closes that loop by watching container registries and automatically committing updated image tags back to Git — keeping the GitOps model intact while removing manual toil from the deployment chain.

<!--more-->

## Architecture Overview

ArgoCD Image Updater runs as a standalone controller alongside ArgoCD. It polls container registries at a configured interval, compares discovered tags against the policy defined on each ArgoCD Application, and writes updated image references back to the Git repository when a newer tag matches the policy.

```
CI Pipeline ──► Container Registry
                      │
              (poll every N seconds)
                      │
             ArgoCD Image Updater
                      │
              ┌───────┴────────┐
              │  Policy match? │
              └───────┬────────┘
                      │ yes
              Git write-back
              (commit or PR)
                      │
                   ArgoCD
              (detects diff, syncs)
                      │
               Kubernetes Cluster
```

Four update strategies are supported:

| Strategy | Behaviour |
|----------|-----------|
| `semver` | Tracks the highest semantic version satisfying a constraint |
| `latest` | Always uses the most recently pushed tag |
| `digest` | Pins to an immutable image digest |
| `name` | Alphabetically highest tag matching an optional regex |

## Installing ArgoCD Image Updater

### Helm Installation

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

helm install argocd-image-updater argo/argocd-image-updater \
  --namespace argocd \
  --create-namespace \
  --values image-updater-values.yaml \
  --version 0.9.6 \
  --wait
```

### Production Helm Values

```yaml
# image-updater-values.yaml
replicaCount: 2

image:
  repository: quay.io/argoprojlabs/argocd-image-updater
  tag: v0.13.1
  pullPolicy: IfNotPresent

config:
  # Check interval — 2 min default works well for most teams
  interval: 120s

  # Log level: trace, debug, info, warn, error
  logLevel: info

  # ArgoCD API endpoint (in-cluster)
  argocd.server.addr: argocd-server.argocd.svc.cluster.local:443
  argocd.insecure: "false"
  argocd.plaintext: "false"

  # Registries section — see per-registry auth below
  registries: |
    - name: DockerHub
      api_url: https://registry-1.docker.io
      ping: yes
      credentials: secret:argocd/dockerhub-credentials#creds
      credsexpire: 10h
    - name: ECR
      api_url: https://123456789012.dkr.ecr.us-east-1.amazonaws.com
      credentials: ext:/scripts/ecr-login.sh
      credsexpire: 10h
    - name: GCR
      api_url: https://gcr.io
      credentials: secret:argocd/gcr-credentials#creds
      credsexpire: 1h

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring
    additionalLabels:
      app: argocd-image-updater

rbac:
  enabled: true

serviceAccount:
  create: true
  name: argocd-image-updater
  annotations:
    # For IRSA on EKS — allows ECR token refresh without long-lived credentials
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/ArgoCD-ImageUpdater-Role

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8081"

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchExpressions:
          - key: app.kubernetes.io/name
            operator: In
            values:
            - argocd-image-updater
        topologyKey: kubernetes.io/hostname
```

### RBAC for ArgoCD Integration

Image Updater needs read/write access to ArgoCD Applications:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: argocd-image-updater
rules:
- apiGroups: ["argoproj.io"]
  resources: ["applications"]
  verbs: ["get", "list", "update", "patch"]
- apiGroups: [""]
  resources: ["secrets", "configmaps"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: argocd-image-updater
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: argocd-image-updater
subjects:
- kind: ServiceAccount
  name: argocd-image-updater
  namespace: argocd
```

## Annotation-Based Configuration

Image Updater is configured through annotations on ArgoCD `Application` resources. This keeps all update policy co-located with the application definition.

### Core Annotation Reference

```
argocd-image-updater.argoproj.io/image-list        # comma-separated image aliases
argocd-image-updater.argoproj.io/<alias>.update-strategy
argocd-image-updater.argoproj.io/<alias>.allow-tags
argocd-image-updater.argoproj.io/<alias>.ignore-tags
argocd-image-updater.argoproj.io/<alias>.force-digest
argocd-image-updater.argoproj.io/<alias>.platforms
argocd-image-updater.argoproj.io/<alias>.credentials
argocd-image-updater.argoproj.io/write-back-method
argocd-image-updater.argoproj.io/write-back-target
argocd-image-updater.argoproj.io/git-branch
argocd-image-updater.argoproj.io/git-commit-message
```

### Semver Update Strategy

Track the latest minor release in the `1.x` range:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: api-service
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: api=company/api-service
    argocd-image-updater.argoproj.io/api.update-strategy: semver
    argocd-image-updater.argoproj.io/api.allow-tags: regexp:^v1\.[0-9]+\.[0-9]+$
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: main
spec:
  project: production
  source:
    repoURL: https://github.com/company/gitops-config
    path: apps/api-service/overlays/production
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: api-service
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### Digest Pinning Strategy

Pin to an immutable digest for maximum reproducibility in production:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-service
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: payment=company/payment-service:main
    argocd-image-updater.argoproj.io/payment.update-strategy: digest
    argocd-image-updater.argoproj.io/payment.allow-tags: regexp:^main$
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/git-branch: main
spec:
  project: production
  source:
    repoURL: https://github.com/company/gitops-config
    path: apps/payment-service/overlays/production
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: payment-service
```

### Latest Strategy with Tag Filtering

Use the `latest` strategy while filtering out non-production tags using `allow-tags`:

```yaml
annotations:
  argocd-image-updater.argoproj.io/image-list: worker=company/worker
  argocd-image-updater.argoproj.io/worker.update-strategy: latest
  # Only track tags that look like release builds: YYYY-MM-DD-<sha>
  argocd-image-updater.argoproj.io/worker.allow-tags: regexp:^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-f0-9]{7}$
  # Never track experimental builds
  argocd-image-updater.argoproj.io/worker.ignore-tags: regexp:^exp-.*
```

### Multi-Image Application

Track multiple images in a single application:

```yaml
annotations:
  argocd-image-updater.argoproj.io/image-list: >-
    frontend=company/frontend,
    backend=company/backend,
    sidecar=company/envoy-sidecar
  argocd-image-updater.argoproj.io/frontend.update-strategy: semver
  argocd-image-updater.argoproj.io/frontend.allow-tags: regexp:^v[0-9]+\.[0-9]+\.[0-9]+$
  argocd-image-updater.argoproj.io/backend.update-strategy: semver
  argocd-image-updater.argoproj.io/backend.allow-tags: regexp:^v[0-9]+\.[0-9]+\.[0-9]+$
  argocd-image-updater.argoproj.io/sidecar.update-strategy: digest
  argocd-image-updater.argoproj.io/sidecar.allow-tags: regexp:^stable$
```

## Git Write-Back Modes

### Direct Commit Mode

The default write-back mode commits the updated image tag directly to the configured branch. This is the simplest model for fully automated environments.

```yaml
annotations:
  argocd-image-updater.argoproj.io/write-back-method: git
  argocd-image-updater.argoproj.io/git-branch: main
  argocd-image-updater.argoproj.io/git-commit-message: |
    chore(image-updater): update {{.AppName}} to {{.Images}}

    Updated by ArgoCD Image Updater
    Triggered at: {{.UpdatedAt}}
```

Git credentials are provided via a Kubernetes secret referenced in the ArgoCD `Repository` configuration. No additional annotation is needed when the application's source repository is already registered with ArgoCD.

For repositories that require a separate write credential:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: git-write-credentials
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
type: Opaque
stringData:
  type: git
  url: https://github.com/company/gitops-config
  username: argocd-bot
  password: EXAMPLE_TOKEN_REPLACE_ME
```

### PR-Based Write-Back

For environments that require peer review before changes reach production, configure write-back to open pull requests instead of committing directly:

```yaml
annotations:
  argocd-image-updater.argoproj.io/write-back-method: github-pr
  argocd-image-updater.argoproj.io/github-app-id: "12345"
  argocd-image-updater.argoproj.io/github-app-installation-id: "98765"
  argocd-image-updater.argoproj.io/github-app-private-key: >-
    secret:argocd/github-app-key#private-key
  argocd-image-updater.argoproj.io/git-branch: main
```

The GitHub App requires `contents: write` and `pull-requests: write` permissions on the target repository.

### Write-Back Target Customisation

By default, Image Updater writes to the `.argocd-source-<appname>.yaml` file in the application's source path. Override this behaviour for Helm and Kustomize write-back targets:

```yaml
# For Helm values file
annotations:
  argocd-image-updater.argoproj.io/write-back-method: git
  argocd-image-updater.argoproj.io/write-back-target: "helmvalues:apps/api-service/values.yaml"

# For Kustomize (writes to kustomization.yaml images section)
annotations:
  argocd-image-updater.argoproj.io/write-back-method: git
  argocd-image-updater.argoproj.io/write-back-target: kustomization
```

## Helm Values Integration

When an application uses Helm, Image Updater can update specific values in a `values.yaml` file rather than the ArgoCD application source.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: nginx-app
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: nginx=company/nginx-app
    argocd-image-updater.argoproj.io/nginx.update-strategy: semver
    argocd-image-updater.argoproj.io/nginx.helm.image-name: image.repository
    argocd-image-updater.argoproj.io/nginx.helm.image-tag: image.tag
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/write-back-target: "helmvalues:apps/nginx/values.yaml"
spec:
  project: production
  source:
    repoURL: https://github.com/company/gitops-config
    path: apps/nginx
    targetRevision: main
    helm:
      valueFiles:
      - values.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: nginx-app
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

Corresponding `values.yaml` before the update:

```yaml
image:
  repository: company/nginx-app
  tag: v1.2.3
  pullPolicy: IfNotPresent
```

After Image Updater runs, it commits a change setting `image.tag` to the newly discovered semver tag.

## Kustomize Image Update

For Kustomize-managed applications, Image Updater updates the `images` section of the `kustomization.yaml` file:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: frontend-kustomize
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: frontend=company/frontend
    argocd-image-updater.argoproj.io/frontend.update-strategy: semver
    argocd-image-updater.argoproj.io/frontend.allow-tags: regexp:^v[0-9]+\.[0-9]+\.[0-9]+$
    argocd-image-updater.argoproj.io/write-back-method: git
    argocd-image-updater.argoproj.io/write-back-target: kustomization
spec:
  project: production
  source:
    repoURL: https://github.com/company/gitops-config
    path: apps/frontend/overlays/production
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: frontend
```

The managed `kustomization.yaml` will have its `images` block updated:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: frontend
resources:
- ../../base
images:
- name: company/frontend
  newTag: v2.1.4   # Updated by ArgoCD Image Updater
```

## Registry Authentication

### DockerHub Authentication

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: dockerhub-credentials
  namespace: argocd
type: Opaque
stringData:
  creds: "username:EXAMPLE_DOCKERHUB_TOKEN_REPLACE_ME"
```

Reference the secret in the Image Updater config:

```yaml
config:
  registries: |
    - name: DockerHub
      api_url: https://registry-1.docker.io
      ping: yes
      credentials: secret:argocd/dockerhub-credentials#creds
      credsexpire: 12h
      defaultns: library
      default: true
```

### ECR Authentication with IRSA

ECR tokens expire every 12 hours. The recommended approach on EKS is IRSA (IAM Roles for Service Accounts), which allows Image Updater to call the ECR `GetAuthorizationToken` API without a stored credential.

IAM policy for the IRSA role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:ListImages",
        "ecr:DescribeImages"
      ],
      "Resource": "*"
    }
  ]
}
```

Image Updater Helm values with IRSA:

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/ArgoCD-ImageUpdater-ECR

config:
  registries: |
    - name: ECR-US-East-1
      api_url: https://123456789012.dkr.ecr.us-east-1.amazonaws.com
      credentials: ext:/scripts/ecr-login.sh
      credsexpire: 9h

extraVolumes:
- name: ecr-login-script
  configMap:
    name: ecr-login-script
    defaultMode: 0755

extraVolumeMounts:
- name: ecr-login-script
  mountPath: /scripts
```

ECR login ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ecr-login-script
  namespace: argocd
data:
  ecr-login.sh: |
    #!/bin/sh
    # Uses the IRSA token in the pod's projected volume
    aws ecr get-login-password \
      --region us-east-1 \
      | awk '{print "AWS:" $0}'
```

### GCR / Artifact Registry Authentication

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gcr-credentials
  namespace: argocd
type: Opaque
stringData:
  # Service account JSON key — use Workload Identity on GKE instead
  creds: "EXAMPLE_GCR_JSON_KEY_REPLACE_ME"
```

For **Workload Identity** on GKE, annotate the service account and omit stored credentials:

```yaml
serviceAccount:
  annotations:
    iam.gke.io/gcp-service-account: argocd-image-updater@my-project.iam.gserviceaccount.com

config:
  registries: |
    - name: GAR-US
      api_url: https://us-docker.pkg.dev
      credentials: ext:/scripts/gar-login.sh
      credsexpire: 55m
```

## Platform Constraints

When building multi-arch images, restrict Image Updater to a specific platform so digest pinning only considers the correct architecture:

```yaml
annotations:
  argocd-image-updater.argoproj.io/image-list: app=company/app
  argocd-image-updater.argoproj.io/app.update-strategy: semver
  # Only consider linux/amd64 manifests
  argocd-image-updater.argoproj.io/app.platforms: linux/amd64
```

For ARM-based node pools:

```yaml
annotations:
  argocd-image-updater.argoproj.io/app.platforms: linux/arm64
```

## Monitoring with Prometheus

Image Updater exposes metrics on port `8081` at `/metrics`.

### ServiceMonitor Configuration

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: argocd-image-updater
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: argocd-image-updater
  namespaceSelector:
    matchNames:
    - argocd
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

### Key Metrics

| Metric | Description |
|--------|-------------|
| `argocd_image_updater_images_updated_total` | Total images successfully updated |
| `argocd_image_updater_images_errors_total` | Total update errors by application |
| `argocd_image_updater_registry_requests_total` | Registry API calls by registry and status |
| `argocd_image_updater_git_write_total` | Git write-back operations |
| `argocd_image_updater_cache_miss_total` | Tag cache misses triggering live registry calls |

### PrometheusRule Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argocd-image-updater-alerts
  namespace: monitoring
spec:
  groups:
  - name: argocd-image-updater
    interval: 30s
    rules:
    - alert: ImageUpdaterHighErrorRate
      expr: |
        rate(argocd_image_updater_images_errors_total[10m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "ArgoCD Image Updater error rate elevated"
        description: "Application {{ $labels.application }} is producing image update errors"

    - alert: ImageUpdaterRegistryUnreachable
      expr: |
        rate(argocd_image_updater_registry_requests_total{status!="200"}[5m]) > 0
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Container registry unreachable"
        description: "Registry {{ $labels.registry }} is returning non-200 responses"

    - alert: ImageUpdaterDown
      expr: |
        up{job="argocd-image-updater"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "ArgoCD Image Updater is down"
        description: "ArgoCD Image Updater has been unreachable for 5 minutes"
```

## Integration with CI Pipelines

The recommended pattern is to have the CI pipeline push the image tag to the registry and let Image Updater detect it asynchronously. No direct coupling to Image Updater from CI is required.

However, some teams prefer to trigger an immediate resync. Image Updater exposes a `/api/v1/applications/{app}/refresh` endpoint that forces an out-of-cycle registry check:

```bash
# Trigger immediate image check after CI push
curl -s \
  -X POST \
  -H "Authorization: Bearer ${ARGOCD_IMAGE_UPDATER_TOKEN}" \
  http://argocd-image-updater.argocd.svc.cluster.local:8080/api/v1/refresh/api-service
```

### GitHub Actions Integration Pattern

```yaml
# .github/workflows/build-and-notify.yaml
name: Build and Deploy
on:
  push:
    branches: [main]
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Log in to ECR
      uses: aws-actions/amazon-ecr-login@v2

    - name: Build and push
      uses: docker/build-push-action@v5
      with:
        context: .
        push: true
        tags: |
          123456789012.dkr.ecr.us-east-1.amazonaws.com/api-service:${{ github.ref_name }}
          123456789012.dkr.ecr.us-east-1.amazonaws.com/api-service:latest
        cache-from: type=gha
        cache-to: type=gha,mode=max

    # ArgoCD Image Updater will detect the new tag within `interval` seconds
    # For environments that need immediate feedback, trigger a manual refresh:
    - name: Trigger Image Updater refresh
      if: startsWith(github.ref, 'refs/tags/')
      run: |
        curl -sf -X POST \
          -H "Authorization: Bearer ${{ secrets.IMAGE_UPDATER_TOKEN }}" \
          "https://argocd-image-updater.argocd.company.com/api/v1/refresh/api-service"
```

## Troubleshooting

### Version Detection Failures

**Symptom:** Image Updater logs show `no tags found matching policy` but the tag clearly exists in the registry.

Check the Image Updater logs for the specific application:

```bash
kubectl logs -n argocd deployment/argocd-image-updater | grep "api-service"
```

Common causes and resolutions:

**1. Regex anchor mismatch**

The `allow-tags` regex is applied to the full tag string. A pattern like `v1\.[0-9]+` will match `v1.x-alpha` too. Always anchor both ends:

```yaml
argocd-image-updater.argoproj.io/api.allow-tags: regexp:^v1\.[0-9]+\.[0-9]+$
```

**2. Registry rate limiting**

DockerHub anonymous pulls are rate-limited. Confirm credentials are set and the `credsexpire` value is longer than the polling interval:

```bash
# Inspect the current credential resolution
kubectl exec -n argocd deployment/argocd-image-updater -- \
  argocd-image-updater test \
    --credentials "secret:argocd/dockerhub-credentials#creds" \
    company/api-service
```

**3. ECR token expiry**

When using `ext:` credentials, verify the script executes cleanly in the container:

```bash
kubectl exec -n argocd deployment/argocd-image-updater -- /scripts/ecr-login.sh
```

**4. Image name alias mismatch**

The image alias in `image-list` must match the alias prefix on all strategy annotations. Mismatches are silently ignored:

```yaml
# Correct — alias "api" used consistently
argocd-image-updater.argoproj.io/image-list: api=company/api-service
argocd-image-updater.argoproj.io/api.update-strategy: semver

# Incorrect — alias mismatch; strategy annotation is ignored
argocd-image-updater.argoproj.io/image-list: api=company/api-service
argocd-image-updater.argoproj.io/app.update-strategy: semver
```

### Git Write-Back Failures

**Symptom:** Tags are discovered but Git commits are not appearing.

```bash
# Check write-back specific errors
kubectl logs -n argocd deployment/argocd-image-updater | grep -i "write-back\|git"
```

Validate the Git credentials secret is correctly formatted:

```bash
kubectl get secret git-write-credentials -n argocd -o jsonpath='{.data.password}' | base64 -d
```

Ensure the token has `contents: write` scope on GitHub and that the repository URL in the ArgoCD source matches the registered repository exactly (including trailing slashes).

### Dry Run Mode

Before enabling write-back in production, run in dry-run mode to preview what Image Updater would commit:

```bash
kubectl exec -n argocd deployment/argocd-image-updater -- \
  argocd-image-updater run \
    --once \
    --dry-run \
    --argocd-server-addr argocd-server.argocd.svc.cluster.local:443 \
    --loglevel debug
```

## Operational Best Practices

### Filtering Noise

Use `ignore-tags` to exclude build artifacts that should never reach production:

```yaml
annotations:
  # Exclude development, pull-request, and debug builds
  argocd-image-updater.argoproj.io/api.ignore-tags: >-
    regexp:^(dev-|pr-|debug-|snapshot-).*
```

### Commit Message Templates

Custom commit messages improve Git history readability and enable downstream tooling (changelogs, Slack notifications) to parse deployments:

```yaml
annotations:
  argocd-image-updater.argoproj.io/git-commit-message: |
    deploy({{.AppName}}): promote {{range .Images}}{{.Name}}:{{.NewTag}} {{end}}

    Previous: {{range .Images}}{{.Name}}:{{.OldTag}} {{end}}
    Registry: {{range .Images}}{{.RegistryURL}} {{end}}
    Timestamp: {{.UpdatedAt}}
```

### Coordinating with Sync Windows

ArgoCD sync windows block automated syncs during maintenance periods. Image Updater will still commit to Git during a sync window — ArgoCD will queue the sync until the window opens. This is intentional: the Git state always reflects what _should_ be deployed, even if the actual sync is delayed.

To prevent Image Updater from even committing during a freeze window, pause the ArgoCD Application:

```bash
argocd app set api-service --sync-option AutoSync=false
# After freeze:
argocd app set api-service --sync-option AutoSync=true
```

## Conclusion

ArgoCD Image Updater eliminates the most repetitive task in a GitOps workflow — manually updating image tags — without breaking the core principle that Git is the source of truth. By combining flexible update strategies, robust registry authentication support, and both direct-commit and PR-based write-back modes, it fits naturally into teams at any maturity level.

Key operational takeaways:

- Use `semver` strategy in production with strict regex anchors on `allow-tags`
- Use `digest` pinning for critical services where tag mutability is unacceptable
- Prefer IRSA or Workload Identity over long-lived registry credentials
- Enable the Prometheus ServiceMonitor from day one — `argocd_image_updater_images_errors_total` catches misconfigurations early
- Test annotation changes in dry-run mode before applying to production Applications
- Set `ignore-tags` to exclude CI noise (PR builds, debug tags) before enabling `latest` strategy
