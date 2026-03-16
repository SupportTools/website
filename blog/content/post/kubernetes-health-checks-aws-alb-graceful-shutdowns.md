---
title: "Kubernetes Health Checks with AWS ALB: Graceful Shutdowns and Auto-scaling"
date: 2026-08-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "AWS", "ALB", "Health Checks", "Auto-scaling", "Production"]
categories: ["Kubernetes", "AWS", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing proper health checks, graceful shutdowns, and auto-scaling strategies with AWS Application Load Balancer and Kubernetes, including production patterns for zero-downtime deployments and connection draining."
more_link: "yes"
url: "/kubernetes-health-checks-aws-alb-graceful-shutdowns/"
---

"Why are users seeing 502 errors during deployments?" This question triggered a deep investigation into our Kubernetes health check implementation with AWS Application Load Balancer. What we discovered was a complex dance between Kubernetes pod lifecycle, ALB target group health checks, and application shutdown behavior that, when misaligned, creates windows of unavailability during routine operations.

This post details our journey from sporadic 502 errors during every deployment to achieving true zero-downtime updates, including the production-tested patterns, gotchas, and monitoring strategies that make it all work reliably at scale.

<!--more-->

## The Problem: 502 Errors During Deployments

### Initial Symptoms

Our monitoring showed a consistent pattern:
- Every deployment triggered a spike in 502 Bad Gateway errors
- Errors lasted 5-15 seconds during pod rollout
- Some user sessions were abruptly terminated
- The error rate increased with deployment frequency

A typical deployment looked like this:

```bash
kubectl rollout status deployment api-server -n production

Waiting for deployment "api-server" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "api-server" rollout to finish: 2 out of 3 new replicas have been updated...
Waiting for deployment "api-server" rollout to finish: 1 old replicas are pending termination...
Waiting for deployment "api-server" rollout to finish: 1 old replicas are pending termination...
deployment "api-server" successfully rolled out
```

During the "old replicas pending termination" phase, users experienced errors. Our Prometheus metrics showed:

```promql
rate(http_requests_total{status="502"}[1m]) during deployment
# Spike from baseline 0/sec to 45 errors/sec
```

### Root Cause Investigation

We started by examining the timing of events during a deployment:

```bash
# Terminal 1: Watch pod status
kubectl get pods -n production -l app=api-server -w

# Terminal 2: Watch ALB target health
aws elbv2 describe-target-health --target-group-arn $TG_ARN --query 'TargetHealthDescriptions[*].[Target.Id,TargetHealth.State]' --output table
```

The logs revealed a critical timing issue:

```
T+0s:    New pod created
T+2s:    Pod becomes "Running"
T+2s:    Readiness probe succeeds (immediately)
T+2s:    ALB begins health checking (every 5s)
T+5s:    Old pod receives SIGTERM
T+5s:    Old pod immediately begins shutdown
T+6s:    ALB marks old pod "unhealthy" (first failed check)
T+11s:   ALB marks old pod "draining" (second failed check)
T+11s:   ALB stops sending new connections to old pod
T+305s:  ALB finishes connection draining (300s default)
T+305s:  Old pod deleted
```

The problem: Between T+5s (SIGTERM) and T+11s (ALB stops routing), the old pod was already shutting down but still receiving traffic, resulting in 502 errors.

## Understanding the Components

### Kubernetes Pod Lifecycle

When a pod is terminated, Kubernetes follows this sequence:

```yaml
# Pod Lifecycle During Termination
1. Pod marked for deletion (deletionTimestamp set)
2. Pod removed from endpoints
3. PreStop hook executed (if defined)
4. SIGTERM sent to main container process
5. Grace period timer starts (default: 30s)
6. If still running after grace period, SIGKILL sent
7. Pod removed from API
```

The key insight: **Steps 2 and 3 happen simultaneously**, not sequentially.

### AWS ALB Health Checks

ALB target group health checks have several configuration parameters:

```json
{
  "HealthCheckEnabled": true,
  "HealthCheckIntervalSeconds": 5,
  "HealthCheckPath": "/health",
  "HealthCheckProtocol": "HTTP",
  "HealthCheckTimeoutSeconds": 2,
  "HealthyThresholdCount": 2,
  "UnhealthyThresholdCount": 2,
  "Matcher": {
    "HttpCode": "200"
  }
}
```

Critical timing calculation:
```
Time to mark target unhealthy = HealthCheckIntervalSeconds × UnhealthyThresholdCount
                                = 5s × 2 = 10 seconds minimum
```

### The Timing Gap

The fundamental issue:

```
Kubernetes endpoint removal:     ~1-2 seconds
ALB health check failure:        ~10 seconds (minimum)
Gap:                             ~8-9 seconds of misrouted traffic
```

During this gap, ALB thinks the pod is healthy but Kubernetes has already begun shutdown.

## Solution Architecture

### 1. PreStop Hook Implementation

The PreStop hook introduces a delay before the application begins shutdown:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Critical: Never reduce capacity during rollout
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      terminationGracePeriodSeconds: 60  # Increased from default 30s

      containers:
      - name: api-server
        image: api-server:v2.3.1
        ports:
        - containerPort: 8080
          name: http
          protocol: TCP

        # Lifecycle hooks
        lifecycle:
          preStop:
            exec:
              command:
                - /bin/sh
                - -c
                - |
                  # Wait for ALB to mark target unhealthy and drain connections
                  echo "PreStop: Sleeping for 15 seconds to allow connection draining..."
                  sleep 15

                  # Signal application to stop accepting new connections
                  echo "PreStop: Sending graceful shutdown signal..."
                  kill -TERM 1

                  # Wait for existing requests to complete
                  echo "PreStop: Waiting for existing requests to complete..."
                  sleep 10

        # Health check endpoints
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 2
          successThreshold: 1
          failureThreshold: 2

        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
          timeoutSeconds: 2
          failureThreshold: 3

        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "1000m"
            memory: "1Gi"
```

### 2. Application-Level Graceful Shutdown

The application must handle SIGTERM gracefully:

```go
package main

import (
    "context"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "sync/atomic"
    "syscall"
    "time"
)

type Server struct {
    http.Server
    ready   int32  // Atomic: 0 = not ready, 1 = ready
    healthy int32  // Atomic: 0 = not healthy, 1 = healthy
}

func NewServer(addr string, handler http.Handler) *Server {
    srv := &Server{
        Server: http.Server{
            Addr:         addr,
            Handler:      handler,
            ReadTimeout:  10 * time.Second,
            WriteTimeout: 10 * time.Second,
            IdleTimeout:  120 * time.Second,
        },
    }

    // Add health check endpoints
    mux := http.NewServeMux()
    mux.HandleFunc("/health", srv.healthHandler)
    mux.HandleFunc("/ready", srv.readyHandler)
    mux.Handle("/", handler)

    srv.Handler = mux
    return srv
}

func (s *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
    // Liveness probe - only fails if application is completely broken
    if atomic.LoadInt32(&s.healthy) == 1 {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("healthy"))
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte("unhealthy"))
    }
}

