---
title: "Chaos Engineering in Production: Principles, Tools, and GameDay Planning"
date: 2027-11-29T00:00:00-05:00
draft: false
tags: ["Chaos Engineering", "Resilience", "Kubernetes", "Litmus", "Reliability"]
categories:
- SRE
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to chaos engineering in production Kubernetes environments, covering LitmusChaos experiments, GameDay planning, SLO impact measurement, circuit breaker validation, and integrating chaos into CI/CD pipelines."
more_link: "yes"
url: "/chaos-engineering-principles-implementation-guide/"
---

Most systems fail under conditions they were never tested under. Chaos engineering addresses this gap by deliberately introducing controlled failures to discover weaknesses before they manifest as unplanned outages. This guide covers the principles, tools, and organizational practices that make chaos engineering effective rather than reckless.

<!--more-->

# Chaos Engineering in Production: Principles, Tools, and GameDay Planning

## Core Principles of Chaos Engineering

Chaos engineering is not random destruction. It is a disciplined scientific approach to discovering systemic weaknesses through controlled experiments.

The five principles that distinguish responsible chaos engineering:

### 1. Define Steady State

Before breaking anything, you must know what normal looks like. Steady state is defined through observable metrics:

- Request success rate (HTTP 200 responses / total requests)
- Latency percentiles (p50, p95, p99)
- Queue depth and processing rate
- Error rates per service
- Resource utilization (CPU, memory, I/O)

If you cannot define steady state quantitatively, chaos experiments will produce data you cannot interpret.

### 2. Hypothesize That Steady State Holds in the Experimental Group

A chaos experiment is a hypothesis test: "If I kill one pod in the payments service, the request success rate will remain above 99.5% and p99 latency will remain below 500ms."

Write this hypothesis before running the experiment. This prevents post-hoc rationalization of results.

### 3. Introduce Variables That Reflect Real-World Events

Realistic variables include:
- Pod crashes (OOMKill, segfault, unhandled exception)
- Network latency between services (50ms, 200ms, 1000ms)
- Network packet loss (1%, 5%, 20%)
- Node failures (hardware failure, kernel panic)
- Disk full conditions
- DNS resolution failures
- External API timeouts and errors
- Clock skew

Unrealistic variables (CPU burn on 100% of cores simultaneously) produce misleading results.

### 4. Run Experiments in Production

Testing resilience only in staging environments provides false confidence because staging differs from production in traffic patterns, data volumes, third-party integrations, and infrastructure configuration. Start in staging but progressively move experiments to production.

### 5. Automate Experiments Continuously

A chaos experiment run once is archaeology. An experiment run continuously is a regression test. Integrate chaos into CI/CD pipelines to catch resilience regressions before they reach production.

## Section 1: Blast Radius Management

Before running any experiment, define the blast radius: the maximum scope of impact the experiment can have.

### Blast Radius Categories

```
Level 1 - Single Pod:
  Impact: One instance of one service unavailable
  Recovery time: Seconds (pod restart)
  When to use: Initial experiments, verifying basic restart behavior

Level 2 - Service Instance Group:
  Impact: N% of a service's pods unavailable
  Recovery time: Seconds to minutes
  When to use: Testing load balancer behavior, connection retry logic

Level 3 - Namespace/Service:
  Impact: Complete service unavailable in one namespace
  Recovery time: Minutes
  When to use: Testing circuit breakers, fallback paths

Level 4 - Node:
  Impact: All pods on a node potentially affected
  Recovery time: Minutes (pod rescheduling)
  When to use: Testing topology spread constraints, node failure recovery

Level 5 - Zone:
  Impact: All services in an availability zone
  Recovery time: Minutes to hours
  When to use: Verifying multi-AZ architecture, cross-zone load balancing

Level 6 - Region:
  Impact: All services in a cloud region
  Recovery time: Hours
  When to use: DR testing, multi-region failover validation
```

### Progressive Blast Radius

