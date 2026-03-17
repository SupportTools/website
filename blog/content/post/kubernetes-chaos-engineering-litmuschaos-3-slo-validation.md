---
title: "Kubernetes Chaos Engineering with LitmusChaos 3.0: Experiment Authoring and SLO Validation"
date: 2030-01-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Chaos Engineering", "LitmusChaos", "SLO", "Reliability", "GameDay"]
categories: ["Kubernetes", "Site Reliability Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced LitmusChaos 3.0 usage covering ChaosEngine v2 API, custom fault development in Go, integrating chaos results with SLO tooling, and automating GameDay exercises at enterprise scale."
more_link: "yes"
url: "/kubernetes-chaos-engineering-litmuschaos-3-slo-validation/"
---

Chaos engineering has matured from a curiosity into a first-class reliability practice. LitmusChaos 3.0 brings a redesigned control plane, a declarative ChaosEngine v2 API, a Go SDK for custom fault development, and native integration hooks that let you feed experiment outcomes directly into SLO burn-rate calculations. This guide walks through everything: deploying the Litmus control plane on a production cluster, authoring custom faults, wiring results into Prometheus-based SLO tooling, and building automated GameDay pipelines that run weekly without human intervention.

<!--more-->

# Kubernetes Chaos Engineering with LitmusChaos 3.0: Experiment Authoring and SLO Validation

## Why LitmusChaos 3.0 Changes the Game

Previous versions of Litmus treated chaos as isolated events. You ran an experiment, observed pod restarts, wrote a post-mortem. LitmusChaos 3.0 introduces three structural improvements that elevate the practice:

1. **ChaosEngine v2** — A redesigned CRD with typed status conditions, structured probe results, and a retry/backoff model for probes.
2. **ChaosHub v2 API** — A versioned, content-addressable experiment library with semantic versioning and dependency resolution.
3. **Native SLO Integration** — Experiment result annotations map directly to SLO error-budget consumption calculations.

The net effect is that chaos engineering stops being a standalone activity and becomes part of the same reliability measurement loop as your SLIs and SLOs.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Litmus Control Plane                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │  Chaos Center│  │ Workflow Eng.│  │  ChaosHub v2  │ │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘ │
│         └─────────────────┴──────────────────┘         │
└─────────────────────────────┬───────────────────────────┘
                              │ ChaosEngine v2 CRDs
┌─────────────────────────────▼───────────────────────────┐
│                  Target Kubernetes Cluster               │
│  ┌────────────────────┐    ┌──────────────────────────┐  │
│  │  Chaos Operator    │    │  Chaos Runner Pod        │  │
│  │  (watches CRDs)    │───▶│  (executes fault logic)  │  │
│  └────────────────────┘    └──────────────────────────┘  │
└─────────────────────────────┬───────────────────────────┘
                              │ metrics/events
┌─────────────────────────────▼───────────────────────────┐
│               Observability Stack                        │
│  Prometheus ──▶ SLO Engine ──▶ Error Budget Dashboard   │
└─────────────────────────────────────────────────────────┘
```

## Installing LitmusChaos 3.0

### Prerequisites

```bash
# Verify cluster version (3.0 requires Kubernetes 1.26+)
kubectl version --short

# Install cert-manager (required for webhook TLS)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=Available deployment --all --timeout=120s
```

### Helm-Based Installation

```bash
helm repo add litmuschaos https://litmuschaos.github.io/litmus-helm/
helm repo update

# Create namespace with required labels
kubectl create namespace litmus
kubectl label namespace litmus \
  app.kubernetes.io/managed-by=helm \
  litmus.io/control-plane=true

# Install control plane
helm install litmus litmuschaos/litmus \
  --namespace litmus \
  --version 3.0.0 \
  --set portal.frontend.service.type=ClusterIP \
  --set portal.server.graphqlServer.genericEnv.SKIP_SSL_VERIFY=false \
  --set portal.server.authServer.env.ADMIN_PASSWORD="$(openssl rand -base64 16)" \
  --set mongodb.enabled=true \
  --set mongodb.auth.rootPassword="$(openssl rand -base64 16)" \
  --set chaos.enabled=true \
  --set chaos.exporter.serviceMonitor.enabled=true \
  --set chaos.exporter.serviceMonitor.namespace=monitoring \
  --wait
```

### Operator Installation on Target Clusters

```bash
# Install the chaos operator (runs on each target cluster)
kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-v3.0.0.yaml

# Install generic experiment CRDs
kubectl apply -f https://litmuschaos.github.io/litmus/chaos-crds.yaml

# Verify operator health
kubectl -n litmus get deployment chaos-operator-ce
kubectl -n litmus get crds | grep litmus
```

## ChaosEngine v2 API Deep Dive

### Anatomy of a ChaosEngine v2 Manifest

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: payment-service-pod-kill
  namespace: production
  annotations:
    litmuschaos.io/slo-name: "payment-service-availability"
    litmuschaos.io/slo-budget-consumed: "true"
    litmuschaos.io/experiment-owner: "platform-reliability@company.com"
spec:
  # Target application selector
  appinfo:
    appns: production
    applabel: "app=payment-service"
    appkind: deployment

  # Chaos service account with minimal RBAC
  chaosServiceAccount: chaos-runner-sa

  # Experiment execution policy
  engineState: active
  terminationGracePeriodSeconds: 30

  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: "60"
            - name: CHAOS_INTERVAL
              value: "10"
            - name: FORCE
              value: "false"
            - name: PODS_AFFECTED_PERC
              value: "50"
            - name: TARGET_PODS
              value: ""
            - name: SEQUENCE
              value: "parallel"
          # Resource constraints for the chaos runner
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "200m"
              memory: "256Mi"

        # Hypothesis validation probes
        probe:
          # HTTP probe - validates service endpoint
          - name: payment-api-availability
            type: httpProbe
            mode: Continuous
            runProperties:
              probeTimeout: 5000
              interval: 2000
              retry: 3
              probePollingInterval: 2000
              initialDelaySeconds: 0
              stopOnFailure: false
            httpProbe/inputs:
              url: "http://payment-service.production.svc.cluster.local/health"
              insecureSkipVerify: false
              method:
                get:
                  criteria: ==
                  responseCode: "200"

          # Prometheus probe - validates SLI metrics
          - name: payment-success-rate
            type: promProbe
            mode: Edge
            runProperties:
              probeTimeout: 10000
              interval: 5000
              retry: 2
              stopOnFailure: false
            promProbe/inputs:
              endpoint: "http://prometheus.monitoring.svc.cluster.local:9090"
              query: >-
                sum(rate(payment_requests_total{status="success"}[2m])) /
                sum(rate(payment_requests_total[2m])) * 100
              comparator:
                criteria: ">="
                value: "99.0"

          # Command probe - validates data integrity
          - name: payment-queue-depth
            type: cmdProbe
            mode: EOT
            runProperties:
              probeTimeout: 15000
              interval: 5000
              retry: 1
              stopOnFailure: true
            cmdProbe/inputs:
              command: >-
                kubectl exec -n production
                $(kubectl get pods -n production -l app=payment-service -o jsonpath='{.items[0].metadata.name}')
                -- curl -s http://localhost:8080/metrics/queue_depth | grep -v '#' | awk '{print $2}'
              comparator:
                type: int
                criteria: "<="
                value: "1000"
```

### RBAC Configuration for Chaos Runner

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: chaos-runner-sa
  namespace: production
  labels:
    app.kubernetes.io/managed-by: litmus
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: chaos-runner-role
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/exec", "events"]
    verbs: ["get", "list", "watch", "create", "delete", "patch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: ["litmuschaos.io"]
    resources: ["chaosengines", "chaosexperiments", "chaosresults"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "create", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: chaos-runner-rb
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: chaos-runner-role
subjects:
  - kind: ServiceAccount
    name: chaos-runner-sa
    namespace: production
```

## Writing Custom Faults in Go

### The Custom Fault Architecture

LitmusChaos 3.0 defines a standard interface for custom faults through the `pkg/chaoslib` package. A custom fault is a Go binary that:

1. Reads experiment configuration from environment variables or a config file
2. Implements pre-chaos, chaos injection, and post-chaos phases
3. Reports results back via the ChaosResult CRD

### Setting Up the Custom Fault Project

```bash
mkdir -p custom-faults/database-connection-chaos
cd custom-faults/database-connection-chaos
go mod init github.com/company/litmus-custom-faults
go get github.com/litmuschaos/litmus-go@v3.0.0
go get github.com/litmuschaos/chaos-operator@v3.0.0
```

### Custom Fault: Database Connection Saturation

```go
// pkg/fault/database_connection_chaos.go
package fault

import (
    "context"
    "fmt"
    "math/rand"
    "net"
    "os"
    "strconv"
    "sync"
    "time"

    "github.com/litmuschaos/litmus-go/pkg/clients"
    "github.com/litmuschaos/litmus-go/pkg/events"
    "github.com/litmuschaos/litmus-go/pkg/log"
    "github.com/litmuschaos/litmus-go/pkg/result"
    "github.com/litmuschaos/litmus-go/pkg/status"
    "github.com/litmuschaos/litmus-go/pkg/types"
    litmusTypes "github.com/litmuschaos/litmus-go/pkg/types"
)

// ExperimentDetails holds experiment parameters
type ExperimentDetails struct {
    ExperimentName         string
    EngineName             string
    ChaosDuration          int
    RampTime               int
    TargetHost             string
    TargetPort             int
    ConnectionCount        int
    ConnectionRampUpTime   int
    ChaosNamespace         string
    ChaosPodName           string
    Timeout                int
    Delay                  int
}

// SetDefaults initializes experiment details from env vars
func (e *ExperimentDetails) SetDefaults() {
    e.ExperimentName = getEnvOrDefault("EXPERIMENT_NAME", "database-connection-chaos")
    e.EngineName = getEnvOrDefault("CHAOSENGINE", "")
    e.ChaosDuration = getEnvAsIntOrDefault("TOTAL_CHAOS_DURATION", 60)
    e.RampTime = getEnvAsIntOrDefault("RAMP_TIME", 0)
    e.TargetHost = getEnvOrDefault("TARGET_HOST", "")
    e.TargetPort = getEnvAsIntOrDefault("TARGET_PORT", 5432)
    e.ConnectionCount = getEnvAsIntOrDefault("CONNECTION_COUNT", 500)
    e.ConnectionRampUpTime = getEnvAsIntOrDefault("CONNECTION_RAMP_UP_TIME", 10)
    e.ChaosNamespace = getEnvOrDefault("CHAOS_NAMESPACE", "litmus")
    e.ChaosPodName = getEnvOrDefault("POD_NAME", "")
    e.Timeout = getEnvAsIntOrDefault("STATUS_CHECK_TIMEOUT", 180)
    e.Delay = getEnvAsIntOrDefault("STATUS_CHECK_DELAY", 2)
}

// RunExperiment is the main entry point
func RunExperiment(clients clients.ClientSets) {
    experimentsDetails := &ExperimentDetails{}
    experimentsDetails.SetDefaults()

    resultDetails := &litmusTypes.ResultDetails{}
    eventsDetails := &litmusTypes.EventDetails{}
    chaosDetails := &litmusTypes.ChaosDetails{}

    // Initialize chaos result
    if err := result.ChaosResult(chaosDetails, clients, resultDetails, "SOT"); err != nil {
        log.Fatalf("failed to initialize chaos result: %v", err)
    }

    // Validate target
    if experimentsDetails.TargetHost == "" {
        log.Error("TARGET_HOST environment variable is required")
        result.RecordAfterFailure(chaosDetails, resultDetails, err, clients, eventsDetails)
        return
    }

    // Ramp time - wait before starting
    if experimentsDetails.RampTime != 0 {
        log.Infof("[Ramp]: Waiting %ds before starting chaos", experimentsDetails.RampTime)
        common.WaitForDuration(experimentsDetails.RampTime)
    }

    // Execute pre-chaos application status check
    log.Info("[PreChaos]: Checking application status before chaos")
    if err := status.CheckApplicationStatus(
        experimentsDetails.ChaosNamespace,
        experimentsDetails.Delay,
        experimentsDetails.Timeout,
        clients,
    ); err != nil {
        log.Errorf("pre-chaos application status check failed: %v", err)
        result.RecordAfterFailure(chaosDetails, resultDetails, err, clients, eventsDetails)
        return
    }

    // Inject chaos
    log.Infof("[ChaosInject]: Saturating %s:%d with %d connections",
        experimentsDetails.TargetHost,
        experimentsDetails.TargetPort,
        experimentsDetails.ConnectionCount,
    )

    chaosCtx, chaosCancel := context.WithTimeout(
        context.Background(),
        time.Duration(experimentsDetails.ChaosDuration)*time.Second,
    )
    defer chaosCancel()

    if err := injectConnectionSaturation(chaosCtx, experimentsDetails); err != nil {
        log.Errorf("chaos injection failed: %v", err)
        result.RecordAfterFailure(chaosDetails, resultDetails, err, clients, eventsDetails)
        return
    }

    // Ramp time - wait after chaos
    if experimentsDetails.RampTime != 0 {
        log.Infof("[Ramp]: Waiting %ds after chaos", experimentsDetails.RampTime)
        common.WaitForDuration(experimentsDetails.RampTime)
    }

    // Post-chaos validation
    log.Info("[PostChaos]: Validating application recovery")
    if err := status.CheckApplicationStatus(
        experimentsDetails.ChaosNamespace,
        experimentsDetails.Delay,
        experimentsDetails.Timeout,
        clients,
    ); err != nil {
        log.Errorf("post-chaos application status check failed: %v", err)
        result.RecordAfterFailure(chaosDetails, resultDetails, err, clients, eventsDetails)
        return
    }

    // Record success
    result.RecordAfterSuccess(chaosDetails, resultDetails, clients, eventsDetails)
    log.Info("[Completion]: Database connection saturation experiment completed successfully")
}

// injectConnectionSaturation opens a flood of TCP connections to the target
func injectConnectionSaturation(ctx context.Context, details *ExperimentDetails) error {
    target := fmt.Sprintf("%s:%d", details.TargetHost, details.TargetPort)
    var conns []net.Conn
    var mu sync.Mutex
    var wg sync.WaitGroup

    log.Infof("[Inject]: Ramping up to %d connections over %ds",
        details.ConnectionCount, details.ConnectionRampUpTime)

    // Ramp up connections gradually
    rampInterval := time.Duration(details.ConnectionRampUpTime) * time.Second / time.Duration(details.ConnectionCount)

    for i := 0; i < details.ConnectionCount; i++ {
        select {
        case <-ctx.Done():
            log.Info("[Inject]: Chaos duration elapsed, stopping ramp-up")
            goto cleanup
        default:
        }

        wg.Add(1)
        go func(connID int) {
            defer wg.Done()
            dialer := &net.Dialer{
                Timeout:   5 * time.Second,
                KeepAlive: 30 * time.Second,
            }
            conn, err := dialer.DialContext(ctx, "tcp", target)
            if err != nil {
                // Connection refused is expected behavior under saturation
                log.Debugf("[Inject]: Connection %d failed (expected): %v", connID, err)
                return
            }
            mu.Lock()
            conns = append(conns, conn)
            mu.Unlock()
            log.Debugf("[Inject]: Connection %d established", connID)

            // Hold the connection for the chaos duration
            select {
            case <-ctx.Done():
            }
        }(i)

        time.Sleep(rampInterval)
    }

    // Wait for chaos duration
    log.Infof("[Inject]: Holding %d connections for %ds",
        details.ConnectionCount, details.ChaosDuration)
    <-ctx.Done()

cleanup:
    log.Info("[Cleanup]: Closing all chaos connections")
    mu.Lock()
    defer mu.Unlock()
    for _, conn := range conns {
        conn.Close()
    }
    wg.Wait()

    return nil
}

func getEnvOrDefault(key, defaultVal string) string {
    if val := os.Getenv(key); val != "" {
        return val
    }
    return defaultVal
}

func getEnvAsIntOrDefault(key string, defaultVal int) int {
    if val := os.Getenv(key); val != "" {
        if i, err := strconv.Atoi(val); err == nil {
            return i
        }
    }
    return defaultVal
}
```

### Custom Fault Dockerfile

```dockerfile
# Build stage
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-w -s" \
    -o /database-connection-chaos \
    ./cmd/database-connection-chaos/main.go

# Runtime stage
FROM gcr.io/distroless/static:nonroot
COPY --from=builder /database-connection-chaos /database-connection-chaos
USER nonroot:nonroot
ENTRYPOINT ["/database-connection-chaos"]
```

### ChaosExperiment CRD for Custom Fault

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosExperiment
metadata:
  name: database-connection-chaos
  namespace: litmus
  labels:
    name: database-connection-chaos
    app.kubernetes.io/part-of: litmus
    app.kubernetes.io/component: chaosexperiment
    app.kubernetes.io/version: v3.0.0
spec:
  definition:
    scope: Namespaced
    permissions:
      - apiGroups: [""]
        resources: ["pods", "pods/log", "pods/exec", "events"]
        verbs: ["get", "list", "watch", "create", "delete", "patch"]
      - apiGroups: ["litmuschaos.io"]
        resources: ["chaosengines", "chaosexperiments", "chaosresults"]
        verbs: ["get", "list", "watch", "create", "update", "patch"]
    image: "registry.company.com/litmus/database-connection-chaos:v1.0.0"
    imagePullPolicy: Always
    args:
      - -c
      - ./database-connection-chaos
    command:
      - /bin/bash
    env:
      - name: TOTAL_CHAOS_DURATION
        value: "60"
      - name: RAMP_TIME
        value: "0"
      - name: TARGET_HOST
        value: ""
      - name: TARGET_PORT
        value: "5432"
      - name: CONNECTION_COUNT
        value: "500"
      - name: CONNECTION_RAMP_UP_TIME
        value: "10"
    labels:
      name: database-connection-chaos
      app.kubernetes.io/part-of: litmus
```

## Integrating Chaos Results with SLO Tooling

### ChaosResult CRD Structure

After each experiment, LitmusChaos writes a ChaosResult resource. The key fields for SLO integration are:

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosResult
metadata:
  name: payment-service-pod-kill-pod-delete
  namespace: production
  labels:
    chaosUID: "abc-123-def"
    engineName: payment-service-pod-kill
  annotations:
    litmuschaos.io/slo-name: "payment-service-availability"
status:
  experimentStatus:
    phase: Completed
    verdict: Pass
    probeSuccessPercentage: "100"
  probeStatus:
    - name: payment-api-availability
      type: httpProbe
      mode: Continuous
      status:
        verdict: Passed
        description: "All 28 probe checks passed"
    - name: payment-success-rate
      type: promProbe
      mode: Edge
      status:
        verdict: Passed
        description: "Success rate maintained above 99%"
  history:
    passedRuns: 12
    failedRuns: 1
    stoppedRuns: 0
```

### Prometheus Exporter for ChaosResults

```go
// pkg/exporter/chaos_result_exporter.go
package exporter

import (
    "context"
    "fmt"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/client-go/dynamic"
)

var (
    chaosExperimentVerdict = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "litmus_chaos_experiment_verdict",
            Help: "Verdict of LitmusChaos experiments (1=Pass, 0=Fail, -1=Awaited)",
        },
        []string{
            "engine_name",
            "experiment_name",
            "namespace",
            "slo_name",
            "experiment_owner",
        },
    )

    chaosProbeSuccessPercentage = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "litmus_chaos_probe_success_percentage",
            Help: "Probe success percentage for chaos experiments",
        },
        []string{"engine_name", "experiment_name", "namespace"},
    )

    chaosExperimentRunTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "litmus_chaos_experiment_runs_total",
            Help: "Total number of chaos experiment runs",
        },
        []string{"engine_name", "verdict", "namespace"},
    )

    chaosExperimentDurationSeconds = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "litmus_chaos_experiment_duration_seconds",
            Help:    "Duration of chaos experiments in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"engine_name", "experiment_name", "namespace"},
    )
)