func (s *Server) readyHandler(w http.ResponseWriter, r *http.Request) {
    // Readiness probe - fails during startup and shutdown
    if atomic.LoadInt32(&s.ready) == 1 {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("ready"))
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte("not ready"))
    }
}

func (s *Server) MarkReady() {
    atomic.StoreInt32(&s.ready, 1)
    atomic.StoreInt32(&s.healthy, 1)
    log.Println("Server marked as ready and healthy")
}

func (s *Server) MarkNotReady() {
    atomic.StoreInt32(&s.ready, 0)
    log.Println("Server marked as not ready (shutting down)")
}

func (s *Server) GracefulShutdown(timeout time.Duration) error {
    // Mark as not ready immediately
    s.MarkNotReady()

    // Allow time for load balancer to detect and stop sending traffic
    log.Printf("Waiting %v for load balancer to drain connections...", timeout)
    time.Sleep(timeout)

    // Create shutdown context
    ctx, cancel := context.WithTimeout(context.Background(), timeout)
    defer cancel()

    // Attempt graceful shutdown
    log.Println("Beginning graceful shutdown...")
    if err := s.Shutdown(ctx); err != nil {
        log.Printf("Graceful shutdown failed: %v", err)
        return err
    }

    log.Println("Graceful shutdown completed")
    return nil
}

