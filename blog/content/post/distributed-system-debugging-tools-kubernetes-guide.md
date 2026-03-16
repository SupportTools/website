---
title: "Distributed System Debugging Tools: Enterprise Kubernetes Troubleshooting Guide"
date: 2026-06-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Debugging", "Distributed Systems", "Troubleshooting", "Observability", "DevOps"]
categories: ["Kubernetes", "DevOps", "Troubleshooting"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to distributed system debugging tools and techniques for Kubernetes environments, including distributed tracing, log aggregation, and advanced troubleshooting workflows for enterprise production systems."
more_link: "yes"
url: "/distributed-system-debugging-tools-kubernetes-guide/"
---

Master distributed system debugging in Kubernetes with comprehensive tools and techniques for tracing, log analysis, performance profiling, and troubleshooting complex microservices architectures in enterprise production environments.

<!--more-->

# Distributed System Debugging Tools: Enterprise Kubernetes Troubleshooting Guide

## Executive Summary

Debugging distributed systems running on Kubernetes presents unique challenges: requests span multiple services, state is distributed across nodes, and failures cascade in unexpected ways. This comprehensive guide covers enterprise-grade debugging tools, distributed tracing techniques, correlation strategies, and systematic troubleshooting workflows. We'll explore production-tested tools like Jaeger, OpenTelemetry, kubectl debug, and custom debugging frameworks for complex Kubernetes environments.

## Understanding Distributed System Challenges

### The Debugging Complexity Pyramid

```
┌─────────────────────────────────────────┐
│   Application Logic Bugs                │  ← Traditional debugging
├─────────────────────────────────────────┤
│   Service Integration Issues            │  ← API contracts, timeouts
├─────────────────────────────────────────┤
│   Network Communication Failures        │  ← DNS, connectivity, latency
├─────────────────────────────────────────┤
│   Infrastructure Problems                │  ← Node issues, resource limits
├─────────────────────────────────────────┤
│   Platform/Orchestration Issues         │  ← Kubernetes scheduler, controllers
└─────────────────────────────────────────┘
```

### Common Distributed System Issues

1. **Cascading Failures**: One service failure triggers failures in dependent services
2. **Partial Failures**: Some requests succeed while others fail intermittently
3. **Network Partitions**: Services can't communicate due to network issues
4. **Resource Contention**: Multiple services competing for limited resources
5. **Configuration Drift**: Inconsistent configuration across service instances
6. **Timing Issues**: Race conditions, timeouts, and synchronization problems

## Distributed Tracing with OpenTelemetry

### OpenTelemetry Instrumentation

Set up comprehensive distributed tracing:

```yaml
# opentelemetry-collector.yaml - OpenTelemetry Collector deployment
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: observability
data:
  collector-config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
      jaeger:
        protocols:
          grpc:
            endpoint: 0.0.0.0:14250
          thrift_http:
            endpoint: 0.0.0.0:14268
      zipkin:
        endpoint: 0.0.0.0:9411
      prometheus:
        config:
          scrape_configs:
            - job_name: 'otel-collector'
              scrape_interval: 10s
              static_configs:
                - targets: ['0.0.0.0:8888']

    processors:
      batch:
        timeout: 10s
        send_batch_size: 1024
      memory_limiter:
        check_interval: 1s
        limit_mib: 512
        spike_limit_mib: 128
      resource:
        attributes:
          - key: cluster.name
            value: production
            action: upsert
          - key: environment
            value: prod
            action: upsert
      span:
        name:
          to_attributes:
            rules:
              - ^\/api\/v1\/(?P<api_version>.*)$
      tail_sampling:
        policies:
          - name: errors-policy
            type: status_code
            status_code:
              status_codes:
                - ERROR
                - UNSET
          - name: slow-requests
            type: latency
            latency:
              threshold_ms: 1000
          - name: probabilistic-policy
            type: probabilistic
            probabilistic:
              sampling_percentage: 10

    exporters:
      otlp/jaeger:
        endpoint: jaeger-collector.observability.svc.cluster.local:4317
        tls:
          insecure: true
      prometheus:
        endpoint: "0.0.0.0:8889"
        namespace: otel
      logging:
        loglevel: debug
      zipkin:
        endpoint: "http://zipkin.observability.svc.cluster.local:9411/api/v2/spans"
        format: proto

    service:
      pipelines:
        traces:
          receivers: [otlp, jaeger, zipkin]
          processors: [memory_limiter, resource, span, tail_sampling, batch]
          exporters: [otlp/jaeger, logging]
        metrics:
          receivers: [otlp, prometheus]
          processors: [memory_limiter, batch]
          exporters: [prometheus]
      extensions: [health_check, pprof, zpages]
      telemetry:
        logs:
          level: "debug"

---
apiVersion: v1
kind: Service
metadata:
  name: otel-collector
  namespace: observability
  labels:
    app: otel-collector
spec:
  type: ClusterIP
  ports:
    - name: otlp-grpc
      port: 4317
      targetPort: 4317
      protocol: TCP
    - name: otlp-http
      port: 4318
      targetPort: 4318
      protocol: TCP
    - name: jaeger-grpc
      port: 14250
      targetPort: 14250
      protocol: TCP
    - name: jaeger-thrift
      port: 14268
      targetPort: 14268
      protocol: TCP
    - name: zipkin
      port: 9411
      targetPort: 9411
      protocol: TCP
    - name: metrics
      port: 8889
      targetPort: 8889
      protocol: TCP
    - name: prometheus
      port: 8888
      targetPort: 8888
      protocol: TCP
  selector:
    app: otel-collector

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector
  namespace: observability
spec:
  replicas: 3
  selector:
    matchLabels:
      app: otel-collector
  template:
    metadata:
      labels:
        app: otel-collector
    spec:
      serviceAccountName: otel-collector
      containers:
      - name: otel-collector
        image: otel/opentelemetry-collector-contrib:0.91.0
        command:
          - "/otelcol-contrib"
          - "--config=/conf/collector-config.yaml"
        ports:
        - containerPort: 4317
          protocol: TCP
        - containerPort: 4318
          protocol: TCP
        - containerPort: 14250
          protocol: TCP
        - containerPort: 14268
          protocol: TCP
        - containerPort: 9411
          protocol: TCP
        - containerPort: 8889
          protocol: TCP
        - containerPort: 8888
          protocol: TCP
        volumeMounts:
        - name: config
          mountPath: /conf
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /
            port: 13133
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 13133
          initialDelaySeconds: 10
          periodSeconds: 5
      volumes:
      - name: config
        configMap:
          name: otel-collector-config
          items:
          - key: collector-config.yaml
            path: collector-config.yaml

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: otel-collector
  namespace: observability

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: otel-collector
rules:
- apiGroups: [""]
  resources: ["pods", "namespaces", "nodes"]
  verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: otel-collector
subjects:
- kind: ServiceAccount
  name: otel-collector
  namespace: observability
roleRef:
  kind: ClusterRole
  name: otel-collector
  apiGroup: rbac.authorization.k8s.io
```

### Application Instrumentation

Instrument applications with OpenTelemetry:

```go
// otel-instrumentation.go - OpenTelemetry instrumentation example
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.17.0"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

// InitTracer initializes OpenTelemetry tracer
func InitTracer(serviceName string) (*sdktrace.TracerProvider, error) {
    ctx := context.Background()

    // Create OTLP exporter
    collectorURL := os.Getenv("OTEL_COLLECTOR_URL")
    if collectorURL == "" {
        collectorURL = "otel-collector.observability.svc.cluster.local:4317"
    }

    conn, err := grpc.DialContext(
        ctx,
        collectorURL,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        return nil, err
    }

    exporter, err := otlptrace.New(
        ctx,
        otlptracegrpc.NewClient(
            otlptracegrpc.WithGRPCConn(conn),
        ),
    )
    if err != nil {
        return nil, err
    }

    // Create resource with service information
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion(os.Getenv("SERVICE_VERSION")),
            semconv.ServiceNamespace(os.Getenv("NAMESPACE")),
            semconv.DeploymentEnvironment(os.Getenv("ENVIRONMENT")),
            attribute.String("pod.name", os.Getenv("POD_NAME")),
            attribute.String("pod.namespace", os.Getenv("POD_NAMESPACE")),
            attribute.String("node.name", os.Getenv("NODE_NAME")),
            attribute.String("cluster.name", os.Getenv("CLUSTER_NAME")),
        ),
    )
    if err != nil {
        return nil, err
    }

    // Create tracer provider
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(0.1), // Sample 10% of traces
        )),
    )

    // Set global tracer provider
    otel.SetTracerProvider(tp)

    // Set global propagator
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp, nil
}

// TracedHTTPHandler wraps HTTP handler with tracing
func TracedHTTPHandler(name string, handler http.HandlerFunc) http.HandlerFunc {
    tracer := otel.Tracer("http-server")

    return func(w http.ResponseWriter, r *http.Request) {
        // Extract context from incoming request
        ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))

        // Start span
        ctx, span := tracer.Start(ctx, name,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                semconv.HTTPMethod(r.Method),
                semconv.HTTPURL(r.URL.String()),
                semconv.HTTPTarget(r.URL.Path),
                semconv.HTTPRoute(r.URL.Path),
                semconv.HTTPScheme(r.URL.Scheme),
                semconv.NetHostName(r.Host),
                semconv.HTTPClientIP(r.RemoteAddr),
                semconv.HTTPUserAgent(r.UserAgent()),
            ),
        )
        defer span.End()

        // Create custom response writer to capture status code
        rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

        // Call handler with traced context
        handler(rw, r.WithContext(ctx))

        // Record response attributes
        span.SetAttributes(
            semconv.HTTPStatusCode(rw.statusCode),
        )

        // Set span status based on HTTP status code
        if rw.statusCode >= 400 {
            span.SetStatus(trace.StatusError, http.StatusText(rw.statusCode))
        }
    }
}

type responseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

// TracedHTTPClient creates HTTP client with tracing
func TracedHTTPClient() *http.Client {
    return &http.Client{
        Transport: &tracedTransport{
            base: http.DefaultTransport,
        },
        Timeout: 30 * time.Second,
    }
}

type tracedTransport struct {
    base http.RoundTripper
}

func (t *tracedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    tracer := otel.Tracer("http-client")

    ctx, span := tracer.Start(req.Context(), req.Method+" "+req.URL.Path,
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            semconv.HTTPMethod(req.Method),
            semconv.HTTPURL(req.URL.String()),
            semconv.HTTPTarget(req.URL.Path),
            semconv.NetPeerName(req.URL.Hostname()),
            semconv.NetPeerPort(req.URL.Port()),
        ),
    )
    defer span.End()

    // Inject context into outgoing request
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

    // Make request
    resp, err := t.base.RoundTrip(req)

    if err != nil {
        span.RecordError(err)
        span.SetStatus(trace.StatusError, err.Error())
        return nil, err
    }

    span.SetAttributes(semconv.HTTPStatusCode(resp.StatusCode))

    if resp.StatusCode >= 400 {
        span.SetStatus(trace.StatusError, http.StatusText(resp.StatusCode))
    }

    return resp, nil
}

// AddSpanEvent adds custom event to current span
func AddSpanEvent(ctx context.Context, name string, attrs ...attribute.KeyValue) {
    span := trace.SpanFromContext(ctx)
    span.AddEvent(name, trace.WithAttributes(attrs...))
}

// RecordError records error in current span
func RecordError(ctx context.Context, err error, message string) {
    span := trace.SpanFromContext(ctx)
    span.RecordError(err)
    span.SetStatus(trace.StatusError, message)
}

// Example usage
func main() {
    // Initialize tracer
    tp, err := InitTracer("my-service")
    if err != nil {
        log.Fatal(err)
    }
    defer func() {
        if err := tp.Shutdown(context.Background()); err != nil {
            log.Fatal(err)
        }
    }()

    // Setup HTTP handlers with tracing
    http.HandleFunc("/api/users", TracedHTTPHandler("GetUsers", func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        tracer := otel.Tracer("my-service")

        // Create child span for database operation
        ctx, dbSpan := tracer.Start(ctx, "database.query",
            trace.WithAttributes(
                attribute.String("db.system", "postgresql"),
                attribute.String("db.statement", "SELECT * FROM users"),
            ),
        )
        defer dbSpan.End()

        // Simulate database query
        time.Sleep(50 * time.Millisecond)
        AddSpanEvent(ctx, "query.completed", attribute.Int("rows", 42))

        // Create child span for external API call
        ctx, apiSpan := tracer.Start(ctx, "external.api.call",
            trace.WithAttributes(
                attribute.String("http.url", "https://api.example.com/users"),
            ),
        )

        // Make traced HTTP call
        client := TracedHTTPClient()
        req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.example.com/users", nil)
        _, err := client.Do(req)

        if err != nil {
            RecordError(ctx, err, "API call failed")
        }
        apiSpan.End()

        w.WriteHeader(http.StatusOK)
        w.Write([]byte("OK"))
    }))

    log.Println("Server starting on :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

## Advanced Debugging Tools

### kubectl debug Enhanced

Create advanced debugging workflows:

```bash
#!/bin/bash
# advanced-kubectl-debug.sh - Advanced Kubernetes debugging toolkit

set -euo pipefail

POD_NAME="${1:-}"
NAMESPACE="${2:-default}"
CONTAINER="${3:-}"
DEBUG_IMAGE="${4:-nicolaka/netshoot:latest}"

if [[ -z "${POD_NAME}" ]]; then
    echo "Usage: $0 <pod-name> [namespace] [container] [debug-image]"
    exit 1
fi

OUTPUT_DIR="./debug-${POD_NAME}-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${OUTPUT_DIR}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${OUTPUT_DIR}/debug.log"
}