// ChaosResultCollector watches ChaosResult CRDs and exports metrics
type ChaosResultCollector struct {
    dynamicClient dynamic.Interface
    namespace     string
    interval      time.Duration
}

var chaosResultGVR = schema.GroupVersionResource{
    Group:    "litmuschaos.io",
    Version:  "v1alpha1",
    Resource: "chaosresults",
}

func NewChaosResultCollector(client dynamic.Interface, namespace string) *ChaosResultCollector {
    return &ChaosResultCollector{
        dynamicClient: client,
        namespace:     namespace,
        interval:      30 * time.Second,
    }
}

func (c *ChaosResultCollector) Start(ctx context.Context) {
    ticker := time.NewTicker(c.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            c.collect(ctx)
        }
    }
}

func (c *ChaosResultCollector) collect(ctx context.Context) {
    results, err := c.dynamicClient.Resource(chaosResultGVR).
        Namespace(c.namespace).
        List(ctx, metav1.ListOptions{})
    if err != nil {
        fmt.Printf("error listing chaos results: %v\n", err)
        return
    }

    for _, item := range results.Items {
        metadata := item.Object["metadata"].(map[string]interface{})
        status, ok := item.Object["status"].(map[string]interface{})
        if !ok {
            continue
        }

        name := metadata["name"].(string)
        namespace := metadata["namespace"].(string)
        annotations, _ := metadata["annotations"].(map[string]interface{})

        sloName := ""
        engineName := ""
        owner := ""
        if annotations != nil {
            sloName, _ = annotations["litmuschaos.io/slo-name"].(string)
            engineName, _ = annotations["litmuschaos.io/engine-name"].(string)
            owner, _ = annotations["litmuschaos.io/experiment-owner"].(string)
        }
        if engineName == "" {
            labels, _ := metadata["labels"].(map[string]interface{})
            if labels != nil {
                engineName, _ = labels["engineName"].(string)
            }
        }

        expStatus, ok := status["experimentStatus"].(map[string]interface{})
        if !ok {
            continue
        }

        phase, _ := expStatus["phase"].(string)
        verdict, _ := expStatus["verdict"].(string)
        probeSuccessStr, _ := expStatus["probeSuccessPercentage"].(string)

        if phase != "Completed" {
            continue
        }

        verdictValue := verdictToFloat(verdict)
        chaosExperimentVerdict.WithLabelValues(
            engineName, name, namespace, sloName, owner,
        ).Set(verdictValue)

        if probeSuccessStr != "" {
            var pct float64
            fmt.Sscanf(probeSuccessStr, "%f", &pct)
            chaosProbeSuccessPercentage.WithLabelValues(
                engineName, name, namespace,
            ).Set(pct)
        }
    }
}

