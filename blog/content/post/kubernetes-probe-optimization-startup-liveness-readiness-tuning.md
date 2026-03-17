---
title: "Kubernetes Probe Optimization: Startup, Liveness, and Readiness Tuning"
date: 2029-09-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Reliability", "SLO", "Health Checks", "gRPC", "Production", "Observability"]
categories: ["Kubernetes", "Reliability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes probe optimization covering probe type selection, initialDelaySeconds vs startupProbe patterns, exec/httpGet/gRPC probe mechanisms, probe failure impact on SLOs, and systematic approaches to debugging probe failures in production."
more_link: "yes"
url: "/kubernetes-probe-optimization-startup-liveness-readiness-tuning/"
---

Misconfigured Kubernetes probes are one of the most common causes of production reliability incidents. A liveness probe that's too sensitive restarts pods unnecessarily during GC pauses. A readiness probe with too-long a period allows traffic to reach pods that are still warming up. Startup probes misconfigured for slow-starting applications cause restart loops. This guide provides a systematic approach to probe configuration that protects SLOs without causing unnecessary restarts.

<!--more-->

# Kubernetes Probe Optimization: Startup, Liveness, and Readiness Tuning

## Section 1: The Three Probe Types and Their Semantics

Kubernetes provides three distinct probe mechanisms, each with a specific purpose that maps directly to a different failure scenario.

### Startup Probe

The startup probe answers: "Has the application finished starting up?" Kubernetes will not execute liveness or readiness probes until the startup probe succeeds. This allows slow-starting applications (Java services, applications that run database migrations at startup) to have a generous startup window without making the liveness probe insensitive during steady-state operation.

**When to use**: Any application that takes more than 15-20 seconds to reach a healthy state.

**Consequence of failure**: Pod is restarted (same as liveness failure).

### Liveness Probe

The liveness probe answers: "Is the application alive and not deadlocked?" When a liveness probe fails, Kubernetes kills and restarts the container. This is the nuclear option — it should only trigger for unrecoverable states like deadlocks, OOM conditions that didn't kill the process, or corrupted internal state.

**When to use**: When your application can enter a state from which it cannot recover without a restart (deadlocked goroutines, corrupted in-memory caches).

**Consequence of failure**: Container is killed and restarted.

**Common mistake**: Making the liveness probe too sensitive by checking dependencies (databases, external APIs). A liveness probe should only check the application's own health, not its dependencies.

### Readiness Probe

The readiness probe answers: "Is the application ready to receive traffic?" When a readiness probe fails, the pod is removed from the Service's endpoint slice — it stops receiving new traffic. When it succeeds, traffic resumes. Readiness probes can fail and recover repeatedly without restarting the container.

**When to use**: Always. Every pod that receives traffic should have a readiness probe.

**Consequence of failure**: Pod removed from load balancer rotation (no restart).

**Common mistake**: Not implementing a readiness probe, causing traffic to reach pods that are still initializing.

## Section 2: Probe Configuration Parameters

```yaml
# Complete probe parameter reference
containers:
  - name: app
    livenessProbe:
      # The probe mechanism (see Section 3)
      httpGet:
        path: /healthz/live
        port: 8080

      # Time to wait before first probe execution (use startupProbe instead)
      initialDelaySeconds: 0

      # How often to run the probe (default: 10s)
      periodSeconds: 10

      # Seconds after which the probe times out (default: 1s)
      timeoutSeconds: 5

      # Minimum consecutive successes for the probe to be considered successful
      # after a failure (default: 1, must be 1 for liveness and startup)
      successThreshold: 1

      # Minimum consecutive failures for the probe to be considered failed
      # (default: 3) — increase to prevent restarts from transient failures
      failureThreshold: 3

      # Configures the grace period for the kubelet between failing a probe
      # and restarting the container (Kubernetes 1.25+, alpha)
      terminationGracePeriodSeconds: 30

    readinessProbe:
      httpGet:
        path: /healthz/ready
        port: 8080
      initialDelaySeconds: 5    # Small delay before first check
      periodSeconds: 5          # Check more frequently for readiness
      timeoutSeconds: 3
      successThreshold: 1       # Remove from rotation immediately on success
      failureThreshold: 3       # Allow 3 consecutive failures before removing

    startupProbe:
      httpGet:
        path: /healthz/started
        port: 8080
      # Total startup window = failureThreshold * periodSeconds = 300s (5 minutes)
      failureThreshold: 30
      periodSeconds: 10
      timeoutSeconds: 5
```

## Section 3: Probe Mechanisms

### httpGet — Most Common

```yaml
# httpGet probe - most common for HTTP services
livenessProbe:
  httpGet:
    path: /healthz/live
    port: 8080
    scheme: HTTP  # or HTTPS
    httpHeaders:
      - name: Accept
        value: application/json
      - name: X-Health-Check
        value: liveness
```

### exec — Shell Commands

```yaml
# exec probe - runs a command inside the container
# Use only when httpGet or gRPC is not available
livenessProbe:
  exec:
    command:
      - /bin/sh
      - -c
      - |
        # Check if the process is running and its PID file is fresh
        PID_FILE=/var/run/myapp.pid
        if [ ! -f "$PID_FILE" ]; then exit 1; fi
        PID=$(cat "$PID_FILE")
        kill -0 "$PID" 2>/dev/null || exit 1
        # Check if PID file was updated recently (within 30 seconds)
        MTIME=$(stat -c %Y "$PID_FILE")
        NOW=$(date +%s)
        AGE=$((NOW - MTIME))
        [ "$AGE" -lt 30 ] || exit 1
```

**Performance warning**: `exec` probes spawn a new process for each check. On nodes running many pods, this creates significant process creation overhead. Prefer `httpGet` or `grpc` whenever possible.

### gRPC — For gRPC Services

```yaml
# gRPC probe (GA since Kubernetes 1.27)
# Requires grpc_health_probe package or native gRPC health checking protocol
livenessProbe:
  grpc:
    port: 9090
    service: ""  # Empty string = use the default service

readinessProbe:
  grpc:
    port: 9090
    service: "grpc.health.v1.Health"
```

```go
// Implementing gRPC health check in Go
// go.mod: google.golang.org/grpc/health

package main

import (
    "net"

    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
)

func setupGRPCHealthCheck(server *grpc.Server, deps *Dependencies) {
    healthSvc := health.NewServer()

    // Service starts as NOT_SERVING
    healthSvc.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)
    healthSvc.SetServingStatus("grpc.health.v1.Health",
        grpc_health_v1.HealthCheckResponse_NOT_SERVING)

    grpc_health_v1.RegisterHealthServer(server, healthSvc)

    // Background goroutine to update health status
    go func() {
        for {
            if deps.AllHealthy() {
                healthSvc.SetServingStatus("",
                    grpc_health_v1.HealthCheckResponse_SERVING)
            } else {
                healthSvc.SetServingStatus("",
                    grpc_health_v1.HealthCheckResponse_NOT_SERVING)
            }
            time.Sleep(5 * time.Second)
        }
    }()
}
```

## Section 4: Health Endpoint Implementation

### Go — Production Health Check Handler

```go
// health/handler.go
package health

import (
    "context"
    "encoding/json"
    "net/http"
    "sync"
    "time"

    "go.uber.org/zap"
)

// CheckFunc is a function that reports whether a dependency is healthy.
type CheckFunc func(ctx context.Context) error

// Server provides HTTP health check endpoints.
type Server struct {
    logger    *zap.Logger
    mu        sync.RWMutex
    checks    map[string]CheckFunc
    started   bool
    startedAt time.Time
}

// NewServer creates a new health check server.
func NewServer(logger *zap.Logger) *Server {
    return &Server{
        logger: logger,
        checks: make(map[string]CheckFunc),
    }
}

// Register adds a named health check function.
func (s *Server) Register(name string, check CheckFunc) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.checks[name] = check
}

// MarkStarted signals that the application has finished initializing.
func (s *Server) MarkStarted() {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.started = true
    s.startedAt = time.Now()
    s.logger.Info("Application marked as started")
}

// RegisterRoutes registers health check routes on the given mux.
func (s *Server) RegisterRoutes(mux *http.ServeMux) {
    // /healthz/started - startup probe
    mux.HandleFunc("/healthz/started", s.handleStarted)
    // /healthz/live - liveness probe
    mux.HandleFunc("/healthz/live", s.handleLive)
    // /healthz/ready - readiness probe
    mux.HandleFunc("/healthz/ready", s.handleReady)
    // /healthz - detailed health status (for operators, not probes)
    mux.HandleFunc("/healthz", s.handleDetailed)
}

// handleStarted checks whether the application has finished initializing.
// Only checks if the application has explicitly called MarkStarted().
func (s *Server) handleStarted(w http.ResponseWriter, r *http.Request) {
    s.mu.RLock()
    started := s.started
    s.mu.RUnlock()

    if !started {
        http.Error(w, "not started", http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("ok"))
}

// handleLive checks whether the application is alive.
// Intentionally DOES NOT check external dependencies —
// only checks application-internal health indicators.
func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
    // Liveness should only check things that indicate the process
    // is in an unrecoverable state. For most services, simply
    // responding to this endpoint means the process is alive.
    //
    // Only add checks here if you have a specific, observable way
    // to detect a deadlocked or corrupted state.
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("ok"))
}

// handleReady checks whether the application is ready for traffic.
// Runs all registered dependency checks.
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
    s.mu.RLock()
    started := s.started
    s.mu.RUnlock()

    if !started {
        http.Error(w, "not started", http.StatusServiceUnavailable)
        return
    }

    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    s.mu.RLock()
    checks := make(map[string]CheckFunc, len(s.checks))
    for k, v := range s.checks {
        checks[k] = v
    }
    s.mu.RUnlock()

    type result struct {
        name string
        err  error
    }

    results := make(chan result, len(checks))
    for name, check := range checks {
        name, check := name, check
        go func() {
            results <- result{name: name, err: check(ctx)}
        }()
    }

    failed := make(map[string]string)
    for range checks {
        r := <-results
        if r.err != nil {
            failed[r.name] = r.err.Error()
        }
    }

    if len(failed) > 0 {
        s.logger.Warn("Readiness check failed",
            zap.Any("failed_checks", failed))
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusServiceUnavailable)
        json.NewEncoder(w).Encode(map[string]interface{}{
            "status": "not ready",
            "failed": failed,
        })
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
}

// handleDetailed provides detailed health status with timing.
// Use this for operator debugging, not for Kubernetes probes.
func (s *Server) handleDetailed(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    type checkResult struct {
        Status   string `json:"status"`
        Error    string `json:"error,omitempty"`
        DurationMs int64 `json:"duration_ms"`
    }

    results := make(map[string]checkResult)

    s.mu.RLock()
    checks := make(map[string]CheckFunc, len(s.checks))
    for k, v := range s.checks {
        checks[k] = v
    }
    started := s.started
    startedAt := s.startedAt
    s.mu.RUnlock()

    allHealthy := true
    for name, check := range checks {
        start := time.Now()
        err := check(ctx)
        dur := time.Since(start).Milliseconds()

        if err != nil {
            allHealthy = false
            results[name] = checkResult{
                Status:     "unhealthy",
                Error:      err.Error(),
                DurationMs: dur,
            }
        } else {
            results[name] = checkResult{
                Status:     "healthy",
                DurationMs: dur,
            }
        }
    }

    status := "healthy"
    code := http.StatusOK
    if !allHealthy {
        status = "unhealthy"
        code = http.StatusServiceUnavailable
    }
    if !started {
        status = "starting"
        code = http.StatusServiceUnavailable
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(code)
    json.NewEncoder(w).Encode(map[string]interface{}{
        "status":     status,
        "started":    started,
        "started_at": startedAt,
        "uptime_s":   time.Since(startedAt).Seconds(),
        "checks":     results,
    })
}

// Example dependency checks
func NewDatabaseCheck(db *sql.DB) CheckFunc {
    return func(ctx context.Context) error {
        return db.PingContext(ctx)
    }
}

func NewRedisCheck(client redis.UniversalClient) CheckFunc {
    return func(ctx context.Context) error {
        return client.Ping(ctx).Err()
    }
}

func NewKafkaCheck(client sarama.Client) CheckFunc {
    return func(ctx context.Context) error {
        // Check that we can list broker metadata
        if err := client.RefreshMetadata(); err != nil {
            return fmt.Errorf("kafka broker unreachable: %w", err)
        }
        return nil
    }
}
```

## Section 5: initialDelaySeconds vs startupProbe

The old pattern of using `initialDelaySeconds` to give slow applications time to start has significant drawbacks:

**Problems with initialDelaySeconds**:
1. During the delay, the pod is marked as "not ready" but the liveness probe is not running. A truly failed startup is not detected until after the delay.
2. The delay is fixed. Fast environments (e.g., pre-warmed nodes) waste time. Slow environments (cold start, resource contention) may not have enough time.
3. It applies to all probes, preventing readiness from being checked while startup is still in progress.

**startupProbe is the correct solution**:

```yaml
# OLD PATTERN (avoid):
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 60  # Wait 60s before any liveness check
  periodSeconds: 10
  failureThreshold: 3

# NEW PATTERN (recommended):
startupProbe:
  httpGet:
    path: /healthz/started
    port: 8080
  # Allow up to 5 minutes for startup (30 checks * 10s)
  failureThreshold: 30
  periodSeconds: 10
  timeoutSeconds: 5
  # successThreshold must be 1 for startup probes

livenessProbe:
  httpGet:
    path: /healthz/live
    port: 8080
  # After startup succeeds, be sensitive for liveness
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
  # No initialDelaySeconds needed - startup probe handles this

readinessProbe:
  httpGet:
    path: /healthz/ready
    port: 8080
  # Check readiness frequently once startup succeeds
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
  successThreshold: 1
```

### Java Service Example (Slow Startup)

```yaml
# containers section for a Java service with 2-3 minute startup
containers:
  - name: java-api
    image: registry.internal.corp/java-api:v5.0.0
    ports:
      - containerPort: 8080
        name: http
      - containerPort: 8081
        name: management

    startupProbe:
      httpGet:
        path: /actuator/health/readiness
        port: 8081
      # Allow up to 10 minutes for startup (including DB migrations)
      failureThreshold: 60
      periodSeconds: 10
      timeoutSeconds: 5

    livenessProbe:
      httpGet:
        path: /actuator/health/liveness
        port: 8081
      # Spring Boot actuator separates liveness and readiness
      # Liveness: checks for heap OOM, deadlocked threads
      # Readiness: checks all dependencies
      periodSeconds: 15
      timeoutSeconds: 5
      failureThreshold: 3

    readinessProbe:
      httpGet:
        path: /actuator/health/readiness
        port: 8081
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3
      successThreshold: 1
```

## Section 6: Probe Impact on SLOs

### How Probes Affect Error Rates

A misconfigured probe creates a feedback loop that degrades SLOs:

1. Liveness probe fires during GC pause → Pod restarts
2. During restart, traffic to pod receives connection refused → HTTP 502s at load balancer
3. 502s are counted as errors → Error budget burns
4. If restart is frequent, error budget is exhausted before the incident is noticed

**Calculating acceptable restart frequency**:

```python
# SLO impact calculation
# Assume:
# - 99.9% availability SLO (43.8 minutes downtime per month budget)
# - Pod restart takes 30 seconds (kill + start + startup probe + graceful warm-up)
# - Service has 3 replicas (loss of 1 replica reduces capacity by 33%)
# - Load balancer detects pod removal via readiness probe in ~5s
# - Each unnecessary restart = ~35s of partial service degradation

# With k8s liveness failure at 1/hour (frequent):
restarts_per_month = 720  # 1/hour * 720 hours
downtime_per_restart_sec = 35
total_degradation_sec = restarts_per_month * downtime_per_restart_sec / 3
# = 720 * 35 / 3 = 8400 seconds = 140 minutes
# >> 43.8 minute monthly budget

# With well-tuned liveness (failure only on true deadlock, ~1/month):
restarts_per_month = 1
total_degradation_sec = 1 * 35 / 3
# = 11.7 seconds
# << 43.8 minute monthly budget
```

### failureThreshold Calibration

```bash
# Calculate appropriate failureThreshold for your GC/pause characteristics
# Monitor your application's maximum pause duration:

# For JVM applications, check GC pause times
kubectl logs -n production deployment/java-api | \
  grep "GC pause" | \
  awk '{print $NF}' | \
  sort -n | tail -20

# Example output showing max GC pause of 8 seconds:
# 1234ms
# 2100ms
# ...
# 8432ms

# Your liveness probe must survive the worst-case pause:
# failureThreshold * timeoutSeconds >= max_pause_seconds * safety_factor
# failureThreshold * 5 >= 8.4 * 2  (2x safety factor)
# failureThreshold >= 3.4 → use failureThreshold: 4
```

## Section 7: Production Probe Configurations

### High-Traffic API Service

```yaml
# Optimized for minimal downtime during rolling updates
containers:
  - name: api
    image: registry.internal.corp/api:v3.0.0
    ports:
      - containerPort: 8080

    startupProbe:
      httpGet:
        path: /healthz/started
        port: 8080
      failureThreshold: 12   # 12 * 5s = 60s max startup
      periodSeconds: 5
      timeoutSeconds: 3

    livenessProbe:
      httpGet:
        path: /healthz/live
        port: 8080
      # Only kill pod if it has been unresponsive for 60 seconds
      # (10s period * 3 retries * 2s timeout = ~60s total)
      periodSeconds: 10
      timeoutSeconds: 2
      failureThreshold: 6  # 60 seconds of unresponsiveness
      successThreshold: 1

    readinessProbe:
      httpGet:
        path: /healthz/ready
        port: 8080
      # Remove from rotation quickly on failure
      periodSeconds: 5
      timeoutSeconds: 3
      failureThreshold: 3  # 15 seconds before removal from rotation
      successThreshold: 1  # Add back to rotation immediately on recovery

    # Graceful shutdown: allow in-flight requests to complete
    lifecycle:
      preStop:
        exec:
          command:
            - /bin/sh
            - -c
            - sleep 5  # Give load balancer time to stop sending traffic
    terminationGracePeriodSeconds: 60
```

### Stateful Service (Database Connection)

```yaml
containers:
  - name: stateful-processor
    image: registry.internal.corp/processor:v2.0.0

    startupProbe:
      exec:
        command:
          - /app/health-check
          - --check=startup
      failureThreshold: 60    # Allow 10 minutes for startup + initial sync
      periodSeconds: 10
      timeoutSeconds: 5

    livenessProbe:
      httpGet:
        path: /healthz/live
        port: 8080
      # Conservative: only restart if clearly deadlocked
      periodSeconds: 20
      timeoutSeconds: 10
      failureThreshold: 3   # 60 seconds of unresponsiveness
      successThreshold: 1

    readinessProbe:
      httpGet:
        path: /healthz/ready
        port: 8080
      # Check DB connectivity, queue depth, cache warmth
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3
      successThreshold: 2  # Require 2 consecutive successes before adding back
      # (successThreshold: 2 prevents thrashing during DB connection instability)
```

## Section 8: Debugging Probe Failures

### Systematic Diagnosis

```bash
# Step 1: Get probe failure events
kubectl describe pod -n production <pod-name> | grep -A 10 "Events:"

# Common event messages:
# "Liveness probe failed: Get http://10.0.1.15:8080/healthz/live: dial tcp: i/o timeout"
# "Startup probe failed: connection refused"
# "Readiness probe failed: HTTP probe failed with statuscode: 503"

# Step 2: Check pod logs around the time of probe failure
kubectl logs -n production <pod-name> --since=5m | \
  grep -E "ERROR|WARN|panic|fatal|health"

# Step 3: Test the probe endpoint manually (from within the cluster)
kubectl run probe-debug --rm -it \
  --image=curlimages/curl:latest \
  --restart=Never \
  --namespace=production \
  -- curl -v http://<pod-ip>:8080/healthz/live

# Step 4: For exec probes, run the command manually in the container
kubectl exec -n production <pod-name> -- /bin/sh -c "your-health-check-command"

# Step 5: Check resource constraints (probes fail due to CPU throttling)
kubectl top pod -n production <pod-name>

# CPU throttling check: high cpu_throttled_seconds_total means probe timeouts
# may be caused by CPU limits being too low
kubectl get pod -n production <pod-name> -o jsonpath='{.spec.containers[0].resources}'

# Step 6: Check probe timing against observed startup time
kubectl get events -n production \
  --field-selector involvedObject.name=<pod-name> \
  --sort-by='.lastTimestamp' | \
  grep -E "Started|Pulled|Created|Liveness|Readiness|Startup"

# Step 7: Check for probe failures in Prometheus
# Query to see liveness probe failure rate:
# kube_pod_container_status_last_terminated_reason{reason="Error"} - but this is broad
# Better:
# increase(kube_pod_info{pod=~"my-service-.*"}[1h]) > 0  - pod restarts in last hour
```

### Probe Failure Due to CPU Throttling

A very common but subtle issue: the probe endpoint responds slowly because the container is CPU-throttled. The probe times out, but the container is actually healthy.

```bash
# Check CPU throttling via cgroup stats
kubectl exec -n production <pod-name> -- \
  cat /sys/fs/cgroup/cpu/cpu.stat 2>/dev/null || \
  cat /sys/fs/cgroup/cpu.stat

# Look for nr_throttled and throttled_time
# High throttled_time relative to nr_periods indicates CPU throttling

# Prometheus metric for CPU throttling:
# container_cpu_cfs_throttled_seconds_total
# rate(container_cpu_cfs_throttled_seconds_total{container="my-app"}[5m])
# High values (> 0.1) correlate with probe timeouts

# Fix: Increase CPU limits or reduce probe timeoutSeconds expectation
# Option 1: Increase timeoutSeconds (trade: slower failure detection)
# Option 2: Increase CPU limits (trade: higher cost)
# Option 3: Increase periodSeconds and failureThreshold (trade: slower restart)
```

### Prometheus Rules for Probe Health

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-probe-alerts
  namespace: monitoring
spec:
  groups:
    - name: kubernetes.probes
      rules:
        # Alert when pods are being restarted frequently (liveness probe issues)
        - alert: PodHighRestartRate
          expr: |
            rate(kube_pod_container_status_restarts_total[15m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is restarting frequently"
            description: "Container {{ $labels.container }} in {{ $labels.pod }} is restarting at {{ $value | humanize }} restarts/sec. Likely liveness probe misconfiguration or application crash."

        # Alert on pods that fail readiness for extended periods
        - alert: PodReadinessFailure
          expr: |
            kube_pod_status_ready{condition="false"} == 1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} not ready for 10 minutes"

        # Alert on startup probe failures (pods stuck starting)
        - alert: PodStartupProbeFailure
          expr: |
            kube_pod_container_status_waiting_reason{reason="ContainerCreating"} == 1
            or kube_pod_container_status_waiting_reason{reason="PodInitializing"} == 1
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Pod {{ $labels.pod }} stuck in {{ $labels.reason }} for 15 minutes"

        # Track probe failure impact on traffic (SLO correlation)
        - alert: ProbeFailuresImpactingTraffic
          expr: |
            (
              sum(kube_endpoint_address_not_ready{namespace=~"production|staging"}) by (namespace, endpoint)
              / sum(kube_endpoint_address_available{namespace=~"production|staging"}) by (namespace, endpoint)
            ) > 0.3
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "More than 30% of endpoints not ready in {{ $labels.namespace }}/{{ $labels.endpoint }}"
            description: "{{ $value | humanizePercentage }} of endpoints are not ready. Check readiness probe configuration."
```

## Section 9: Rolling Update Probe Interaction

Probes directly affect rolling update behavior. Understanding this interaction prevents update-induced outages.

```yaml
# Deployment strategy for zero-downtime rolling updates
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: production
spec:
  replicas: 6
  strategy:
    type: RollingUpdate
    rollingUpdate:
      # Allow only 1 pod to be unavailable at a time
      maxUnavailable: 1
      # Allow 1 extra pod above desired count during update
      maxSurge: 1
  template:
    spec:
      containers:
        - name: api
          image: registry.internal.corp/api:v4.0.0

          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            # The new pod must pass readiness before the old pod is terminated
            # minReadySeconds + readiness probe period determines how long this takes
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
            successThreshold: 1

          # Graceful shutdown for in-flight requests
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - |
                    # Signal the app to stop accepting new requests
                    kill -SIGTERM 1
                    # Wait for in-flight requests to complete (up to 30s)
                    sleep 30

      # Must be longer than preStop sleep + application shutdown time
      terminationGracePeriodSeconds: 60

  # minReadySeconds: After new pod passes readiness, wait this long before
  # proceeding with rolling update (prevents immediate restart on flaky readiness)
  minReadySeconds: 10
```

## Section 10: Probe Configuration Checklist

```bash
# Probe audit script for a namespace
#!/bin/bash
NAMESPACE=${1:-production}

echo "=== Probe Audit for namespace: $NAMESPACE ==="

kubectl get pods -n "$NAMESPACE" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.name}{"\t"}{.livenessProbe}{"\t"}{.readinessProbe}{"\t"}{.startupProbe}{"\n"}{end}{end}' | \
while IFS=$'\t' read pod container liveness readiness startup; do
    echo ""
    echo "Pod: $pod / Container: $container"

    # Check for missing readiness probe
    if [ "$readiness" = "null" ] || [ -z "$readiness" ]; then
        echo "  WARNING: No readiness probe configured"
    fi

    # Check for missing startup probe (if liveness has long initialDelaySeconds)
    if [ -n "$liveness" ] && [ "$liveness" != "null" ]; then
        INITIAL_DELAY=$(echo "$liveness" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('initialDelaySeconds',0))" 2>/dev/null)
        if [ "${INITIAL_DELAY:-0}" -gt 30 ]; then
            echo "  WARNING: liveness has initialDelaySeconds=$INITIAL_DELAY. Consider using startupProbe instead"
        fi
    fi

    # Check for exec probes (performance concern)
    if echo "$liveness $readiness $startup" | grep -q '"exec"'; then
        echo "  INFO: exec probe detected - consider switching to httpGet for better performance"
    fi
done
```

## Conclusion

The three-probe model in Kubernetes provides exactly the right abstractions for production reliability: startup probes handle the "is it initialized?" question, liveness handles "is it alive?", and readiness handles "is it ready for traffic?" The most common mistake is conflating these concerns — checking database connectivity in a liveness probe (which should restart the pod when the database is briefly unavailable) instead of the readiness probe (which should only remove the pod from rotation).

The second most impactful improvement is replacing `initialDelaySeconds` with startup probes. The fixed delay of `initialDelaySeconds` is a blunt instrument; startup probes provide adaptive, observable startup detection that handles variable startup times gracefully.

Implement the Prometheus alerting rules from Section 8 before changing probe configurations in production. The metrics will show you the baseline restart rate and readiness failure rate, allowing you to measure the impact of your tuning changes precisely.
