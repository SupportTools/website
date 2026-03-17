---
title: "Kubernetes Rolling Updates and Deployment Strategies: Zero-Downtime Production Patterns"
date: 2030-09-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Deployments", "Rolling Updates", "Zero Downtime", "Production", "GitOps", "SRE"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise deployment guide covering maxSurge and maxUnavailable tuning, readiness gate patterns, preStop hook drain configuration, progressive rollout validation, automated rollback triggers, and coordinating deployments across microservice dependencies."
more_link: "yes"
url: "/kubernetes-rolling-updates-deployment-strategies-zero-downtime/"
---

Kubernetes rolling updates are often described as "zero downtime by default," but in practice, production incidents caused by botched deployments remain one of the most common causes of service degradation. Default Deployment configuration is designed for correctness, not for the operational realities of enterprise services: long startup times, graceful shutdown requirements, pre-warming needs, load balancer propagation delays, and cascading dependencies between microservices. This guide covers every configurable knob in the rolling update path — `maxSurge`, `maxUnavailable`, readiness gate patterns, `preStop` hook drain configuration, progressive rollout validation with automated rollback, and the coordination patterns needed when deploying interdependent microservices simultaneously.

<!--more-->

## Understanding Kubernetes Rolling Update Mechanics

A rolling update replaces old Pods with new Pods in a controlled sequence. The Deployment controller drives this process through the ReplicaSet abstraction:

1. A new ReplicaSet is created with the updated Pod template.
2. New Pods are added to the new ReplicaSet (up to `maxSurge`).
3. As new Pods become Ready, old Pods are terminated (constrained by `maxUnavailable`).
4. The process repeats until all old Pods are replaced.

The invariant maintained throughout: at any moment, the number of Ready Pods is at least `(desiredReplicas - maxUnavailable)`.

### Rolling Update Parameters

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-api
  namespace: production
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2         # At most 12 Pods exist simultaneously
      maxUnavailable: 0   # At least 10 Pods are Ready at all times
```

**maxSurge**: The maximum number of Pods that can exist above the desired replica count during the update. Can be an absolute number or a percentage.

**maxUnavailable**: The maximum number of Pods that can be unavailable (not Ready) during the update. Can be absolute or percentage.

### Default Values and Their Problems

Kubernetes defaults to `maxSurge: 25%` and `maxUnavailable: 25%`. For a 10-replica Deployment:
- maxSurge = 3 (rounded up from 2.5)
- maxUnavailable = 2 (rounded down from 2.5)

This means during rollout, at most 8 Pods are required to be Ready while up to 13 exist. For latency-sensitive services at high utilization, losing 20-25% of capacity during a deployment can be catastrophic. Most production services should set `maxUnavailable: 0`.

## Configuring maxSurge and maxUnavailable for Production

### Conservative Configuration (High-Traffic Services)

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1         # Add one new Pod at a time
    maxUnavailable: 0   # Never remove a Pod until a replacement is Ready
```

This is the safest configuration. It guarantees full capacity throughout the deployment at the cost of requiring one extra Pod's worth of resources. With 10 replicas, the cluster must support 11 Pods temporarily.

**Trade-off**: Slower rollout. With maxSurge=1 and maxUnavailable=0, each cycle adds one Pod and removes one Pod. For a 10-replica Deployment with 3-minute startup time, the full rollout takes approximately 30 minutes.

### Aggressive Configuration (Fast Deployments, Non-Critical Services)

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 4           # 40% surge — faster rollout
    maxUnavailable: 2     # Allow 20% capacity reduction
```

Appropriate for staging environments, non-critical batch processors, or stateless services with fast startup times (under 30 seconds) and low utilization.

### Percentage-Based Configuration

```yaml
strategy:
  rollingUpdate:
    maxSurge: "30%"
    maxUnavailable: "0%"