Always start with the smallest blast radius and increase gradually:

```bash
# Week 1: Single pod, non-critical service
# Week 2: Single pod, critical service (during low traffic)
# Week 3: 25% of pods, non-critical service
# Week 4: 25% of pods, critical service
# Month 2: Node failure simulation
# Month 3: Zone failure simulation
```

## Section 2: LitmusChaos Installation and Configuration

LitmusChaos is the leading open-source chaos engineering platform for Kubernetes. It provides pre-built experiments (ChaosExperiments) that can be composed into complex scenarios (ChaosEngines).

### Installation

```bash
# Install LitmusChaos using Helm
helm repo add litmuschaos https://litmuschaos.github.io/litmus-helm/
helm repo update

# Create namespace
kubectl create namespace litmus

# Install LitmusChaos
helm install litmuschaos litmuschaos/litmus \
  --namespace litmus \
  --set portal.frontend.service.type=ClusterIP \
  --set portal.server.graphqlServer.replicaCount=2 \
  --set portal.server.authServer.replicaCount=2 \
  --set mongodb.auth.enabled=true \
  --set mongodb.auth.rootPassword="$(openssl rand -base64 24)" \
  --wait

# Verify installation
kubectl get pods -n litmus

# Install ChaosHub experiments (CNCF hub)
kubectl apply -f https://hub.litmuschaos.io/api/chaos/master?file=charts/generic/experiments.yaml -n litmus
```

### RBAC for Chaos Experiments

```yaml
# Service account with permissions to create chaos experiments
apiVersion: v1
kind: ServiceAccount
metadata:
  name: litmus-chaos-runner
  namespace: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: litmus-chaos-runner
rules:
# Required for pod chaos experiments
- apiGroups: [""]
  resources: ["pods", "events", "configmaps"]
  verbs: ["get", "list", "watch", "create", "delete", "patch"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets", "replicasets", "daemonsets"]
  verbs: ["get", "list", "watch", "patch"]
- apiGroups: ["litmuschaos.io"]
  resources: ["chaosengines", "chaosexperiments", "chaosresults"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
# Required for node chaos experiments
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list", "watch", "patch"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "watch", "create", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: litmus-chaos-runner
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: litmus-chaos-runner
subjects:
- kind: ServiceAccount
  name: litmus-chaos-runner
  namespace: production
```

## Section 3: Pod Failure Experiments

### Pod Delete Experiment

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payments-pod-delete
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payments-api"
    appkind: deployment

  # Stop chaos when annotation is applied to the engine
  annotationCheck: "true"

  # Service account for the chaos runner pod
  chaosServiceAccount: litmus-chaos-runner

  # Wait for application to be healthy before starting
  jobCleanUpPolicy: retain

  experiments:
  - name: pod-delete
    spec:
      components:
        env:
        # Kill one pod at a time
        - name: TOTAL_CHAOS_DURATION
          value: "60"  # Duration of experiment in seconds
        - name: CHAOS_INTERVAL
          value: "10"  # Interval between pod kills in seconds
        - name: RANDOMNESS
          value: "true"  # Randomly select victim pods
        - name: PODS_AFFECTED_PERC
          value: "33"  # Kill 33% of matching pods
        - name: FORCE
          value: "false"  # Graceful termination (false) vs SIGKILL (true)
        - name: NODE_LABEL
          value: ""  # Empty = any node
        # Probes verify the steady state
      probe:
      - name: check-success-rate
        type: httpProbe
        httpProbe/inputs:
          url: "http://payments-api.production.svc.cluster.local/health"
          insecureSkipVerify: false
          method:
            get:
              criteria: "=="
              responseCode: "200"
        runProperties:
          probeTimeout: 10
          interval: 5
          attempt: 3
          probePollingInterval: 2
        mode: Continuous
        # Run throughout the experiment