func verdictToFloat(verdict string) float64 {
    switch verdict {
    case "Pass":
        return 1.0
    case "Fail":
        return 0.0
    default:
        return -1.0
    }
}
```

### SLO Error Budget Integration

```yaml
# Prometheus recording rules that wire chaos results into SLO burn rates
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: chaos-slo-integration
  namespace: monitoring
spec:
  groups:
    - name: chaos.slo.rules
      interval: 60s
      rules:
        # Record chaos experiment failure as SLO error events
        - record: slo:chaos_induced_errors:rate5m
          expr: |
            increase(
              litmus_chaos_experiment_runs_total{verdict="Fail"}[5m]
            ) > 0
          labels:
            slo_event_type: "chaos_failure"

        # SLO compliance during chaos - payment service
        - record: slo:payment_availability_during_chaos:ratio
          expr: |
            (
              sum(rate(payment_requests_total{status="success"}[5m]))
              /
              sum(rate(payment_requests_total[5m]))
            )
            unless
            (
              litmus_chaos_experiment_verdict{
                slo_name="payment-service-availability",
                experiment_name=~".*pod-kill.*|.*pod-delete.*"
              } == -1
            )

        # Error budget burn rate including chaos windows
        - record: slo:error_budget_burn_rate:1h
          expr: |
            (
              1 - slo:payment_availability_during_chaos:ratio
            ) / (1 - 0.999)

        # Alert when chaos reveals SLO violations
        - alert: ChaosExperimentRevealsSLOViolation
          expr: |
            (
              litmus_chaos_experiment_verdict{slo_name!=""} == 0
              AND
              litmus_chaos_probe_success_percentage < 95
            )
          for: 0m
          labels:
            severity: critical
            team: "{{ $labels.experiment_owner }}"
          annotations:
            summary: "Chaos experiment revealed SLO violation"
            description: >-
              Experiment {{ $labels.experiment_name }} for SLO
              {{ $labels.slo_name }} failed with
              {{ $value }}% probe success rate.
              Immediate investigation required.
