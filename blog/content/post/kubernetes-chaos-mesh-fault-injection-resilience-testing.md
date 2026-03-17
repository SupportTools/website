---
title: "Kubernetes Chaos Mesh: Fault Injection Framework for Resilience Testing"
date: 2031-05-08T00:00:00-05:00
draft: false
tags: ["Chaos Mesh", "Kubernetes", "Chaos Engineering", "Resilience Testing", "Fault Injection", "SRE", "Grafana"]
categories: ["Kubernetes", "SRE"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Build a resilience testing program with Chaos Mesh: PodChaos, NetworkChaos, IOChaos, StressChaos, workflow-based experiments, Grafana integration, steady-state hypothesis validation, and chaos automation."
more_link: "yes"
url: "/kubernetes-chaos-mesh-fault-injection-resilience-testing/"
---

Chaos Mesh is a Kubernetes-native chaos engineering platform that provides fine-grained fault injection across pods, networks, file I/O, and system resources. Unlike manual failure testing, Chaos Mesh integrates with your observability stack to measure the actual impact of failures against defined steady-state hypotheses. This guide covers production chaos engineering workflows from basic fault injection to automated experiment pipelines.

<!--more-->

# Kubernetes Chaos Mesh: Fault Injection Framework for Resilience Testing

## Section 1: Chaos Engineering Principles

Chaos engineering is not random destruction. It follows a structured process:

1. **Define steady state** - What does "working" look like? (SLIs: error rate < 0.1%, p99 latency < 500ms)
2. **Hypothesize** - "We believe the system will maintain steady state when [fault] occurs"
3. **Introduce fault** - Controlled, scoped fault injection
4. **Observe** - Measure against steady-state metrics
5. **Validate or invalidate** - Did the system maintain steady state?
6. **Fix and repeat** - Fix weaknesses discovered, then re-run

Chaos Mesh enables steps 3-5 with infrastructure-level fault injection. Steps 1-2 and 6 require your team's involvement.

## Section 2: Installation

```bash
# Install Chaos Mesh using Helm
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm repo update

# Create namespace
kubectl create namespace chaos-testing

# Install with basic configuration
helm upgrade --install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace chaos-testing \
  --set chaosDaemon.runtime=containerd \
  --set chaosDaemon.socketPath=/run/containerd/containerd.sock \
  --version 2.7.0 \
  --wait

# For Docker runtime
helm upgrade --install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace chaos-testing \
  --set chaosDaemon.runtime=docker \
  --set chaosDaemon.socketPath=/var/run/docker.sock \
  --version 2.7.0

# Verify installation
kubectl get pods -n chaos-testing

# Access Chaos Dashboard
kubectl port-forward -n chaos-testing svc/chaos-dashboard 2333:2333
# Open http://localhost:2333
```

### Production Installation with Security

```yaml
# chaos-mesh-values.yaml
controllerManager:
  replicaCount: 3
  leaderElection:
    enabled: true
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 2Gi

chaosDaemon:
  runtime: containerd
  socketPath: /run/containerd/containerd.sock
  tolerations:
    - operator: Exists
      effect: NoSchedule
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 1Gi

dashboard:
  enabled: true
  replicaCount: 2
  securityMode: true  # Enable authentication
  resources:
    requests:
      cpu: 250m
      memory: 256Mi

# RBAC for experiment submission
chaosDaemon:
  serviceAccount:
    create: true

webhook:
  certManager:
    enabled: true  # Use cert-manager for webhook TLS

# Metrics for Prometheus
enableProfiling: false
```

## Section 3: RBAC - Restricting Chaos to Specific Namespaces

```yaml
# chaos-rbac.yaml
# Role for submitting chaos experiments in specific namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: chaos-experiment-submitter
  namespace: staging
rules:
  - apiGroups: ["chaos-mesh.org"]
    resources:
      - podchaos
      - networkchaos
      - iochaos
      - stresschaos
      - kernelchaos
      - timechaos
      - awschaos
      - gcpchaos
      - httpchaos
    verbs: ["get", "list", "watch", "create", "delete", "patch", "update"]
  - apiGroups: ["chaos-mesh.org"]
    resources:
      - workflows
      - workflownodes
    verbs: ["get", "list", "watch", "create", "delete", "patch", "update"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: chaos-experiment-submitter-binding
  namespace: staging
subjects:
  - kind: ServiceAccount
    name: chaos-runner
    namespace: chaos-testing
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: chaos-experiment-submitter

---
# IMPORTANT: By default, Chaos Mesh only affects namespaces you authorize
# Add namespaces to the allowlist in chaos-mesh's controller-manager config
apiVersion: v1
kind: ConfigMap
metadata:
  name: chaos-mesh
  namespace: chaos-testing
data:
  # Only allow chaos in staging namespace (not production!)
  namespace-allowlist: "staging"
```

## Section 4: PodChaos - Pod Failure and Restart Testing

```yaml
# pod-kill-chaos.yaml
# Kill random pods in the payment service
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: payment-service-pod-kill
  namespace: staging
  labels:
    app: chaos-experiment
    target: payment-service
spec:
  action: pod-kill
  mode: one                    # Kill one pod at a time
  # mode options:
  # one:              Kill exactly one pod
  # all:              Kill all matching pods (dangerous!)
  # fixed:            Kill a fixed number of pods
  # fixed-percent:    Kill a percentage of pods
  # random-max-percent: Kill up to a percentage

  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
    # Optionally exclude specific pods
    # annotationSelectors:
    #   "chaos-mesh.org/inject": "enabled"

  # Run for 5 minutes
  duration: 5m

  # Scheduling: run experiment every hour
  # scheduler:
  #   cron: "@every 1h"

---
# pod-failure-chaos.yaml
# Pause pods (SIGSTOP) to simulate unresponsive but running pods
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: payment-service-pod-failure
  namespace: staging
spec:
  action: pod-failure
  mode: fixed-percent
  value: "30"  # Kill 30% of pods
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  duration: 2m

---
# container-kill-chaos.yaml
# Kill a specific container within a pod (useful for multi-container pods)
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: sidecar-container-kill
  namespace: staging
spec:
  action: container-kill
  mode: all
  containerNames:
    - "envoy"       # Kill only the sidecar, not the main app
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  duration: 1m
```

## Section 5: NetworkChaos - Latency, Partition, and Loss

```yaml
# network-delay-chaos.yaml
# Add 100ms latency with 20ms jitter to payment service egress traffic
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: payment-service-network-delay
  namespace: staging
spec:
  action: delay
  mode: all
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  delay:
    latency: "100ms"
    correlation: "25"    # 25% correlation with previous packet delay
    jitter: "20ms"       # ±20ms jitter
  direction: to          # Apply to outgoing traffic (from = incoming, both = both)
  # Target specific pods as the destination
  target:
    mode: all
    selector:
      namespaces:
        - staging
      labelSelectors:
        "app.kubernetes.io/name": "postgresql"
  duration: 10m

---
# network-partition-chaos.yaml
# Create a network partition between services
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: payment-database-partition
  namespace: staging
spec:
  action: partition
  mode: all
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  direction: both
  target:
    mode: all
    selector:
      namespaces:
        - staging
      labelSelectors:
        "app.kubernetes.io/name": "postgresql"
  duration: 2m

---
# network-loss-chaos.yaml
# 30% packet loss for all outgoing traffic from payment service
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: payment-service-packet-loss
  namespace: staging
spec:
  action: loss
  mode: all
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  loss:
    loss: "30"         # 30% packet loss
    correlation: "25"  # 25% correlation
  direction: to
  duration: 5m

---
# network-corrupt-chaos.yaml
# Corrupt packets to simulate bad network hardware
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: payment-service-packet-corrupt
  namespace: staging
spec:
  action: corrupt
  mode: all
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  corrupt:
    corrupt: "5"       # 5% packet corruption
    correlation: "25"
  direction: to
  duration: 5m

---
# network-bandwidth-chaos.yaml
# Limit bandwidth to 1Mbps (simulates degraded WAN link)
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: payment-service-bandwidth-limit
  namespace: staging
spec:
  action: bandwidth
  mode: all
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  bandwidth:
    rate: "1mbps"
    limit: 20971520    # Buffer size in bytes
    buffer: 10000      # Token bucket size
  direction: to
  duration: 10m
```

## Section 6: IOChaos - Disk I/O Fault Injection

```yaml
# io-latency-chaos.yaml
# Add 100ms latency to all disk reads in PostgreSQL pods
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: postgresql-io-latency
  namespace: staging
spec:
  action: latency
  mode: one
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "postgresql"
  volumePath: /var/lib/postgresql/data
  path: "**/*.db"   # Apply to .db files only
  delay: "100ms"
  # Apply only to reads (not writes)
  methods:
    - read
  percent: 50       # Apply to 50% of read operations
  duration: 5m

---
# io-fault-chaos.yaml
# Inject I/O errors (EIO) for write operations
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: postgresql-io-fault
  namespace: staging
spec:
  action: fault
  mode: one
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "postgresql"
  volumePath: /var/lib/postgresql/data
  path: "**"
  # ENOSPC: No space left on device
  # EIO: Input/output error
  # EPERM: Operation not permitted
  errno: 5    # EIO
  methods:
    - write
  percent: 10   # 10% of writes fail
  duration: 2m

---
# io-mistake-chaos.yaml
# Introduce data corruption (fills write buffers with zeros)
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: postgresql-io-mistake
  namespace: staging
spec:
  action: mistake
  mode: one
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "postgresql"
  volumePath: /var/lib/postgresql/data
  path: "**/*.db"
  mistake:
    filling: zero       # Fill with zeros (or random)
    maxOccurrences: 1   # Max mistakes per operation
    maxLength: 16       # Max bytes to corrupt per mistake
  methods:
    - read
  percent: 10
  duration: 1m
```

## Section 7: StressChaos - CPU and Memory Pressure

```yaml
# cpu-stress-chaos.yaml
# Consume 80% CPU on payment service pods
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: payment-service-cpu-stress
  namespace: staging
spec:
  mode: one
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  stressors:
    cpu:
      workers: 2        # Number of CPU stress goroutines
      load: 80          # CPU load percentage (0-100)
      options:
        - "--cpu-method"
        - "all"
  containerNames:
    - "payment-service"  # Stress only the main container, not sidecars
  duration: 5m

---
# memory-stress-chaos.yaml
# Consume 512Mi memory to simulate memory leak or high load
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: payment-service-memory-stress
  namespace: staging
spec:
  mode: one
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  stressors:
    memory:
      workers: 4
      size: "512Mi"    # Memory to consume
      # time: "30s"    # How long to hold memory (default: indefinitely)
      oomScoreAdj: -1000  # Prevent OOM killer from killing the stressor
  containerNames:
    - "payment-service"
  duration: 5m

---
# combined-stress-chaos.yaml
# CPU + Memory stress simultaneously
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: payment-service-combined-stress
  namespace: staging
spec:
  mode: fixed-percent
  value: "50"
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  stressors:
    cpu:
      workers: 1
      load: 60
    memory:
      workers: 2
      size: "256Mi"
  duration: 10m
```

## Section 8: HTTPChaos - HTTP Request Fault Injection

```yaml
# http-delay-chaos.yaml
# Add 500ms delay to HTTP responses from payment service
apiVersion: chaos-mesh.org/v1alpha1
kind: HTTPChaos
metadata:
  name: payment-service-http-delay
  namespace: staging
spec:
  mode: all
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  target: Response     # Inject into responses (Request = inject into requests)
  port: 8080           # Port the service listens on
  path: "/api/payments"  # Only affect this path (* = all paths)
  method: "POST"       # Only POST requests
  delay: "500ms"
  percent: 100         # 100% of matching requests
  duration: 5m

---
# http-abort-chaos.yaml
# Return 503 for 30% of payment creation requests
apiVersion: chaos-mesh.org/v1alpha1
kind: HTTPChaos
metadata:
  name: payment-service-http-abort
  namespace: staging
spec:
  mode: all
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  target: Response
  port: 8080
  path: "/api/v1/payments"
  method: "POST"
  abort: true          # Abort the connection (or use code: 503)
  percent: 30
  duration: 5m

---
# http-response-patch-chaos.yaml
# Modify response body to inject malformed data
apiVersion: chaos-mesh.org/v1alpha1
kind: HTTPChaos
metadata:
  name: payment-service-http-response-patch
  namespace: staging
spec:
  mode: all
  selector:
    namespaces:
      - staging
    labelSelectors:
      "app.kubernetes.io/name": "payment-service"
  target: Response
  port: 8080
  path: "/api/v1/payments/*"
  replace:
    code: 503
    headers:
      Content-Type: "application/json"
    body: eyJlcnJvcjoidGVtcG9yYXJpbHlfZG93biIsInJldHJ5X2FmdGVyIjozMH0=
    # base64 of: {"error":"temporarily_down","retry_after":30}
  percent: 50
  duration: 2m
```

## Section 9: Workflow-Based Chaos Experiments

Workflows execute multiple chaos experiments in sequence or parallel with conditions:

```yaml
# payment-service-workflow.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: Workflow
metadata:
  name: payment-service-resilience-test
  namespace: staging
  labels:
    experiment: payment-service-resilience
    environment: staging
spec:
  entry: full-test-suite
  templates:
    # Entry point: run all test phases
    - name: full-test-suite
      templateType: Serial
      deadline: "60m"
      children:
        - baseline-measurement
        - pod-failure-test
        - verify-recovery
        - network-partition-test
        - verify-recovery-2
        - combined-stress-test

    # Baseline: No chaos, just measure
    - name: baseline-measurement
      templateType: Suspend
      deadline: "5m"  # Wait 5 minutes to record baseline metrics

    # Pod failure test
    - name: pod-failure-test
      templateType: PodChaos
      deadline: "10m"
      podChaos:
        action: pod-kill
        mode: one
        selector:
          namespaces:
            - staging
          labelSelectors:
            "app.kubernetes.io/name": "payment-service"

    # Verify recovery after pod failure
    - name: verify-recovery
      templateType: Serial
      deadline: "5m"
      children:
        - wait-for-pod-recovery
        - run-smoke-test

    - name: wait-for-pod-recovery
      templateType: Suspend
      deadline: "3m"

    - name: run-smoke-test
      templateType: Task
      deadline: "2m"
      task:
        container:
          name: smoke-test
          image: ghcr.io/myorg/smoke-test:latest
          command:
            - /bin/sh
            - -c
            - |
              # Run smoke test against staging
              curl -f http://payment-service.staging.svc.cluster.local:8080/healthz || exit 1
              # Run API smoke tests
              ./run-smoke-tests.sh staging || exit 1
          resources:
            limits:
              cpu: 200m
              memory: 256Mi

    # Network partition test
    - name: network-partition-test
      templateType: Parallel
      deadline: "15m"
      children:
        - partition-database
        - generate-traffic

    - name: partition-database
      templateType: NetworkChaos
      deadline: "5m"
      networkChaos:
        action: partition
        mode: all
        selector:
          namespaces:
            - staging
          labelSelectors:
            "app.kubernetes.io/name": "payment-service"
        direction: both
        target:
          mode: all
          selector:
            namespaces:
              - staging
            labelSelectors:
              "app.kubernetes.io/name": "postgresql"

    - name: generate-traffic
      templateType: Task
      deadline: "15m"
      task:
        container:
          name: traffic-generator
          image: ghcr.io/myorg/load-generator:latest
          command:
            - /bin/sh
            - -c
            - |
              ./k6 run \
                --vus 50 \
                --duration 10m \
                --out json=/tmp/results.json \
                /scripts/payment-load-test.js
          resources:
            limits:
              cpu: 500m
              memory: 512Mi

    # Verify recovery after network partition
    - name: verify-recovery-2
      templateType: Suspend
      deadline: "3m"

    # Combined stress: CPU + memory while also having network delay
    - name: combined-stress-test
      templateType: Parallel
      deadline: "10m"
      children:
        - cpu-memory-stress
        - network-delay

    - name: cpu-memory-stress
      templateType: StressChaos
      deadline: "10m"
      stressChaos:
        mode: fixed-percent
        value: "50"
        selector:
          namespaces:
            - staging
          labelSelectors:
            "app.kubernetes.io/name": "payment-service"
        stressors:
          cpu:
            workers: 1
            load: 70
          memory:
            workers: 2
            size: "256Mi"

    - name: network-delay
      templateType: NetworkChaos
      deadline: "10m"
      networkChaos:
        action: delay
        mode: all
        selector:
          namespaces:
            - staging
          labelSelectors:
            "app.kubernetes.io/name": "payment-service"
        delay:
          latency: "50ms"
          jitter: "10ms"
        direction: to
```

## Section 10: Grafana Integration for Impact Measurement

Configure Grafana annotations to mark when chaos experiments run:

```yaml
# chaos-mesh-grafana-values.yaml addition
# Configure Grafana data source for chaos events

# chaos-grafana-annotations.yaml
# Grafana annotation query for Chaos Mesh events:
# {
#   "datasource": "Prometheus",
#   "enable": true,
#   "hide": false,
#   "iconColor": "red",
#   "name": "Chaos Experiments",
#   "query": "changes(chaos_experiment_injections_total{namespace=\"staging\"}[1m]) > 0",
#   "step": 60,
#   "titleFormat": "Chaos: {{kind}}/{{name}}"
# }
```

Prometheus rules for chaos experiment tracking:

```yaml
# chaos-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: chaos-mesh-rules
  namespace: chaos-testing
  labels:
    release: prometheus
spec:
  groups:
    - name: chaos-mesh
      rules:
        # Alert when chaos is injected in production (should never happen)
        - alert: ChaosExperimentInProduction
          expr: |
            chaos_controller_manager_chaos_injected_total{namespace="production"} > 0
          for: 0s
          labels:
            severity: critical
          annotations:
            summary: "Chaos experiment running in PRODUCTION namespace!"
            description: "Chaos Mesh is injecting faults in production. Stop immediately."

        # Alert when chaos experiment fails to inject
        - alert: ChaosExperimentInjectionFailed
          expr: |
            increase(chaos_controller_manager_chaos_failed_total[5m]) > 0
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Chaos experiment injection failed"
```

Dashboard JSON for chaos impact measurement:

```json
{
  "title": "Chaos Engineering Impact",
  "panels": [
    {
      "title": "Payment Service Error Rate During Chaos",
      "type": "timeseries",
      "targets": [
        {
          "expr": "rate(http_requests_total{job=\"payment-service\",status=~\"5..\"}[1m]) / rate(http_requests_total{job=\"payment-service\"}[1m])",
          "legendFormat": "Error Rate"
        }
      ],
      "annotations": [
        {
          "datasource": "Prometheus",
          "enable": true,
          "expr": "chaos_experiment_injections_total{namespace=\"staging\"}"
        }
      ]
    },
    {
      "title": "Payment Service p99 Latency",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{job=\"payment-service\"}[5m]))",
          "legendFormat": "p99 Latency"
        }
      ]
    }
  ]
}
```

## Section 11: Steady-State Hypothesis Validation

Automate steady-state validation using a pre/during/post test framework:

```go
// cmd/chaos-validator/main.go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"
)

// SteadyStateHypothesis defines what "healthy" means for the target system.
type SteadyStateHypothesis struct {
	Name           string
	ProbeInterval  time.Duration
	Probes         []Probe
}

// Probe measures a single system property.
type Probe interface {
	Name() string
	Measure(ctx context.Context) (float64, error)
	IsWithinTolerance(value float64) bool
}

// ErrorRateProbe measures HTTP error rate against Prometheus.
type ErrorRateProbe struct {
	PrometheusURL string
	Service       string
	MaxErrorRate  float64  // e.g., 0.001 = 0.1%
}

func (p *ErrorRateProbe) Name() string { return "error_rate" }

func (p *ErrorRateProbe) Measure(ctx context.Context) (float64, error) {
	query := fmt.Sprintf(
		`sum(rate(http_requests_total{job="%s",status=~"5.."}[1m])) / sum(rate(http_requests_total{job="%s"}[1m]))`,
		p.Service, p.Service,
	)
	return queryPrometheus(ctx, p.PrometheusURL, query)
}

func (p *ErrorRateProbe) IsWithinTolerance(value float64) bool {
	return value <= p.MaxErrorRate
}

// LatencyP99Probe measures p99 latency.
type LatencyP99Probe struct {
	PrometheusURL  string
	Service        string
	MaxLatencyMs   float64
}

func (p *LatencyP99Probe) Name() string { return "p99_latency" }

func (p *LatencyP99Probe) Measure(ctx context.Context) (float64, error) {
	query := fmt.Sprintf(
		`histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{job="%s"}[5m])) * 1000`,
		p.Service,
	)
	return queryPrometheus(ctx, p.PrometheusURL, query)
}

func (p *LatencyP99Probe) IsWithinTolerance(value float64) bool {
	return value <= p.MaxLatencyMs
}

// Validator runs steady-state hypothesis validation.
type Validator struct {
	hypothesis *SteadyStateHypothesis
	logger     *slog.Logger
}

// ValidateBaseline measures baseline before chaos injection.
func (v *Validator) ValidateBaseline(ctx context.Context) (map[string]float64, error) {
	v.logger.Info("measuring baseline steady state")
	return v.measureAll(ctx)
}

// ValidateDuringChaos measures state while chaos is active.
func (v *Validator) ValidateDuringChaos(ctx context.Context, duration time.Duration) ([]map[string]float64, error) {
	v.logger.Info("measuring during chaos", "duration", duration)

	var measurements []map[string]float64
	ticker := time.NewTicker(v.hypothesis.ProbeInterval)
	defer ticker.Stop()

	deadline := time.Now().Add(duration)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return measurements, ctx.Err()
		case <-ticker.C:
			m, err := v.measureAll(ctx)
			if err != nil {
				v.logger.Error("measurement failed", "error", err)
				continue
			}
			measurements = append(measurements, m)
			v.logMeasurement(m)
		}
	}

	return measurements, nil
}

// GenerateReport produces a chaos experiment report.
func (v *Validator) GenerateReport(
	baseline map[string]float64,
	duringChaos []map[string]float64,
	afterChaos map[string]float64,
) *ExperimentReport {
	report := &ExperimentReport{
		Hypothesis: v.hypothesis.Name,
		Timestamp:  time.Now(),
		Passed:     true,
	}

	// Check baseline
	for probeName, baselineValue := range baseline {
		probe := v.findProbe(probeName)
		if probe != nil && !probe.IsWithinTolerance(baselineValue) {
			report.Findings = append(report.Findings, Finding{
				Phase:     "baseline",
				ProbeName: probeName,
				Value:     baselineValue,
				Message:   fmt.Sprintf("baseline already outside tolerance: %.4f", baselineValue),
				Severity:  "warning",
			})
		}
	}

	// Check during chaos
	for _, m := range duringChaos {
		for probeName, value := range m {
			probe := v.findProbe(probeName)
			if probe != nil && !probe.IsWithinTolerance(value) {
				report.Passed = false
				report.Findings = append(report.Findings, Finding{
					Phase:     "chaos",
					ProbeName: probeName,
					Value:     value,
					Message:   fmt.Sprintf("outside tolerance during chaos: %.4f", value),
					Severity:  "critical",
				})
			}
		}
	}

	// Check recovery
	for probeName, recoveryValue := range afterChaos {
		probe := v.findProbe(probeName)
		if probe != nil && !probe.IsWithinTolerance(recoveryValue) {
			report.Passed = false
			report.Findings = append(report.Findings, Finding{
				Phase:     "recovery",
				ProbeName: probeName,
				Value:     recoveryValue,
				Message:   fmt.Sprintf("failed to recover after chaos: %.4f", recoveryValue),
				Severity:  "critical",
			})
		}
	}

	return report
}

type ExperimentReport struct {
	Hypothesis string
	Timestamp  time.Time
	Passed     bool
	Findings   []Finding
}

type Finding struct {
	Phase     string
	ProbeName string
	Value     float64
	Message   string
	Severity  string
}
```