log "Starting advanced debugging for ${NAMESPACE}/${POD_NAME}"

# Get pod information
kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o yaml > "${OUTPUT_DIR}/pod-spec.yaml"
kubectl describe pod -n "${NAMESPACE}" "${POD_NAME}" > "${OUTPUT_DIR}/pod-describe.txt"

POD_IP=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.status.podIP}')
NODE=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.nodeName}')

log "Pod IP: ${POD_IP}, Node: ${NODE}"

# If container not specified, get first container
if [[ -z "${CONTAINER}" ]]; then
    CONTAINER=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.containers[0].name}')
fi

log "Target container: ${CONTAINER}"

# Method 1: Ephemeral debug container (shares process namespace)
log "Launching ephemeral debug container..."

kubectl debug -n "${NAMESPACE}" "${POD_NAME}" \
    --image="${DEBUG_IMAGE}" \
    --target="${CONTAINER}" \
    -it -- bash -c "
        echo '=== System Information ==='
        uname -a
        cat /etc/os-release

        echo ''
        echo '=== Process List ==='
        ps auxwwf

        echo ''
        echo '=== Network Connections ==='
        netstat -tunap

        echo ''
        echo '=== Open Files ==='
        lsof | head -100

        echo ''
        echo '=== Environment Variables ==='
        env

        echo ''
        echo '=== Disk Usage ==='
        df -h

        echo ''
        echo '=== Memory Usage ==='
        free -h

        echo ''
        echo '=== Network Interfaces ==='
        ip addr show

        echo ''
        echo '=== Routing Table ==='
        ip route show

        echo ''
        echo '=== DNS Resolution ==='
        cat /etc/resolv.conf

        echo ''
        echo '=== iptables Rules (if accessible) ==='
        iptables -L -n -v 2>/dev/null || echo 'iptables not accessible'

        echo ''
        echo 'Debug shell available. Press Ctrl+D to exit.'
        bash
    " 2>&1 | tee "${OUTPUT_DIR}/debug-session.log"