```

## GameDay Automation

### GameDay Controller Architecture

```go
// pkg/gameday/controller.go
package gameday

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/robfig/cron/v3"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/client-go/dynamic"
)

// GameDaySchedule defines a recurring chaos exercise
type GameDaySchedule struct {
    Name          string            `json:"name"`
    CronExpression string           `json:"cronExpression"`
    Experiments   []ExperimentRef   `json:"experiments"`
    NotifySlack   string            `json:"notifySlack,omitempty"`
    MaxParallel   int               `json:"maxParallel"`
    SLOValidation SLOValidation     `json:"sloValidation"`
}

type ExperimentRef struct {
    Namespace  string            `json:"namespace"`
    EngineName string            `json:"engineName"`
    Template   string            `json:"template"`
    Parameters map[string]string `json:"parameters"`
}

type SLOValidation struct {
    PrometheusURL  string  `json:"prometheusURL"`
    SLOName        string  `json:"sloName"`
    MinBudgetLeft  float64 `json:"minBudgetLeftPercent"`
}

// GameDayController orchestrates scheduled chaos exercises
type GameDayController struct {
    dynamicClient dynamic.Interface
    scheduler     *cron.Cron
    schedules     []GameDaySchedule
    slackClient   *SlackNotifier
}

func NewGameDayController(client dynamic.Interface, schedules []GameDaySchedule) *GameDayController {
    return &GameDayController{
        dynamicClient: client,
        scheduler:     cron.New(cron.WithSeconds()),
        schedules:     schedules,
    }
}

