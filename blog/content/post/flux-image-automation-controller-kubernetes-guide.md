---
title: "Flux Image Automation Controller: Automated Image Updates in GitOps"
date: 2027-02-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flux", "GitOps", "Image Automation", "CI/CD"]
categories:
- Kubernetes
- GitOps
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Flux Image Automation Controller for automated container image updates, covering ImageRepository, ImagePolicy, ImageUpdateAutomation resources, ECR/GCR authentication, and production monitoring."
more_link: "yes"
url: "/flux-image-automation-controller-kubernetes-guide/"
---

Flux's image automation stack automates the feedback loop between a container registry and a GitOps repository. When a CI pipeline pushes a new image tag, Flux detects the change, evaluates it against a policy, and commits an updated image reference back to Git — triggering a standard reconciliation without any direct coupling between CI and CD. This guide covers every component of that stack from initial installation through production-scale operation.

<!--more-->

## Architecture: Three-Controller Model

Flux splits image automation across three controllers and three corresponding CRD types. Understanding the responsibility boundaries prevents most configuration mistakes.

```
┌────────────────────────────────────────────────────────────┐
│  flux-system namespace                                      │
│                                                            │
│  image-reflector-controller                                │
│    ├─ watches: ImageRepository (polling interval)          │
│    └─ writes: .status.lastScanResult (tag list in etcd)    │
│                                                            │
│  image-reflector-controller (also)                         │
│    ├─ watches: ImagePolicy                                 │
│    └─ writes: .status.latestImage (selected tag)           │
│                                                            │
│  image-automation-controller                               │
│    ├─ watches: ImageUpdateAutomation                       │
│    ├─ reads:   ImagePolicy.status.latestImage              │
│    ├─ clones Git repo via SSH/HTTPS                        │
│    └─ commits: updated image references                    │
└────────────────────────────────────────────────────────────┘
```

| CRD | Controller | Purpose |
|-----|------------|---------|
| `ImageRepository` | image-reflector | Poll a registry, store tag list |
| `ImagePolicy` | image-reflector | Select the best tag from the stored list |
| `ImageUpdateAutomation` | image-automation | Commit the selected tag to Git |

## Installing the Image Automation Stack

### Flux Bootstrap with Image Components

If Flux is not yet installed, bootstrap with the image controllers enabled:

```bash
flux bootstrap github \
  --owner=company \
  --repository=gitops-config \
  --branch=main \
  --path=clusters/production \
  --components-extra=image-reflector-controller,image-automation-controller \
  --personal
```

For an existing Flux installation, add the controllers via a Kustomization patch:

```yaml
# clusters/production/flux-system/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- gotk-components.yaml
- gotk-sync.yaml
patches:
- patch: |
    - op: add
      path: /spec/components/-
      value: image-reflector-controller
    - op: add
      path: /spec/components/-
      value: image-automation-controller
  target:
    kind: Kustomization
    name: flux-system
```

Apply and reconcile:

```bash
flux reconcile kustomization flux-system --with-source
```

Verify both controllers are running:

```bash
flux check
kubectl get deploy -n flux-system | grep image
# image-automation-controller   1/1     1            1
# image-reflector-controller    1/1     1            1
```

### Resource Sizing

For large fleets with many `ImageRepository` objects, the reflector controller memory usage grows with the number of stored tags. Patch the default resource limits:

```yaml
# clusters/production/flux-system/image-reflector-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: image-reflector-controller
  namespace: flux-system
spec:
  template:
    spec:
      containers:
      - name: manager
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        args:
        - --max-scan-tags=100    # Cap stored tags per ImageRepository
        - --reconcile-interval=2m
```

## ImageRepository: Registry Scanning

An `ImageRepository` tells the reflector controller which registry path to scan and how often.

### Public Registry

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: api-service
  namespace: flux-system
spec:
  image: company/api-service
  interval: 5m
  # Limit stored tags to reduce memory pressure
  exclusionList:
  - "^.*-alpha$"
  - "^.*-rc[0-9]+$"