func main() {
    // Create server
    handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Simulate some processing time
        time.Sleep(100 * time.Millisecond)
        fmt.Fprintf(w, "Request processed successfully\n")
    })

    srv := NewServer(":8080", handler)

    // Start server in goroutine
    go func() {
        log.Printf("Server starting on %s", srv.Addr)
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("Server failed: %v", err)
        }
    }()

    // Application initialization (database connections, caches, etc.)
    log.Println("Performing initialization...")
    time.Sleep(2 * time.Second)

    // Mark server as ready to receive traffic
    srv.MarkReady()

    // Wait for interrupt signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

    sig := <-sigChan
    log.Printf("Received signal: %v", sig)

    // Perform graceful shutdown
    if err := srv.GracefulShutdown(15 * time.Second); err != nil {
        log.Printf("Shutdown error: %v", err)
        os.Exit(1)
    }

    log.Println("Server stopped")
}
```

### 3. ALB Target Group Configuration

Optimize ALB target group settings for faster health check response:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-server
  namespace: production
  annotations:
    # AWS Load Balancer Controller annotations
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"

    # Health check configuration
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-path: "/health"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol: "HTTP"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-interval: "5"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-timeout: "2"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-healthy-threshold: "2"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-unhealthy-threshold: "2"

    # Connection draining
    service.beta.kubernetes.io/aws-load-balancer-target-group-attributes: |
      deregistration_delay.timeout_seconds=30,
      deregistration_delay.connection_termination.enabled=true

spec:
  type: LoadBalancer
  selector:
    app: api-server
  ports:
  - port: 80
    targetPort: 8080
    protocol: TCP
    name: http
```

Terraform configuration for explicit target group management:

```hcl
resource "aws_lb_target_group" "api_server" {
  name        = "api-server-prod"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 2
    timeout             = 2
    interval            = 5
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
  }

  deregistration_delay = 30

  # Connection draining attributes
  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "api-server-prod"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}

# Target group attributes for connection draining
resource "aws_lb_target_group_attachment" "api_server" {
  for_each = toset(var.pod_ips)

  target_group_arn = aws_lb_target_group.api_server.arn
  target_id        = each.value
  port             = 8080

  lifecycle {
    create_before_destroy = true
  }
}
```

## Advanced Patterns

### 1. Connection Draining with Metrics

Implement application metrics to monitor active connections during shutdown:

```go
package main

import (
    "context"
    "log"
    "net/http"
    "sync"
    "sync/atomic"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    activeConnections = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "http_active_connections",
        Help: "Number of active HTTP connections",
    })

    requestsInFlight = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "http_requests_in_flight",
        Help: "Number of HTTP requests currently being processed",
    })

    shutdownDuration = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "http_shutdown_duration_seconds",
        Help:    "Time taken for graceful shutdown",
        Buckets: []float64{1, 5, 10, 15, 20, 30, 45, 60},
    })
)

type InstrumentedServer struct {
    *http.Server
    activeReqs int64
    wg         sync.WaitGroup
}

func NewInstrumentedServer(addr string) *InstrumentedServer {
    srv := &InstrumentedServer{
        Server: &http.Server{
            Addr: addr,
        },
    }

    mux := http.NewServeMux()

    // Metrics endpoint
    mux.Handle("/metrics", promhttp.Handler())

    // Health endpoints
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("healthy"))
    })

    mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("ready"))
    })

    // Main handler with request tracking
    mux.HandleFunc("/", srv.instrumentedHandler)

    // Connection state tracking
    srv.Server.ConnState = srv.connStateHandler

    srv.Handler = mux
    return srv
}

func (s *InstrumentedServer) instrumentedHandler(w http.ResponseWriter, r *http.Request) {
    // Track request start
    s.wg.Add(1)
    atomic.AddInt64(&s.activeReqs, 1)
    requestsInFlight.Inc()

    defer func() {
        // Track request completion
        atomic.AddInt64(&s.activeReqs, -1)
        requestsInFlight.Dec()
        s.wg.Done()
    }()

    // Process request
    time.Sleep(100 * time.Millisecond) // Simulate work
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

func (s *InstrumentedServer) connStateHandler(conn net.Conn, state http.ConnState) {
    switch state {
    case http.StateNew:
        activeConnections.Inc()
    case http.StateClosed, http.StateHijacked:
        activeConnections.Dec()
    }
}

func (s *InstrumentedServer) GracefulShutdown(maxWait time.Duration) error {
    startTime := time.Now()
    defer func() {
        duration := time.Since(startTime).Seconds()
        shutdownDuration.Observe(duration)
        log.Printf("Shutdown completed in %.2f seconds", duration)
    }()

    // Create shutdown context
    ctx, cancel := context.WithTimeout(context.Background(), maxWait)
    defer cancel()

    // Stop accepting new connections
    if err := s.Shutdown(ctx); err != nil {
        log.Printf("Shutdown error: %v", err)
        return err
    }

    // Wait for in-flight requests with monitoring
    done := make(chan struct{})
    go func() {
        ticker := time.NewTicker(1 * time.Second)
        defer ticker.Stop()

        for {
            select {
            case <-done:
                return
            case <-ticker.C:
                active := atomic.LoadInt64(&s.activeReqs)
                if active > 0 {
                    log.Printf("Waiting for %d in-flight requests to complete...", active)
                }
            }
        }
    }()

    // Wait for all requests to complete
    s.wg.Wait()
    close(done)

    log.Println("All requests completed")
    return nil
}
```