func (g *GameDayController) Start(ctx context.Context) error {
    for _, schedule := range g.schedules {
        s := schedule // capture for closure
        entryID, err := g.scheduler.AddFunc(s.CronExpression, func() {
            g.runGameDay(ctx, s)
        })
        if err != nil {
            return fmt.Errorf("failed to schedule %s: %w", s.Name, err)
        }
        fmt.Printf("Scheduled GameDay %s with entry ID %d\n", s.Name, entryID)
    }

    g.scheduler.Start()

    <-ctx.Done()
    g.scheduler.Stop()
    return nil
}

func (g *GameDayController) runGameDay(ctx context.Context, schedule GameDaySchedule) {
    startTime := time.Now()
    fmt.Printf("[GameDay] Starting exercise: %s at %s\n", schedule.Name, startTime.Format(time.RFC3339))

    // Pre-flight: Check error budget
    if schedule.SLOValidation.SLOName != "" {
        budgetLeft, err := g.checkErrorBudget(schedule.SLOValidation)
        if err != nil {
            fmt.Printf("[GameDay] Error checking budget: %v, proceeding with caution\n", err)
        } else if budgetLeft < schedule.SLOValidation.MinBudgetLeft {
            msg := fmt.Sprintf(
                "[GameDay] SKIPPED %s: Error budget at %.1f%% (min: %.1f%%)",
                schedule.Name, budgetLeft, schedule.SLOValidation.MinBudgetLeft,
            )
            fmt.Println(msg)
            g.notify(schedule.NotifySlack, msg)
            return
        }
    }

    // Launch experiments (respecting MaxParallel)
    semaphore := make(chan struct{}, schedule.MaxParallel)
    results := make(chan experimentResult, len(schedule.Experiments))

    for _, exp := range schedule.Experiments {
        exp := exp
        semaphore <- struct{}{}
        go func() {
            defer func() { <-semaphore }()
            result := g.runExperiment(ctx, exp)
            results <- result
        }()
    }

    // Collect results
    var passed, failed int
    for range schedule.Experiments {
        r := <-results
        if r.Verdict == "Pass" {
            passed++
        } else {
            failed++
        }
    }

    duration := time.Since(startTime)
    summary := fmt.Sprintf(
        "[GameDay] %s completed in %v: %d passed, %d failed",
        schedule.Name, duration.Round(time.Second), passed, failed,
    )
    fmt.Println(summary)
    g.notify(schedule.NotifySlack, summary)
}