```

### Pod CPU Stress Experiment

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payments-cpu-stress
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payments-api"
    appkind: deployment
  chaosServiceAccount: litmus-chaos-runner
  experiments:
  - name: pod-cpu-hog
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: "120"
        - name: CPU_CORES
          value: "2"       # Number of CPU cores to consume
        - name: CPU_LOAD
          value: "80"      # CPU load percentage per core
        - name: PODS_AFFECTED_PERC
          value: "50"      # Affect 50% of matching pods
        - name: CHAOS_INJECT_COMMAND
          value: "md5sum /dev/zero"  # CPU stress command
        - name: CHAOS_KILL_COMMAND
          value: "kill $(find /proc -name exe -lname '*/md5sum' 2>/dev/null | awk -F/ '{print $3}')"
      probe:
      # Verify HPA kicks in during CPU stress
      - name: check-hpa-scaling
        type: k8sProbe
        k8sProbe/inputs:
          group: autoscaling
          version: v2
          resource: horizontalpodautoscalers
          namespace: production
          fieldSelector: "metadata.name=payments-api"
          operation: present
        runProperties:
          probeTimeout: 30
          interval: 15
          attempt: 4
        mode: EOT  # Check at end of test
      # Verify success rate is maintained during stress
      - name: check-success-rate-under-load
        type: httpProbe
        httpProbe/inputs:
          url: "http://payments-api.production.svc.cluster.local/health"
          method:
            get:
              criteria: "=="
              responseCode: "200"
        runProperties:
          probeTimeout: 10
          interval: 5
          attempt: 6
        mode: Continuous
```

## Section 4: Network Chaos Experiments

### Network Latency Injection

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payments-network-latency
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payments-api"
    appkind: deployment
  chaosServiceAccount: litmus-chaos-runner
  experiments:
  - name: pod-network-latency
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: "120"
        - name: NETWORK_INTERFACE
          value: "eth0"
        - name: NETWORK_LATENCY
          value: "200"   # 200ms latency added to all outgoing traffic
        - name: JITTER
          value: "50"    # Plus or minus 50ms jitter
        - name: PODS_AFFECTED_PERC
          value: "50"
        # Target traffic only to specific destinations
        - name: DESTINATION_IPS
          value: "10.96.0.0/12"  # Only affect traffic to ClusterIP range
        - name: DESTINATION_HOSTS
          value: "postgresql-primary.production.svc.cluster.local"
      probe:
      - name: check-timeout-handling
        type: httpProbe
        httpProbe/inputs:
          url: "http://payments-api.production.svc.cluster.local/api/v1/payment"
          method:
            post:
              contentType: "application/json"
              body: '{"amount":100,"currency":"USD","idempotencyKey":"chaos-test-001"}'
              criteria: "=="
              responseCode: "200"
        runProperties:
          probeTimeout: 5000  # 5 second probe timeout
          interval: 10
          attempt: 6
        mode: Continuous
---
# Network packet loss experiment
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payments-network-loss
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payments-api"
    appkind: deployment
  chaosServiceAccount: litmus-chaos-runner
  experiments:
  - name: pod-network-loss
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: "60"
        - name: NETWORK_INTERFACE
          value: "eth0"
        - name: NETWORK_PACKET_LOSS_PERCENTAGE
          value: "10"  # 10% packet loss
        - name: PODS_AFFECTED_PERC
          value: "50"
```

### Network Partition (Split-Brain) Simulation

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: database-network-partition
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=postgresql"
    appkind: statefulset
  chaosServiceAccount: litmus-chaos-runner
  experiments:
  - name: pod-network-partition
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: "120"
        - name: NETWORK_INTERFACE
          value: "eth0"
        # Partition pod-0 from pod-1 and pod-2 (isolate primary)
        - name: DESTINATION_IPS
          value: ""  # Block all traffic (simulate complete partition)
        - name: POLICY
          value: "ingress"  # Block incoming traffic
        - name: PODS_AFFECTED_PERC
          value: "33"  # Affect only the primary (1 out of 3 pods)
        # Specify exact pod(s) to affect
        - name: TARGET_POD
          value: "postgresql-0"
      probe:
      - name: verify-failover-occurred
        type: cmdProbe
        cmdProbe/inputs:
          command: |
            kubectl exec -n production postgresql-1 -- \
              psql -U postgres -t -c "SELECT NOT pg_is_in_recovery();" | tr -d ' \n'
          comparator:
            type: string
            criteria: contains
            value: "t"
        runProperties:
          probeTimeout: 60
          interval: 15
          attempt: 5
        mode: EOT
```

