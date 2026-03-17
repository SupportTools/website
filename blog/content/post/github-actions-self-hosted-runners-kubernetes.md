---
title: "GitHub Actions Self-Hosted Runners on Kubernetes with ARC"
date: 2027-11-14T00:00:00-05:00
draft: false
tags: ["GitHub Actions", "ARC", "Kubernetes", "CI/CD", "Self-Hosted Runners"]
categories:
- CI/CD
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying GitHub Actions Runner Controller on Kubernetes, covering RunnerSet auto-scaling, ephemeral runners, Docker-in-Docker builds, private registries, runner groups, and cost optimization."
more_link: "yes"
url: "/github-actions-self-hosted-runners-kubernetes/"
---

GitHub-hosted runners provide convenience but impose limitations: fixed compute sizes, no access to private network resources, and costs that scale with workflow minutes. Self-hosted runners on Kubernetes with the Actions Runner Controller (ARC) solve these problems by deploying ephemeral runners that scale with demand, run inside your VPC with access to internal services, and use your existing node pool for compute.

This guide covers ARC deployment, RunnerSet configuration for auto-scaling, ephemeral runner patterns, Docker-in-Docker builds for container image workflows, private registry integration, runner group management, and cost optimization strategies for large engineering organizations.

<!--more-->

# GitHub Actions Self-Hosted Runners on Kubernetes with ARC

## Architecture Overview

The Actions Runner Controller (ARC) is a Kubernetes operator that manages the lifecycle of GitHub Actions runner pods. ARC v2 (the current version) uses `RunnerScaleSet` as the primary resource, which replaced the older `RunnerDeployment` and `RunnerSet` types.

```
GitHub Actions API
        │
        │  Webhook or polling
        ▼
ARC Controller (scale-set-controller)
        │
        │  Creates/deletes runner pods
        ▼
RunnerScaleSet (Kubernetes resource)
        │
        │  Pods with ephemeral runner agent
        ▼
Runner Pods (run workflows, then terminate)
```

### ARC vs GitHub-Hosted Runners

| Capability | GitHub-Hosted | ARC Self-Hosted |
|------------|---------------|-----------------|
| Machine size | Fixed tiers | Any node pool |
| VPC access | No | Yes |
| Cost | Per-minute billing | Cluster compute cost |
| Persistence | None | Configurable |
| Cold start | ~30s | ~10-60s (image pull) |
| Max concurrent | Plan-limited | Node capacity |
| Registry access | GitHub Container Registry | Private registry |

## Installation

### Prerequisites

```bash
# Install cert-manager (required by ARC)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.15.0/cert-manager.yaml
kubectl wait --for=condition=Available deployment/cert-manager -n cert-manager --timeout=60s

# Create GitHub App or PAT for ARC authentication
# GitHub App is recommended for production (better rate limits)
# Required permissions for the GitHub App:
# - Actions: Read and Write
# - Administration: Read and Write (for runner groups)
# - Checks: Read (optional, for workflow status)
# - Metadata: Read
```

### Installing ARC via Helm

```yaml
# arc-controller-values.yaml
replicaCount: 1

image:
  repository: ghcr.io/actions/actions-runner-controller-2/gha-runner-scale-set-controller
  pullPolicy: IfNotPresent

serviceAccount:
  create: true
  name: arc-controller-sa

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

flags:
  logLevel: info
  logFormat: json
  updateStrategy: eventual
```

```bash
# Add ARC Helm repository
helm repo add actions-runner-controller \
  https://actions-runner-controller.github.io/actions-runner-controller

# This repo is for the legacy version. For ARC v2:
helm repo add arc https://actions-runner-controller.github.io/actions-runner-controller

# Install ARC scale set controller
NAMESPACE="arc-systems"
helm install arc \
  oci://ghcr.io/actions/actions-runner-controller-2/helm/gha-runner-scale-set-controller \
  --version 0.9.3 \
  --namespace $NAMESPACE \
  --create-namespace \
  --values arc-controller-values.yaml

# Verify controller is running
kubectl get pods -n arc-systems
```

### GitHub App Authentication Secret

```bash
# Create secret from GitHub App credentials
kubectl create secret generic arc-github-app-secret \
  --namespace arc-systems \
  --from-literal=github_app_id=YOUR_APP_ID \
  --from-literal=github_app_installation_id=YOUR_INSTALLATION_ID \
  --from-file=github_app_private_key=private-key.pem
```