# Method 2: Copy debug tools into running container
log "Copying debug tools into container..."

# Create debug tools archive
cat > /tmp/debug-tools.sh << 'EOFSCRIPT'
#!/bin/bash
# Install common debugging tools

if command -v apt-get &> /dev/null; then
    apt-get update && apt-get install -y \
        curl wget netcat-openbsd dnsutils iproute2 \
        tcpdump strace ltrace procps vim less
elif command -v yum &> /dev/null; then
    yum install -y \
        curl wget nc bind-utils iproute \
        tcpdump strace procps-ng vim less
elif command -v apk &> /dev/null; then
    apk add --no-cache \
        curl wget netcat-openbsd bind-tools iproute2 \
        tcpdump strace busybox-extras vim less
fi

echo "Debug tools installed successfully"
EOFSCRIPT

kubectl cp /tmp/debug-tools.sh "${NAMESPACE}/${POD_NAME}:/tmp/debug-tools.sh" -c "${CONTAINER}" || true
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${CONTAINER}" -- sh /tmp/debug-tools.sh || true

# Collect detailed diagnostics
log "Collecting detailed diagnostics..."

# Process information
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${CONTAINER}" -- ps auxwwf > "${OUTPUT_DIR}/processes.txt" 2>&1 || true

# Network connections
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${CONTAINER}" -- netstat -tunap > "${OUTPUT_DIR}/connections.txt" 2>&1 || true

