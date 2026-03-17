---
title: "Kubernetes Network Chaos Engineering: Simulating Failures with tc and Toxiproxy"
date: 2031-02-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Chaos Engineering", "Network", "tc", "Toxiproxy", "Chaos Mesh", "Resilience"]
categories:
- Kubernetes
- Site Reliability Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes network chaos engineering covering Linux tc netem for latency and packet loss injection, Toxiproxy for proxy-level failures, Chaos Mesh network chaos types, circuit breaker validation, and building network chaos runbooks."
more_link: "yes"
url: "/kubernetes-network-chaos-engineering-tc-toxiproxy-chaos-mesh/"
---

Network faults are among the most insidious production failures. Latency spikes, packet loss, connection resets, and bandwidth throttling expose weaknesses in retry logic, circuit breakers, and timeout configurations that never appear under normal conditions. Systematic chaos engineering against these failure modes before they hit production is the difference between a pager alert at 3 AM and a routine recovery.

This guide covers the full network chaos toolkit: Linux `tc netem` for kernel-level fault injection, Toxiproxy for application-layer chaos, and Chaos Mesh for orchestrated Kubernetes-native experiments.

<!--more-->

# Kubernetes Network Chaos Engineering: Simulating Failures with tc and Toxiproxy

## Section 1: Why Network Chaos Engineering

Modern distributed systems make assumptions about network behavior that the real world violates regularly:

