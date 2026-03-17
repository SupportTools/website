---
title: "Kubernetes Image Pull Policy and Caching: Registry Mirrors, Image Pull Secrets, Node-Level Caching, and Pre-Pulling DaemonSets"
date: 2032-03-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Container Images", "Registry", "Caching", "DaemonSet", "Image Pull Secrets", "Performance"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes image caching strategy: imagePullPolicy semantics, registry mirror configuration, node-level cache management, pre-pulling with DaemonSets, image pull secrets for private registries, and startup latency optimization."
more_link: "yes"
url: "/kubernetes-image-pull-policy-caching-registry-mirrors-pre-pulling-daemonsets/"
---

Container image pull latency is a hidden tax on Kubernetes cluster performance. A single 500MB image pull over a saturated WAN link adds 30+ seconds to pod startup time and can cascade into readiness probe failures and deployment timeouts. Designing a correct caching strategy requires understanding imagePullPolicy semantics, the node-level image cache, containerd's content store, registry mirror configuration, and pre-pulling techniques. This post covers each layer in depth with production-ready configurations.

<!--more-->

# Kubernetes Image Pull Policy and Caching: Registry Mirrors, Image Pull Secrets, Node-Level Caching, and Pre-Pulling DaemonSets

## imagePullPolicy Semantics

### The Three Policies

```yaml
# Always: Pull the image every time a container starts
# Even if the image with this exact tag is already on the node
spec:
  containers:
  - name: app
    image: nginx:1.27.2
    imagePullPolicy: Always   # Network call every container start

# Never: Use the locally cached image, fail if not present
# No network calls; pod fails to start if image missing
spec:
  containers:
  - name: app
    image: nginx:1.27.2
    imagePullPolicy: Never    # Zero network calls; image must be pre-pulled

# IfNotPresent: Pull only if not already in the local node cache
# Default for specific tags (not :latest)
spec:
  containers:
  - name: app
    image: nginx:1.27.2
    imagePullPolicy: IfNotPresent  # Network call only on first pull
```

### Default Policy Rules

The default imagePullPolicy depends on the image tag:

| Image Tag | Default Policy | Rationale |
|-----------|---------------|-----------|
| `:latest` or no tag | `Always` | Latest may have changed |
| Specific tag (`:1.27.2`) | `IfNotPresent` | Tagged image is immutable |
| Digest (`@sha256:abc...`) | `IfNotPresent` | Digest is content-addressed, immutable |

**Critical production rule**: Never use `:latest` in production manifests. Beyond the `Always` pull policy performance hit, `:latest` creates a distributed system where different nodes may run different versions of your application simultaneously, making debugging extremely difficult.

### Always vs IfNotPresent: When It Matters

```yaml
# Scenario: Horizontal Pod Autoscaler scales from 3 to 30 pods
# 27 new pods scheduled across 10 nodes

# With imagePullPolicy: Always
# - 27 pods each trigger an image pull check (HEAD request + potential full pull)
# - Even if the image is already on every node, 27 registry API calls occur
# - During registry outages, ALL scale events fail regardless of cache state
# - Each HEAD request adds 50-200ms to container startup

# With imagePullPolicy: IfNotPresent + digest pinning
# - Pods on nodes that already have the image start immediately
# - Only first-time pulls on new nodes require network
# - Registry outage only blocks pods on nodes without the cache
```

### Image Digest Pinning

Always pin production images to digest, not just tag:

```bash
# Resolve a tag to its digest
crane digest nginx:1.27.2
# sha256:a484819eb60211f5299034ac80f6a681b06f89e65866ce91f356e2fc0c5f0b41

# Use digest in manifests
kubectl patch deployment nginx \
  --patch '{"spec":{"template":{"spec":{"containers":[{"name":"nginx","image":"nginx@sha256:a484819eb60211f5299034ac80f6a681b06f89e65866ce91f356e2fc0c5f0b41"}]}}}}'
```

```yaml
# kustomize digest pinning
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
      - name: nginx
        image: nginx:1.27.2@sha256:a484819eb60211f5299034ac80f6a681b06f89e65866ce91f356e2fc0c5f0b41
        imagePullPolicy: IfNotPresent
```

## Node-Level Image Cache

### containerd Content Store

containerd (the default CRI in Kubernetes 1.20+) stores images in a content-addressed store:

```
/var/lib/containerd/
├── io.containerd.content.v1.content/
│   ├── blobs/
│   │   └── sha256/
│   │       ├── <digest1>    # Image manifest
│   │       ├── <digest2>    # Image config
│   │       └── <digest3>    # Layer tar.gz
│   └── ingest/              # Partially downloaded layers
├── io.containerd.snapshotter.v1.overlayfs/
│   └── snapshots/           # Overlayfs layers
└── io.containerd.metadata.v1.bolt/
    └── meta.db              # BoltDB metadata
```

Each unique layer is stored exactly once regardless of how many images reference it. This means layer deduplication is automatic - a 50MB base layer shared by 20 different application images is only stored once on each node.

### Inspecting the Node Image Cache

```bash
# List all images on a node (via crictl)
crictl images

# Show image sizes and layer breakdown
crictl imagefsinfo

# Check disk usage by images
du -sh /var/lib/containerd/io.containerd.content.v1.content/blobs/

# Count unique layers
ls /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/ | wc -l

# Find images consuming the most space
crictl images -v 2>/dev/null | awk '/REF/ {image=$3} /SIZE/ {print $2, image}' | sort -rh | head -20
```

### Image Garbage Collection

The kubelet automatically garbage collects images when disk pressure occurs:

```yaml
# kubelet configuration for image garbage collection
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
imageGCHighThresholdPercent: 85  # Start GC when disk is 85% full
imageGCLowThresholdPercent: 80   # GC until disk is 80% full
imageMinimumGCAge: 2m            # Images unused for less than 2m are not GC'd
# Note: images referenced by running or recently stopped containers are never GC'd
```

Monitoring image cache pressure:

```yaml
# PrometheusRule for image cache health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: image-cache-alerts
  namespace: monitoring
spec:
  groups:
  - name: kubernetes.image.cache
    rules:
    - alert: NodeDiskPressureApproaching
      expr: |
        (
          kubelet_volume_stats_available_bytes{persistentvolumeclaim=""}
          / kubelet_volume_stats_capacity_bytes{persistentvolumeclaim=""}
        ) < 0.2
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.node }} disk usage above 80%"

    - alert: ImagePullLatencyHigh
      expr: |
        histogram_quantile(0.95,
          rate(kubelet_image_pull_duration_seconds_bucket[5m])
        ) > 30
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "95th percentile image pull latency above 30 seconds"

    - alert: ImagePullErrors
      expr: |
        rate(kubelet_image_pull_total{result!="success"}[5m]) > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Image pull errors detected on {{ $labels.node }}"
```

## Registry Mirror Configuration

### containerd Registry Mirror Configuration

Registry mirrors allow pulling from a local registry before trying the upstream. This provides:
- Reduced pull latency (local network vs internet)
- Air-gap support (no internet required after mirror is seeded)
- Rate limit avoidance (Docker Hub 100/6h anonymous pulls)
- Bandwidth savings

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri".registry]
  # Mirror configuration
  [plugins."io.containerd.grpc.v1.cri".registry.mirrors]

    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
      endpoint = [
        "https://mirror.example.com",           # Internal mirror first
        "https://registry-1.docker.io"          # Docker Hub fallback
      ]

    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."gcr.io"]
      endpoint = [
        "https://mirror.example.com/gcr",
        "https://gcr.io"
      ]

    [plugins."io.containerd.grpc.v1.cri".registry.mirrors."registry.k8s.io"]
      endpoint = [
        "https://mirror.example.com/registry-k8s-io",
        "https://registry.k8s.io"
      ]

  # Authentication for private mirrors
  [plugins."io.containerd.grpc.v1.cri".registry.configs]
    [plugins."io.containerd.grpc.v1.cri".registry.configs."mirror.example.com".auth]
      username = "pull-user"
      password = "<registry-pull-password>"

    [plugins."io.containerd.grpc.v1.cri".registry.configs."mirror.example.com".tls]
      cert_file = "/etc/containerd/certs/mirror.crt"
      key_file  = "/etc/containerd/certs/mirror.key"
      ca_file   = "/etc/containerd/certs/ca.crt"