### 2. Readiness Gate for ALB Target Health

Use Kubernetes readiness gates to coordinate with ALB health status:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api-server
  labels:
    app: api-server
spec:
  readinessGates:
  - conditionType: "target-health.alb.kubernetes.aws/api-server_http"

  containers:
  - name: api-server
    image: api-server:v2.3.1
    ports:
    - containerPort: 8080

    readinessProbe:
      httpGet:
        path: /ready
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 5
```

This requires the AWS Load Balancer Controller with target health integration:

```yaml
# aws-load-balancer-controller configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-load-balancer-controller-config
  namespace: kube-system
data:
  enable-pod-readiness-gate-inject: "true"
```

### 3. HPA Configuration for Auto-scaling

Configure Horizontal Pod Autoscaler to maintain capacity during deployments:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server

  minReplicas: 3
  maxReplicas: 20

  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # Wait 5 minutes before scaling down
      policies:
      - type: Percent
        value: 10  # Scale down by max 10% of current replicas
        periodSeconds: 60
      - type: Pods
        value: 2  # Or scale down by max 2 pods
        periodSeconds: 60
      selectPolicy: Min  # Use the policy that results in fewer pods removed

    scaleUp:
      stabilizationWindowSeconds: 0  # Scale up immediately
      policies:
      - type: Percent
        value: 50  # Scale up by max 50% of current replicas
        periodSeconds: 60
      - type: Pods
        value: 4  # Or scale up by max 4 pods
        periodSeconds: 60
      selectPolicy: Max  # Use the policy that results in more pods added

  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70

  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80

  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "1000"  # 1000 req/s per pod
```

### 4. PodDisruptionBudget for Availability

Ensure minimum availability during voluntary disruptions:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: 2  # Always keep at least 2 pods running
  selector:
    matchLabels:
      app: api-server
```

## Testing and Validation

### Load Testing During Deployments

Create a test harness that validates zero-downtime deployments:

```bash
#!/bin/bash
# test-zero-downtime-deployment.sh

set -euo pipefail

NAMESPACE="production"
DEPLOYMENT="api-server"
SERVICE_URL="https://api.example.com"
DURATION=300  # 5 minutes
RPS=100  # Requests per second

echo "=== Zero-Downtime Deployment Test ==="
echo "Namespace: $NAMESPACE"
echo "Deployment: $DEPLOYMENT"
echo "Service URL: $SERVICE_URL"
echo "Duration: ${DURATION}s"
echo "Target RPS: $RPS"
echo ""

# Start load generator in background
echo "Starting load generator..."
vegeta attack \
    -rate=$RPS \
    -duration=${DURATION}s \
    -targets=<(echo "GET $SERVICE_URL/health") \
    | tee results.bin \
    | vegeta report

# Trigger deployment after 60 seconds
sleep 60

echo "Triggering deployment..."
kubectl set image deployment/$DEPLOYMENT \
    -n $NAMESPACE \
    api-server=api-server:v2.3.2

# Wait for deployment to complete
kubectl rollout status deployment/$DEPLOYMENT -n $NAMESPACE

# Analyze results
echo ""
echo "=== Load Test Results ==="
vegeta report -type=text results.bin

# Check for any errors
ERROR_COUNT=$(vegeta report -type=json results.bin | jq '.status_codes | to_entries[] | select(.key != "200") | .value' | paste -sd+ | bc)

if [ "$ERROR_COUNT" -gt 0 ]; then
    echo "ERROR: Found $ERROR_COUNT failed requests during deployment"
    exit 1
else
    echo "SUCCESS: Zero errors during deployment"
    exit 0