## Section 12: Chaos Experiment Automation in CI/CD

```yaml
# .github/workflows/chaos-test.yaml
name: Chaos Testing

on:
  # Run weekly
  schedule:
    - cron: '0 2 * * 1'  # Monday 2 AM UTC
  # Run manually
  workflow_dispatch:
    inputs:
      experiment:
        description: 'Experiment to run'
        required: true
        default: 'pod-kill'
        type: choice
        options:
          - pod-kill
          - network-partition
          - cpu-stress
          - full-workflow

jobs:
  chaos-test:
    runs-on: ubuntu-latest
    environment: staging-chaos
    timeout-minutes: 90

    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/k8s-set-context@v3
        with:
          kubeconfig: ${{ secrets.KUBECONFIG_STAGING }}

      - name: Install kube-score
        run: |
          curl -L https://github.com/zegl/kube-score/releases/latest/download/kube-score_linux_amd64.tar.gz | tar -xz
          mv kube-score /usr/local/bin/

      - name: Verify steady state before chaos
        run: |
          ./scripts/verify-steady-state.sh staging \
            --error-rate-threshold 0.001 \
            --p99-latency-threshold 200 \
            --duration 120

      - name: Apply chaos experiment
        run: |
          EXPERIMENT="${{ github.event.inputs.experiment || 'pod-kill' }}"
          kubectl apply -f chaos/experiments/${EXPERIMENT}.yaml

      - name: Monitor during chaos
        run: |
          ./scripts/monitor-chaos.sh \
            --duration 300 \
            --namespace staging \
            --service payment-service

      - name: Remove chaos experiment
        if: always()
        run: |
          EXPERIMENT="${{ github.event.inputs.experiment || 'pod-kill' }}"
          kubectl delete -f chaos/experiments/${EXPERIMENT}.yaml --ignore-not-found

      - name: Verify recovery after chaos
        run: |
          sleep 60  # Wait for recovery
          ./scripts/verify-steady-state.sh staging \
            --error-rate-threshold 0.001 \
            --p99-latency-threshold 200 \
            --duration 120

      - name: Generate chaos report
        if: always()
        run: |
          ./scripts/generate-chaos-report.sh \
            --experiment "${{ github.event.inputs.experiment || 'pod-kill' }}" \
            --output chaos-report.json

      - name: Upload chaos report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: chaos-report
          path: chaos-report.json
          retention-days: 90

      - name: Comment on PR (if applicable)
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = JSON.parse(fs.readFileSync('chaos-report.json'));
            const status = report.passed ? '✅ PASSED' : '❌ FAILED';
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `## Chaos Test Results: ${status}\n\n${report.summary}`
            });
```

## Summary

Chaos Mesh provides a comprehensive fault injection platform with:

1. **PodChaos** for testing pod restart resilience, replica count minimums, and graceful shutdown
2. **NetworkChaos** for testing circuit breakers, retry logic, and timeout handling
3. **IOChaos** for validating database write paths under disk degradation
4. **StressChaos** for testing resource limit configuration and OOM handling
5. **HTTPChaos** for testing client-side retry and timeout behavior
6. **Workflows** for orchestrating multi-phase experiments with sequential and parallel steps
7. **Grafana annotations** for correlating chaos events with system metrics
8. **Steady-state validation** for automated experiment pass/fail determination
9. **CI/CD integration** for making chaos a standard part of the release process

Start with PodChaos killing a single instance of your most critical service in staging. If it recovers within your SLO window, expand to network delays. The first chaos experiment almost always reveals a missing readiness probe, an insufficient replica count, or a client without retry logic - all fixable before they cause a real incident.