- DNS resolution always succeeds (it doesn't — Kubernetes CoreDNS can be overwhelmed)
- Connections time out predictably (they don't — firewalls drop connections silently)
- Retry-after-timeout works (it doesn't if all retries hit the same degraded endpoint)
- Circuit breakers open correctly (they don't if the failure threshold is too high or open duration too long)

Network chaos testing validates:

1. **Timeout configuration**: Is the read timeout shorter than the connect timeout? Are they both shorter than the upstream's SLA?
2. **Retry logic**: Do retries use exponential backoff? Do they retry idempotent requests only?
3. **Circuit breaker calibration**: Does the breaker open before cascading failures propagate?
4. **Graceful degradation**: Does the service return cached or degraded responses when dependencies are slow?
5. **Health check sensitivity**: Does your readiness probe fail fast enough during network degradation?

## Section 2: Linux tc netem — Kernel-Level Fault Injection

`tc` (traffic control) with the `netem` (Network Emulator) discipline provides kernel-level packet manipulation. It can add:

- Fixed and variable latency
- Packet loss (random, correlated, or based on patterns)
- Packet duplication
- Packet reordering
- Bandwidth throttling
- Corruption

### Prerequisites on Kubernetes Nodes

```bash
# Install iproute2 on the node (usually already present)
# For injection inside pods, the container needs NET_ADMIN capability
kubectl exec -it debug-pod -- tc qdisc show

# Add NET_ADMIN capability to a debug pod
kubectl run chaos-debug \
  --image=nicolaka/netshoot:latest \
  --overrides='{"spec":{"containers":[{"name":"chaos-debug","image":"nicolaka/netshoot:latest","securityContext":{"capabilities":{"add":["NET_ADMIN"]}},"command":["sleep","86400"]}]}}' \
  --restart=Never
```

### Basic tc netem Operations

```bash
# Show current qdisc configuration on eth0
tc qdisc show dev eth0

# Add 100ms latency to ALL outgoing packets on eth0
tc qdisc add dev eth0 root netem delay 100ms

# Verify
tc qdisc show dev eth0
# qdisc netem 8001: root refcnt 2 limit 1000 delay 100ms

# Test the latency
ping -c 5 8.8.8.8
# PING 8.8.8.8 56 bytes of data.
# 64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=101 ms  <- 100ms added

# Remove the delay
tc qdisc del dev eth0 root

# Add variable latency: 100ms ± 20ms (normal distribution)
tc qdisc add dev eth0 root netem delay 100ms 20ms

# Add jitter with correlation: 100ms avg, 20ms variation, 75% correlation
# (each packet's delay is 75% correlated to the previous packet's delay)
tc qdisc add dev eth0 root netem delay 100ms 20ms 75%

# 10% random packet loss
tc qdisc add dev eth0 root netem loss 10%

# Correlated packet loss: 10% average, 25% correlation
# (simulates bursty packet loss from link errors)
tc qdisc add dev eth0 root netem loss 10% 25%

# 1% packet duplication
tc qdisc add dev eth0 root netem duplicate 1%

# 5% packet reordering with 100ms delay
tc qdisc add dev eth0 root netem delay 100ms reorder 5% 50%

# 0.1% random bit corruption
tc qdisc add dev eth0 root netem corrupt 0.1%

# Combine: 100ms latency + 5% loss
tc qdisc add dev eth0 root netem delay 100ms loss 5%
```

### Targeted Traffic Shaping with Filters

The above applies to ALL traffic on the interface. To target specific destinations:

```bash
# Step 1: Create a prio qdisc at root to enable filtering
tc qdisc add dev eth0 root handle 1: prio

# Step 2: Add netem to band 3 of the prio qdisc
tc qdisc add dev eth0 parent 1:3 handle 30: netem delay 200ms loss 5%

# Step 3: Add a filter to route traffic to 10.100.0.50 into band 3
tc filter add dev eth0 protocol ip parent 1:0 \
  u32 match ip dst 10.100.0.50/32 flowid 1:3

# Now only packets to 10.100.0.50 experience delay and loss
# All other traffic is unaffected

# To target a port instead of IP:
tc filter add dev eth0 protocol ip parent 1:0 \
  u32 match ip dport 5432 0xffff flowid 1:3

# To target traffic TO a Kubernetes service ClusterIP:
SERVICE_IP=$(kubectl get svc postgres -o jsonpath='{.spec.clusterIP}')
tc filter add dev eth0 protocol ip parent 1:0 \
  u32 match ip dst "${SERVICE_IP}/32" flowid 1:3
```

### Bandwidth Throttling

```bash
# Limit bandwidth to 1 Mbps (simulate slow client)
tc qdisc add dev eth0 root tbf \
  rate 1mbit \
  burst 32kbit \
  latency 400ms

# Combined: throttle + latency
tc qdisc add dev eth0 root handle 1: netem delay 50ms
tc qdisc add dev eth0 parent 1:1 handle 2: tbf \
  rate 1mbit burst 32kbit latency 400ms
```

### Pod-Level Chaos Script

```bash
#!/bin/bash
# pod-network-chaos.sh — inject network faults into a specific pod

set -euo pipefail

NAMESPACE="${1:?Usage: $0 <namespace> <pod-name> <fault-type> [duration]}"
POD="${2:?}"
FAULT="${3:?'delay|loss|throttle|all'}"
DURATION="${4:-60}"  # Default: 60 seconds

POD_IP=$(kubectl get pod -n "$NAMESPACE" "$POD" \
  -o jsonpath='{.status.podIP}')
NODE=$(kubectl get pod -n "$NAMESPACE" "$POD" \
  -o jsonpath='{.spec.nodeName}')

echo "Targeting pod: ${POD} (IP: ${POD_IP}) on node: ${NODE}"
echo "Fault type: ${FAULT}, Duration: ${DURATION}s"

apply_fault() {
    case "$FAULT" in
        delay)
            kubectl node-shell "${NODE}" -- tc qdisc add dev eth0 root \
              netem delay 200ms 50ms
            ;;
        loss)
            kubectl node-shell "${NODE}" -- tc qdisc add dev eth0 root \
              netem loss 15%
            ;;
        throttle)
            kubectl node-shell "${NODE}" -- tc qdisc add dev eth0 root tbf \
              rate 512kbit burst 16kbit latency 300ms
            ;;
        all)
            kubectl node-shell "${NODE}" -- tc qdisc add dev eth0 root \
              netem delay 150ms 30ms loss 5%
            ;;
    esac
    echo "Fault injected at $(date)"
}

remove_fault() {
    kubectl node-shell "${NODE}" -- tc qdisc del dev eth0 root 2>/dev/null || true
    echo "Fault removed at $(date)"
}

# Inject fault
apply_fault

# Wait for duration
echo "Fault active for ${DURATION} seconds..."
sleep "$DURATION"

# Remove fault
remove_fault

echo "Chaos experiment complete"
```

## Section 3: Toxiproxy — Application-Layer Chaos

Toxiproxy is a TCP proxy that sits between your application and its dependencies. Unlike `tc`, it operates at the application layer and can simulate:

- **Latency**: Add delay to connections
- **Bandwidth**: Limit throughput
- **Slow close**: Simulate half-open connections
- **Reset peer**: Force connection resets
- **Timeout**: Silently drop traffic (connection appears open but no data flows)
- **Limit data**: Limit total bytes before dropping
- **Slicer**: Split packets into smaller chunks (exposes buffering bugs)

### Installing Toxiproxy in Kubernetes

```yaml
# toxiproxy-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: toxiproxy
  namespace: chaos-testing
spec:
  replicas: 1
  selector:
    matchLabels:
      app: toxiproxy
  template:
    metadata:
      labels:
        app: toxiproxy
    spec:
      containers:
        - name: toxiproxy
          image: ghcr.io/shopify/toxiproxy:2.9.0
          ports:
            # Management API
            - containerPort: 8474
              name: api
            # Proxied services (one port per service)
            - containerPort: 5432
              name: postgres
            - containerPort: 6379
              name: redis
            - containerPort: 9042
              name: cassandra
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
---
apiVersion: v1
kind: Service
metadata:
  name: toxiproxy
  namespace: chaos-testing
spec:
  selector:
    app: toxiproxy
  ports:
    - name: api
      port: 8474
      targetPort: 8474
    - name: postgres
      port: 5432
      targetPort: 5432
    - name: redis
      port: 6379
      targetPort: 6379
```

### Configuring Proxies

```bash
# Port-forward to the Toxiproxy management API
kubectl port-forward -n chaos-testing svc/toxiproxy 8474:8474 &

# Create a proxy for PostgreSQL
curl -X POST http://localhost:8474/proxies \
  -H "Content-Type: application/json" \
  -d '{
    "name": "postgres",
    "listen": "0.0.0.0:5432",
    "upstream": "postgres.database.svc.cluster.local:5432",
    "enabled": true
  }'

# Create a proxy for Redis
curl -X POST http://localhost:8474/proxies \
  -H "Content-Type: application/json" \
  -d '{
    "name": "redis",
    "listen": "0.0.0.0:6379",
    "upstream": "redis.cache.svc.cluster.local:6379",
    "enabled": true
  }'

# List all proxies
curl http://localhost:8474/proxies | jq .
```

### Adding Toxics (Fault Injectors)

```bash
# Add 500ms latency to postgres traffic (upstream direction = database responses)
curl -X POST http://localhost:8474/proxies/postgres/toxics \
  -H "Content-Type: application/json" \
  -d '{
    "name": "query-latency",
    "type": "latency",
    "stream": "upstream",
    "toxicity": 1.0,
    "attributes": {
      "latency": 500,
      "jitter": 100
    }
  }'

# Add bandwidth throttle to redis
curl -X POST http://localhost:8474/proxies/redis/toxics \
  -H "Content-Type: application/json" \
  -d '{
    "name": "bandwidth-limit",
    "type": "bandwidth",
    "stream": "downstream",
    "toxicity": 1.0,
    "attributes": {
      "rate": 1000
    }
  }'

# Simulate a connection reset
curl -X POST http://localhost:8474/proxies/postgres/toxics \
  -H "Content-Type: application/json" \
  -d '{
    "name": "reset-peer",
    "type": "reset_peer",
    "stream": "upstream",
    "toxicity": 0.1,
    "attributes": {
      "timeout": 0
    }
  }'

# Timeout toxic — 50% of connections will hang until they time out
curl -X POST http://localhost:8474/proxies/postgres/toxics \
  -H "Content-Type: application/json" \
  -d '{
    "name": "connection-timeout",
    "type": "timeout",
    "stream": "upstream",
    "toxicity": 0.5,
    "attributes": {
      "timeout": 0
    }
  }'

# Disable a proxy (simulates service outage)
curl -X POST http://localhost:8474/proxies/redis \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Re-enable
curl -X POST http://localhost:8474/proxies/redis \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# Remove a specific toxic
curl -X DELETE http://localhost:8474/proxies/postgres/toxics/query-latency

# List all toxics on a proxy
curl http://localhost:8474/proxies/postgres/toxics | jq .
```

### Toxiproxy Go Client

```go
package chaos

import (
    "testing"
    "time"

    toxiproxy "github.com/Shopify/toxiproxy/v2/client"
)

// ChaosHarness wraps Toxiproxy for test setup/teardown
type ChaosHarness struct {
    client  *toxiproxy.Client
    proxies map[string]*toxiproxy.Proxy
}

func NewChaosHarness(apiURL string) *ChaosHarness {
    return &ChaosHarness{
        client:  toxiproxy.NewClient(apiURL),
        proxies: make(map[string]*toxiproxy.Proxy),
    }
}

func (h *ChaosHarness) AddProxy(name, listen, upstream string) (*toxiproxy.Proxy, error) {
    proxy, err := h.client.CreateProxy(name, listen, upstream)
    if err != nil {
        return nil, err
    }
    h.proxies[name] = proxy
    return proxy, nil
}

func (h *ChaosHarness) Cleanup() {
    for name, proxy := range h.proxies {
        proxy.Delete()
        delete(h.proxies, name)
    }
}

// Integration test using Toxiproxy
func TestServiceDegradedDatabase(t *testing.T) {
    harness := NewChaosHarness("http://localhost:8474")
    defer harness.Cleanup()

    // Create proxy for database
    dbProxy, err := harness.AddProxy("postgres-test",
        "localhost:15432",
        "localhost:5432")
    if err != nil {
        t.Fatalf("Failed to create proxy: %v", err)
    }

    // Test 1: Service responds correctly with no chaos
    svc := NewMyService("localhost:15432")
    result, err := svc.GetUser(ctx, "user-1")
    if err != nil || result == nil {
        t.Fatalf("Baseline test failed: %v", err)
    }

    // Test 2: Add 200ms latency — service should still succeed but be slow
    latencyToxic, err := dbProxy.AddToxic("latency", "latency", "upstream",
        1.0,
        toxiproxy.Attributes{"latency": 200, "jitter": 50})
    if err != nil {
        t.Fatalf("Failed to add latency toxic: %v", err)
    }

    start := time.Now()
    result, err = svc.GetUser(ctx, "user-1")
    elapsed := time.Since(start)

    if err != nil {
        t.Errorf("Service failed with 200ms latency: %v", err)
    }
    if elapsed < 200*time.Millisecond {
        t.Errorf("Latency toxic not working: elapsed=%v", elapsed)
    }
    t.Logf("Request with 200ms latency: %v", elapsed)

    dbProxy.RemoveToxic(latencyToxic.Name)

    // Test 3: Disable database — service should use cache
    dbProxy.Disable()
    result, err = svc.GetUser(ctx, "user-1")
    if err != nil {
        t.Errorf("Service should return cached result when DB is down: %v", err)
    }
    dbProxy.Enable()

    // Test 4: 10% packet loss — circuit breaker should open
    _, err = dbProxy.AddToxic("loss", "timeout", "upstream",
        0.1,
        toxiproxy.Attributes{"timeout": 0})
    if err != nil {
        t.Fatalf("Failed to add timeout toxic: %v", err)
    }

    // Make many requests — circuit breaker should open after threshold
    var failCount int
    for i := 0; i < 100; i++ {
        _, err = svc.GetUser(ctx, "user-1")
        if err != nil {
            failCount++
        }
    }
    t.Logf("10%% timeout: %d/100 failures, circuit breaker: %v",
        failCount, svc.CircuitBreakerState())
}
```

## Section 4: Chaos Mesh — Kubernetes-Native Network Chaos

Chaos Mesh provides declarative network chaos via Kubernetes custom resources. It uses eBPF and tc under the hood but adds a Kubernetes-native interface with scheduling, scoping, and pause/resume capabilities.

### Installing Chaos Mesh

```bash
# Add Helm repo
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm repo update

# Install Chaos Mesh
helm install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace chaos-testing \
  --create-namespace \
  --set controllerManager.replicaCount=1 \
  --set dashboard.enabled=true \
  --set chaosDaemon.runtime=containerd \
  --set chaosDaemon.socketPath=/run/containerd/containerd.sock

# Verify installation
kubectl get pods -n chaos-testing
# chaos-controller-manager-xxx   3/3     Running
# chaos-daemon-xxxxx              1/1     Running (on each node)
# chaos-dashboard-xxxxx           1/1     Running
```

### NetworkChaos Resource Types

```yaml
# 1. Network Latency — add 200ms latency to all traffic from app pods
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: web-latency
  namespace: production
spec:
  action: delay
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: web-api

  delay:
    latency: "200ms"
    correlation: "25"
    jitter: "50ms"

  # Only affect traffic TO these services
  target:
    selector:
      namespaces:
        - production
      labelSelectors:
        tier: database
    mode: all

  direction: to

  # Run for 10 minutes
  duration: "10m"
---
# 2. Packet Loss — 15% loss between web tier and cache
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: cache-packet-loss
  namespace: production
spec:
  action: loss
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: web-api

  loss:
    loss: "15"
    correlation: "25"

  target:
    selector:
      namespaces:
        - production
      labelSelectors:
        app: redis
    mode: all

  direction: to
  duration: "5m"
---
# 3. Network Partition — complete isolation between app and database
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: database-partition
  namespace: production
spec:
  action: partition
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: web-api

  target:
    selector:
      namespaces:
        - production
      labelSelectors:
        app: postgres
    mode: all

  direction: both
  duration: "2m"
---
# 4. Bandwidth Throttle — limit to 1 Mbps
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: bandwidth-throttle
  namespace: production
spec:
  action: bandwidth
  mode: all
  selector:
    namespaces:
      - production
    labelSelectors:
      app: file-processor

  bandwidth:
    rate: "1mbps"
    limit: 200000
    buffer: 10000

  direction: from
  duration: "15m"
---
# 5. Corrupt packets — 0.5% bit corruption
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: packet-corruption
  namespace: staging
spec:
  action: corrupt
  mode: all
  selector:
    namespaces:
      - staging
    labelSelectors:
      app: data-pipeline

  corrupt:
    corrupt: "0.5"
    correlation: "25"

  direction: to
  target:
    selector:
      namespaces:
        - staging
      labelSelectors:
        app: kafka
    mode: all

  duration: "5m"
```

### Scheduled Chaos Experiments

```yaml
# Run chaos experiment every night at 2 AM for 10 minutes
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata:
  name: nightly-latency-test
  namespace: staging
spec:
  schedule: "0 2 * * *"
  historyLimit: 7
  type: NetworkChaos
  networkChaos:
    action: delay
    mode: all
    selector:
      namespaces:
        - staging
      labelSelectors:
        app: web-api
    delay:
      latency: "100ms"
      jitter: "25ms"
    direction: both
    duration: "10m"
```

### Workflow — Multi-Step Chaos Experiment

```yaml
# Simulate a complex failure scenario: gradual latency increase then partition
apiVersion: chaos-mesh.org/v1alpha1
kind: Workflow
metadata:
  name: database-degradation-scenario
  namespace: staging
spec:
  entry: entry
  templates:
    # Entry point
    - name: entry
      templateType: Serial
      children:
        - baseline-check
        - add-latency-100ms
        - wait-2m
        - add-latency-500ms
        - wait-2m
        - full-partition
        - wait-2m
        - recover

    # Step: verify baseline
    - name: baseline-check
      templateType: Task
      task:
        container:
          name: check
          image: curlimages/curl:latest
          command:
            - /bin/sh
            - -c
            - |
              echo "Baseline check..."
              for i in $(seq 1 5); do
                STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
                  http://web-api.staging/health)
                echo "Health check $i: $STATUS"
              done

    # Step: 100ms latency
    - name: add-latency-100ms
      templateType: NetworkChaos
      networkChaos:
        action: delay
        mode: all
        selector:
          namespaces: [staging]
          labelSelectors:
            app: web-api
        delay:
          latency: "100ms"
        direction: to
        target:
          selector:
            namespaces: [staging]
            labelSelectors:
              app: postgres
          mode: all
        duration: "2m"

    - name: wait-2m
      templateType: Suspend
      deadline: "2m"

    # Step: 500ms latency
    - name: add-latency-500ms
      templateType: NetworkChaos
      networkChaos:
        action: delay
        mode: all
        selector:
          namespaces: [staging]
          labelSelectors:
            app: web-api
        delay:
          latency: "500ms"
        direction: to
        target:
          selector:
            namespaces: [staging]
            labelSelectors:
              app: postgres
          mode: all
        duration: "2m"

    # Step: complete partition
    - name: full-partition
      templateType: NetworkChaos
      networkChaos:
        action: partition
        mode: all
        selector:
          namespaces: [staging]
          labelSelectors:
            app: web-api
        direction: both
        target:
          selector:
            namespaces: [staging]
            labelSelectors:
              app: postgres
          mode: all
        duration: "2m"

    - name: recover
      templateType: Task
      task:
        container:
          name: recover-check
          image: curlimages/curl:latest
          command:
            - /bin/sh
            - -c
            - |
              echo "Recovery check — waiting for service to recover..."
              for i in $(seq 1 30); do
                STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
                  http://web-api.staging/health 2>/dev/null)
                echo "[$i] Health: $STATUS"
                [ "$STATUS" = "200" ] && echo "Service recovered!" && exit 0
                sleep 10
              done
              echo "FAIL: Service did not recover in 5 minutes"
              exit 1
```

## Section 5: Testing Circuit Breaker Behavior

```bash
#!/bin/bash
# test-circuit-breaker.sh — validate circuit breaker opens and recovers

set -euo pipefail

SERVICE_URL="${1:-http://web-api.staging}"
TOXIPROXY_URL="${2:-http://localhost:8474}"
PROXY_NAME="${3:-backend}"

echo "=== Circuit Breaker Test ==="
echo "Service: $SERVICE_URL"

# Helper function
check_health() {
    local label="$1"
    local response
    response=$(curl -s -o /dev/null -w "%{http_code}|%{time_total}" \
        "${SERVICE_URL}/health" 2>/dev/null || echo "000|999")
    local code="${response%|*}"
    local time="${response#*|}"
    printf "%-30s HTTP: %s, Time: %.3fs\n" "$label" "$code" "$time"
    echo "$code"
}

# 1. Verify baseline
echo ""
echo "Phase 1: Baseline verification (no chaos)"
for i in 1 2 3; do check_health "Baseline check $i"; done

# 2. Inject latency that should trigger timeout
echo ""
echo "Phase 2: Injecting 3s latency (timeout threshold = 2s)"
curl -s -X POST "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics" \
  -H "Content-Type: application/json" \
  -d '{"name":"latency","type":"latency","stream":"upstream","toxicity":1.0,"attributes":{"latency":3000}}'

# Make requests — should fail with timeout
FAILURES=0
for i in $(seq 1 10); do
    code=$(check_health "Degraded request $i")
    [ "$code" != "200" ] && ((FAILURES++))
done
echo "Failures during latency: ${FAILURES}/10"

# 3. Check if circuit breaker opened
echo ""
echo "Phase 3: Verifying circuit breaker state"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${SERVICE_URL}/metrics" 2>/dev/null)
if [ "$CODE" = "200" ]; then
    CB_STATE=$(curl -s "${SERVICE_URL}/metrics" | grep -E "circuit_breaker_state")
    echo "Circuit breaker metrics: $CB_STATE"
fi

# 4. Remove latency — circuit breaker should close after recovery
echo ""
echo "Phase 4: Removing latency — waiting for circuit breaker recovery"
curl -s -X DELETE "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics/latency"

# Wait for circuit breaker to close (half-open -> closed)
RECOVERED=false
for i in $(seq 1 30); do
    code=$(check_health "Recovery check $i")
    if [ "$code" = "200" ]; then
        RECOVERED=true
        echo "Circuit breaker CLOSED after $((i * 5)) seconds"
        break
    fi
    sleep 5
done

if ! $RECOVERED; then
    echo "FAIL: Circuit breaker did not recover within 150 seconds"
    exit 1
fi

echo ""
echo "=== Test PASSED ==="
```

## Section 6: Validating Retry Logic

```python
#!/usr/bin/env python3
"""validate-retry-logic.py — test that retry logic works correctly under network faults"""

import requests
import time
import threading
import statistics
from dataclasses import dataclass, field
from typing import List

@dataclass
class RequestResult:
    attempt: int
    status_code: int
    elapsed_ms: float
    error: str = ""

@dataclass
class ExperimentResult:
    total_requests: int = 0
    successful: int = 0
    failed: int = 0
    retried: int = 0
    latencies: List[float] = field(default_factory=list)

def run_experiment(service_url: str, num_requests: int = 100) -> ExperimentResult:
    result = ExperimentResult()

    for _ in range(num_requests):
        result.total_requests += 1
        attempt = 0
        max_retries = 3
        last_error = None

        while attempt <= max_retries:
            try:
                start = time.time()
                resp = requests.get(
                    f"{service_url}/api/data",
                    timeout=1.0  # 1s timeout
                )
                elapsed = (time.time() - start) * 1000

                if attempt > 0:
                    result.retried += 1

                if resp.status_code == 200:
                    result.successful += 1
                    result.latencies.append(elapsed)
                    break
                else:
                    last_error = f"HTTP {resp.status_code}"
                    attempt += 1
                    time.sleep(0.1 * (2 ** attempt))  # Exponential backoff

            except requests.Timeout:
                last_error = "timeout"
                attempt += 1
                if attempt <= max_retries:
                    time.sleep(0.1 * (2 ** attempt))
            except requests.ConnectionError:
                last_error = "connection_error"
                attempt += 1
                if attempt <= max_retries:
                    time.sleep(0.1 * (2 ** attempt))
        else:
            result.failed += 1

    return result

def print_report(experiment_name: str, result: ExperimentResult):
    print(f"\n=== {experiment_name} ===")
    print(f"Total requests: {result.total_requests}")
    print(f"Successful: {result.successful} ({100*result.successful/result.total_requests:.1f}%)")
    print(f"Failed: {result.failed} ({100*result.failed/result.total_requests:.1f}%)")
    print(f"Retried: {result.retried}")
    if result.latencies:
        print(f"Latency p50: {statistics.median(result.latencies):.1f}ms")
        print(f"Latency p95: {statistics.quantiles(result.latencies, n=20)[18]:.1f}ms")
        print(f"Latency p99: {statistics.quantiles(result.latencies, n=100)[98]:.1f}ms")

if __name__ == "__main__":
    SERVICE = "http://web-api.staging"
    TOXIPROXY = "http://localhost:8474"

    import subprocess

    # Baseline
    result = run_experiment(SERVICE, 100)
    print_report("Baseline (no chaos)", result)

    # Add 200ms latency
    subprocess.run(["curl", "-s", "-X", "POST",
        f"{TOXIPROXY}/proxies/backend/toxics",
        "-H", "Content-Type: application/json",
        "-d", '{"name":"lat","type":"latency","stream":"upstream","toxicity":1.0,"attributes":{"latency":200}}'])

    result = run_experiment(SERVICE, 100)
    print_report("With 200ms latency", result)
    subprocess.run(["curl", "-s", "-X", "DELETE",
        f"{TOXIPROXY}/proxies/backend/toxics/lat"])

    # Add 20% connection reset
    subprocess.run(["curl", "-s", "-X", "POST",
        f"{TOXIPROXY}/proxies/backend/toxics",
        "-H", "Content-Type: application/json",
        "-d", '{"name":"reset","type":"reset_peer","stream":"upstream","toxicity":0.2,"attributes":{"timeout":0}}'])

    result = run_experiment(SERVICE, 100)
    print_report("With 20% connection reset (should retry)", result)
    subprocess.run(["curl", "-s", "-X", "DELETE",
        f"{TOXIPROXY}/proxies/backend/toxics/reset"])
```

## Section 7: Network Chaos Runbook Template

```markdown
# Network Chaos Experiment Runbook: [Experiment Name]

## Experiment Overview
- **Date**: [DATE]
- **Target Service**: [SERVICE_NAME]
- **Failure Scenario**: [LATENCY/LOSS/PARTITION/etc]
- **Duration**: [MINUTES]
- **Owner**: [TEAM/PERSON]
- **Blast Radius**: [AFFECTED_SERVICES]

## Hypothesis
> When [FAILURE_CONDITION], the service will [EXPECTED_BEHAVIOR].
> Specifically, [METRIC_A] will remain below [THRESHOLD_A] and
> [METRIC_B] will remain above [THRESHOLD_B].

## Prerequisites
- [ ] Staging environment verified healthy (all green)
- [ ] Monitoring dashboards open (Grafana: [LINK])
- [ ] On-call engineer notified
- [ ] Rollback procedure verified working
- [ ] PagerDuty integration disabled for staging alerts

## Steady State Definition
| Metric | Threshold |
|---|---|
| HTTP 5xx rate | < 0.1% |
| P99 latency | < 500ms |
| Circuit breaker state | Closed |
| Error budget remaining | > 99% |

## Experiment Steps

### Phase 1: Verify Steady State (5 minutes)
```bash
# Check service health
kubectl get pods -n staging -l app=[SERVICE_NAME]
curl -s http://[SERVICE_URL]/health | jq .
# Expected: {"status": "healthy", "dependencies": {"database": "ok", "cache": "ok"}}
```

### Phase 2: Inject Fault
```bash
# [PASTE SPECIFIC CHAOS COMMAND HERE]
```

### Phase 3: Observe (during experiment duration)
- Monitor error rate in Grafana
- Watch circuit breaker state
- Check application logs: `kubectl logs -n staging -l app=[SERVICE_NAME] -f`

### Phase 4: Remove Fault
```bash
# [PASTE SPECIFIC REMOVAL COMMAND HERE]
```

### Phase 5: Verify Recovery
- [ ] Error rate returns to baseline within [X] minutes
- [ ] Circuit breaker closes within [X] minutes
- [ ] No permanent data loss
- [ ] Alerts fire (if expected)

## Rollback Procedure
If something goes wrong (unexpected blast radius, production impact):
```bash
# Emergency: remove all Chaos Mesh experiments
kubectl delete networkchaos --all -n staging

# OR remove tc rules from nodes
kubectl node-shell [NODE_NAME] -- tc qdisc del dev eth0 root
```

## Results
| Metric | Expected | Actual | Pass/Fail |
|---|---|---|---|
| Service availability | > 99% | | |
| Circuit breaker opened | Yes (after N failures) | | |
| Recovery time | < 5 minutes | | |

## Observations
[Document what happened — did the hypothesis hold? What surprised you?]

## Follow-Up Actions
- [ ] [ACTION_1]
- [ ] [ACTION_2]
```

## Summary

Network chaos engineering requires a layered toolkit:

- **tc netem** for kernel-level packet manipulation — best for node-level experiments and traffic shaping.
- **Toxiproxy** for application-layer chaos — best for unit and integration tests, fine-grained per-connection control.
- **Chaos Mesh** for Kubernetes-native experiments — best for coordinated, scheduled, auditable production-safe experiments.

The validation priorities for any distributed service:
1. All timeouts are explicitly configured (no relying on defaults).
2. Retries use exponential backoff and target only idempotent operations.
3. Circuit breakers are calibrated for the expected failure rate of dependencies.
4. Services degrade gracefully (return stale or partial data, not errors) when dependencies are slow.
5. Recovery is automatic — services should detect and reconnect without operator intervention.

Run chaos experiments on a schedule in staging, and gate production deployments on passing circuit breaker and retry validation tests. The goal is to turn network failures from incidents into routine recoveries.