fi
```

### Monitoring Dashboard

Create a Grafana dashboard to visualize deployment health:

```json
{
  "dashboard": {
    "title": "Deployment Health - API Server",
    "panels": [
      {
        "title": "Request Success Rate",
        "targets": [
          {
            "expr": "sum(rate(http_requests_total{job=\"api-server\",status=~\"2..\"}[1m])) / sum(rate(http_requests_total{job=\"api-server\"}[1m]))"
          }
        ],
        "thresholds": [
          { "value": 0.99, "color": "green" },
          { "value": 0.95, "color": "yellow" },
          { "value": 0, "color": "red" }
        ]
      },
      {
        "title": "Active Connections During Rollout",
        "targets": [
          {
            "expr": "http_active_connections{job=\"api-server\"}"
          }
        ]
      },
      {
        "title": "Pod Status",
        "targets": [
          {
            "expr": "kube_pod_status_phase{namespace=\"production\",pod=~\"api-server-.*\"}"
          }
        ]
      },
      {
        "title": "ALB Target Health",
        "targets": [
          {
            "expr": "aws_alb_target_health{target_group=\"api-server-prod\"}"
          }
        ]
      },
      {
        "title": "Graceful Shutdown Duration",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(http_shutdown_duration_seconds_bucket[5m]))"
          }
        ]
      }
    ],
    "annotations": {
      "list": [
        {
          "name": "Deployments",
          "datasource": "Prometheus",
          "expr": "changes(kube_deployment_status_observed_generation{namespace=\"production\",deployment=\"api-server\"}[1m]) > 0"
        }
      ]
    }
  }
}
```

## Production Checklist

Before deploying to production, validate:

### Application Level
- [ ] Graceful shutdown implemented (handles SIGTERM)
- [ ] Separate /health and /ready endpoints
- [ ] /ready returns 503 during shutdown
- [ ] Active connection tracking
- [ ] Request completion monitoring
- [ ] Metrics exported (Prometheus format)

### Kubernetes Configuration
- [ ] PreStop hook configured (15-30s delay)
- [ ] terminationGracePeriodSeconds >= 60s
- [ ] readinessProbe configured correctly
- [ ] livenessProbe distinct from readinessProbe
- [ ] maxUnavailable = 0 in deployment strategy
- [ ] PodDisruptionBudget configured
- [ ] HPA with appropriate scale-down policies

### AWS ALB Configuration
- [ ] Health check interval optimal (5-10s)
- [ ] Unhealthy threshold = 2
- [ ] Deregistration delay = 30-60s
- [ ] Connection draining enabled
- [ ] Target group attributes validated

### Monitoring
- [ ] Deployment annotation in Grafana
- [ ] Alerting for elevated error rates
- [ ] Request duration tracking
- [ ] Connection drain monitoring
- [ ] Load test automation

## Lessons Learned

### 1. Timing is Everything

The timing between Kubernetes, ALB, and application shutdown must be carefully orchestrated. Our production configuration:

```
T+0s:    SIGTERM received
T+0s:    /ready returns 503 (stop accepting new requests)
T+0-5s:  ALB health check may still show healthy
T+5s:    ALB health check fails
T+10s:   ALB marks target unhealthy (2 failures)
T+10s:   ALB stops routing traffic
T+10-15s: PreStop hook sleep completes
T+15s:   Application begins shutdown
T+15-30s: Existing requests complete
T+30s:   ALB deregistration delay completes
T+30s:   Pod deleted
```

### 2. Separate Health and Readiness

Never use the same endpoint for liveness and readiness probes:

```
/health  - Liveness:  Only fails if application is broken (rarely fails)
/ready   - Readiness: Fails during startup AND shutdown (fails frequently)
```

### 3. Monitor Connection Draining

Implement metrics to verify connections are actually draining:

```go
// Track how many requests complete during shutdown
shutdownRequestsCompleted = prometheus.NewCounter(...)

// Track maximum time to drain
shutdownMaxDrainTime = prometheus.NewGauge(...)
```

### 4. Test Under Load

Deployments behave differently under load. Always test with realistic traffic:

- Load testing reveals timing issues
- Verify error rates remain at 0% during rollouts
- Test with various request durations (long and short)
- Validate connection draining with long-lived connections

### 5. HPA Scale-Down Policies

Configure HPA to avoid scaling down during traffic spikes:

- Use stabilizationWindow to prevent flapping
- Set conservative scale-down rates
- Consider business hours in scaling decisions

## Conclusion

Achieving zero-downtime deployments with Kubernetes and AWS ALB requires careful coordination of multiple components:

1. **Application-level graceful shutdown** that properly handles SIGTERM
2. **PreStop hooks** that introduce appropriate delays
3. **ALB configuration** optimized for fast health checks and connection draining
4. **Monitoring and alerting** to verify the system works as expected

Since implementing these patterns:
- 502 errors during deployments reduced from 45/sec to 0/sec
- Deployment confidence increased across teams
- Automated deployment frequency increased 3x
- Mean time to deploy reduced from 30 minutes to 8 minutes

The investment in proper health checks and graceful shutdown pays dividends in system reliability and developer productivity.

## Additional Resources

- [Kubernetes Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
- [Container Lifecycle Hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)
- [ALB Target Groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html)

For consultation on zero-downtime deployments and AWS/Kubernetes architecture, contact mmattox@support.tools.