## Section 5: Node Drain and Failure Experiments

### Node Drain Experiment

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: node-drain-test
  namespace: litmus
spec:
  # Node-level experiments run at cluster scope
  engineState: active
  chaosServiceAccount: litmus-chaos-runner
  experiments:
  - name: node-drain
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: "120"
        # Target a specific node (or use label selector)
        - name: TARGET_NODE
          value: "worker-node-03.acme.corp"
        # Cordon and drain the node
        - name: DRAIN_NODE
          value: "true"
        # Reboot the node after draining
        - name: REBOOT_NODE
          value: "false"
      probe:
      # Verify workloads reschedule successfully
      - name: check-all-pods-running
        type: k8sProbe
        k8sProbe/inputs:
          group: ""
          version: v1
          resource: pods
          namespace: production
          fieldSelector: "status.phase=Running"
          operation: present
        runProperties:
          probeTimeout: 120
          interval: 20
          attempt: 6
        mode: EOT
```

### Simulate Node Hardware Failure

```bash
#!/bin/bash
# simulate-node-failure.sh - Simulate hardware failure without Litmus

TARGET_NODE="${1:?Usage: $0 <node-name>}"
RECOVERY_WAIT_SECONDS="${2:-180}"

echo "Simulating node failure for: $TARGET_NODE"

# Record current pod distribution
echo "Pre-failure pod distribution:"
kubectl get pods --all-namespaces -o wide | grep "$TARGET_NODE"

# Cordon the node (prevent new scheduling)
kubectl cordon "$TARGET_NODE"

# Stop kubelet on the node (simulates hardware/OS failure)
# This requires SSH access or a privileged pod
kubectl run node-agent --image=nicolaka/netshoot --rm -it --restart=Never \
  --overrides="{\"spec\":{\"hostNetwork\":true,\"hostPID\":true,\"nodeName\":\"$TARGET_NODE\",\"containers\":[{\"name\":\"agent\",\"image\":\"busybox\",\"command\":[\"sh\",\"-c\",\"systemctl stop kubelet; sleep $RECOVERY_WAIT_SECONDS; systemctl start kubelet\"],\"securityContext\":{\"privileged\":true}}]}}" &

echo "Node is unreachable, monitoring pod rescheduling..."

# Monitor pod recovery
start_time=$(date +%s)
while true; do
  elapsed=$(( $(date +%s) - start_time ))
  running=$(kubectl get pods -n production --field-selector status.phase=Running --no-headers | wc -l)
  pending=$(kubectl get pods -n production --field-selector status.phase=Pending --no-headers | wc -l)
  
  echo "[${elapsed}s] Running: $running, Pending: $pending"
  
  if [ "$pending" -eq 0 ] && [ "$running" -gt 0 ]; then
    echo "All pods recovered after ${elapsed} seconds"
    break
  fi
  
  if [ "$elapsed" -gt 600 ]; then
    echo "TIMEOUT: Pods did not recover within 10 minutes"
    break
  fi
  
  sleep 10
done

# Uncordon the node when kubelet restarts
kubectl wait node "$TARGET_NODE" --for=condition=Ready --timeout=300s
kubectl uncordon "$TARGET_NODE"