# Environment variables
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${CONTAINER}" -- env > "${OUTPUT_DIR}/environment.txt" 2>&1 || true

# Disk usage
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${CONTAINER}" -- df -h > "${OUTPUT_DIR}/disk-usage.txt" 2>&1 || true

# Application logs
kubectl logs -n "${NAMESPACE}" "${POD_NAME}" -c "${CONTAINER}" --tail=1000 > "${OUTPUT_DIR}/logs-current.txt" 2>&1 || true
kubectl logs -n "${NAMESPACE}" "${POD_NAME}" -c "${CONTAINER}" --previous --tail=1000 > "${OUTPUT_DIR}/logs-previous.txt" 2>&1 || true

# Events
kubectl get events -n "${NAMESPACE}" --field-selector involvedObject.name="${POD_NAME}" -o yaml > "${OUTPUT_DIR}/events.yaml"

# Method 3: Node-level debugging
log "Performing node-level debugging..."

# Deploy privileged debug pod on same node
cat > "${OUTPUT_DIR}/node-debug-pod.yaml" << EOF
apiVersion: v1
kind: Pod
metadata:
  name: node-debugger-${NODE}
  namespace: kube-system
spec:
  nodeName: ${NODE}
  hostPID: true
  hostNetwork: true
  hostIPC: true
  containers:
  - name: debugger
    image: ${DEBUG_IMAGE}
    command: ['sleep', '3600']
    securityContext:
      privileged: true
    volumeMounts:
    - name: host-root
      mountPath: /host
  volumes:
  - name: host-root
    hostPath:
      path: /
  restartPolicy: Never