```

### Private Registry with Imagepullsecret

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: api-service-private
  namespace: flux-system
spec:
  image: registry.company.com/backend/api-service
  interval: 5m
  secretRef:
    name: registry-credentials
---
apiVersion: v1
kind: Secret
metadata:
  name: registry-credentials
  namespace: flux-system
type: kubernetes.io/dockerconfigjson
stringData:
  .dockerconfigjson: |
    {
      "auths": {
        "registry.company.com": {
          "username": "robot-flux",
          "password": "EXAMPLE_REGISTRY_TOKEN_REPLACE_ME"
        }
      }
    }
```

### ECR with IRSA

ECR requires a token refresh every 12 hours. Use IRSA so the reflector pod assumes an IAM role without stored credentials.

```yaml
# Patch the image-reflector ServiceAccount with IRSA annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: image-reflector-controller
  namespace: flux-system
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/FluxImageReflector
```

IAM policy for the role (least-privilege):

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
        "ecr:DescribeImages",
        "ecr:DescribeRepositories"
      ],
      "Resource": "*"
    }
  ]
}
```

`ImageRepository` for ECR — no `secretRef` is needed when IRSA is configured:

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: ecr-api-service
  namespace: flux-system
spec:
  image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/api-service
  interval: 5m
  provider: aws
```

### GCR / Artifact Registry with Workload Identity

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: image-reflector-controller
  namespace: flux-system
  annotations:
    iam.gke.io/gcp-service-account: flux-image-reflector@my-project.iam.gserviceaccount.com
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: gar-api-service
  namespace: flux-system
spec:
  image: us-docker.pkg.dev/my-project/my-repo/api-service
  interval: 5m
  provider: gcp
```

## ImagePolicy: Tag Selection

An `ImagePolicy` selects the best tag from the list stored by `ImageRepository`. Two policy types cover the vast majority of use cases.

### Semver Policy

Track the latest patch release within the `1.x` minor range:

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-service
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-service
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"
```

Track the absolute latest stable release:

```yaml
spec:
  imageRepositoryRef:
    name: api-service
  policy:
    semver:
      range: ">=0.0.0"
  # Pre-filter to exclude pre-releases before semver evaluation
  filterTags:
    pattern: '^v[0-9]+\.[0-9]+\.[0-9]+$'
    extract: '$0'
```

### Regex + Alphabetical Policy

For images tagged with a build timestamp pattern (`YYYYMMDD-<sha>`), use alphabetical ordering which naturally selects the newest date:

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: worker-service
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: worker-service
  filterTags:
    # Only consider production build tags
    pattern: '^[0-9]{8}-[a-f0-9]{7}$'
    extract: '$0'
  policy:
    alphabetical:
      order: asc
```

### Numerical Policy

For simple numeric build numbers:

```yaml
spec:
  imageRepositoryRef:
    name: build-service
  filterTags:
    pattern: '^build-([0-9]+)$'
    extract: '$1'
  policy:
    numerical:
      order: asc
```

Check the resolved tag:

```bash
flux get image policy api-service
# NAME          LATEST IMAGE                          READY
# api-service   company/api-service:v1.4.2            True
```

## Git Write-Back: SSH Key Setup

`ImageUpdateAutomation` requires write access to the Git repository. The cleanest approach uses a dedicated SSH key pair.

### Generate the Deploy Key

```bash
# Generate an Ed25519 key — do not set a passphrase
ssh-keygen -t ed25519 -C "flux-image-updater" -f flux-image-updater -N ""

# The private key goes into a Kubernetes secret
kubectl create secret generic flux-git-auth \
  --namespace=flux-system \
  --from-file=identity=./flux-image-updater \
  --from-file=identity.pub=./flux-image-updater.pub \
  --from-file=known_hosts=<(ssh-keyscan github.com)