## RunnerScaleSet Configuration

### Basic RunnerScaleSet

```yaml
# runner-scale-set-values.yaml
githubConfigUrl: "https://github.com/company"
githubConfigSecret: arc-github-app-secret

minRunners: 0
maxRunners: 20

runnerScaleSetName: "k8s-runners"

template:
  spec:
    serviceAccountName: arc-runner-sa
    containers:
    - name: runner
      image: ghcr.io/actions/actions-runner:latest
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_INPUT_JITCONFIG
        value: ${{ inputs.jitConfig }}
      resources:
        requests:
          cpu: 500m
          memory: 1Gi
        limits:
          cpu: 2000m
          memory: 4Gi
      volumeMounts:
      - name: work
        mountPath: /home/runner/_work
    volumes:
    - name: work
      emptyDir: {}
    initContainers: []
    securityContext:
      runAsNonRoot: true
      runAsUser: 1001
      fsGroup: 123
```

```bash
# Deploy runner scale set for an organization
helm install arc-runner-set \
  oci://ghcr.io/actions/actions-runner-controller-2/helm/gha-runner-scale-set \
  --version 0.9.3 \
  --namespace arc-runners \
  --create-namespace \
  --values runner-scale-set-values.yaml
```

### Repository-Scoped RunnerScaleSet

```yaml
# Repository-specific runners (better isolation)
githubConfigUrl: "https://github.com/company/backend-services"
githubConfigSecret: arc-github-app-secret

minRunners: 1
maxRunners: 10

runnerScaleSetName: "backend-services-runners"

containerMode:
  type: dind

template:
  spec:
    serviceAccountName: arc-runner-sa
    containers:
    - name: runner
      image: registry.company.com/arc-runner:latest
      command: ["/home/runner/run.sh"]
      resources:
        requests:
          cpu: 1000m
          memory: 2Gi
        limits:
          cpu: 4000m
          memory: 8Gi
      env:
      - name: DOCKER_HOST
        value: tcp://localhost:2376
      - name: DOCKER_TLS_VERIFY
        value: "1"
      - name: DOCKER_CERT_PATH
        value: /certs/client
      volumeMounts:
      - name: work
        mountPath: /home/runner/_work
      - name: dind-certs
        mountPath: /certs/client
        readOnly: true
    - name: dind
      image: docker:26-dind
      args:
      - dockerd
      - --host=tcp://0.0.0.0:2376
      - --tlsverify
      - --tlscacert=/certs/ca.pem
      - --tlscert=/certs/server-cert.pem
      - --tlskey=/certs/server-key.pem
      securityContext:
        privileged: true
      env:
      - name: DOCKER_TLS_CERTDIR
        value: /certs
      volumeMounts:
      - name: work
        mountPath: /home/runner/_work
      - name: dind-certs
        mountPath: /certs/client
      resources:
        requests:
          cpu: 500m
          memory: 1Gi
        limits:
          cpu: 4000m
          memory: 8Gi
    volumes:
    - name: work
      emptyDir: {}
    - name: dind-certs
      emptyDir: {}
```

## Custom Runner Images

### Building a Custom Runner Image

```dockerfile
# Dockerfile.runner
FROM ubuntu:22.04

# Install GitHub Actions runner dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    jq \
    tar \
    wget \
    unzip \
    ca-certificates \
    gnupg \
    lsb-release \
    libicu70 \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Install specific runner version
ARG RUNNER_VERSION=2.319.0
ARG RUNNER_ARCH=x64

RUN curl -o /tmp/actions-runner.tar.gz -L \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz" && \
    mkdir -p /home/runner && \
    tar xzf /tmp/actions-runner.tar.gz -C /home/runner && \
    rm /tmp/actions-runner.tar.gz

# Install common build tools
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    python3-pip \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install Go
ARG GO_VERSION=1.23.0
RUN curl -L "https://golang.org/dl/go${GO_VERSION}.linux-amd64.tar.gz" | \
    tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

# Install Docker CLI (not daemon - use DinD sidecar)
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
    tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

# Install kubectl
ARG KUBECTL_VERSION=1.31.0
RUN curl -LO "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && \
    mv kubectl /usr/local/bin/

# Install Helm
RUN curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Create non-root user
RUN useradd -m -u 1001 runner && \
    chown -R runner:runner /home/runner

USER runner
WORKDIR /home/runner
```