EOF

kubectl apply -f "${OUTPUT_DIR}/node-debug-pod.yaml"
kubectl wait --for=condition=Ready pod -n kube-system "node-debugger-${NODE}" --timeout=60s || true

# Collect node-level information
log "Collecting node-level information..."

kubectl exec -n kube-system "node-debugger-${NODE}" -- chroot /host bash -c "
    echo '=== Node Information ==='
    hostname
    uptime
    uname -a

    echo ''
    echo '=== Container Runtime Info ==='
    crictl ps | grep ${POD_NAME} || true
    docker ps | grep ${POD_NAME} || true

    echo ''
    echo '=== Network Configuration ==='
    ip addr show
    ip route show

    echo ''
    echo '=== iptables Rules ==='
    iptables-save

    echo ''
    echo '=== System Resources ==='
    top -b -n 1 | head -20
    free -h
    df -h

    echo ''
    echo '=== Kernel Messages ==='
    dmesg | tail -100

    echo ''
    echo '=== SystemD Services ==='
    systemctl status kubelet
    systemctl status containerd || systemctl status docker
" > "${OUTPUT_DIR}/node-diagnostics.txt" 2>&1 || true

# Cleanup node debug pod
kubectl delete pod -n kube-system "node-debugger-${NODE}" --force --grace-period=0 || true

# Generate summary report
log "Generating debugging summary..."

cat > "${OUTPUT_DIR}/SUMMARY.md" << EOF
# Debugging Summary for ${NAMESPACE}/${POD_NAME}

## Pod Information
- **Name**: ${POD_NAME}
- **Namespace**: ${NAMESPACE}
- **Container**: ${CONTAINER}
- **IP**: ${POD_IP}
- **Node**: ${NODE}
- **Debug Date**: $(date)

## Files Generated
- \`pod-spec.yaml\`: Complete pod specification
- \`pod-describe.txt\`: Pod description and status
- \`debug-session.log\`: Interactive debug session log
- \`processes.txt\`: Running processes in container
- \`connections.txt\`: Network connections
- \`environment.txt\`: Environment variables
- \`disk-usage.txt\`: Filesystem usage
- \`logs-current.txt\`: Current container logs
- \`logs-previous.txt\`: Previous container logs (if restarted)
- \`events.yaml\`: Kubernetes events for pod
- \`node-diagnostics.txt\`: Node-level diagnostics

## Quick Checks

### Pod Status
\`\`\`
$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" 2>&1 || echo "Unable to get pod status")
\`\`\`

### Recent Events
\`\`\`
$(kubectl get events -n "${NAMESPACE}" --field-selector involvedObject.name="${POD_NAME}" --sort-by='.lastTimestamp' | tail -5)
\`\`\`

### Resource Usage
\`\`\`
$(kubectl top pod -n "${NAMESPACE}" "${POD_NAME}" 2>&1 || echo "Metrics not available")
\`\`\`

## Recommended Next Steps

1. Review logs in \`logs-current.txt\` and \`logs-previous.txt\`
2. Check for abnormal processes in \`processes.txt\`
3. Verify network connectivity in \`connections.txt\`
4. Review resource usage in \`disk-usage.txt\`
5. Check Kubernetes events in \`events.yaml\`
6. If issues persist, review \`node-diagnostics.txt\` for node-level problems

## Debug Commands Reference

### Enter debug container
\`\`\`bash
kubectl debug -n ${NAMESPACE} ${POD_NAME} --image=${DEBUG_IMAGE} --target=${CONTAINER} -it
\`\`\`

### View logs
\`\`\`bash
kubectl logs -n ${NAMESPACE} ${POD_NAME} -c ${CONTAINER} --tail=100 -f
\`\`\`

### Execute commands
\`\`\`bash
kubectl exec -n ${NAMESPACE} ${POD_NAME} -c ${CONTAINER} -it -- bash
\`\`\`

### Port forward for direct access
\`\`\`bash
kubectl port-forward -n ${NAMESPACE} ${POD_NAME} 8080:8080
\`\`\`

EOF

cat "${OUTPUT_DIR}/SUMMARY.md"

log "Debugging complete! Output directory: ${OUTPUT_DIR}"
```

