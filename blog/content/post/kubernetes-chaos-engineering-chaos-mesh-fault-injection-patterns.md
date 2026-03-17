---
title: "Kubernetes Chaos Engineering with Chaos Mesh: Fault Injection Patterns"
date: 2029-08-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Chaos Engineering", "Chaos Mesh", "Resilience", "Testing", "SRE"]
categories: ["Kubernetes", "SRE", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Chaos Mesh on Kubernetes: pod kill, network chaos, I/O chaos, and stress tests. Chaos workflows, schedule-based experiments, steady-state hypothesis validation, and integrating chaos into CI/CD pipelines."
more_link: "yes"
url: "/kubernetes-chaos-engineering-chaos-mesh-fault-injection-patterns/"
---

Chaos engineering is the discipline of deliberately introducing failures into a system to validate its resilience. The key word is "deliberately" — controlled, hypothesis-driven experiments that expose weaknesses before production incidents do. Chaos Mesh is the CNCF project that brings comprehensive fault injection to Kubernetes: pod kills, network partitions, I/O delays, CPU stress, and more. This guide covers building a production chaos engineering practice with Chaos Mesh, from installing the platform to designing meaningful experiments that improve your system's resilience.

<!--more-->

# Kubernetes Chaos Engineering with Chaos Mesh: Fault Injection Patterns

## Why Chaos Engineering?

Every team believes their system is resilient until production proves otherwise. Chaos engineering inverts this: you prove resilience before production. The Netflix Chaos Monkey concept has evolved significantly — modern chaos engineering is not about random destruction but about:

1. **Steady-state hypothesis**: Define what "normal" looks like (SLOs, error rates, latency percentiles)
2. **Hypothesis**: "If we inject fault X, the system will maintain steady-state Y"
3. **Experiment**: Inject the fault in a controlled manner
4. **Observation**: Did the system maintain steady-state?
5. **Learning**: If not, why? If yes, can we expand the blast radius?

## Installing Chaos Mesh

```bash
# Install via Helm
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm repo update

# Install in dedicated namespace
kubectl create namespace chaos-mesh

helm install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace chaos-mesh \
  --set controllerManager.replicaCount=3 \
  --set chaosDaemon.runtime=containerd \
  --set chaosDaemon.socketPath=/run/containerd/containerd.sock \
  --set dashboard.create=true \
  --version 2.6.0

# Verify installation
kubectl get pods -n chaos-mesh

# Expected pods:
# chaos-controller-manager-xxxx  (3 replicas)
# chaos-daemon-xxxx              (DaemonSet, one per node)
# chaos-dashboard-xxxx           (Dashboard UI)

# Create RBAC for chaos experiments
kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: chaos-experiments
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: chaos-experiments
  namespace: default
rules:
  - apiGroups: ["chaos-mesh.org"]
    resources: ["*"]
    verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: chaos-experiments
  namespace: default
subjects:
  - kind: ServiceAccount
    name: chaos-experiments
    namespace: default
roleRef:
  kind: Role
  name: chaos-experiments
  apiGroup: rbac.authorization.k8s.io
EOF
```

## Pod Chaos Experiments

### Pod Kill

```yaml
# experiments/pod-kill-random.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: pod-kill-random
  namespace: default
spec:
  action: pod-kill
  mode: one         # Kill one pod at a time
  # mode options: one, all, fixed, fixed-percent, random-max-percent

  selector:
    namespaces:
      - production
    labelSelectors:
      "app.kubernetes.io/name": "order-service"

  # Grace period before kill (default: 0 = immediate SIGKILL)
  gracePeriod: 30

  duration: "5m"    # Run experiment for 5 minutes
```

```yaml
# experiments/pod-kill-fixed-percent.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: pod-kill-33-percent
  namespace: default
spec:
  action: pod-kill
  mode: fixed-percent
  value: "33"        # Kill 33% of matching pods

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "payment-service"

  duration: "2m"
```

```yaml
# experiments/pod-failure.yaml
# Pod failure is different from pod-kill: it makes pods fail without killing them
# Useful for testing pod restart behavior and readiness probes
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: pod-failure-test
  namespace: default
spec:
  action: pod-failure
  mode: one

  selector:
    namespaces:
      - staging
    labelSelectors:
      "app": "api-gateway"

  duration: "3m"
  # The pod will be marked as failed and restarted
  # Validates that traffic is redirected during failure
```

### Container Kill

```yaml
# experiments/container-kill.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: sidecar-kill
  namespace: default
spec:
  action: container-kill
  mode: one

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "order-service"

  # Kill a specific container, not the whole pod
  containerNames:
    - "envoy-proxy"   # Kill the sidecar

  duration: "5m"
```

## Network Chaos Experiments

Network chaos experiments are the most valuable for distributed systems. They simulate real-world network conditions: packet loss, latency, bandwidth limits, and partition.

### Network Delay

```yaml
# experiments/network-delay-api.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: api-latency-injection
  namespace: default
spec:
  action: delay
  mode: all

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "frontend"

  delay:
    latency: "100ms"    # Add 100ms to all network calls
    correlation: "25"   # 25% correlation between consecutive packets
    jitter: "20ms"      # ± 20ms jitter

  direction: both       # both, to, from
  duration: "10m"

  # Target specific traffic (instead of all traffic)
  target:
    selector:
      namespaces:
        - production
      labelSelectors:
        "app": "database"
    mode: all
```

```yaml
# experiments/network-delay-p99.yaml
# Simulate P99 latency spike on the payment service
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: payment-latency-spike
  namespace: default
spec:
  action: delay
  mode: fixed-percent
  value: "10"            # Affect 10% of pods

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "payment-processor"

  delay:
    latency: "500ms"
    jitter: "200ms"

  duration: "5m"
```

### Network Packet Loss

```yaml
# experiments/network-packet-loss.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: packet-loss-simulation
  namespace: default
spec:
  action: loss
  mode: one

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "notification-service"

  loss:
    loss: "5"           # 5% packet loss
    correlation: "30"   # 30% correlation (bursty loss)

  duration: "5m"
```

### Network Partition

```yaml
# experiments/network-partition.yaml
# Simulate a network split between two services
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: database-partition
  namespace: default
spec:
  action: partition
  mode: all

  # Source: all API servers
  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "api-server"

  direction: both

  # Target: database pods
  target:
    selector:
      namespaces:
        - production
      labelSelectors:
        "app": "postgresql"
    mode: all

  duration: "2m"
  # Hypothesis: API servers should return 503s and circuit breakers should trip
  # Recovery: After partition ends, reconnection should be automatic within 30s
```

### Bandwidth Throttle

```yaml
# experiments/bandwidth-throttle.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: storage-bandwidth-limit
  namespace: default
spec:
  action: bandwidth
  mode: all

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "data-processor"

  bandwidth:
    rate: "10mbps"     # Limit to 10 Mbps
    limit: 100         # Burst limit in packets
    buffer: 10000      # Token bucket size

  duration: "10m"
```

## I/O Chaos Experiments

I/O chaos injects faults at the filesystem level: delays, errors, and attribute corruption.

### I/O Delay

```yaml
# experiments/io-delay.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: storage-io-delay
  namespace: default
spec:
  action: latency
  mode: one

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "logging-service"

  volumePath: /var/log   # Inject on this mount path
  path: "*.log"          # Only affect .log files
  delay: "100ms"
  percent: 50            # Affect 50% of I/O operations

  duration: "5m"
```

### I/O Errors

```yaml
# experiments/io-errors.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: database-io-errors
  namespace: default
spec:
  action: fault
  mode: one

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "postgres"

  volumePath: /var/lib/postgresql/data
  path: "*"
  errno: 5               # EIO (I/O error)
  methods:
    - read
    - write
  percent: 10            # 10% of operations fail

  duration: "3m"
  # Hypothesis: PostgreSQL should log errors but not crash
  # The connection pool should reconnect after I/O errors
```

### I/O Attribute Override

```yaml
# experiments/io-attr-override.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: filesystem-full-simulation
  namespace: default
spec:
  action: attrOverride
  mode: one

  selector:
    namespaces:
      - staging
    labelSelectors:
      "app": "etcd"

  volumePath: /var/lib/etcd
  attr:
    size: 1               # Override file size to 1 byte
    blocks: 0             # Override block count to 0

  percent: 5
  duration: "2m"
```

## Stress Tests

### CPU Stress

```yaml
# experiments/cpu-stress.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: cpu-stress-test
  namespace: default
spec:
  mode: one

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "recommendation-engine"

  stressors:
    cpu:
      workers: 4           # 4 CPU worker goroutines
      load: 80             # 80% CPU load per worker
      # Options: workers, load

  containerNames:
    - "recommender"

  duration: "5m"
  # Hypothesis: CPU throttling should not cause timeouts > 500ms
```

### Memory Stress

```yaml
# experiments/memory-stress.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: memory-pressure
  namespace: default
spec:
  mode: one

  selector:
    namespaces:
      - production
    labelSelectors:
      "app": "cache-service"

  stressors:
    memory:
      workers: 2
      size: "256Mi"        # Allocate 256MB per worker
      time: "10s"          # Hold for 10 seconds before releasing

  duration: "5m"
  # Hypothesis: Cache eviction should maintain acceptable hit rate
  # OOMKiller should not trigger (we're within container limits)
```

## Chaos Workflows: Orchestrating Multiple Experiments

Chaos Workflows allow sequential and parallel execution of multiple chaos experiments:

```yaml
# workflows/resilience-validation.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: Workflow
metadata:
  name: full-resilience-validation
  namespace: default
spec:
  entry: entry

  templates:
    # Entry point
    - name: entry
      templateType: Serial
      deadline: "60m"
      children:
        - check-baseline
        - inject-pod-failure
        - verify-recovery
        - inject-network-chaos
        - verify-recovery-2
        - inject-cpu-stress
        - verify-final-state

    # Verify system is healthy before starting
    - name: check-baseline
      templateType: Task
      deadline: "5m"
      task:
        container:
          name: verify-baseline
          image: curlimages/curl:latest
          command:
            - sh
            - -c
            - |
              # Check that all services are healthy
              curl -f http://api-service/health || exit 1
              curl -f http://payment-service/health || exit 1
              echo "Baseline verified"

    # Inject pod failure
    - name: inject-pod-failure
      templateType: PodChaos
      deadline: "5m"
      podChaos:
        action: pod-kill
        mode: one
        selector:
          namespaces: [production]
          labelSelectors:
            app: order-service
        duration: "3m"

    # Verify recovery after pod failure
    - name: verify-recovery
      templateType: Task
      deadline: "3m"
      task:
        container:
          name: verify-recovery
          image: curlimages/curl:latest
          command:
            - sh
            - -c
            - |
              echo "Waiting for recovery..."
              for i in $(seq 1 30); do
                if curl -sf http://order-service/health; then
                  echo "Service recovered after ${i} attempts"
                  exit 0
                fi
                sleep 2
              done
              echo "Service did not recover within 60 seconds"
              exit 1

    # Parallel network chaos
    - name: inject-network-chaos
      templateType: Parallel
      deadline: "10m"
      children:
        - api-latency
        - db-packet-loss

    - name: api-latency
      templateType: NetworkChaos
      deadline: "8m"
      networkChaos:
        action: delay
        mode: all
        selector:
          namespaces: [production]
          labelSelectors:
            tier: frontend
        delay:
          latency: "200ms"
          jitter: "50ms"
        duration: "5m"

    - name: db-packet-loss
      templateType: NetworkChaos
      deadline: "8m"
      networkChaos:
        action: loss
        mode: one
        selector:
          namespaces: [production]
          labelSelectors:
            app: postgresql
        loss:
          loss: "10"
        duration: "5m"

    # Final state verification
    - name: verify-final-state
      templateType: Task
      deadline: "5m"
      task:
        container:
          name: final-verify
          image: python:3.11-slim
          command:
            - python3
            - -c
            - |
              import urllib.request
              import json
              import sys

              # Check error rate is below SLO
              metrics_url = "http://prometheus:9090/api/v1/query?query=sum(rate(http_requests_total{status=~'5..'}[5m]))/sum(rate(http_requests_total[5m]))"
              resp = urllib.request.urlopen(metrics_url)
              data = json.loads(resp.read())
              error_rate = float(data['data']['result'][0]['value'][1])

              if error_rate > 0.01:  # 1% error rate SLO
                  print(f"ERROR RATE TOO HIGH: {error_rate:.4f}")
                  sys.exit(1)

              print(f"Final error rate: {error_rate:.4f} - PASS")
```

## Schedule-Based Chaos

Running chaos experiments on a schedule ensures continuous resilience validation:

```yaml
# schedules/daily-pod-kill.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata:
  name: daily-pod-kill
  namespace: default
spec:
  schedule: "0 10 * * 1-5"   # Weekdays at 10 AM UTC (business hours, with team present)
  concurrencyPolicy: Forbid   # Don't start if previous run still active
  historyLimit: 10            # Keep last 10 runs

  type: PodChaos
  podChaos:
    action: pod-kill
    mode: one
    selector:
      namespaces:
        - production
      labelSelectors:
        "chaos.company.com/enabled": "true"   # Opt-in label
    duration: "10m"
```

```yaml
# schedules/weekly-network-partition.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata:
  name: weekly-network-partition
  namespace: default
spec:
  schedule: "0 14 * * 3"   # Wednesdays at 2 PM UTC
  concurrencyPolicy: Forbid
  historyLimit: 5

  type: NetworkChaos
  networkChaos:
    action: partition
    mode: fixed-percent
    value: "50"
    selector:
      namespaces:
        - production
      labelSelectors:
        "app": "microservices"
    duration: "5m"
```

## Steady-State Hypothesis with SLOs

The critical piece of chaos engineering that separates it from random testing is the steady-state hypothesis:

```python
#!/usr/bin/env python3
# steady-state.py - Verify steady-state before and after chaos experiments

import requests
import time
import sys
from dataclasses import dataclass
from typing import Callable

@dataclass
class SteadyStateProbe:
    name: str
    query: str         # PromQL query
    threshold: float   # Maximum acceptable value
    operator: str      # 'lt', 'gt', 'le', 'ge', 'eq'

    def check(self, prometheus_url: str) -> tuple[bool, float]:
        resp = requests.get(
            f"{prometheus_url}/api/v1/query",
            params={"query": self.query},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

        if not data["data"]["result"]:
            return False, 0.0

        value = float(data["data"]["result"][0]["value"][1])

        passed = {
            "lt": value < self.threshold,
            "gt": value > self.threshold,
            "le": value <= self.threshold,
            "ge": value >= self.threshold,
            "eq": abs(value - self.threshold) < 0.001,
        }[self.operator]

        return passed, value

# Define steady-state probes
PROBES = [
    SteadyStateProbe(
        name="API Error Rate",
        query='sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
        threshold=0.01,
        operator="lt",
    ),
    SteadyStateProbe(
        name="P99 Latency",
        query='histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))',
        threshold=0.5,
        operator="lt",
    ),
    SteadyStateProbe(
        name="Service Availability",
        query='count(up{job="application"} == 1) / count(up{job="application"})',
        threshold=0.9,
        operator="gt",
    ),
    SteadyStateProbe(
        name="Queue Depth",
        query='nats_consumer_pending_messages{consumer="order-processor"}',
        threshold=1000,
        operator="lt",
    ),
]

def check_steady_state(prometheus_url: str, phase: str) -> bool:
    print(f"\n=== Steady State Check: {phase} ===")
    all_passed = True

    for probe in PROBES:
        passed, value = probe.check(prometheus_url)
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {probe.name}: {value:.4f} (threshold: {probe.operator} {probe.threshold})")
        if not passed:
            all_passed = False

    return all_passed

def run_chaos_experiment(experiment_fn: Callable, prometheus_url: str) -> bool:
    # Phase 1: Verify steady state
    if not check_steady_state(prometheus_url, "PRE-EXPERIMENT"):
        print("ERROR: System not in steady state before experiment. Aborting.")
        return False

    # Phase 2: Run experiment
    print("\n=== Running Chaos Experiment ===")
    try:
        experiment_fn()
        print("Experiment completed. Waiting 60s for system to stabilize...")
        time.sleep(60)
    except Exception as e:
        print(f"Experiment failed: {e}")
        return False

    # Phase 3: Verify steady state maintained
    post_steady_state = check_steady_state(prometheus_url, "POST-EXPERIMENT")

    # Phase 4: Wait for full recovery
    print("\nWaiting 5 minutes for full recovery...")
    time.sleep(300)

    # Phase 5: Final steady state check
    final_steady_state = check_steady_state(prometheus_url, "RECOVERY")

    if post_steady_state and final_steady_state:
        print("\nRESULT: HYPOTHESIS CONFIRMED - System maintained steady state")
        return True
    else:
        print("\nRESULT: HYPOTHESIS REJECTED - System violated steady state")
        return False

if __name__ == "__main__":
    prometheus_url = "http://prometheus:9090"

    def run_pod_kill():
        """Apply and then delete a pod kill experiment"""
        import subprocess
        subprocess.run(["kubectl", "apply", "-f", "experiments/pod-kill-random.yaml"], check=True)
        time.sleep(300)  # Let experiment run for 5 minutes
        subprocess.run(["kubectl", "delete", "-f", "experiments/pod-kill-random.yaml"], check=True)

    success = run_chaos_experiment(run_pod_kill, prometheus_url)
    sys.exit(0 if success else 1)
```

## Integrating Chaos into CI/CD

```yaml
# .github/workflows/chaos-validation.yaml
name: Chaos Engineering Validation

on:
  schedule:
    - cron: "0 14 * * 3"   # Wednesday afternoons
  workflow_dispatch:
    inputs:
      experiment:
        description: "Experiment to run"
        required: true
        type: choice
        options:
          - pod-kill
          - network-delay
          - cpu-stress

jobs:
  chaos-experiment:
    runs-on: ubuntu-latest
    environment: staging  # Require approval for staging environment

    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        run: |
          echo "${{ secrets.KUBECONFIG }}" | base64 -d > kubeconfig
          echo "KUBECONFIG=./kubeconfig" >> $GITHUB_ENV

      - name: Verify pre-experiment steady state
        run: |
          python3 chaos/steady-state.py \
            --prometheus http://prometheus.monitoring.svc.cluster.local:9090 \
            --phase pre

      - name: Apply chaos experiment
        run: |
          kubectl apply -f chaos/experiments/${{ github.event.inputs.experiment }}.yaml

      - name: Wait for experiment duration
        run: sleep 300  # 5 minutes

      - name: Verify post-experiment steady state
        run: |
          python3 chaos/steady-state.py \
            --prometheus http://prometheus.monitoring.svc.cluster.local:9090 \
            --phase post

      - name: Cleanup experiment
        if: always()
        run: |
          kubectl delete -f chaos/experiments/${{ github.event.inputs.experiment }}.yaml --ignore-not-found

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: chaos-results-${{ github.run_id }}
          path: chaos/results/
```

## Summary

Building a chaos engineering practice with Chaos Mesh requires:

1. **Start with steady-state definition**: Know your SLOs before injecting faults. If you don't know what healthy looks like, you can't tell if chaos has a negative effect.
2. **Begin with pod kills**: Kubernetes should handle pod restarts gracefully. If pod kills cause outages, fix that first.
3. **Progress to network chaos**: Latency, packet loss, and partitions reveal the most critical distributed systems weaknesses.
4. **Use workflows for realistic scenarios**: Real failures involve multiple simultaneous faults. Workflows let you compose complex scenarios.
5. **Schedule regular experiments**: Continuous validation prevents regression in resilience.
6. **Integrate with CI/CD**: Automated chaos tests in your deployment pipeline catch resilience regressions before they reach production.
7. **Opt-in by default**: Use labels like `chaos.company.com/enabled: "true"` to allow teams to opt their services into chaos experiments gradually.
