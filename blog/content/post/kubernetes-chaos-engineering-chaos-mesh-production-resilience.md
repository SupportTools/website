---
title: "Kubernetes Chaos Engineering with Chaos Mesh: Production Resilience Testing"
date: 2030-08-15T00:00:00-05:00
draft: false
tags: ["Chaos Engineering", "Chaos Mesh", "Kubernetes", "Resilience", "Testing", "SRE", "CI/CD"]
categories:
- Kubernetes
- SRE
- Testing
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Chaos Mesh guide covering network chaos, pod chaos, IO chaos, kernel chaos experiments, schedule management, workflow automation, blast radius control, and integrating chaos testing into CI/CD pipelines."
more_link: "yes"
url: "/kubernetes-chaos-engineering-chaos-mesh-production-resilience/"
---

Chaos engineering transforms resilience from an assumption into a verified property. Chaos Mesh provides a Kubernetes-native chaos engineering platform that injects controlled failures — network partitions, pod kills, disk I/O errors, kernel failures — directly into production-like environments. When combined with structured workflows, blast radius controls, and CI/CD integration, Chaos Mesh shifts resilience testing from ad-hoc incident retrospectives to systematic, repeatable experiments that validate system behavior before failures occur in production.

<!--more-->

## Installing Chaos Mesh

### Helm Installation

```bash
# Add the Chaos Mesh Helm repository
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm repo update

# Create the chaos engineering namespace
kubectl create namespace chaos-mesh

# Install Chaos Mesh with dashboard enabled
helm install chaos-mesh chaos-mesh/chaos-mesh \
    --namespace chaos-mesh \
    --version 2.6.3 \
    --set dashboard.create=true \
    --set dashboard.service.type=ClusterIP \
    --set chaosDaemon.runtime=containerd \
    --set chaosDaemon.socketPath=/run/containerd/containerd.sock \
    --set controllerManager.replicaCount=3 \
    --set webhook.certManager.enabled=true

# Verify installation
kubectl get pods -n chaos-mesh
```

### Verify CRDs

```bash
kubectl get crd | grep chaos-mesh.org
# networkchaos.chaos-mesh.org
# podchaos.chaos-mesh.org
# iochaos.chaos-mesh.org
# kernelchaos.chaos-mesh.org
# timechaos.chaos-mesh.org
# stresschaos.chaos-mesh.org
# physicalmachinechaos.chaos-mesh.org
# httpchaos.chaos-mesh.org
# dnschaos.chaos-mesh.org
# awschaos.chaos-mesh.org
# gcpchaos.chaos-mesh.org
```

---

## RBAC and Namespace Scoping

Chaos Mesh supports namespace-scoped experiments for blast radius control. Create a service account for chaos experiments in the target namespace:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: chaos-operator
  namespace: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: chaos-operator
  namespace: production