```

### Applying containerd Config via DaemonSet (Node Bootstrap)

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: containerd-config
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: containerd-config
  template:
    spec:
      hostPID: true
      initContainers:
      - name: configure-containerd
        image: busybox:1.36
        securityContext:
          privileged: true
        command:
        - sh
        - -c
        - |
          # Write mirror configuration
          mkdir -p /host/etc/containerd
          cat > /host/etc/containerd/config.toml << 'EOF'
          version = 2
          [plugins."io.containerd.grpc.v1.cri".registry.mirrors]
            [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
              endpoint = ["https://mirror.example.com", "https://registry-1.docker.io"]
          EOF

          # Reload containerd
          nsenter -t 1 -m -u -i -n -- systemctl reload containerd
        volumeMounts:
        - name: host-etc
          mountPath: /host/etc
      containers:
      - name: pause
        image: gcr.io/google-containers/pause:3.9
      volumes:
      - name: host-etc
        hostPath:
          path: /etc
          type: Directory
```

### Registry Mirror with Harbor

Harbor is the production-standard registry for on-premises deployments:

```yaml
# Harbor Helm values for registry mirror (proxy cache)
expose:
  type: loadBalancer
  loadBalancer:
    IP: "10.0.1.50"
  tls:
    enabled: true
    certSource: secret
    secret:
      secretName: harbor-tls

externalURL: https://harbor.example.com

proxy:
  httpProxy: ""
  httpsProxy: ""
  noProxy: "127.0.0.1,localhost,core,registry,portal,internal-service"

persistence:
  imageChartStorage:
    type: s3
    s3:
      region: <aws-region>
      bucket: <harbor-storage-bucket>
      accesskey: <aws-access-key-id>
      secretkey: <aws-secret-access-key>
      multipartcopythresholdsize: "33554432"

# Create a proxy cache project in Harbor:
# Harbor UI → Projects → New Project
# Type: Proxy Cache
# Endpoint: https://registry-1.docker.io
# Name: docker-proxy
# Access Level: Public (or Internal with pull secrets)
```

## Image Pull Secrets

### Creating Pull Secrets

```bash
# Docker config file approach
kubectl create secret docker-registry registry-credentials \
  --docker-server=<registry-hostname> \
  --docker-username=<username> \
  --docker-password=<registry-password> \
  --docker-email=<email> \
  --namespace=production

# From an existing docker config file
kubectl create secret generic registry-credentials \
  --from-file=.dockerconfigjson=$HOME/.docker/config.json \
  --type=kubernetes.io/dockerconfigjson \
  --namespace=production

# View the secret
kubectl get secret registry-credentials -o jsonpath='{.data.\.dockerconfigjson}' | \
  base64 -d | jq .
```

### Attaching Pull Secrets to Pods

```yaml
# Method 1: Per-deployment imagePullSecrets
apiVersion: apps/v1
kind: Deployment
metadata:
  name: private-app
  namespace: production
spec:
  template:
    spec:
      imagePullSecrets:
      - name: registry-credentials
      containers:
      - name: app
        image: <private-registry>/myapp:v2.3.1

# Method 2: ServiceAccount-level (applies to all pods using this SA)
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-service-account
  namespace: production
imagePullSecrets:
- name: registry-credentials
```

### Syncing Pull Secrets Across Namespaces

```yaml
# Use Reflector or similar to sync secrets across namespaces
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secret-reflector
  namespace: kube-system
spec:
  replicas: 1
  template:
    spec:
      serviceAccountName: reflector
      containers:
      - name: reflector
        image: emberstack/kubernetes-reflector:8.0.281
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
---
# Annotate the source secret for reflection
apiVersion: v1
kind: Secret
metadata:
  name: registry-credentials
  namespace: platform
  annotations:
    reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
    reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
    reflector.v1.k8s.emberstack.com/reflection-auto-namespaces: ".*"
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: <base64-docker-config>
```

### ECR Authentication with IRSA

For AWS ECR, use IRSA (IAM Roles for Service Accounts) to avoid static credentials:

```yaml
# Amazon ECR credential helper via DaemonSet
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ecr-credential-helper
  namespace: kube-system
spec:
  template:
    spec:
      serviceAccountName: ecr-credential-helper
      hostPID: true
      containers:
      - name: ecr-helper
        image: <account-id>.dkr.ecr.<aws-region>.amazonaws.com/ecr-credential-helper:latest
        securityContext:
          privileged: true
        volumeMounts:
        - name: docker-config
          mountPath: /root/.docker
        - name: host-docker-config
          mountPath: /host-docker-config
        env:
        - name: AWS_REGION
          value: <aws-region>
      volumes:
      - name: docker-config
        emptyDir: {}
      - name: host-docker-config
        hostPath:
          path: /root/.docker
          type: DirectoryOrCreate
---
# IAM Role for ECR access (attach to node instance role or use IRSA)
# Required IAM policy:
# {
#   "Version": "2012-10-17",
#   "Statement": [{
#     "Effect": "Allow",
#     "Action": [
#       "ecr:GetDownloadUrlForLayer",
#       "ecr:BatchGetImage",
#       "ecr:BatchCheckLayerAvailability",
#       "ecr:GetAuthorizationToken"
#     ],
#     "Resource": "*"
#   }]
# }
```