# The public key is added as a deploy key with write access
# on the GitHub repository: Settings > Deploy keys > Add deploy key
cat flux-image-updater.pub
```

Register the repository with the secret:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: gitops-config-write
  namespace: flux-system
spec:
  interval: 1m
  url: ssh://git@github.com/company/gitops-config
  secretRef:
    name: flux-git-auth
  ref:
    branch: main
```

## ImageUpdateAutomation: Committing Updates

`ImageUpdateAutomation` ties together a `GitRepository` source, a target Git branch, and commit metadata.

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: flux-image-updates
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: gitops-config-write
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: flux-bot@company.com
        name: Flux Image Updater
      messageTemplate: |
        deploy: update image(s) in {{.AutomationObject}}

        {{range .Updated.Images -}}
        - {{.Repository}}: {{.OldTag}} → {{.NewTag}}
        {{end -}}
    push:
      branch: main
  update:
    path: ./clusters/production
    strategy: Setters
```

### Interval Tuning

The `interval` on `ImageUpdateAutomation` controls how often the automation controller checks whether the selected image in any `ImagePolicy` has changed since the last commit. Setting it too low (under 60 seconds) increases Git API calls and SSH connections; 5 minutes is a sensible default for most production workloads.

## Marker Syntax for Image Substitution

Flux uses in-file markers to know exactly which field to update. The automation controller replaces only the tagged field, leaving surrounding YAML untouched.

### Kustomization Marker

```yaml
# clusters/production/apps/api-service/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: api-service
resources:
- deployment.yaml
images:
- name: company/api-service
  newTag: v1.2.3 # {"$imagepolicy": "flux-system:api-service:tag"}
```

The marker format is `{"$imagepolicy": "<namespace>:<policy-name>:<field>"}` where `<field>` is `tag`, `name`, or `digest`.

### Deployment YAML Marker

```yaml
# clusters/production/apps/api-service/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
spec:
  template:
    spec:
      containers:
      - name: api-service
        image: company/api-service:v1.2.3 # {"$imagepolicy": "flux-system:api-service"}
```

When the full `image` field (repository + tag) should be updated together, omit the `:field` suffix.

### Helm Values Marker

For Helm-based deployments, Flux can update values files:

```yaml
# clusters/production/apps/nginx/values.yaml
image:
  repository: company/nginx-app
  tag: v2.0.1 # {"$imagepolicy": "flux-system:nginx-app:tag"}
  pullPolicy: IfNotPresent
```

The corresponding `HelmRelease` must reference this values file:

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta2
kind: HelmRelease
metadata:
  name: nginx-app
  namespace: nginx-app
spec:
  interval: 10m
  chart:
    spec:
      chart: ./charts/nginx-app
      sourceRef:
        kind: GitRepository
        name: gitops-config
  valuesFrom:
  - kind: ConfigMap
    name: nginx-app-values
```

## Multi-Tenant Image Policies

In a multi-tenant cluster, each team typically owns their own namespace and `ImagePolicy` objects. The automation controller can commit across all policies in a single pass.

```yaml
# Team A namespace — manages its own ImageRepository and ImagePolicy
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: team-a-frontend
  namespace: team-a
spec:
  image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/team-a/frontend
  interval: 5m
  provider: aws
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: team-a-frontend
  namespace: team-a
spec:
  imageRepositoryRef:
    name: team-a-frontend
  policy:
    semver:
      range: ">=2.0.0 <3.0.0"
```

Reference cross-namespace policies in markers using the full `namespace:policy` form:

```yaml
image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/team-a/frontend:v2.1.0 # {"$imagepolicy": "team-a:team-a-frontend"}
```

The `ImageUpdateAutomation` in `flux-system` with `path: ./clusters/production` will walk all YAML files in that subtree and update every marker it finds, regardless of which namespace the referenced `ImagePolicy` belongs to.

## Automated PR Creation Pattern

Direct commits to the default branch are appropriate for staging environments but many production workflows require a pull request. Flux does not natively create PRs, but the pattern is implementable with a GitHub Actions workflow that watches for automation commits on a dedicated branch.