```bash
# Build and push custom runner image
docker build -f Dockerfile.runner \
  -t registry.company.com/arc-runner:2.319.0 \
  --build-arg RUNNER_VERSION=2.319.0 .

docker push registry.company.com/arc-runner:2.319.0
```

## Docker-in-Docker Builds

### Kubernetes Mode (Recommended)

The "kubernetes" container mode runs each workflow step as a separate Kubernetes pod, avoiding the need for privileged DinD containers:

```yaml
# runner-scale-set-kubernetes-mode.yaml
githubConfigUrl: "https://github.com/company"
githubConfigSecret: arc-github-app-secret

containerMode:
  type: kubernetes
  kubernetesModeWorkVolumeClaim:
    accessModes:
    - ReadWriteOnce
    storageClassName: gp3
    resources:
      requests:
        storage: 1Gi

minRunners: 0
maxRunners: 30

template:
  spec:
    serviceAccountName: arc-runner-sa
    containers:
    - name: runner
      image: registry.company.com/arc-runner:2.319.0
      command: ["/home/runner/run.sh"]
      resources:
        requests:
          cpu: 200m
          memory: 512Mi
        limits:
          cpu: 1000m
          memory: 2Gi
```

The runner service account needs permissions to create pods:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: arc-runner-sa
  namespace: arc-runners
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: arc-runner-role
  namespace: arc-runners
rules:
- apiGroups: [""]
  resources:
  - pods
  - pods/exec
  - pods/log
  - secrets
  - configmaps
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups: [""]
  resources:
  - persistentvolumeclaims
  verbs:
  - create
  - delete
  - get
  - list
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: arc-runner-role-binding
  namespace: arc-runners
subjects:
- kind: ServiceAccount
  name: arc-runner-sa
  namespace: arc-runners
roleRef:
  kind: Role
  name: arc-runner-role
  apiGroup: rbac.authorization.k8s.io
```

### DinD Mode with Kaniko Fallback

For workflows that need Docker commands directly:

```yaml
# Workflow using self-hosted runner with DinD
name: Build and Push

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: [self-hosted, k8s-runners]
    steps:
    - uses: actions/checkout@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3
      with:
        driver: docker-container
        endpoint: tcp://localhost:2376
        driver-opts: env.DOCKER_TLS_VERIFY=1,env.DOCKER_CERT_PATH=/certs/client

    - name: Log in to private registry
      uses: docker/login-action@v3
      with:
        registry: registry.company.com
        username: ${{ secrets.REGISTRY_USER }}
        password: ${{ secrets.REGISTRY_PASSWORD }}

    - name: Build and push
      uses: docker/build-push-action@v6
      with:
        context: .
        push: true
        tags: |
          registry.company.com/myapp:${{ github.sha }}
          registry.company.com/myapp:latest
        cache-from: type=registry,ref=registry.company.com/myapp:cache
        cache-to: type=registry,ref=registry.company.com/myapp:cache,mode=max
```

## Private Registry Configuration

### Pulling Runner Images from Private Registry

```yaml
# Configure imagePullSecrets for runner pods
template:
  spec:
    imagePullSecrets:
    - name: registry-credentials
    containers:
    - name: runner
      image: registry.company.com/arc-runner:2.319.0
```

```bash
# Create the pull secret
kubectl create secret docker-registry registry-credentials \
  --namespace arc-runners \
  --docker-server=registry.company.com \
  --docker-username=arc-runner \
  --docker-password=PAT-or-service-account-password \
  --docker-email=platform@company.com
```

### Mounting Registry Credentials for Builds

```yaml
template:
  spec:
    serviceAccountName: arc-runner-sa
    containers:
    - name: runner
      image: registry.company.com/arc-runner:2.319.0
      env:
      - name: DOCKER_CONFIG
        value: /home/runner/.docker
      volumeMounts:
      - name: registry-creds
        mountPath: /home/runner/.docker
        readOnly: true
      - name: work
        mountPath: /home/runner/_work
    volumes:
    - name: registry-creds
      secret:
        secretName: registry-docker-config
        items:
        - key: .dockerconfigjson
          path: config.json
    - name: work
      emptyDir: {}