## Pre-Pulling with DaemonSets

### The Pre-Pull Pattern

Pre-pulling images ensures they are available on all nodes before pods need them, eliminating pull latency from critical paths:

```yaml
# Image pre-puller DaemonSet
# Runs a container that immediately exits after ensuring the image is present
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: prepull-myapp
  namespace: kube-system
  labels:
    app: prepull-myapp
    version: v2.3.1
spec:
  selector:
    matchLabels:
      app: prepull-myapp
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 100%    # Pull on all nodes simultaneously
  template:
    metadata:
      labels:
        app: prepull-myapp
    spec:
      # Use low priority to avoid competing with production workloads
      priorityClassName: low-priority
      tolerations:
      - operator: Exists    # Run on all nodes including tainted ones
      initContainers:
      - name: pull
        image: <private-registry>/myapp:v2.3.1
        imagePullPolicy: IfNotPresent    # Only pull if not already cached
        command: ["sh", "-c", "echo Image pulled successfully"]
        resources:
          requests:
            cpu: "10m"
            memory: "16Mi"
          limits:
            cpu: "100m"
            memory: "32Mi"
      imagePullSecrets:
      - name: registry-credentials
      containers:
      - name: pause
        image: gcr.io/google-containers/pause:3.9
        resources:
          requests:
            cpu: "1m"
            memory: "4Mi"
```

### Automated Pre-Puller for Deployments

A controller that automatically creates pre-pull DaemonSets for deployments tagged for pre-pulling:

```go
// controller that watches Deployments and creates pre-pull DaemonSets
package main

import (
    "context"
    "fmt"
    "log/slog"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"
)

const prepullAnnotation = "image.kubernetes.io/prepull"

type DeploymentReconciler struct {
    client.Client
    logger *slog.Logger
}

func (r *DeploymentReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
    var deploy appsv1.Deployment
    if err := r.Get(ctx, req.NamespacedName, &deploy); err != nil {
        if errors.IsNotFound(err) {
            return reconcile.Result{}, nil
        }
        return reconcile.Result{}, err
    }

    // Check if pre-pull annotation is set
    if deploy.Annotations[prepullAnnotation] != "true" {
        return reconcile.Result{}, nil
    }

    // Create or update pre-pull DaemonSet
    ds := r.buildPrepullDaemonSet(&deploy)
    existing := &appsv1.DaemonSet{}
    err := r.Get(ctx, client.ObjectKeyFromObject(ds), existing)
    if errors.IsNotFound(err) {
        return reconcile.Result{}, r.Create(ctx, ds)
    }
    if err != nil {
        return reconcile.Result{}, err
    }

    // Update if image changed
    if existing.Spec.Template.Spec.InitContainers[0].Image != ds.Spec.Template.Spec.InitContainers[0].Image {
        existing.Spec = ds.Spec
        return reconcile.Result{}, r.Update(ctx, existing)
    }

    return reconcile.Result{}, nil
}

func (r *DeploymentReconciler) buildPrepullDaemonSet(deploy *appsv1.Deployment) *appsv1.DaemonSet {
    // Get the first container's image
    var image string
    var pullSecrets []corev1.LocalObjectReference
    if len(deploy.Spec.Template.Spec.Containers) > 0 {
        image = deploy.Spec.Template.Spec.Containers[0].Image
    }
    pullSecrets = deploy.Spec.Template.Spec.ImagePullSecrets

    maxUnavailable := intstr.FromString("100%")
    return &appsv1.DaemonSet{
        ObjectMeta: metav1.ObjectMeta{
            Name:      fmt.Sprintf("prepull-%s", deploy.Name),
            Namespace: "kube-system",
            Labels: map[string]string{
                "app.kubernetes.io/managed-by": "prepull-controller",
                "prepull.target.namespace":     deploy.Namespace,
                "prepull.target.deployment":    deploy.Name,
            },
        },
        Spec: appsv1.DaemonSetSpec{
            Selector: &metav1.LabelSelector{
                MatchLabels: map[string]string{
                    "prepull.target.deployment": deploy.Name,
                },
            },
            UpdateStrategy: appsv1.DaemonSetUpdateStrategy{
                Type: appsv1.RollingUpdateDaemonSetStrategyType,
                RollingUpdate: &appsv1.RollingUpdateDaemonSet{
                    MaxUnavailable: &maxUnavailable,
                },
            },
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{
                        "prepull.target.deployment": deploy.Name,
                    },
                },
                Spec: corev1.PodSpec{
                    Tolerations: []corev1.Toleration{
                        {Operator: corev1.TolerationOpExists},
                    },
                    PriorityClassName: "low-priority",
                    ImagePullSecrets:  pullSecrets,
                    InitContainers: []corev1.Container{
                        {
                            Name:            "pull",
                            Image:           image,
                            ImagePullPolicy: corev1.PullIfNotPresent,
                            Command:         []string{"sh", "-c", "echo Image cached"},
                            Resources: corev1.ResourceRequirements{
                                Requests: corev1.ResourceList{
                                    corev1.ResourceCPU:    resource.MustParse("10m"),
                                    corev1.ResourceMemory: resource.MustParse("16Mi"),
                                },
                            },
                        },
                    },
                    Containers: []corev1.Container{
                        {
                            Name:  "pause",
                            Image: "gcr.io/google-containers/pause:3.9",
                            Resources: corev1.ResourceRequirements{
                                Requests: corev1.ResourceList{
                                    corev1.ResourceCPU:    resource.MustParse("1m"),
                                    corev1.ResourceMemory: resource.MustParse("4Mi"),
                                },
                            },
                        },
                    },
                },
            },
        },
    }
}
```