echo "Node failure simulation complete. Recovery time: ${elapsed} seconds"
```

## Section 6: GameDay Planning

A GameDay is a structured event where the entire team practices incident response by deliberately triggering failures and measuring their response capability.

### GameDay Roles

```
Game Master:
  - Owns the GameDay schedule and sequence of events
  - Calls "chaos in!" when triggering experiments
  - Calls "abort!" if blast radius is exceeded
  - Records outcomes and metrics

Chaos Operator:
  - Executes the chaos experiments via Litmus or kubectl
  - Monitors chaos engine status
  - Ready to terminate experiments immediately

On-Call Team:
  - Responds as if this were a real incident
  - Uses standard runbooks and escalation procedures
  - No additional context beyond what alerts provide

Observer(s):
  - Records team behavior: detection time, escalation paths, communication
  - Does NOT intervene or provide hints
  - Produces after-action report
```

### GameDay Runbook Template

```yaml
# gameday-runbook.yaml
gameday:
  title: "Payments Service Resilience GameDay"
  date: "2024-02-15"
  duration: "4 hours"
  participants:
    game_master: "alice.jones@acme.corp"
    chaos_operator: "bob.smith@acme.corp"
    on_call: ["carol.white@acme.corp", "dave.brown@acme.corp"]
    observers: ["eve.davis@acme.corp"]
  
  environment:
    cluster: "prod-us-east-1"
    namespace: "production"
    services_under_test: ["payments-api", "payments-worker", "postgresql"]
  
  steady_state:
    metrics:
      success_rate: ">= 99.5%"
      p99_latency_ms: "<= 500"
      error_rate: "<= 0.5%"
      queue_depth: "<= 1000"
    verification_command: |
      kubectl exec prometheus-0 -n monitoring -- \
        promtool query instant \
        'rate(http_requests_total{namespace="production",code="200"}[5m]) / rate(http_requests_total{namespace="production"}[5m]) * 100'
  
  experiments:
  - id: EXP-001
    title: "Kill single payments-api pod"
    time: "10:05"
    duration: "5 minutes"
    hypothesis: "Success rate stays above 99.5%, p99 below 500ms"
    chaos_command: |
      kubectl delete pod -n production -l app=payments-api --field-selector status.phase=Running | head -1
    expected_outcome: "Pod restarts within 30 seconds, no alerts fire"
    abort_criteria: "Success rate drops below 95% or p99 exceeds 2 seconds"
    recovery_command: "kubectl rollout status deployment/payments-api -n production"
  
  - id: EXP-002
    title: "Inject 200ms latency to database"
    time: "10:20"
    duration: "10 minutes"
    hypothesis: "Application handles database latency with circuit breaker, success rate above 98%"
    chaos_command: |
      kubectl apply -f experiments/network-latency-db.yaml -n production
    expected_outcome: "Circuit breaker opens after 5 failed requests, returns cached data"
    abort_criteria: "Success rate below 90% for more than 60 seconds"
    recovery_command: "kubectl delete chaosengine payments-db-latency -n production"
  
  - id: EXP-003
    title: "Drain worker node"
    time: "10:45"
    duration: "15 minutes"
    hypothesis: "All pods reschedule within 3 minutes, no data loss"
    chaos_command: |
      kubectl drain worker-node-03 --ignore-daemonsets --delete-emptydir-data
    expected_outcome: "Pods rescheduled to other nodes, queue processing continues"
    abort_criteria: "Any pod fails to reschedule within 5 minutes"
    recovery_command: "kubectl uncordon worker-node-03"
  
  success_criteria:
  - "All experiments completed within planned duration"
  - "Steady state maintained throughout each experiment"
  - "Detection time for each failure < 2 minutes"
  - "Recovery time < 5 minutes for each experiment"
  
  debrief:
    scheduled: "14:00"
    questions:
    - "Which experiments violated the hypothesis and why?"
    - "Which alerts fired? Which should have fired but did not?"
    - "What runbooks were followed? Were they accurate?"
    - "What improvements should be made to the system?"
    - "What improvements should be made to the monitoring/alerting?"