```

## Runner Groups and Labels

### Organizing Runners by Team

```yaml
# Team-specific runner scale sets with labels
# Payments team runners
apiVersion: v1
kind: ConfigMap
metadata:
  name: payments-runner-config
data:
  values.yaml: |
    githubConfigUrl: "https://github.com/company"
    githubConfigSecret: arc-github-app-secret
    runnerGroup: "payments-team"
    runnerScaleSetName: "payments-runners"
    minRunners: 2
    maxRunners: 15
    template:
      spec:
        nodeSelector:
          runner-pool: payments
        tolerations:
        - key: runner-pool
          operator: Equal
          value: payments
          effect: NoSchedule
        containers:
        - name: runner
          image: registry.company.com/arc-runner-payments:latest
          resources:
            requests:
              cpu: 2000m
              memory: 4Gi
            limits:
              cpu: 8000m
              memory: 16Gi
```

### Workflow Using Specific Runner Groups

```yaml
name: Payments Service CI

on:
  push:
    paths:
    - 'services/payments/**'

jobs:
  test:
    # Use the payments team runner group with specific labels
    runs-on:
    - self-hosted
    - payments-runners
    - linux
    steps:
    - uses: actions/checkout@v4

    - name: Run integration tests
      run: |
        # These tests need access to internal postgres (only accessible from VPC)
        go test ./... \
          -tags=integration \
          -database-url="postgres://test:test@postgres.internal:5432/payments_test"
      env:
        TEST_DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
```

## Auto-Scaling Configuration

### Scale-to-Zero with Minimum Warm Runners

```yaml
# Efficient auto-scaling configuration
githubConfigUrl: "https://github.com/company"
githubConfigSecret: arc-github-app-secret

minRunners: 0
maxRunners: 50

# Scale up aggressively, scale down conservatively
template:
  spec:
    terminationGracePeriodSeconds: 300  # 5 min to finish any cleanup
    containers:
    - name: runner
      image: registry.company.com/arc-runner:2.319.0
      lifecycle:
        preStop:
          exec:
            command: ["/bin/sh", "-c", "sleep 5"]
      resources:
        requests:
          cpu: 500m
          memory: 1Gi
        limits:
          cpu: 4000m
          memory: 8Gi
```

### Priority Node Pool for Runner Pods

```yaml
# Use spot/preemptible instances for cost optimization
# with a fallback to on-demand for critical workloads

# Priority class for non-critical CI runners
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: ci-runner-spot
value: 100
preemptionPolicy: Never
globalDefault: false
description: "Priority class for CI runners on spot instances"
---
# Runner template using spot instances
template:
  spec:
    priorityClassName: ci-runner-spot
    nodeSelector:
      node-lifecycle: spot
    tolerations:
    - key: spot-instance
      operator: Equal
      value: "true"
      effect: NoSchedule
    - key: kubernetes.azure.com/scalesetpriority
      operator: Equal
      value: spot
      effect: NoSchedule
    containers:
    - name: runner
      image: registry.company.com/arc-runner:2.319.0
```

## Caching Strategies

### Persistent Volume Cache

```yaml
# Mount a shared RWX volume for build caches
template:
  spec:
    containers:
    - name: runner
      image: registry.company.com/arc-runner:2.319.0
      env:
      - name: GOPATH
        value: /cache/go
      - name: GOCACHE
        value: /cache/go/pkg/mod
      - name: npm_config_cache
        value: /cache/npm
      - name: GRADLE_USER_HOME
        value: /cache/gradle
      volumeMounts:
      - name: work
        mountPath: /home/runner/_work
      - name: cache
        mountPath: /cache
    volumes:
    - name: work
      emptyDir: {}
    - name: cache
      persistentVolumeClaim:
        claimName: arc-runner-cache
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: arc-runner-cache
  namespace: arc-runners
spec:
  accessModes:
  - ReadWriteMany
  storageClassName: efs-sc
  resources:
    requests:
      storage: 100Gi
```

### S3-Backed GitHub Actions Cache

```yaml
# Use actions/cache with S3 backend
name: Go Build

on:
  push:

jobs:
  build:
    runs-on: [self-hosted, k8s-runners]
    steps:
    - uses: actions/checkout@v4

    - name: Set up Go module cache
      uses: actions/cache@v4
      with:
        path: |
          ~/go/pkg/mod
          ~/.cache/go-build
        key: ${{ runner.os }}-go-${{ hashFiles('**/go.sum') }}
        restore-keys: |
          ${{ runner.os }}-go-

    - name: Build
      run: go build ./...
```

## Monitoring and Observability

### Prometheus Metrics from ARC

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: arc-controller
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: gha-runner-scale-set-controller
  namespaceSelector:
    matchNames:
    - arc-systems
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

Key ARC metrics:

```promql
# Number of registered runners
arc_runner_count{runner_scale_set="k8s-runners"}

# Pending workflow jobs waiting for runners
arc_pending_jobs{runner_scale_set="k8s-runners"}

# Runner acquisition time (how long jobs wait)
histogram_quantile(0.99, rate(arc_job_startup_duration_seconds_bucket[5m]))

# Scale-up events
rate(arc_scale_up_total[5m])

# Runner pod start failures
rate(arc_runner_pod_creation_failed_total[5m])
```

### Grafana Dashboard

```json
{
  "title": "GitHub Actions Runner Status",
  "panels": [
    {
      "title": "Active Runners by Scale Set",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(arc_runner_count) by (runner_scale_set)",
          "legendFormat": "{{runner_scale_set}}"
        }
      ]
    },
    {
      "title": "Pending Jobs Queue Depth",
      "type": "timeseries",
      "targets": [
        {
          "expr": "arc_pending_jobs",
          "legendFormat": "{{runner_scale_set}}"
        }
      ]
    },
    {
      "title": "Runner Utilization",
      "type": "gauge",
      "targets": [
        {
          "expr": "sum(arc_busy_runners) by (runner_scale_set) / sum(arc_runner_count) by (runner_scale_set)",
          "legendFormat": "{{runner_scale_set}}"
        }
      ]
    }
  ]
}
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: arc-alerts
  namespace: monitoring
spec:
  groups:
  - name: arc.runner
    rules:
    - alert: ARCRunnerQueueBacklog
      expr: |
        arc_pending_jobs > 10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "ARC runner queue backlog for {{ $labels.runner_scale_set }}"
        description: "{{ $value }} jobs waiting for runners - consider increasing maxRunners"

    - alert: ARCRunnerPodsNotStarting
      expr: |
        rate(arc_runner_pod_creation_failed_total[5m]) > 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "ARC runner pods are failing to start"
        description: "Check node capacity and image pull issues"

    - alert: ARCControllerDown
      expr: |
        absent(up{job="arc-controller"})
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "ARC controller is down - no new runners will be provisioned"
```

## Cost Optimization

### Spot Instance Strategy

```bash
# Create a spot node pool for CI runners (EKS example)
eksctl create nodegroup \
  --cluster prod-cluster \
  --name ci-runners-spot \
  --node-type m5.2xlarge,m5a.2xlarge,m4.2xlarge \
  --spot \
  --nodes-min 0 \
  --nodes-max 20 \
  --asg-access \
  --node-labels "node-lifecycle=spot,runner-pool=general" \
  --taints "spot-instance=true:NoSchedule"
```

### Cost Attribution Labels

```yaml
template:
  metadata:
    labels:
      cost-center: engineering-platform
      team: ci-cd
      runner-pool: general
    annotations:
      cost.company.com/budget-code: "infra-2024"
  spec:
    containers:
    - name: runner
      image: registry.company.com/arc-runner:2.319.0
```

### Resource Right-Sizing

```bash
#!/bin/bash
# analyze-runner-resource-usage.sh
# Analyzes actual resource usage to optimize runner requests/limits

NAMESPACE="arc-runners"
DAYS=7

echo "=== Runner Resource Usage Analysis (last $DAYS days) ==="

# Average CPU usage
kubectl top pods -n $NAMESPACE --sort-by=cpu 2>/dev/null | \
  awk 'NR>1 {cpu += $2; count++} END {
    gsub("m", "", cpu)
    if (count > 0)
      printf "Average CPU: %dm across %d runner samples\n", cpu/count, count
  }'

# Average memory usage
kubectl top pods -n $NAMESPACE --sort-by=memory 2>/dev/null | \
  awk 'NR>1 {mem += $3; count++} END {
    gsub("Mi", "", mem)
    if (count > 0)
      printf "Average Memory: %dMi across %d runner samples\n", mem/count, count
  }'