type experimentResult struct {
    Name    string
    Verdict string
    Error   error
}

func (g *GameDayController) runExperiment(ctx context.Context, ref ExperimentRef) experimentResult {
    // Build ChaosEngine from template
    engine := g.buildChaosEngine(ref)

    chaosEngineGVR := schema.GroupVersionResource{
        Group:    "litmuschaos.io",
        Version:  "v1alpha1",
        Resource: "chaosengines",
    }

    // Create the ChaosEngine
    created, err := g.dynamicClient.Resource(chaosEngineGVR).
        Namespace(ref.Namespace).
        Create(ctx, engine, metav1.CreateOptions{})
    if err != nil {
        return experimentResult{Name: ref.EngineName, Error: err}
    }

    engineName := created.GetName()
    fmt.Printf("[GameDay] Launched experiment: %s/%s\n", ref.Namespace, engineName)

    // Poll for completion
    timeout := time.After(30 * time.Minute)
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return experimentResult{Name: engineName, Error: ctx.Err()}
        case <-timeout:
            return experimentResult{
                Name:  engineName,
                Error: fmt.Errorf("timeout waiting for experiment completion"),
            }
        case <-ticker.C:
            result, done := g.checkExperimentStatus(ctx, ref.Namespace, engineName)
            if done {
                return result
            }
        }
    }
}

func (g *GameDayController) buildChaosEngine(ref ExperimentRef) *unstructured.Unstructured {
    engine := &unstructured.Unstructured{
        Object: map[string]interface{}{
            "apiVersion": "litmuschaos.io/v1alpha1",
            "kind":       "ChaosEngine",
            "metadata": map[string]interface{}{
                "name":      fmt.Sprintf("%s-%d", ref.EngineName, time.Now().Unix()),
                "namespace": ref.Namespace,
                "labels": map[string]interface{}{
                    "app.kubernetes.io/managed-by": "gameday-controller",
                    "gameday.litmus.io/template":   ref.Template,
                },
            },
            "spec": map[string]interface{}{
                "engineState":    "active",
                "chaosServiceAccount": "chaos-runner-sa",
                "experiments": []interface{}{
                    map[string]interface{}{
                        "name": ref.Template,
                        "spec": map[string]interface{}{
                            "components": map[string]interface{}{
                                "env": buildEnvList(ref.Parameters),
                            },
                        },
                    },
                },
            },
        },
    }
    return engine
}