```

### GameDay Execution Checklist

```bash
#!/bin/bash
# gameday-preflight.sh - Verify readiness before GameDay

echo "=== GameDay Preflight Checklist ==="

NAMESPACE="production"
PASSED=0
FAILED=0

check() {
  local desc="$1"
  local cmd="$2"
  if eval "$cmd" > /dev/null 2>&1; then
    echo "[PASS] $desc"
    PASSED=$((PASSED + 1))
  else
    echo "[FAIL] $desc"
    FAILED=$((FAILED + 1))
  fi
}

# Verify monitoring is operational
check "Prometheus is scraping production namespace" \
  "kubectl exec prometheus-0 -n monitoring -- wget -qO- 'localhost:9090/api/v1/query?query=up{namespace=\"production\"}' | jq '.data.result | length > 0'"

# Verify alerting is working
check "Alertmanager is reachable" \
  "kubectl exec alertmanager-0 -n monitoring -- wget -qO- localhost:9093/-/healthy"

# Verify Litmus is operational
check "LitmusChaos operator is running" \
  "kubectl get pods -n litmus -l app=litmus --field-selector status.phase=Running | grep -q litmus"

# Verify PodDisruptionBudgets are configured
check "payments-api PDB exists" \
  "kubectl get pdb -n $NAMESPACE payments-api-pdb"

check "postgresql PDB exists" \
  "kubectl get pdb -n $NAMESPACE postgresql-pdb"

# Verify all pods are healthy
check "All production pods are running" \
  "test $(kubectl get pods -n $NAMESPACE --field-selector status.phase!=Running --no-headers | grep -v Completed | wc -l) -eq 0"

# Verify baseline metrics
check "Success rate above 99.5%" \
  "kubectl exec prometheus-0 -n monitoring -- wget -qO- 'localhost:9090/api/v1/query?query=sum(rate(http_requests_total{namespace=\"production\",code=~\"2..\"}[5m]))/sum(rate(http_requests_total{namespace=\"production\"}[5m]))*100' | jq '.data.result[0].value[1] | tonumber > 99.5'"

echo ""
echo "Results: $PASSED passed, $FAILED failed"

if [ "$FAILED" -gt 0 ]; then
  echo "ABORT: Pre-flight checks failed. Do not proceed with GameDay."
  exit 1
fi

echo "Pre-flight checks passed. Ready to proceed."
```

## Section 7: SLO Impact Measurement

### Connecting Chaos Experiments to SLOs

```yaml
# Prometheus recording rules for chaos experiment impact
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: chaos-slo-tracking
  namespace: monitoring
spec:
  groups:
  - name: chaos-experiments
    interval: 15s
    rules:
    # Track error budget consumption during experiments
    - record: chaos:error_budget_consumption:rate5m
      expr: |
        1 - (
          sum(rate(http_requests_total{namespace="production",code=~"2.."}[5m]))
          /
          sum(rate(http_requests_total{namespace="production"}[5m]))
        )
    
    # Mark experiment windows
    - record: chaos:experiment_active
      expr: |
        sum(kube_job_status_active{namespace="litmus"}) > 0

    # Calculate error budget burn during experiments
    - record: chaos:error_budget_burn_rate
      expr: |
        chaos:error_budget_consumption:rate5m
        /
        (1 - 0.995)  # 99.5% SLO target
```

### Chaos Experiment Result Dashboard

```json
{
  "title": "Chaos Engineering Dashboard",
  "panels": [
    {
      "title": "Error Budget Consumption During Experiments",
      "type": "timeseries",
      "targets": [
        {
          "expr": "chaos:error_budget_consumption:rate5m",
          "legendFormat": "Error Rate"
        },
        {
          "expr": "chaos:experiment_active * 0.005",
          "legendFormat": "SLO Threshold (0.5%)"
        }
      ]
    },
    {
      "title": "Recovery Time Histogram",
      "type": "histogram",
      "targets": [
        {
          "expr": "chaos_recovery_duration_seconds_bucket"
        }
      ]
    }
  ]
}
```

## Section 8: Circuit Breaker Validation

Chaos experiments are ideal for validating circuit breaker configurations. The circuit breaker should open before the SLO is breached.

### Testing with Hystrix/Resilience4j Pattern

```yaml
# Configure Istio's circuit breaker (using DestinationRule)
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payments-api-circuit-breaker
  namespace: production