# Job duration distribution (from GitHub API)
curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/company/REPO/actions/runs?per_page=100" | \
  python3 -c "
import json, sys
from datetime import datetime
data = json.load(sys.stdin)
durations = []
for run in data.get('workflow_runs', []):
    if run.get('created_at') and run.get('updated_at'):
        created = datetime.fromisoformat(run['created_at'].replace('Z', '+00:00'))
        updated = datetime.fromisoformat(run['updated_at'].replace('Z', '+00:00'))
        duration = (updated - created).total_seconds()
        durations.append(duration)

if durations:
    durations.sort()
    p50 = durations[len(durations)//2]
    p95 = durations[int(len(durations)*0.95)]
    print(f'P50 job duration: {p50:.0f}s ({p50/60:.1f}m)')
    print(f'P95 job duration: {p95:.0f}s ({p95/60:.1f}m)')
    print(f'Max job duration: {max(durations):.0f}s ({max(durations)/60:.1f}m)')
"
```

## Troubleshooting

### Common Issues

```bash
# Runner pod not starting
kubectl describe pod -n arc-runners -l runner.actions.github.com/scale-set-name=k8s-runners

# Check ARC controller logs
kubectl logs -n arc-systems \
  deployment/arc-gha-runner-scale-set-controller \
  -f --tail=100

# Check runner registration with GitHub
kubectl logs -n arc-runners \
  $(kubectl get pods -n arc-runners -l runner.actions.github.com/scale-set-name=k8s-runners -o name | head -1) \
  -c runner

# Verify GitHub App authentication
kubectl get secret -n arc-systems arc-github-app-secret -o yaml | \
  python3 -c "
import yaml, base64, sys
data = yaml.safe_load(sys.stdin)
for key in data.get('data', {}):
    val = base64.b64decode(data['data'][key]).decode()
    if key != 'github_app_private_key':
        print(f'{key}: {val}')
    else:
        print(f'{key}: [REDACTED - {len(val)} chars]')
"

# Check RBAC for runner service account
kubectl auth can-i create pods --as=system:serviceaccount:arc-runners:arc-runner-sa -n arc-runners
kubectl auth can-i delete pods --as=system:serviceaccount:arc-runners:arc-runner-sa -n arc-runners
```

### Workflow Job Never Picked Up

```bash
# Check if scale set is registered with GitHub
# Go to: Settings > Actions > Runners in your GitHub organization

# Check if the runner label matches the workflow
# Workflow: runs-on: [self-hosted, k8s-runners]
# Must match: runnerScaleSetName: "k8s-runners"

# Check for pending jobs in the queue
kubectl get runnerscaleset -n arc-runners -o yaml | \
  grep -A5 "pendingEphemeralRunners"

# Trigger manual reconciliation
kubectl annotate runnerscaleset -n arc-runners k8s-runners \
  arc.actions.github.com/last-reconciled=$(date +%s) --overwrite
```

## Summary

Actions Runner Controller provides a production-grade self-hosted runner solution that balances isolation, cost efficiency, and operational simplicity.

**Deployment**: ARC v2 uses `RunnerScaleSet` resources managed via Helm. GitHub App authentication is preferred over PATs for better rate limits and organization-wide runner management.

**Container mode**: Kubernetes mode (each workflow step as a pod) is preferred for isolation and avoids privileged containers. DinD mode is suitable when Docker commands are required directly in the workflow.

**Auto-scaling**: Configure `minRunners: 0` for cost-sensitive workloads. The controller scales up on pending jobs and scales down after jobs complete. Use `minRunners: 2` for critical workflows that cannot tolerate cold start latency.

**Cost optimization**: Spot instances reduce runner costs by 60-80%. Label runner pods with team and cost-center labels for chargeback attribution. Right-size resource requests based on actual workflow profiling.

**Monitoring**: ARC exposes Prometheus metrics through the controller's metrics port. Key metrics are pending job queue depth (indicates under-provisioning) and runner pod creation failures (indicates infrastructure problems).

**Private resources**: The primary advantage of self-hosted runners is VPC access. Configure runner pods with service accounts that have the necessary IAM permissions for AWS/GCP/Azure resource access, eliminating the need for long-lived credentials in workflow secrets.