func buildEnvList(params map[string]string) []interface{} {
    var envList []interface{}
    for k, v := range params {
        envList = append(envList, map[string]interface{}{
            "name":  k,
            "value": v,
        })
    }
    return envList
}

func (g *GameDayController) checkExperimentStatus(
    ctx context.Context,
    namespace, engineName string,
) (experimentResult, bool) {
    chaosResultGVR := schema.GroupVersionResource{
        Group:    "litmuschaos.io",
        Version:  "v1alpha1",
        Resource: "chaosresults",
    }

    results, err := g.dynamicClient.Resource(chaosResultGVR).
        Namespace(namespace).
        List(ctx, metav1.ListOptions{
            LabelSelector: fmt.Sprintf("engineName=%s", engineName),
        })
    if err != nil || len(results.Items) == 0 {
        return experimentResult{}, false
    }

    item := results.Items[0]
    status, ok := item.Object["status"].(map[string]interface{})
    if !ok {
        return experimentResult{}, false
    }

    expStatus, ok := status["experimentStatus"].(map[string]interface{})
    if !ok {
        return experimentResult{}, false
    }

    phase, _ := expStatus["phase"].(string)
    if phase != "Completed" {
        return experimentResult{}, false
    }

    verdict, _ := expStatus["verdict"].(string)
    return experimentResult{Name: engineName, Verdict: verdict}, true
}

func (g *GameDayController) checkErrorBudget(v SLOValidation) (float64, error) {
    // Query Prometheus for remaining error budget
    query := fmt.Sprintf(
        `slo:error_budget_remaining_percent{slo_name="%s"}`,
        v.SLOName,
    )
    result, err := queryPrometheus(v.PrometheusURL, query)
    if err != nil {
        return 100.0, err
    }
    return result, nil
}

func (g *GameDayController) notify(webhookURL, message string) {
    if webhookURL == "" {
        return
    }
    // Post to Slack webhook
    payload := map[string]string{"text": message}
    data, _ := json.Marshal(payload)
    fmt.Printf("[Notify] Would send to %s: %s\n", webhookURL, string(data))
}
```

### GameDay Schedule Configuration

```yaml
# gameday-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gameday-schedules
  namespace: litmus
data:
  schedules.json: |
    [
      {
        "name": "weekly-payment-service-resilience",
        "cronExpression": "0 0 10 * * 3",
        "maxParallel": 2,
        "notifySlack": "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>",
        "sloValidation": {
          "prometheusURL": "http://prometheus.monitoring.svc.cluster.local:9090",
          "sloName": "payment-service-availability",
          "minBudgetLeftPercent": 20.0
        },
        "experiments": [
          {
            "namespace": "production",
            "engineName": "payment-pod-kill",
            "template": "pod-delete",
            "parameters": {
              "TOTAL_CHAOS_DURATION": "60",
              "PODS_AFFECTED_PERC": "50"
            }
          },
          {
            "namespace": "production",
            "engineName": "payment-network-loss",
            "template": "pod-network-loss",
            "parameters": {
              "TOTAL_CHAOS_DURATION": "60",
              "NETWORK_PACKET_LOSS_PERCENTAGE": "20"
            }
          }
        ]
      }
    ]
```

## Chaos Workflow Automation with Argo Workflows

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: payment-resilience-gameday
  namespace: litmus
spec:
  entrypoint: gameday-main
  serviceAccountName: argo-chaos-sa
  arguments:
    parameters:
      - name: target-namespace
        value: production
      - name: chaos-duration
        value: "60"

  templates:
    - name: gameday-main
      steps:
        - - name: check-slo-budget
            template: check-budget
        - - name: pre-chaos-baseline
            template: capture-metrics
            arguments:
              parameters:
                - name: phase
                  value: pre-chaos
        - - name: pod-kill-experiment
            template: run-chaos
            arguments:
              parameters:
                - name: experiment-name
                  value: pod-delete
                - name: engine-name
                  value: payment-pod-kill-{{workflow.uid}}
          - name: network-chaos-experiment
            template: run-chaos
            arguments:
              parameters:
                - name: experiment-name
                  value: pod-network-latency
                - name: engine-name
                  value: payment-network-{{workflow.uid}}
        - - name: post-chaos-baseline
            template: capture-metrics
            arguments:
              parameters:
                - name: phase
                  value: post-chaos
        - - name: generate-report
            template: chaos-report

    - name: check-budget
      container:
        image: curlimages/curl:8.6.0
        command: [sh, -c]
        args:
          - |
            BUDGET=$(curl -s "http://prometheus.monitoring:9090/api/v1/query?query=slo:error_budget_remaining_percent{slo_name=\"payment-service\"}" | jq -r '.data.result[0].value[1]')
            echo "Error budget remaining: ${BUDGET}%"
            if (( $(echo "$BUDGET < 20" | bc -l) )); then
              echo "Insufficient error budget, aborting GameDay"
              exit 1
            fi

    - name: run-chaos
      inputs:
        parameters:
          - name: experiment-name
          - name: engine-name
      resource:
        action: create
        successCondition: "status.experimentStatus.phase == Completed"
        failureCondition: "status.engineStatus == stopped"
        manifest: |
          apiVersion: litmuschaos.io/v1alpha1
          kind: ChaosEngine
          metadata:
            name: "{{inputs.parameters.engine-name}}"
            namespace: "{{workflow.parameters.target-namespace}}"
          spec:
            engineState: active
            chaosServiceAccount: chaos-runner-sa
            experiments:
              - name: "{{inputs.parameters.experiment-name}}"
                spec:
                  components:
                    env:
                      - name: TOTAL_CHAOS_DURATION
                        value: "{{workflow.parameters.chaos-duration}}"

    - name: capture-metrics
      inputs:
        parameters:
          - name: phase
      container:
        image: curlimages/curl:8.6.0
        command: [sh, -c]
        args:
          - |
            PHASE="{{inputs.parameters.phase}}"
            METRICS=$(curl -s "http://prometheus.monitoring:9090/api/v1/query_range?query=sum(rate(payment_requests_total{status=\"success\"}[1m]))/sum(rate(payment_requests_total[1m]))&start=$(date -d '5 minutes ago' -u +%s)&end=$(date -u +%s)&step=15s")
            echo "Phase: $PHASE"
            echo "Metrics: $METRICS" | jq '.data.result[0].values[-1][1]'

    - name: chaos-report
      container:
        image: registry.company.com/litmus/chaos-reporter:v1.0.0
        env:
          - name: WORKFLOW_ID
            value: "{{workflow.uid}}"
          - name: REPORT_ENDPOINT
            value: "http://chaos-reports.litmus.svc.cluster.local/api/reports"
```