```

Percentage values scale with the replica count — useful for Deployments that are frequently HPA-scaled.

**Note**: `maxUnavailable: "0%"` rounds down to 0 — the cluster maintains full capacity. `maxSurge: "30%"` rounds up — for 10 replicas, this allows 3 additional Pods (up to 13 total).

## Readiness Probes: The Foundation of Zero-Downtime Updates

The rolling update controller considers a Pod "Ready" only when its readiness probe returns success. A misconfigured readiness probe is the most common cause of "zero-downtime deployment" failures.

### Application-Level Readiness vs Infrastructure Readiness

```yaml
containers:
- name: checkout-api
  readinessProbe:
    httpGet:
      path: /health/ready      # Application-defined readiness endpoint
      port: 8080
    initialDelaySeconds: 10    # Wait before first probe (seconds to start HTTP server)
    periodSeconds: 5           # Probe every 5 seconds
    failureThreshold: 3        # Require 3 failures before marking Not Ready
    successThreshold: 1        # Single success restores Ready state
    timeoutSeconds: 3          # Probe timeout
  livenessProbe:
    httpGet:
      path: /health/live       # Separate liveness check (restart on failure)
      port: 8080
    initialDelaySeconds: 30
    periodSeconds: 10
    failureThreshold: 3
    timeoutSeconds: 5
  startupProbe:
    httpGet:
      path: /health/live
      port: 8080
    initialDelaySeconds: 0
    periodSeconds: 5
    failureThreshold: 30       # 30 × 5s = 150s startup window
    timeoutSeconds: 3
```

### Readiness Endpoint Implementation

The readiness endpoint must reflect the application's actual ability to serve traffic, not just process liveness:

```go
// internal/health/handler.go
package health

import (
    "context"
    "encoding/json"
    "net/http"
    "sync/atomic"
    "time"
)

type Handler struct {
    db        DatabasePinger
    cache     CachePinger
    ready     atomic.Bool      // Application-controlled readiness gate
    startTime time.Time
}

func NewHandler(db DatabasePinger, cache CachePinger) *Handler {
    h := &Handler{
        db:        db,
        cache:     cache,
        startTime: time.Now(),
    }
    return h
}

// SetReady allows the application to explicitly control readiness.
// Call SetReady(true) after warm-up tasks complete.
func (h *Handler) SetReady(ready bool) {
    h.ready.Store(ready)
}

func (h *Handler) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()

    checks := map[string]string{}
    healthy := true

    // Application gate — not ready until SetReady(true) is called
    if !h.ready.Load() {
        checks["app"] = "not_ready"
        healthy = false
    } else {
        checks["app"] = "ok"
    }

    // Database connectivity check
    if err := h.db.Ping(ctx); err != nil {
        checks["database"] = "failed: " + err.Error()
        healthy = false
    } else {
        checks["database"] = "ok"
    }

    // Cache connectivity check (non-blocking — degraded is still ready)
    if err := h.cache.Ping(ctx); err != nil {
        checks["cache"] = "degraded: " + err.Error()
        // Cache failure does not block readiness — app can serve without it
    } else {
        checks["cache"] = "ok"
    }

    status := http.StatusOK
    if !healthy {
        status = http.StatusServiceUnavailable
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(map[string]interface{}{
        "status": map[bool]string{true: "ready", false: "not_ready"}[healthy],
        "checks": checks,
        "uptime": time.Since(h.startTime).String(),
    })
}
```

### Startup Sequence with Explicit Readiness

```go
// cmd/server/main.go
func main() {
    logger := slog.Default()
    db := mustConnectDB()
    cache := mustConnectCache()
    healthHandler := health.NewHandler(db, cache)

    // Start HTTP server immediately (readiness probe will return 503 until ready)
    server := &http.Server{
        Addr:    ":8080",
        Handler: setupRouter(healthHandler),
    }
    go server.ListenAndServe()

    // Perform warm-up tasks
    logger.Info("warming up caches...")
    if err := cache.WarmCriticalKeys(context.Background()); err != nil {
        logger.Warn("cache warm-up failed", "error", err)
        // Non-fatal — proceed to ready state
    }

    logger.Info("running startup migrations check...")
    if err := db.ValidateMigrations(context.Background()); err != nil {
        logger.Error("migration check failed", "error", err)
        os.Exit(1)
    }

    // Signal ready to Kubernetes
    healthHandler.SetReady(true)
    logger.Info("server ready")

    // Wait for shutdown signal
    waitForShutdown(server, healthHandler, logger)
}
```

## ReadinessGates: Extending the Ready Condition

Kubernetes Pod ReadinessGates allow external controllers to gate a Pod's `Ready` condition on arbitrary conditions beyond the standard container-level readiness probes. This is essential for integrating with load balancers that have propagation delays.

### AWS ALB Target Group Readiness Gate

When using the AWS Load Balancer Controller, configure ReadinessGates to prevent traffic from being sent to a Pod before the load balancer has registered and health-checked the target:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-api
spec:
  template:
    spec:
      readinessGates:
      - conditionType: "target-health.alb.ingress.k8s.aws/checkout-api-ingress_checkout-api_80"
      containers:
      - name: checkout-api
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          periodSeconds: 5
          failureThreshold: 3
```