spec:
  host: payments-api.production.svc.cluster.local
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
        maxRetries: 3
    outlierDetection:
      # Eject hosts that return 5xx errors
      consecutiveGatewayErrors: 5
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 50
```

### Circuit Breaker Test Script

```bash
#!/bin/bash
# test-circuit-breaker.sh

SERVICE_URL="http://payments-api.production.svc.cluster.local/api/v1/payment"
LOAD_GENERATOR_POD="load-test-pod"

echo "=== Circuit Breaker Validation Test ==="

# Step 1: Establish baseline
echo "Baseline: $(kubectl exec "$LOAD_GENERATOR_POD" -- \
  hey -n 100 -c 10 -q 10 "$SERVICE_URL" 2>&1 | grep 'Status code distribution' -A 5)"

# Step 2: Inject failures in 50% of pods
echo "Injecting failures (50% of pods returning 500)..."
kubectl apply -f - <<'EOF'
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: circuit-breaker-test
  namespace: production
spec:
  appinfo:
    appns: production
    applabel: "app=payments-api"
    appkind: deployment
  chaosServiceAccount: litmus-chaos-runner
  experiments:
  - name: pod-http-status-code
    spec:
      components:
        env:
        - name: TOTAL_CHAOS_DURATION
          value: "120"
        - name: STATUS_CODE
          value: "500"
        - name: PODS_AFFECTED_PERC
          value: "50"
        - name: RESPONSE_BODY
          value: '{"error":"service temporarily unavailable"}'
EOF

# Step 3: Monitor during chaos
echo "Monitoring for circuit breaker opening..."
for i in $(seq 1 12); do
  sleep 10
  SUCCESS=$(kubectl exec "$LOAD_GENERATOR_POD" -- \
    hey -n 50 -c 5 "$SERVICE_URL" 2>&1 | grep '200' | awk '{print $2}')
  echo "[${i}0s] Success rate: ${SUCCESS:-0}%"
done

# Step 4: Verify circuit breaker opened (should see 503 from circuit breaker, not 500 from backend)
echo "Checking response codes (expecting 503 from circuit breaker)..."
kubectl exec "$LOAD_GENERATOR_POD" -- \
  hey -n 100 -c 10 "$SERVICE_URL" 2>&1 | grep 'Status code distribution' -A 10

# Step 5: Remove chaos
kubectl delete chaosengine circuit-breaker-test -n production

# Step 6: Verify recovery
echo "Waiting for circuit breaker to close (30s)..."
sleep 35

echo "Post-recovery metrics:"
kubectl exec "$LOAD_GENERATOR_POD" -- \
  hey -n 100 -c 10 "$SERVICE_URL" 2>&1 | grep 'Status code distribution' -A 5

echo "Circuit breaker test complete"
```

## Section 9: Chaos in CI/CD Pipelines

Integrate chaos experiments into your deployment pipeline to catch resilience regressions:

```yaml
# .github/workflows/chaos-regression.yml
name: Chaos Regression Tests
on:
  workflow_dispatch:
  schedule:
  - cron: "0 2 * * 1-5"  # Weeknights at 2 AM