## Image Layer Optimization

### Minimizing Image Size for Faster Pulls

```dockerfile
# Multi-stage build: minimize runtime image size
FROM golang:1.23 AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /app/server .

# Distroless: no shell, no package manager, minimal attack surface
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /app/server /server
USER nonroot:nonroot
ENTRYPOINT ["/server"]

# Resulting image: typically 15-25MB vs 800MB for a debian-based image
# Layer count: 2 (distroless base + binary) vs 10+ layers
```

### Layer Ordering for Maximum Cache Reuse

```dockerfile
# GOOD: Dependencies (rarely changed) before application code (frequently changed)
FROM python:3.12-slim

# Layer 1: System packages (changes rarely)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Layer 2: Python dependencies (changes infrequently)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Layer 3: Application code (changes frequently)
COPY src/ /app/src/
COPY config/ /app/config/

CMD ["python", "-m", "app"]

# BAD: Mixing stable and volatile content in one layer
# COPY . /app  <- invalidates cache on every code change
# RUN pip install -r /app/requirements.txt  <- re-downloads ALL dependencies
```

### Measuring Layer Sizes

```bash
# Analyze image layers with dive
docker run --rm -it \
  -v /var/run/docker.sock:/var/run/docker.sock \
  wagoodman/dive:latest myapp:v2.3.1

# List all layers and sizes
docker history --no-trunc myapp:v2.3.1 | \
  awk '{print $1, $NF}' | column -t

# Find duplicate data across layers
docker save myapp:v2.3.1 | tar -tv | sort | uniq -d
```

## Production Configuration: Complete Example

```yaml
# Node configuration via containerd config and kubelet settings
# Applied via node bootstrap or DaemonSet

# containerd config for production cluster
apiVersion: v1
kind: ConfigMap
metadata:
  name: containerd-config
  namespace: kube-system
data:
  config.toml: |
    version = 2
    [metrics]
      address = "127.0.0.1:1338"

    [plugins."io.containerd.grpc.v1.cri"]
      [plugins."io.containerd.grpc.v1.cri".containerd]
        snapshotter = "overlayfs"
        default_runtime_name = "runc"

        [plugins."io.containerd.grpc.v1.cri".containerd.default_runtime]
          [plugins."io.containerd.grpc.v1.cri".containerd.default_runtime.options]
            SystemdCgroup = true

      [plugins."io.containerd.grpc.v1.cri".registry]
        [plugins."io.containerd.grpc.v1.cri".registry.mirrors]
          [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
            endpoint = ["https://harbor.example.com/docker-proxy", "https://registry-1.docker.io"]
          [plugins."io.containerd.grpc.v1.cri".registry.mirrors."registry.k8s.io"]
            endpoint = ["https://harbor.example.com/registry-k8s-io", "https://registry.k8s.io"]
          [plugins."io.containerd.grpc.v1.cri".registry.mirrors."ghcr.io"]
            endpoint = ["https://harbor.example.com/ghcr-proxy", "https://ghcr.io"]

        [plugins."io.containerd.grpc.v1.cri".registry.configs]
          [plugins."io.containerd.grpc.v1.cri".registry.configs."harbor.example.com".auth]
            username = "robot$pull-user"
            password = "<harbor-robot-token>"
          [plugins."io.containerd.grpc.v1.cri".registry.configs."harbor.example.com".tls]
            insecure_skip_verify = false
            ca_file = "/etc/containerd/harbor-ca.crt"
```