With this configuration, the rolling update controller holds old Pods alive until new Pods are both application-ready AND registered as healthy in the ALB target group — preventing the brief window where traffic hits a Pod not yet in the load balancer.

### Istio Sidecar Readiness Gate

For Istio service mesh, the Envoy sidecar must be ready before application traffic flows. Configure the Istio-injected readiness gate:

```yaml
spec:
  template:
    metadata:
      annotations:
        proxy.istio.io/config: |
          holdApplicationUntilProxyStarts: true
    spec:
      readinessGates:
      - conditionType: istio.io/proxyReady
```

## preStop Hook: Graceful Shutdown

The `preStop` hook executes before Kubernetes sends `SIGTERM` to the container. It provides time for the application to drain in-flight requests and deregister from service discovery before the termination signal arrives.

### Load Balancer Drain Pattern

```yaml
containers:
- name: checkout-api
  lifecycle:
    preStop:
      exec:
        command:
        - /bin/sh
        - -c
        - sleep 15   # Wait for load balancer to stop sending new connections
```

The 15-second sleep addresses the race condition between:
1. Kubernetes removing the Pod from the Endpoints object (immediate).
2. kube-proxy propagating the change to iptables/IPVS (up to several seconds).
3. The load balancer removing the Pod from its target group (up to 30 seconds for ALB).

During this window, new connections may still arrive at the Pod. The `preStop` sleep keeps the process alive and accepting connections while the load balancer drains.

### Application-Aware Graceful Shutdown

For Go HTTP servers:

```go
func waitForShutdown(srv *http.Server, healthHandler *health.Handler, logger *slog.Logger) {
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    <-sigCh

    // Step 1: Mark not ready — stop receiving new connections via readiness probe
    healthHandler.SetReady(false)
    logger.Info("received shutdown signal, marked not ready")

    // Step 2: Wait for load balancer propagation (supplement to preStop hook)
    // The preStop hook provides the primary drain window.
    // This sleep handles cases where the hook was not executed.
    time.Sleep(5 * time.Second)

    // Step 3: Drain in-flight requests with a deadline
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(ctx); err != nil {
        logger.Error("graceful shutdown failed", "error", err)
    } else {
        logger.Info("graceful shutdown complete")
    }
}
```

### terminationGracePeriodSeconds

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 60   # Total time allowed from SIGTERM to SIGKILL
      containers:
      - name: checkout-api
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 15"]
```

The total shutdown sequence budget is `terminationGracePeriodSeconds`. Ensure:
- `preStop` duration + application drain time < `terminationGracePeriodSeconds`.
- For `preStop: sleep 15` + 30-second request drain: set `terminationGracePeriodSeconds: 60` minimum.

## Progressive Rollout Validation

Before completing a full rolling update, validate that new Pods are healthy using deployment validation gates.

### Deployment Pause and Resume

```bash
# Deploy and immediately pause after the first wave of new Pods
kubectl rollout pause deployment/checkout-api -n production

# Monitor new Pod health (manual inspection)
kubectl get pods -n production -l app=checkout-api \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount'