```yaml
# ImageUpdateAutomation — writes to staging/image-updates branch
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: flux-image-updates-pr
  namespace: flux-system
spec:
  interval: 5m
  sourceRef:
    kind: GitRepository
    name: gitops-config-write
  git:
    checkout:
      ref:
        branch: staging/image-updates
    commit:
      author:
        email: flux-bot@company.com
        name: Flux Image Updater
      messageTemplate: "auto: update images {{.AutomationObject}}"
    push:
      branch: staging/image-updates
  update:
    path: ./clusters/production
    strategy: Setters
```

```yaml
# .github/workflows/auto-pr.yaml
name: Open PR for image updates
on:
  push:
    branches: [staging/image-updates]

jobs:
  open-pr:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - name: Create Pull Request
      uses: peter-evans/create-pull-request@v6
      with:
        token: ${{ secrets.GITHUB_TOKEN }}
        base: main
        branch: staging/image-updates
        title: "deploy: automated image updates"
        body: |
          Automated image tag updates from Flux Image Automation Controller.
          Review the changes and merge to trigger deployment.
        labels: automated,image-update
```

## Monitoring with Prometheus

Both image controllers expose Prometheus metrics on port `8080` at `/metrics`.

### PodMonitor Configuration

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: flux-image-controllers
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
    - flux-system
  selector:
    matchLabels:
      app: image-reflector-controller
  podMetricsEndpoints:
  - port: http-prom
    interval: 30s
---
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: flux-image-automation-controller
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
    - flux-system
  selector:
    matchLabels:
      app: image-automation-controller
  podMetricsEndpoints:
  - port: http-prom
    interval: 30s
```

### Key Metrics

| Metric | Controller | Description |
|--------|------------|-------------|
| `gotk_reconcile_duration_seconds` | both | Reconciliation latency histogram |
| `gotk_reconcile_condition` | both | Ready/Failed state per object |
| `controller_runtime_reconcile_total` | both | Total reconcile calls by result |
| `workqueue_depth` | both | Pending reconcile queue depth |

### PrometheusRule Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: flux-image-alerts
  namespace: monitoring
spec:
  groups:
  - name: flux-image-automation
    rules:
    - alert: FluxImagePolicyNotReady
      expr: |
        gotk_reconcile_condition{type="Ready",status="False",kind="ImagePolicy"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Flux ImagePolicy not ready"
        description: "ImagePolicy {{ $labels.name }} in {{ $labels.namespace }} has been failing for 10 minutes"

    - alert: FluxImageRepositoryNotReady
      expr: |
        gotk_reconcile_condition{type="Ready",status="False",kind="ImageRepository"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Flux ImageRepository not ready"
        description: "ImageRepository {{ $labels.name }} cannot reach registry"

    - alert: FluxImageUpdateAutomationNotReady
      expr: |
        gotk_reconcile_condition{type="Ready",status="False",kind="ImageUpdateAutomation"} == 1
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Flux image automation has stopped"
        description: "ImageUpdateAutomation {{ $labels.name }} is failing — image updates will not be committed"

    - alert: FluxControllerReconcileErrors
      expr: |
        increase(controller_runtime_reconcile_total{result="error",controller=~"image.*"}[5m]) > 5
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "Flux image controller reconcile errors"
        description: "Controller {{ $labels.controller }} has had {{ $value }} reconcile errors in the last 5 minutes"
```

## Comparison with ArgoCD Image Updater

Both tools accomplish the same goal — automatically updating image tags in a GitOps repository — but the implementation models differ in ways that matter for architecture decisions.