## Production Best Practices

### Blast Radius Control

```yaml
# ChaosHub experiment with explicit blast radius limits
spec:
  definition:
    env:
      # Hard limit on affected pods
      - name: PODS_AFFECTED_PERC
        value: "30"
      # Never affect more than N pods regardless of percentage
      - name: MAX_PODS_AFFECTED
        value: "3"
      # Minimum healthy pods required before injection
      - name: MIN_AVAILABLE_PODS
        value: "2"
```

### Chaos Guard - Pre-flight Checks

```bash
#!/bin/bash
# chaos-guard.sh - Run before any chaos experiment

TARGET_NS="${1:?Target namespace required}"
MIN_REPLICAS="${2:-2}"

echo "[ChaosGuard] Pre-flight checks for namespace: $TARGET_NS"

# Check deployment health
UNHEALTHY=$(kubectl get deployments -n "$TARGET_NS" \
  -o jsonpath='{range .items[*]}{.metadata.name} {.status.readyReplicas} {.spec.replicas}{"\n"}{end}' | \
  awk '$2 < $3 {print $1}')

if [ -n "$UNHEALTHY" ]; then
  echo "[ChaosGuard] ABORT: Unhealthy deployments found: $UNHEALTHY"
  exit 1
fi

# Check PodDisruptionBudgets
kubectl get pdb -n "$TARGET_NS" -o json | \
  jq -r '.items[] | select(.status.disruptionsAllowed == 0) | .metadata.name' | \
  while read -r pdb; do
    echo "[ChaosGuard] WARN: PDB $pdb allows 0 disruptions"
  done

echo "[ChaosGuard] All pre-flight checks passed"
exit 0
```

### Monitoring Dashboard Queries

```yaml
# Key Grafana/Perses panel queries for chaos observability

# Panel 1: Experiment Success Rate (7d)
expr: |
  sum(litmus_chaos_experiment_runs_total{verdict="Pass"}) by (engine_name)
  /
  sum(litmus_chaos_experiment_runs_total) by (engine_name)
  * 100

# Panel 2: SLO Impact During Chaos Windows
expr: |
  slo:payment_availability_during_chaos:ratio
  * on() group_left()
  (litmus_chaos_experiment_verdict{slo_name="payment-service-availability"} >= 0)

# Panel 3: Error Budget Consumption Rate
expr: |
  rate(slo:error_budget_burn_rate:1h[1h]) > 1

# Panel 4: Probe Success Heatmap
expr: |
  litmus_chaos_probe_success_percentage
```

## Conclusion

LitmusChaos 3.0 represents a fundamental shift from chaos-as-a-tool to chaos-as-a-practice. The key takeaways from this guide:

- **ChaosEngine v2** provides structured probe definitions that directly map to hypothesis validation, making experiment outcomes actionable
- **Custom faults** in Go allow encoding institutional knowledge about failure modes specific to your infrastructure
- **SLO integration** closes the feedback loop: chaos experiments now contribute to error budget calculations rather than being isolated data points
- **GameDay automation** with budget guards ensures experiments only run when there is sufficient reliability headroom, preventing chaos from compounding existing incidents
- **Argo Workflows integration** enables reproducible, auditable GameDay exercises with parallel experiment execution and automatic reporting

Start with the built-in pod-delete and network-loss experiments before developing custom faults. Instrument your services with the Prometheus metrics that your chaos probes will validate. Most importantly, treat a failed experiment as a learning opportunity — the goal of chaos engineering is to find weaknesses before your users do.