# Check error rates in new Pods (using stern or kubectl logs)
stern -n production checkout-api --since 2m | grep -c "level=error"

# If healthy, resume the rollout
kubectl rollout resume deployment/checkout-api -n production

# If unhealthy, rollback immediately
kubectl rollout undo deployment/checkout-api -n production
```

### Automated Rollback with flagger

Flagger extends Kubernetes deployments with canary analysis, automatically promoting or rolling back based on metrics:

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: checkout-api
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-api

  progressDeadlineSeconds: 600   # Give up and roll back after 10 minutes

  service:
    port: 80
    targetPort: 8080
    gateways:
    - istio-ingressgateway.istio-system.svc.cluster.local
    hosts:
    - checkout-api.production.svc.cluster.local

  analysis:
    interval: 1m           # Check metrics every minute
    threshold: 5           # Fail after 5 metric failures
    maxWeight: 50          # Cap canary traffic at 50%
    stepWeight: 10         # Increment by 10% per interval

    metrics:
    - name: request-success-rate
      thresholdRange:
        min: 99            # Rollback if success rate drops below 99%
      interval: 1m

    - name: request-duration
      thresholdRange:
        max: 500           # Rollback if P99 latency exceeds 500ms
      interval: 1m

    webhooks:
    - name: load-test
      type: rollout
      url: http://flagger-loadtester.test/
      timeout: 5s
      metadata:
        cmd: "hey -z 1m -q 10 -c 2 http://checkout-api-canary.production/"
```

### Argo Rollouts (Alternative to Flagger)

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: checkout-api
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: checkout-api
  template:
    metadata:
      labels:
        app: checkout-api
    spec:
      containers:
      - name: checkout-api
        image: example/checkout-api:v2.1.0
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          periodSeconds: 5
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 15"]
      terminationGracePeriodSeconds: 60

  strategy:
    canary:
      canaryService: checkout-api-canary
      stableService: checkout-api-stable
      trafficRouting:
        istio:
          virtualService:
            name: checkout-api-vsvc
          destinationRule:
            name: checkout-api-destrule
            canarySubsetName: canary
            stableSubsetName: stable
      steps:
      - setWeight: 10          # 10% canary traffic
      - pause: {duration: 5m}  # Observe for 5 minutes
      - setWeight: 25
      - pause: {duration: 5m}
      - setWeight: 50
      - pause: {duration: 10m}
      - setWeight: 100         # Full rollout

      analysis:
        templates:
        - templateName: checkout-api-success-rate
        startingStep: 2        # Start analysis after first pause
        args:
        - name: service-name
          value: checkout-api-canary
```

## Automated Rollback Triggers

### Deployment Monitoring with Automatic Rollback

```bash
#!/bin/bash
# monitor-deployment.sh — watch a deployment and roll back if it fails
set -euo pipefail

NAMESPACE="${1:-production}"
DEPLOYMENT="${2:-checkout-api}"
TIMEOUT="${3:-300}"  # seconds

log() {
    echo "[$(date -Iseconds)] $*"
}

# Record current revision
PREVIOUS_REVISION=$(kubectl rollout history deployment/${DEPLOYMENT} -n ${NAMESPACE} \
  | tail -2 | head -1 | awk '{print $1}')

log "Monitoring rollout of ${DEPLOYMENT} in ${NAMESPACE}"
log "Previous revision: ${PREVIOUS_REVISION}"

# Watch rollout with timeout
if ! kubectl rollout status deployment/${DEPLOYMENT} -n ${NAMESPACE} --timeout=${TIMEOUT}s; then
    log "ROLLOUT FAILED — initiating rollback to revision ${PREVIOUS_REVISION}"
    kubectl rollout undo deployment/${DEPLOYMENT} -n ${NAMESPACE} --to-revision=${PREVIOUS_REVISION}
    kubectl rollout status deployment/${DEPLOYMENT} -n ${NAMESPACE} --timeout=120s
    log "Rollback complete"
    exit 1
fi

log "Rollout SUCCEEDED"

# Post-rollout validation: check error rate for 2 minutes
log "Running post-rollout validation..."
sleep 30