| Dimension | Flux Image Automation | ArgoCD Image Updater |
|-----------|----------------------|---------------------|
| **GitOps tool coupling** | Native Flux — no ArgoCD dependency | Requires ArgoCD |
| **Configuration model** | Separate CRDs (`ImageRepository`, `ImagePolicy`, `ImageUpdateAutomation`) | Annotations on ArgoCD `Application` |
| **Registry polling** | Dedicated `ImageRepository` per image path | Per-application `image-list` annotation |
| **Marker syntax** | In-file YAML comments | Write-back target types |
| **PR creation** | Requires external workflow (GitHub Actions) | Native `github-pr` write-back method |
| **Multi-arch support** | No per-policy platform filter | Per-image `.platforms` annotation |
| **OIDC / credential rotation** | IRSA / Workload Identity via provider field | IRSA via `ext:` credential script |
| **ArgoCD-agnostic** | Yes — works with any GitOps tool | No |

Choose Flux Image Automation when running Flux as the primary GitOps controller and the team is comfortable managing three CRD types. Choose ArgoCD Image Updater when ArgoCD is already the standard and the annotation-driven approach reduces YAML proliferation.

## Troubleshooting

### ImageRepository Not Scanning

```bash
# Check reflector controller logs
kubectl logs -n flux-system deployment/image-reflector-controller --tail=50

# Describe the ImageRepository for conditions
flux get image repository api-service --namespace flux-system
kubectl describe imagerepo api-service -n flux-system
```

Common causes:

- `secretRef` pointing to a missing or incorrectly formatted secret
- Network policy blocking egress to the registry
- For ECR: IRSA annotation not applied to the correct ServiceAccount
- `provider: aws` not set when using IRSA for ECR

### ImagePolicy Stays at OldTag

```bash
flux get image policy api-service
```

If `LATEST IMAGE` shows an old tag despite newer tags existing in the registry:

1. Confirm the `ImageRepository` scan has completed: `flux get image repository api-service`
2. Check `filterTags.pattern` — a greedy regex may exclude the new tag
3. For `semver` policy, verify the new tag parses as valid semver: `echo "v1.5.0" | grep -P '^v?[0-9]+\.[0-9]+\.[0-9]+$'`

### Automation Not Committing

```bash
kubectl logs -n flux-system deployment/image-automation-controller --tail=50
flux get image update flux-image-updates
```

Verify the `GitRepository` used by the automation has write credentials:

```bash
kubectl describe gitrepository gitops-config-write -n flux-system
# Look for: "ssh: handshake failed" or "permission denied"
```

Re-create the SSH key secret if the deploy key was rotated on GitHub without updating the secret:

```bash
ssh-keyscan github.com > known_hosts_new
kubectl create secret generic flux-git-auth \
  --namespace=flux-system \
  --from-file=identity=./flux-image-updater \
  --from-file=identity.pub=./flux-image-updater.pub \
  --from-file=known_hosts=./known_hosts_new \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Marker Not Being Updated

The automation controller only updates lines containing a valid marker comment. Validate the marker syntax in the file exactly matches the format `# {"$imagepolicy": "namespace:name"}`:

```bash
# Find all files with image policy markers
grep -r '\$imagepolicy' clusters/production/
```

A common mistake is using double-quotes inside the JSON comment when the surrounding YAML already uses double-quotes, causing YAML parse errors. Use single-line comments and keep the JSON on the same line as the image field.

## Conclusion

The Flux Image Automation stack provides a clean, CRD-first approach to automated image updates. By separating registry scanning (`ImageRepository`), tag selection (`ImagePolicy`), and Git write-back (`ImageUpdateAutomation`) into distinct objects, each concern is independently observable and tunable.

Key operational recommendations:

- Use IRSA or Workload Identity for ECR and GCR — avoid stored registry tokens that expire silently
- Set `exclusionList` on `ImageRepository` to keep the reflector's tag cache small and scan latency predictable
- Place `filterTags.pattern` before `policy.semver` to exclude non-semver tags from version comparison
- Enable the `PodMonitor` resources on day one and alert on `gotk_reconcile_condition{status="False"}`
- For production environments requiring change approval, push automation commits to a feature branch and open PRs via a lightweight GitHub Actions workflow
- Periodically rotate the SSH deploy key and update the `flux-git-auth` secret — automated key rotation through Sealed Secrets or External Secrets Operator eliminates this toil entirely