## Distributed Debugging Framework

### Correlation and Root Cause Analysis

Create a framework for correlating logs, metrics, and traces:

```python
#!/usr/bin/env python3
# distributed-debugger.py - Distributed system debugging framework

import sys
import json
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Optional
import re

class DistributedDebugger:
    def __init__(self, config: Dict):
        self.config = config
        self.jaeger_url = config.get('jaeger_url', 'http://jaeger-query:16686')
        self.prometheus_url = config.get('prometheus_url', 'http://prometheus:9090')
        self.loki_url = config.get('loki_url', 'http://loki:3100')

        self.traces = []
        self.metrics = {}
        self.logs = []

    def investigate_request(self, trace_id: str = None, time_range: int = 300):
        """
        Investigate a specific request or time range
        Args:
            trace_id: Optional trace ID to investigate
            time_range: Time range in seconds to search (default 5 minutes)
        """
        print(f"Starting investigation...")
        print(f"Trace ID: {trace_id or 'Auto-detect errors'}")
        print(f"Time range: {time_range} seconds")

        end_time = datetime.now()
        start_time = end_time - timedelta(seconds=time_range)

        if trace_id:
            # Investigate specific trace
            self.analyze_trace(trace_id)
        else:
            # Find error traces
            self.find_error_traces(start_time, end_time)

        # Correlate with metrics
        self.correlate_metrics(start_time, end_time)

        # Correlate with logs
        self.correlate_logs(start_time, end_time)

        # Perform root cause analysis
        self.root_cause_analysis()

        # Generate report
        self.generate_report()

    def analyze_trace(self, trace_id: str):
        """Analyze a specific trace"""
        print(f"\nAnalyzing trace: {trace_id}")

        try:
            response = requests.get(
                f"{self.jaeger_url}/api/traces/{trace_id}",
                timeout=10
            )
            response.raise_for_status()

            trace_data = response.json()

            if 'data' in trace_data and len(trace_data['data']) > 0:
                trace = trace_data['data'][0]
                self.traces.append(trace)

                print(f"Trace found: {trace['traceID']}")
                print(f"Number of spans: {len(trace['spans'])}")

                # Analyze spans
                self._analyze_spans(trace['spans'])
            else:
                print(f"Trace not found: {trace_id}")

        except Exception as e:
            print(f"Error fetching trace: {e}")

    def find_error_traces(self, start_time: datetime, end_time: datetime):
        """Find traces with errors in time range"""
        print(f"\nSearching for error traces...")

        try:
            # Search for traces with error tag
            params = {
                'service': self.config.get('service', ''),
                'start': int(start_time.timestamp() * 1000000),
                'end': int(end_time.timestamp() * 1000000),
                'limit': 100,
                'tags': '{"error":"true"}'
            }

            response = requests.get(
                f"{self.jaeger_url}/api/traces",
                params=params,
                timeout=30
            )
            response.raise_for_status()

            traces_data = response.json()

            if 'data' in traces_data:
                self.traces = traces_data['data']
                print(f"Found {len(self.traces)} traces with errors")

                for trace in self.traces[:10]:  # Analyze top 10
                    print(f"\nTrace ID: {trace['traceID']}")
                    self._analyze_spans(trace['spans'])
            else:
                print("No error traces found")

        except Exception as e:
            print(f"Error searching traces: {e}")

    def _analyze_spans(self, spans: List[Dict]):
        """Analyze spans in a trace"""
        # Build span tree
        span_map = {span['spanID']: span for span in spans}
        root_spans = [s for s in spans if len(s.get('references', [])) == 0]

        print("\nSpan Analysis:")
        for root in root_spans:
            self._print_span_tree(root, span_map, 0)

        # Find slow spans
        slow_spans = [s for s in spans if s.get('duration', 0) > 1000000]  # > 1s
        if slow_spans:
            print("\nSlow Spans (> 1s):")
            for span in sorted(slow_spans, key=lambda x: x['duration'], reverse=True):
                print(f"  - {span['operationName']}: {span['duration']/1000000:.2f}s")

        # Find error spans
        error_spans = [s for s in spans if any(t.get('key') == 'error' and t.get('value') == True
                                                for t in s.get('tags', []))]
        if error_spans:
            print("\nError Spans:")
            for span in error_spans:
                print(f"  - {span['operationName']}")
                error_logs = [log for log in span.get('logs', [])
                            if any(f.get('key') == 'error' for f in log.get('fields', []))]
                for log in error_logs:
                    for field in log.get('fields', []):
                        if field.get('key') in ['error', 'error.object', 'message']:
                            print(f"    {field.get('key')}: {field.get('value')}")

    def _print_span_tree(self, span: Dict, span_map: Dict, level: int):
        """Print span tree recursively"""
        indent = "  " * level
        duration_ms = span.get('duration', 0) / 1000
        print(f"{indent}- {span['operationName']} ({duration_ms:.2f}ms)")

        # Find child spans
        children = [s for s in span_map.values()
                   if any(ref.get('spanID') == span['spanID']
                         for ref in s.get('references', []))]

        for child in children:
            self._print_span_tree(child, span_map, level + 1)

    def correlate_metrics(self, start_time: datetime, end_time: datetime):
        """Correlate with Prometheus metrics"""
        print(f"\nCorrelating with metrics...")

        queries = [
            ('request_rate', 'rate(http_requests_total[5m])'),
            ('error_rate', 'rate(http_requests_total{status=~"5.."}[5m])'),
            ('latency_p99', 'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))'),
            ('cpu_usage', 'rate(container_cpu_usage_seconds_total[5m])'),
            ('memory_usage', 'container_memory_usage_bytes'),
        ]

        for metric_name, query in queries:
            try:
                params = {
                    'query': query,
                    'start': start_time.isoformat() + 'Z',
                    'end': end_time.isoformat() + 'Z',
                    'step': '15s'
                }

                response = requests.get(
                    f"{self.prometheus_url}/api/v1/query_range",
                    params=params,
                    timeout=10
                )
                response.raise_for_status()

                data = response.json()

                if data['status'] == 'success' and data['data']['result']:
                    self.metrics[metric_name] = data['data']['result']
                    print(f"  - {metric_name}: {len(data['data']['result'])} series")

            except Exception as e:
                print(f"  - Error fetching {metric_name}: {e}")

    def correlate_logs(self, start_time: datetime, end_time: datetime):
        """Correlate with Loki logs"""
        print(f"\nCorrelating with logs...")

        try:
            # Query for error logs
            query = '{level=~"error|ERROR"}'

            params = {
                'query': query,
                'start': int(start_time.timestamp() * 1000000000),
                'end': int(end_time.timestamp() * 1000000000),
                'limit': 1000
            }

            response = requests.get(
                f"{self.loki_url}/loki/api/v1/query_range",
                params=params,
                timeout=30
            )
            response.raise_for_status()

            data = response.json()

            if data['status'] == 'success' and 'data' in data:
                result = data['data']['result']
                for stream in result:
                    for value in stream.get('values', []):
                        timestamp, log_line = value
                        self.logs.append({
                            'timestamp': timestamp,
                            'log': log_line,
                            'labels': stream['stream']
                        })

                print(f"Found {len(self.logs)} error logs")

                # Group by error pattern
                error_patterns = {}
                for log in self.logs:
                    # Extract error message
                    error_match = re.search(r'error[:\s]+([^\n]+)', log['log'], re.IGNORECASE)
                    if error_match:
                        error_msg = error_match.group(1)[:100]
                        error_patterns[error_msg] = error_patterns.get(error_msg, 0) + 1

                print("\nTop Error Patterns:")
                for pattern, count in sorted(error_patterns.items(),
                                            key=lambda x: x[1], reverse=True)[:10]:
                    print(f"  - ({count}x) {pattern}")

        except Exception as e:
            print(f"Error fetching logs: {e}")

    def root_cause_analysis(self):
        """Perform automated root cause analysis"""
        print(f"\n{'='*80}")
        print("ROOT CAUSE ANALYSIS")
        print('='*80)

        findings = []

        # Analyze traces for common issues
        if self.traces:
            for trace in self.traces:
                spans = trace.get('spans', [])

                # Check for database slowness
                db_spans = [s for s in spans if 'db' in s.get('operationName', '').lower()]
                slow_db = [s for s in db_spans if s.get('duration', 0) > 1000000]
                if slow_db:
                    findings.append({
                        'type': 'Database Performance',
                        'severity': 'HIGH',
                        'description': f"Found {len(slow_db)} slow database queries (>1s)",
                        'recommendation': "Investigate database query performance and indexing"
                    })

                # Check for external API slowness
                http_spans = [s for s in spans if 'http' in s.get('operationName', '').lower()]
                slow_http = [s for s in http_spans if s.get('duration', 0) > 5000000]
                if slow_http:
                    findings.append({
                        'type': 'External API Latency',
                        'severity': 'HIGH',
                        'description': f"Found {len(slow_http)} slow external API calls (>5s)",
                        'recommendation': "Check external API health and implement timeouts/circuit breakers"
                    })

                # Check for cascading failures
                error_spans = [s for s in spans if any(t.get('key') == 'error'
                                                      for t in s.get('tags', []))]
                if len(error_spans) > len(spans) * 0.3:
                    findings.append({
                        'type': 'Cascading Failure',
                        'severity': 'CRITICAL',
                        'description': f"{len(error_spans)}/{len(spans)} spans failed - likely cascading failure",
                        'recommendation': "Implement circuit breakers and fallback mechanisms"
                    })

        # Analyze metrics for anomalies
        if 'error_rate' in self.metrics:
            for series in self.metrics['error_rate']:
                values = [float(v[1]) for v in series['values'] if v[1] != 'NaN']
                if values and max(values) > 0.05:  # > 5% error rate
                    findings.append({
                        'type': 'High Error Rate',
                        'severity': 'HIGH',
                        'description': f"Error rate peaked at {max(values)*100:.2f}%",
                        'recommendation': "Investigate application errors and implement better error handling"
                    })

        if 'cpu_usage' in self.metrics:
            for series in self.metrics['cpu_usage']:
                values = [float(v[1]) for v in series['values'] if v[1] != 'NaN']
                if values and max(values) > 0.8:  # > 80% CPU
                    findings.append({
                        'type': 'High CPU Usage',
                        'severity': 'MEDIUM',
                        'description': f"CPU usage peaked at {max(values)*100:.0f}%",
                        'recommendation': "Consider horizontal scaling or CPU optimization"
                    })

        # Analyze logs for patterns
        if self.logs:
            # Check for specific error patterns
            timeout_errors = [l for l in self.logs if 'timeout' in l['log'].lower()]
            if timeout_errors:
                findings.append({
                    'type': 'Timeout Errors',
                    'severity': 'HIGH',
                    'description': f"Found {len(timeout_errors)} timeout errors",
                    'recommendation': "Increase timeouts or investigate slow dependencies"
                })

            oom_errors = [l for l in self.logs if 'out of memory' in l['log'].lower() or 'oom' in l['log'].lower()]
            if oom_errors:
                findings.append({
                    'type': 'Out of Memory',
                    'severity': 'CRITICAL',
                    'description': f"Found {len(oom_errors)} OOM errors",
                    'recommendation': "Increase memory limits or fix memory leaks"
                })

        # Print findings
        if findings:
            for finding in sorted(findings, key=lambda x: {'CRITICAL': 0, 'HIGH': 1, 'MEDIUM': 2}.get(x['severity'], 3)):
                print(f"\n[{finding['severity']}] {finding['type']}")
                print(f"Description: {finding['description']}")
                print(f"Recommendation: {finding['recommendation']}")
        else:
            print("\nNo specific issues identified. System appears healthy within analyzed timeframe.")

        return findings

    def generate_report(self):
        """Generate investigation report"""
        print(f"\n{'='*80}")
        print("INVESTIGATION REPORT")
        print('='*80)

        print(f"\nTraces Analyzed: {len(self.traces)}")
        print(f"Metrics Collected: {len(self.metrics)} types")
        print(f"Log Entries: {len(self.logs)}")

        print("\nFor detailed analysis, review:")
        print("- Jaeger UI:", self.jaeger_url)
        print("- Prometheus UI:", self.prometheus_url)
        print("- Grafana Dashboards")

def main():
    if len(sys.argv) < 2:
        print("Usage: distributed-debugger.py <config-file> [trace-id] [time-range-seconds]")
        sys.exit(1)

    config_file = sys.argv[1]
    trace_id = sys.argv[2] if len(sys.argv) > 2 else None
    time_range = int(sys.argv[3]) if len(sys.argv) > 3 else 300

    with open(config_file, 'r') as f:
        config = json.load(f)

    debugger = DistributedDebugger(config)
    debugger.investigate_request(trace_id, time_range)

if __name__ == "__main__":
    main()
```

## Conclusion

Debugging distributed systems in Kubernetes requires a comprehensive toolkit combining distributed tracing, log correlation, metric analysis, and systematic troubleshooting workflows. By implementing proper instrumentation, leveraging advanced debugging tools, and following structured investigation processes, teams can effectively diagnose and resolve complex issues in production microservices architectures.

Key takeaways:

1. **Distributed Tracing**: Implement OpenTelemetry for request flow visibility
2. **Correlation**: Connect logs, metrics, and traces for complete context
3. **Systematic Approach**: Follow structured debugging workflows
4. **Automation**: Automate common debugging tasks and analysis
5. **Root Cause Analysis**: Use data correlation to identify underlying issues

The tools and frameworks presented provide a solid foundation for enterprise-grade distributed system debugging in Kubernetes environments.