POD_NAME=$(kubectl get pods -n ${NAMESPACE} -l app=${DEPLOYMENT} \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
if [ -z "${POD_NAME}" ]; then
    log "ERROR: No pods found for ${DEPLOYMENT}"
    exit 1
fi

RESTARTS=$(kubectl get pod ${POD_NAME} -n ${NAMESPACE} \
  -o jsonpath='{.status.containerStatuses[0].restartCount}')
if [ "${RESTARTS}" -gt "2" ]; then
    log "POST-ROLLOUT VALIDATION FAILED: ${POD_NAME} has ${RESTARTS} restarts"
    kubectl rollout undo deployment/${DEPLOYMENT} -n ${NAMESPACE}
    exit 1
fi

log "Post-rollout validation PASSED (${RESTARTS} restarts)"
```

### Kubernetes Deployment Conditions

```bash
# Check deployment conditions for automated rollback decisions
kubectl get deployment checkout-api -n production -o json | jq '
  .status.conditions[] |
  select(.type == "Progressing" or .type == "Available") |
  {type, status, reason, message}
'
```

Key conditions:
- `Progressing: True, reason: NewReplicaSetAvailable` — rollout succeeded.
- `Progressing: False, reason: ProgressDeadlineExceeded` — rollout timed out.
- `Available: False` — insufficient ready Pods.

## Coordinating Deployments Across Microservice Dependencies

### Deployment Ordering for Breaking Changes

When a schema change or API contract change requires coordinated deployment:

**Pattern 1: Expand/Contract (most common)**

1. Deploy service A with both old and new API versions (backward + forward compatible).
2. Deploy service B (consumer of A) to use the new API version.
3. Deploy service A again removing the old API version.

No coordination of timing is required — both services can be independently deployed as long as A's expanded version is in production before B is updated.

**Pattern 2: Synchronized Wave Deployment**

For changes where both services must update simultaneously:

```bash
#!/bin/bash
# synchronized-deploy.sh

NAMESPACE="production"

# Apply both Deployments simultaneously
kubectl apply -f checkout-api-v2.yaml -f payment-service-v2.yaml -n ${NAMESPACE}

# Monitor both rollouts in parallel
kubectl rollout status deployment/checkout-api -n ${NAMESPACE} &
PID1=$!
kubectl rollout status deployment/payment-service -n ${NAMESPACE} &
PID2=$!

wait $PID1 || FAILED=1
wait $PID2 || FAILED=1

if [ "${FAILED:-0}" -eq 1 ]; then
    echo "Synchronized deployment FAILED — rolling back both services"
    kubectl rollout undo deployment/checkout-api -n ${NAMESPACE}
    kubectl rollout undo deployment/payment-service -n ${NAMESPACE}
    exit 1
fi

echo "Synchronized deployment SUCCEEDED"
```

### GitOps Wave-Based Deployment with Argo CD

```yaml
# Application set with sync waves for ordered deployment
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: production-microservices
spec:
  generators:
  - list:
      elements:
      - service: database-migrations
        wave: "-10"    # Run before all other services
      - service: api-gateway
        wave: "0"
      - service: checkout-api
        wave: "5"
      - service: payment-service
        wave: "5"      # Deploys in parallel with checkout-api (same wave)
      - service: notification-service
        wave: "10"     # Deploys after checkout-api and payment-service
  template:
    metadata:
      name: '{{service}}'
      annotations:
        argocd.argoproj.io/sync-wave: '{{wave}}'
    spec:
      project: production
      source:
        repoURL: https://github.com/example/gitops
        path: 'apps/{{service}}/overlays/production'
        targetRevision: HEAD
      destination:
        server: https://kubernetes.default.svc
        namespace: production
      syncPolicy:
        automated:
          prune: true
          selfHeal: false
        syncOptions:
        - RespectIgnoreDifferences=true
        retry:
          limit: 3
          backoff:
            duration: 30s
            factor: 2
            maxDuration: 5m
```

## Rollout Observability

### Prometheus Deployment Metrics

```yaml
# Key metrics for monitoring rolling updates
groups:
- name: kubernetes-deployments
  rules:
  - alert: DeploymentRolloutStuck
    expr: |
      kube_deployment_status_observed_generation{namespace="production"} !=
      kube_deployment_metadata_generation{namespace="production"}
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "Deployment {{ $labels.deployment }} rollout stuck"

  - alert: DeploymentReplicasMismatch
    expr: |
      kube_deployment_spec_replicas{namespace="production"} !=
      kube_deployment_status_ready_replicas{namespace="production"}
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Deployment {{ $labels.deployment }} has {{ $value }} unavailable replicas"

  - alert: DeploymentProgressDeadlineExceeded
    expr: |
      kube_deployment_status_condition{condition="Progressing",status="false",
        namespace="production"} == 1
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "Deployment {{ $labels.deployment }} progress deadline exceeded"
```

### Watching Rollouts in Real Time

```bash
# Real-time rollout status with kubectl
watch -n 2 'kubectl rollout status deployment/checkout-api -n production && \
  kubectl get pods -n production -l app=checkout-api \
  -o custom-columns="NAME:.metadata.name,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp"'

# Use stern for streaming logs from new Pods during rollout
stern -n production checkout-api --since 5m -o json | jq -r '.message'
```

## Complete Production Deployment Spec

Assembling all patterns into a production-ready Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-api
  namespace: production
  annotations:
    deployment.kubernetes.io/change-cause: "Release v2.1.0: Add buy-now-pay-later support"
spec:
  replicas: 10
  revisionHistoryLimit: 5   # Keep 5 old ReplicaSets for rollback

  selector:
    matchLabels:
      app: checkout-api

  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2           # Allow 2 extra Pods during rollout
      maxUnavailable: 0     # Never reduce capacity

  minReadySeconds: 30       # Pod must be Ready for 30s before counted as Available
                            # Prevents "available" counts while app is warming up

  template:
    metadata:
      labels:
        app: checkout-api
        version: v2.1.0
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"

    spec:
      terminationGracePeriodSeconds: 90

      # Ensure graceful shutdown before SIGTERM
      containers:
      - name: checkout-api
        image: ghcr.io/example/checkout-api:v2.1.0
        imagePullPolicy: IfNotPresent

        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: metrics

        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace

        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            memory: 1Gi    # CPU limit intentionally omitted (causes throttling)

        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 20"]

        startupProbe:
          httpGet:
            path: /health/live
            port: 8080
          failureThreshold: 30
          periodSeconds: 5

        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3
          successThreshold: 1
          timeoutSeconds: 3

        livenessProbe:
          httpGet:
            path: /health/live
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 15
          failureThreshold: 3
          timeoutSeconds: 5

        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 65532
          capabilities:
            drop: [ALL]

        volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: config
          mountPath: /app/config
          readOnly: true

      # ReadinessGate for ALB target group health check propagation
      readinessGates:
      - conditionType: "target-health.alb.ingress.k8s.aws/checkout-ingress_checkout-api_80"

      volumes:
      - name: tmp
        emptyDir: {}
      - name: config
        configMap:
          name: checkout-api-config

      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: checkout-api
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: checkout-api

      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: checkout-api
              topologyKey: kubernetes.io/hostname
```

## Summary

Zero-downtime Kubernetes deployments require deliberate configuration across multiple interacting systems. The core principles are: set `maxUnavailable: 0` for any service where capacity reduction during deployment is not acceptable; configure readiness probes that reflect actual application readiness (including warm-up state), not just process liveness; use `preStop` hooks with sleep durations that exceed the maximum load balancer propagation latency; set `terminationGracePeriodSeconds` to accommodate `preStop` duration plus maximum request drain time; and apply `minReadySeconds` to prevent prematurely counting starting Pods as fully available. For high-risk deployments, progressive rollout tools like Flagger or Argo Rollouts provide automated metric-based promotion and rollback that eliminates the human bottleneck in deployment validation. Coordinating across service dependencies requires expand/contract API patterns or wave-based GitOps synchronization to eliminate the coordination failures that cause cascading deployment incidents.