### Monitoring Image Pull Performance

```bash
# Dashboard queries for Grafana

# Average image pull duration by registry
histogram_quantile(0.95,
  sum(rate(kubelet_image_pull_duration_seconds_bucket[5m]))
  by (le, image)
)

# Image cache hit rate (pulls that found image already cached)
# (No direct metric; infer from IfNotPresent + no pull event)
sum(rate(kubelet_image_pull_total{pull_result="cached"}[5m]))
/
sum(rate(kubelet_image_pull_total[5m]))

# Pods waiting for image pull (shows startup impact)
sum(kube_pod_container_status_waiting_reason{reason="ContainerCreating"}) by (namespace)
```

```yaml
# Kubernetes event-based image pull monitoring
apiVersion: v1
kind: ConfigMap
metadata:
  name: event-exporter-config
  namespace: monitoring
data:
  config.yaml: |
    logLevel: error
    logFormat: json
    route:
      routes:
      - match:
        - receiver: image-pull-events
          type: Normal
          reason: Pulling
        - receiver: image-pull-events
          type: Normal
          reason: Pulled
        - receiver: image-pull-failure
          type: Warning
          reason: Failed
    receivers:
    - name: image-pull-events
      prometheus:
        labels:
          event_type: "{{.Type}}"
          reason: "{{.Reason}}"
          namespace: "{{.Namespace}}"
```

## Startup Latency Budget

### Calculating Total Pod Startup Time

```
Total startup latency =
  API server processing         (~50ms)
  Scheduler decision            (~10ms)
  Node kubelet processing       (~100ms)
  + Image pull time             (0ms cached, 1-120s uncached)
  + Container creation (runc)   (~200ms)
  + Application init time       (varies)
  + Readiness probe delay       (initialDelaySeconds)
  + First readiness probe pass  (periodSeconds)

Target: < 10 seconds for production deployments
Acceptable: < 30 seconds for large images or heavy init
Unacceptable: > 60 seconds (triggers deployment timeouts)
```

### Deployment Strategy to Hide Pull Latency

```yaml
# Use maxSurge > 0 with pre-pulled images to achieve zero-latency upgrades
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  annotations:
    # Trigger pre-pull DaemonSet before deploy
    image.kubernetes.io/prepull: "true"
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2          # Create 2 new pods before removing old ones
      maxUnavailable: 0    # Never reduce capacity during upgrade
  template:
    spec:
      containers:
      - name: app
        image: <private-registry>/myapp:v2.3.1@sha256:<digest>
        imagePullPolicy: IfNotPresent    # Fast: image already cached by DaemonSet
```

## Summary

Image pull strategy is a foundational performance concern for Kubernetes clusters. The key principles are:

- Never use `:latest` in production; always pin to a specific tag or, better, a digest for true immutability
- Use `IfNotPresent` for all tagged images; use `Always` only when a tag genuinely cannot guarantee content identity
- Deploy a registry mirror (Harbor in proxy cache mode or equivalent) to avoid external registry latency and rate limits for all cluster image traffic
- Configure containerd's registry mirror list to fall back to the upstream if the mirror is unavailable, preventing the mirror from being a single point of failure
- Pre-pull critical images using DaemonSets before deploying workloads that require them, eliminating cold-start latency from critical deployment paths
- Monitor `kubelet_image_pull_duration_seconds` to identify slow registries, and `kube_pod_container_status_waiting_reason{reason="ContainerCreating"}` to identify pods blocked on image pulls
- Optimize Dockerfile layer order to maximize layer cache reuse: stable dependencies first, application code last
- Use distroless or minimal base images to reduce image size and pull time, especially for services with aggressive HPA scaling policies