jobs:
  chaos-tests:
    runs-on: ubuntu-latest
    environment: staging  # Run against staging, not production

    steps:
    - uses: actions/checkout@v4

    - name: Configure kubectl
      run: |
        echo "${{ secrets.KUBE_CONFIG_STAGING }}" | base64 -d > kubeconfig.yaml
        echo "KUBECONFIG=$(pwd)/kubeconfig.yaml" >> "$GITHUB_ENV"

    - name: Verify steady state
      run: |
        SUCCESS_RATE=$(kubectl exec prometheus-0 -n monitoring -- \
          wget -qO- 'localhost:9090/api/v1/query?query=sum(rate(http_requests_total{namespace="staging",code=~"2.."}[5m]))/sum(rate(http_requests_total{namespace="staging"}[5m]))*100' | \
          jq -r '.data.result[0].value[1]')
        echo "Current success rate: $SUCCESS_RATE%"
        if (( $(echo "$SUCCESS_RATE < 99.0" | bc -l) )); then
          echo "Steady state not met, aborting chaos tests"
          exit 1
        fi

    - name: Run pod failure experiment
      run: |
        kubectl apply -f chaos/staging/pod-delete-experiment.yaml
        kubectl wait chaosengine/staging-pod-delete -n staging \
          --for=jsonpath='{.status.engineStatus}'=completed \
          --timeout=300s

    - name: Check experiment results
      run: |
        RESULT=$(kubectl get chaosresult staging-pod-delete-pod-delete -n staging \
          -o jsonpath='{.status.experimentStatus.verdict}')
        echo "Experiment verdict: $RESULT"
        if [ "$RESULT" != "Pass" ]; then
          echo "Chaos experiment FAILED - resilience regression detected"
          exit 1
        fi

    - name: Run network latency experiment
      run: |
        kubectl apply -f chaos/staging/network-latency-experiment.yaml
        kubectl wait chaosengine/staging-network-latency -n staging \
          --for=jsonpath='{.status.engineStatus}'=completed \
          --timeout=300s

    - name: Cleanup and report
      if: always()
      run: |
        kubectl delete -f chaos/staging/ --ignore-not-found
        kubectl get chaosresult -n staging -o json | \
          jq '[.items[] | {name: .metadata.name, verdict: .status.experimentStatus.verdict}]'
```

## Section 10: Observability for Chaos Engineering

### Chaos Event Annotations in Grafana

```yaml
# configmap for Grafana annotations API configuration
# Use this to mark chaos experiments on dashboards
apiVersion: v1
kind: ConfigMap
metadata:
  name: chaos-annotation-script
  namespace: litmus
data:
  annotate.sh: |
    #!/bin/bash
    GRAFANA_URL="${GRAFANA_URL:-http://grafana.monitoring.svc.cluster.local:3000}"
    GRAFANA_TOKEN="${GRAFANA_TOKEN}"
    
    START_TIME=$(date +%s%3N)
    EXPERIMENT_NAME="$1"
    
    # Create start annotation
    curl -s -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $GRAFANA_TOKEN" \
      "$GRAFANA_URL/api/annotations" \
      -d "{
        \"time\": $START_TIME,
        \"tags\": [\"chaos\", \"experiment\", \"$EXPERIMENT_NAME\"],
        \"text\": \"Chaos experiment started: $EXPERIMENT_NAME\"
      }"
    
    echo "Annotation created at $START_TIME"
```

## Summary

Effective chaos engineering requires both technical tools and organizational discipline:

1. Define measurable steady state before running any experiment
2. Start with the smallest possible blast radius and increase gradually
3. Write hypotheses before running experiments to avoid post-hoc rationalization
4. Use LitmusChaos for repeatable, auditable experiments with built-in probes
5. GameDays are rehearsals, not surprises—communicate with all stakeholders in advance
6. Measure SLO impact during experiments to validate error budget accounting
7. Validate circuit breakers, retry logic, and fallback paths specifically—these are the mechanisms that should absorb failures
8. Automate chaos experiments in CI/CD pipelines to catch resilience regressions

The ultimate goal of chaos engineering is to find weaknesses in a controlled setting so they can be fixed before they cause real incidents. Organizations that practice chaos engineering consistently report fewer high-severity incidents and significantly faster recovery times when incidents do occur.