rules:
  - apiGroups: ["chaos-mesh.org"]
    resources: ["*"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: chaos-operator
  namespace: production
subjects:
  - kind: ServiceAccount
    name: chaos-operator
    namespace: production
roleRef:
  kind: Role
  name: chaos-operator
  apiGroup: rbac.authorization.k8s.io
```

---

## Pod Chaos Experiments

### Pod Kill

The most fundamental experiment — kill a subset of pods and verify the system recovers within SLO bounds.

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: kill-order-service-pods
  namespace: production
spec:
  action: pod-kill
  mode: fixed-percent
  value: "30"           # Kill 30% of matching pods
  selector:
    namespaces:
      - production
    labelSelectors:
      app: order-service
  gracePeriod: 0        # Immediate kill (no graceful shutdown signal)
  duration: "10m"       # Run the experiment for 10 minutes
```

### Pod Failure (Pause, Not Kill)

Pod failure pauses a container process without killing the pod. This simulates a hung process or deadlock:

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: pause-inventory-service
  namespace: production
spec:
  action: pod-failure
  mode: fixed
  value: "1"
  selector:
    namespaces:
      - production
    labelSelectors:
      app: inventory-service
  duration: "5m"
```

### Container Kill (Multi-Container Pods)

For pods with multiple containers (sidecar patterns), target a specific container:

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: kill-sidecar-proxy
  namespace: production
spec:
  action: container-kill
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: payment-service
  containerNames:
    - envoy-proxy
  duration: "5m"
```

---

## Network Chaos Experiments

### Network Delay

Inject latency between services to validate timeout and retry behavior:

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: delay-database-calls
  namespace: production
spec:
  action: delay
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: order-service
  delay:
    latency: "200ms"
    correlation: "25"
    jitter: "50ms"
  direction: to
  externalTargets:
    - postgres-primary.production.svc.cluster.local
  duration: "15m"
```

### Network Partition

Simulate a network split between two service groups:

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: partition-payment-from-fraud
  namespace: production
spec:
  action: partition
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: payment-service
  direction: to
  target:
    mode: all
    selector:
      namespaces:
        - production
      labelSelectors:
        app: fraud-detection-service
  duration: "5m"
```

### Packet Loss and Corruption

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: packet-loss-cache
  namespace: production
spec:
  action: loss
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: api-gateway
  loss:
    loss: "20"        # 20% packet loss
    correlation: "75"  # High correlation — packet losses cluster together
  direction: to
  externalTargets:
    - redis-cluster.production.svc.cluster.local
  duration: "10m"
---
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: packet-corruption-upstream
  namespace: production
spec:
  action: corrupt
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: api-gateway
  corrupt:
    corrupt: "5"    # 5% packet corruption
    correlation: "50"
  duration: "5m"
```

---

## IO Chaos Experiments

IO chaos injects faults at the filesystem layer using the chaos-daemon's eBPF-based IO fault injection.

### IO Latency

Simulate slow disk I/O for storage-backed services:

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: slow-disk-postgres
  namespace: production
spec:
  action: latency
  mode: one
  selector:
    namespaces:
      - production
    labelSelectors:
      app: postgresql
  volumePath: /var/lib/postgresql/data
  path: "**"          # Affect all file operations in this path
  delay: "50ms"
  percent: 80         # Inject latency on 80% of IO operations
  methods:
    - read
    - write
  duration: "10m"
```

### IO Error Injection

Inject ENOSP (no space left) or EIO errors:

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: io-error-write-path
  namespace: production
spec:
  action: fault
  mode: one
  selector:
    namespaces:
      - production
    labelSelectors:
      app: audit-logger
  volumePath: /var/log/audit
  path: "*.log"
  errno: 28           # ENOSPC — no space left on device
  percent: 50
  methods:
    - write
  duration: "5m"
```

---

## Stress Chaos Experiments

StressChaos creates CPU and memory pressure using stress-ng inside target pods.

### CPU Stress

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: cpu-stress-api-gateway
  namespace: production
spec:
  mode: fixed-percent
  value: "50"
  selector:
    namespaces:
      - production
    labelSelectors:
      app: api-gateway
  stressors:
    cpu:
      workers: 4
      load: 80          # 80% CPU load per worker
  duration: "10m"
```

### Memory Stress

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: memory-pressure-order-service
  namespace: production
spec:
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: order-service
  stressors:
    memory:
      workers: 2
      size: "512MB"     # Allocate and hold 512MB per worker
  duration: "5m"
```

---

## Kernel Chaos

Kernel chaos injects syscall failures via eBPF, simulating kernel-level faults without requiring kernel module modifications.

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: KernelChaos
metadata:
  name: kernel-fault-malloc
  namespace: production
spec:
  mode: one
  selector:
    namespaces:
      - production
    labelSelectors:
      app: memory-intensive-service
  failKernRequest:
    callchain:
      - funcname: "__x64_sys_mmap"
    failtype: 0         # 0 = return error, 1 = panic
    headers:
      - "FAULT_INJECTION"
    probability: 5      # 5% of mmap calls fail
  duration: "5m"
```

---

## HTTP Chaos

HTTPChaos injects faults at the HTTP layer for services behind envoy sidecars or other proxies.

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: HTTPChaos
metadata:
  name: http-abort-catalog-api
  namespace: production
spec:
  mode: fixed-percent
  value: "20"
  selector:
    namespaces:
      - production
    labelSelectors:
      app: catalog-service
  target: Response
  port: 8080
  path: /api/v1/products/*
  abort: true           # Return immediately with no response body
  duration: "5m"
---
apiVersion: chaos-mesh.org/v1alpha1
kind: HTTPChaos
metadata:
  name: http-delay-checkout
  namespace: production
spec:
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: checkout-service
  target: Request
  port: 8080
  path: /api/v1/checkout
  delay: "3s"
  duration: "10m"
```

---

## Schedule Management

The Schedule CRD runs experiments on a cron schedule, enabling continuous resilience validation:

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata:
  name: weekly-pod-kill-order-service
  namespace: production
spec:
  schedule: "0 2 * * 2"    # Every Tuesday at 2 AM UTC
  historyLimit: 10
  concurrencyPolicy: Forbid
  type: PodChaos
  podChaos:
    action: pod-kill
    mode: fixed-percent
    value: "25"
    selector:
      namespaces:
        - production
      labelSelectors:
        app: order-service
    duration: "5m"
```

---

## Chaos Workflow Automation

Workflows compose multiple experiments with dependencies, enabling complex failure scenarios that mirror real-world incident patterns.

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: Workflow
metadata:
  name: cascading-failure-scenario
  namespace: production
spec:
  entry: entry
  templates:
    - name: entry
      templateType: Serial
      deadline: 30m
      children:
        - inject-db-latency
        - wait-for-alert
        - kill-payment-pods
        - verify-recovery

    - name: inject-db-latency
      templateType: Task
      task:
        container:
          name: inject
          image: victoriametrics/vmtools:latest
          command:
            - sh
            - -c
            - |
              kubectl apply -f /experiments/db-latency.yaml
              sleep 300
              kubectl delete -f /experiments/db-latency.yaml

    - name: wait-for-alert
      templateType: Suspend
      deadline: 5m   # Wait up to 5 minutes between steps

    - name: kill-payment-pods
      templateType: PodChaos
      podChaos:
        action: pod-kill
        mode: fixed-percent
        value: "50"
        selector:
          namespaces:
            - production
          labelSelectors:
            app: payment-service
        duration: "3m"

    - name: verify-recovery
      templateType: Task
      task:
        container:
          name: verify
          image: curlimages/curl:latest
          command:
            - sh
            - -c
            - |
              for i in $(seq 1 30); do
                status=$(curl -s -o /dev/null -w "%{http_code}" \
                  http://api-gateway.production.svc.cluster.local/health)
                if [ "$status" = "200" ]; then
                  echo "Service recovered after $i checks"
                  exit 0
                fi
                sleep 10
              done
              echo "Service did not recover within 5 minutes"
              exit 1
```

---

## Blast Radius Controls

### Namespace Selector Restrictions

Limit experiments to specific namespaces and prevent accidental production experiments:

```yaml
# chaos-mesh-values.yaml for Helm
controllerManager:
  allowedNamespaces: "staging,chaos-test"    # Only allow experiments in these namespaces
  ignoredNamespaces: "kube-system,monitoring,istio-system"
```

### Annotation-Based Opt-Out

Protect critical workloads from chaos experiments using annotations:

```yaml
# Add to pods or deployments that must never be targeted
metadata:
  annotations:
    chaos-mesh.org/inject: disabled
```

### Pod Selector with Availability Guards

Always pair chaos experiments with PodDisruptionBudgets that limit the minimum available replicas, ensuring chaos experiments respect availability requirements:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: order-service
```

When a PodChaos experiment attempts to kill pods in violation of a PDB, Kubernetes will prevent the kill — the experiment reveals whether the system's self-healing is correctly configured.

---

## Integrating Chaos Testing into CI/CD

### GitHub Actions Pipeline

```yaml
# .github/workflows/chaos-validation.yaml
name: Chaos Validation

on:
  workflow_dispatch:
  schedule:
    - cron: '0 3 * * 1'   # Every Monday at 3 AM UTC

jobs:
  chaos-test:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        run: |
          echo "${{ secrets.KUBECONFIG_STAGING }}" | base64 -d > /tmp/kubeconfig
          echo "KUBECONFIG=/tmp/kubeconfig" >> $GITHUB_ENV

      - name: Deploy chaos experiment
        run: |
          kubectl apply -f chaos/experiments/staging-pod-kill.yaml

      - name: Monitor SLO during experiment
        run: |
          EXPERIMENT_DURATION=300
          CHECK_INTERVAL=10
          ELAPSED=0
          SLO_BREACHES=0

          while [ $ELAPSED -lt $EXPERIMENT_DURATION ]; do
            ERROR_RATE=$(curl -s "http://prometheus.monitoring.svc/api/v1/query" \
              --data-urlencode 'query=rate(http_requests_total{status=~"5.."}[1m]) / rate(http_requests_total[1m])' \
              | jq -r '.data.result[0].value[1]' 2>/dev/null || echo "0")

            if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
              SLO_BREACHES=$((SLO_BREACHES + 1))
              echo "SLO breach detected: error rate $ERROR_RATE at $ELAPSED seconds"
            fi

            sleep $CHECK_INTERVAL
            ELAPSED=$((ELAPSED + CHECK_INTERVAL))
          done

          echo "Total SLO breaches during experiment: $SLO_BREACHES"
          if [ $SLO_BREACHES -gt 3 ]; then
            echo "FAIL: Too many SLO breaches during chaos experiment"
            exit 1
          fi

      - name: Clean up experiment
        if: always()
        run: |
          kubectl delete -f chaos/experiments/staging-pod-kill.yaml --ignore-not-found
```

---

## Observability During Chaos Experiments

### Grafana Dashboard Annotations

Tag Grafana dashboards with chaos experiment events to correlate system behavior with injected faults:

```bash
# Annotate Grafana when an experiment starts
curl -X POST http://grafana.monitoring.svc.cluster.local/api/annotations \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Chaos Experiment Started: pod-kill order-service 30%",
    "tags": ["chaos", "experiment", "order-service"],
    "time": '"$(date +%s%3N)"'
  }'
```

### Prometheus Alerts During Experiments

Configure a silence for non-critical alerts during scheduled chaos windows to reduce noise:

```yaml
# alertmanager-silence.yaml (Alertmanager API)
matchers:
  - name: severity
    value: warning
startsAt: "2030-08-15T02:00:00Z"
endsAt: "2030-08-15T03:00:00Z"
comment: "Scheduled chaos engineering window — weekly resilience test"
createdBy: "chaos-ci-pipeline"
```

---

## Conclusion

Chaos Mesh provides a mature, Kubernetes-native chaos engineering platform that covers the full spectrum of failure modes: pod lifecycle, network faults, storage I/O, HTTP-layer errors, and CPU/memory pressure. Effective chaos engineering programs combine controlled blast radius through namespace and annotation selectors, structured workflows that mirror real incident patterns, and CI/CD integration that makes resilience testing a continuous practice rather than a quarterly exercise. The goal is not to break things — it is to verify in a controlled way that the system's designed resilience mechanisms actually work before an uncontrolled failure does the testing for the team.
