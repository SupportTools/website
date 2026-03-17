---
title: "Istio Observability: Metrics, Traces, and Access Logs at Scale"
date: 2028-01-27T00:00:00-05:00
draft: false
tags: ["Istio", "Service Mesh", "Observability", "Prometheus", "Jaeger", "Kiali", "OpenTelemetry"]
categories: ["Kubernetes", "Observability", "Service Mesh"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Istio observability including Telemetry API v2, custom Envoy metrics, distributed tracing with trace sampling, access log configuration, Kiali visualization, and WASM plugins for advanced telemetry."
more_link: "yes"
url: "/istio-observability-advanced-guide/"
---

Istio ships with a rich observability stack built into every Envoy sidecar, but unlocking its full potential requires understanding several distinct systems: Envoy's internal statistics engine, the Telemetry API v2 that shapes how those stats are exported, the access logging pipeline, the distributed tracing propagation chain, and the monitoring integrations that make it all visible. This guide covers each layer from initial metric collection through custom WASM-based telemetry extensions.

<!--more-->

# Istio Observability: Metrics, Traces, and Access Logs at Scale

## Istio Telemetry Architecture

Istio's telemetry stack has two generations. The older mixer-based architecture has been fully removed. The current architecture, referred to as Telemetry v2, is implemented entirely via Envoy extensions (WASM plugins compiled into the proxy) and produces data directly without any intermediate process.

```
Application Pod
├── Application Container (port 8080)
└── istio-proxy (Envoy)
      ├── Inbound listener (intercepts incoming traffic)
      │     ├── stats_inbound WASM filter → Prometheus metrics
      │     └── access_log WASM filter → stdout/file logs
      ├── Outbound listeners (intercepts outgoing traffic)
      │     ├── stats_outbound WASM filter → Prometheus metrics
      │     └── access_log WASM filter
      └── Zipkin/Jaeger trace headers forwarded to tracing backend
```

The three observability signals are:
1. **Metrics** — Prometheus-format counters, histograms, and gauges from Envoy stats
2. **Traces** — Distributed trace spans propagated across service calls
3. **Access logs** — Per-request structured logs with request metadata

## Installing Istio with Observability Components

```bash
# Install Istio with the demo profile (includes tracing, prometheus, grafana)
# For production use the default profile and add components separately
istioctl install --set profile=default \
  --set meshConfig.enableTracing=true \
  --set meshConfig.defaultConfig.tracing.sampling=1.0 \
  --set meshConfig.accessLogFile=/dev/stdout \
  --set meshConfig.accessLogEncoding=JSON

# Verify the installation
istioctl verify-install

# Check istiod and ingressgateway
kubectl get pods -n istio-system

# Install Kiali for visualization
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.20/samples/addons/kiali.yaml

# Install Prometheus
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.20/samples/addons/prometheus.yaml

# Install Grafana with Istio dashboards
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.20/samples/addons/grafana.yaml

# Install Jaeger for distributed tracing
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.20/samples/addons/jaeger.yaml
```

## Telemetry API v2: Custom Metrics

The Telemetry API allows precise control over which metrics are generated, their labels, and how they are reported. This is far more efficient than generating all metrics and then filtering at the Prometheus level.

### Default Metrics Configuration

```yaml
# Verify what the default telemetry configuration produces
# Istio generates these standard metrics by default:
# Requests total:
#   istio_requests_total{reporter, source_workload, destination_workload, response_code, ...}
# Request duration:
#   istio_request_duration_milliseconds{...}
# Request bytes:
#   istio_request_bytes{...}
# Response bytes:
#   istio_response_bytes{...}
# TCP connection events:
#   istio_tcp_connections_opened_total, istio_tcp_connections_closed_total
# TCP bytes:
#   istio_tcp_sent_bytes_total, istio_tcp_received_bytes_total

# View current telemetry resources
kubectl get telemetry -A
```

### Adding Custom Dimensions to Existing Metrics

```yaml
# telemetry-custom-dimensions.yaml
# Add request headers as dimensions on the requests_total metric
# This allows filtering by specific header values in Prometheus queries
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: custom-metrics
  namespace: production  # Applies to all pods in this namespace
spec:
  metrics:
    - providers:
        - name: prometheus
      overrides:
        # Override the istio_requests_total metric to add custom tags
        - match:
            metric: REQUEST_COUNT
            mode: CLIENT_AND_SERVER
          tagOverrides:
            # Add the x-tenant-id header as a metric dimension
            # WARNING: high-cardinality labels can cause Prometheus memory issues
            # Only use headers with bounded cardinality (e.g., tenant IDs, not user IDs)
            tenant_id:
              value: "request.headers['x-tenant-id'] | 'unknown'"
            # Add the API version from headers
            api_version:
              value: "request.headers['x-api-version'] | 'v1'"
            # Add response content type
            response_content_type:
              value: "response.headers['content-type'] | 'unknown'"
```

### Disabling Metrics for Specific Services

```yaml
# telemetry-disable-health-metrics.yaml
# Health check endpoints generate high-volume low-value metrics
# Disable reporting for these endpoints to reduce metric cardinality
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: disable-health-metrics
  namespace: production
spec:
  # Target only the pods matching this selector
  selector:
    matchLabels:
      app: my-api
  metrics:
    - providers:
        - name: prometheus
      overrides:
        - match:
            metric: ALL_METRICS
            mode: SERVER
          # Disable all metrics when the request path is a health check
          disabled:
            value: "request.url_path.startsWith('/health') || request.url_path.startsWith('/ready') || request.url_path.startsWith('/metrics')"
```

### Adding New Custom Metrics via STATS Plugin

```yaml
# istio-operator-custom-stats.yaml
# Configure the EnvoyFilter to expose additional Envoy statistics
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: custom-envoy-stats
  namespace: istio-system
spec:
  configPatches:
    - applyTo: HTTP_FILTER
      match:
        context: SIDECAR_INBOUND
        listener:
          filterChain:
            filter:
              name: "envoy.filters.network.http_connection_manager"
      patch:
        operation: MERGE
        value:
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.http.wasm.v3.Wasm
            config:
              configuration:
                "@type": type.googleapis.com/google.protobuf.StringValue
                # Expose circuit breaker and retry statistics
                value: |
                  {
                    "debug": "false",
                    "stat_prefix": "istio",
                    "metrics": [
                      {
                        "dimensions": {
                          "source_cluster": "node.metadata['CLUSTER_ID']",
                          "destination_cluster": "upstream_peer.cluster_id"
                        }
                      }
                    ]
                  }
```

## Envoy Access Log Configuration

### Global Access Log Format

```yaml
# istio-config-access-logs.yaml
# Configure the global access log format in the mesh config
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio
  namespace: istio-system
spec:
  meshConfig:
    # Log to stdout (captured by the container log driver)
    accessLogFile: /dev/stdout
    # JSON encoding for structured logging with log aggregation systems
    accessLogEncoding: JSON
    # Custom access log format
    # All available fields: https://www.envoyproxy.io/docs/envoy/latest/configuration/observability/access_log/usage
    accessLogFormat: |
      {
        "timestamp": "%START_TIME%",
        "method": "%REQ(:METHOD)%",
        "path": "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%",
        "protocol": "%PROTOCOL%",
        "response_code": "%RESPONSE_CODE%",
        "response_flags": "%RESPONSE_FLAGS%",
        "bytes_received": "%BYTES_RECEIVED%",
        "bytes_sent": "%BYTES_SENT%",
        "duration": "%DURATION%",
        "upstream_service_time": "%RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)%",
        "x_forwarded_for": "%REQ(X-FORWARDED-FOR)%",
        "user_agent": "%REQ(USER-AGENT)%",
        "request_id": "%REQ(X-REQUEST-ID)%",
        "trace_id": "%REQ(X-B3-TRACEID)%",
        "span_id": "%REQ(X-B3-SPANID)%",
        "authority": "%REQ(:AUTHORITY)%",
        "upstream_host": "%UPSTREAM_HOST%",
        "upstream_cluster": "%UPSTREAM_CLUSTER%",
        "upstream_local_address": "%UPSTREAM_LOCAL_ADDRESS%",
        "downstream_local_address": "%DOWNSTREAM_LOCAL_ADDRESS%",
        "downstream_remote_address": "%DOWNSTREAM_REMOTE_ADDRESS%",
        "source_workload": "%ENVIRONMENT(WORKLOAD_NAME)%",
        "source_namespace": "%ENVIRONMENT(POD_NAMESPACE)%"
      }
```

### Per-Service Access Log Override via Telemetry API

```yaml
# telemetry-access-logs-service.yaml
# Customize access logs for a specific service
# This is useful for services with very high request rates where
# you want to reduce log verbosity
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: api-gateway-access-logs
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-gateway
  accessLogging:
    - providers:
        - name: envoy
      # Only log requests that resulted in an error or took more than 500ms
      filter:
        expression: "response.code >= 400 || request.duration > duration('500ms')"
```

### Sending Access Logs to OpenTelemetry Collector

```yaml
# EnvoyFilter to configure OTLP log export
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: otel-access-log
  namespace: istio-system
spec:
  configPatches:
    - applyTo: NETWORK_FILTER
      match:
        listener:
          filterChain:
            filter:
              name: "envoy.filters.network.http_connection_manager"
      patch:
        operation: MERGE
        value:
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
            access_log:
              - name: envoy.access_loggers.open_telemetry
                typed_config:
                  "@type": type.googleapis.com/envoy.extensions.access_loggers.open_telemetry.v3.OpenTelemetryAccessLogConfig
                  common_config:
                    log_name: "otel_envoy_accesslog"
                    grpc_service:
                      envoy_grpc:
                        cluster_name: outbound|4317||otel-collector.monitoring.svc.cluster.local
                  body:
                    string_value: "%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %PROTOCOL% %RESPONSE_CODE%"
                  attributes:
                    values:
                      - key: "response_code"
                        value:
                          string_value: "%RESPONSE_CODE%"
                      - key: "request_duration"
                        value:
                          string_value: "%DURATION%"
```

## Distributed Tracing Configuration

### Trace Sampling Strategies

```yaml
# Sampling must be configured carefully — too high burns storage,
# too low misses rare issues

# Option 1: Uniform sampling via mesh config (simple, recommended for dev)
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  meshConfig:
    enableTracing: true
    defaultConfig:
      tracing:
        # Sample 1% of requests in production (10 per 1000)
        sampling: 1.0
        # Increase to 100% for debugging (expensive)
        # sampling: 100.0
        zipkin:
          address: jaeger-collector.monitoring:9411

# Option 2: Dynamic sampling via EnvoyFilter (probability-based)
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: dynamic-sampling
  namespace: istio-system
spec:
  configPatches:
    - applyTo: HTTP_FILTER
      match:
        context: ANY
        listener:
          filterChain:
            filter:
              name: "envoy.filters.network.http_connection_manager"
      patch:
        operation: MERGE
        value:
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
            tracing:
              provider:
                name: envoy.tracers.zipkin
                typed_config:
                  "@type": type.googleapis.com/envoy.config.trace.v3.ZipkinConfig
                  collector_cluster: "outbound|9411||jaeger-collector.monitoring.svc.cluster.local"
                  collector_endpoint: "/api/v2/spans"
                  collector_endpoint_version: HTTP_JSON
              # Random sampling at 1%
              random_sampling:
                value: 1.0
              # Force trace if x-b3-sampled: 1 header is present
              # This allows per-request trace forcing for debugging
              overall_sampling:
                value: 1.0
```

### Trace Context Propagation

Applications must forward trace headers for distributed traces to work end-to-end. Envoy injects headers on the first request but applications must propagate them on outbound calls.

```go
// pkg/tracing/propagation.go
// Helper to propagate Istio/B3 trace headers in Go HTTP clients

package tracing

import (
    "net/http"

    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/contrib/propagators/b3"
)

// TraceHeaders contains the B3 trace context headers that Istio uses
var TraceHeaders = []string{
    "x-request-id",
    "x-b3-traceid",
    "x-b3-spanid",
    "x-b3-parentspanid",
    "x-b3-sampled",
    "x-b3-flags",
    "b3",
    // Jaeger headers
    "uber-trace-id",
    // W3C trace context
    "traceparent",
    "tracestate",
}

// PropagateHeaders copies trace headers from an incoming request
// to an outgoing request. This must be called for every outbound
// HTTP call to maintain the distributed trace chain.
func PropagateHeaders(incoming *http.Request, outgoing *http.Request) {
    for _, header := range TraceHeaders {
        if value := incoming.Header.Get(header); value != "" {
            outgoing.Header.Set(header, value)
        }
    }
}

// InstrumentedTransport wraps an http.RoundTripper to automatically
// propagate trace headers from a context.
type InstrumentedTransport struct {
    Base        http.RoundTripper
    Propagators propagation.TextMapPropagator
}

// RoundTrip implements http.RoundTripper
func (t *InstrumentedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    // Inject trace context from the request context into headers
    t.Propagators.Inject(req.Context(), propagation.HeaderCarrier(req.Header))
    return t.Base.RoundTrip(req)
}

// NewInstrumentedClient creates an http.Client that automatically propagates
// distributed trace context. The propagator should be the same one used
// by the application's OpenTelemetry SDK initialization.
func NewInstrumentedClient(propagators propagation.TextMapPropagator) *http.Client {
    return &http.Client{
        Transport: &InstrumentedTransport{
            Base:        http.DefaultTransport,
            Propagators: propagators,
        },
    }
}
```

### Jaeger Production Deployment

```yaml
# jaeger/jaeger-production.yaml
# Production Jaeger deployment with Elasticsearch backend
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-production
  namespace: monitoring
spec:
  strategy: production
  # Production strategy uses a dedicated collector and query service
  collector:
    replicas: 3
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        memory: 1Gi
    # High queue size to handle bursts
    options:
      collector:
        queue-size: 100000
        num-workers: 50
  # Query service for the Jaeger UI
  query:
    replicas: 2
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
  # Elasticsearch storage backend
  storage:
    type: elasticsearch
    options:
      es:
        server-urls: https://elasticsearch-es-http.elastic-system:9200
        index-prefix: jaeger
        tls:
          ca: /es/certificates/ca.crt
    secretName: jaeger-es-credentials
  # Automatic span index cleanup (keep 7 days)
  esIndexCleaner:
    enabled: true
    numberOfDays: 7
    schedule: "55 23 * * *"
```

## Kiali Configuration and Integration

### Kiali CR Configuration

```yaml
# kiali/kiali-cr.yaml
apiVersion: kiali.io/v1alpha1
kind: Kiali
metadata:
  name: kiali
  namespace: istio-system
spec:
  auth:
    strategy: openid
    openid:
      client_id: kiali
      issuer_uri: https://dex.example.com
      username_claim: email
  external_services:
    prometheus:
      url: http://kube-prometheus-stack-prometheus.monitoring:9090
    grafana:
      enabled: true
      in_cluster_url: http://kube-prometheus-stack-grafana.monitoring
      url: https://grafana.example.com
      dashboards:
        - name: "Istio Service Dashboard"
          variables:
            namespace: var-namespace
            service: var-service
        - name: "Istio Workload Dashboard"
          variables:
            namespace: var-namespace
            workload: var-workload
    tracing:
      enabled: true
      in_cluster_url: http://jaeger-query.monitoring:16686
      url: https://jaeger.example.com
      use_grpc: true
      grpc_port: 16685
  # Tune the graph rendering for large deployments
  kiali_feature_flags:
    certificates_information_indicators:
      enabled: true
    # Show cross-namespace graph edges
    istio_annotation_action: true
    # Enable the validations for Istio resources
    validations:
      ignore: []
  # Namespace inclusion list — avoid scanning all namespaces in large clusters
  deployment:
    accessible_namespaces:
      - production
      - staging
      - platform
```

### Kiali Custom Dashboards via Annotations

```yaml
# Annotate a service to provide Kiali with custom dashboard links
apiVersion: v1
kind: Service
metadata:
  name: my-api
  namespace: production
  annotations:
    # Custom metric dashboard for this specific service
    kiali.io/health-annotation: custom
    # Link to the Grafana dashboard for this service
    "grafana.io/dashboard-url": "https://grafana.example.com/d/my-api-dashboard"
```

## WASM Plugins for Custom Telemetry

WASM plugins allow injecting custom logic into Envoy's request processing path. This is useful for adding business-specific telemetry that cannot be expressed through the standard Telemetry API.

### Building a WASM Plugin in Go

```go
// wasm/tenant-metrics/main.go
// WASM plugin that extracts tenant ID from JWT claims and adds it
// as a metric label to Envoy stats

//go:build ignore
// +build ignore

package main

import (
    "github.com/tetratelabs/proxy-wasm-go-sdk/proxywasm"
    "github.com/tetratelabs/proxy-wasm-go-sdk/proxywasm/types"
)

// main is called once when the WASM module is loaded
func main() {
    proxywasm.SetVMContext(&vmContext{})
}

type vmContext struct{}

// OnVMStart is called when the VM starts
func (*vmContext) OnVMStart(vmConfigurationSize int) types.OnVMStartStatus {
    return types.OnVMStartStatusOK
}

// NewPluginContext creates a new plugin context per filter chain
func (*vmContext) NewPluginContext(contextID uint32) types.PluginContext {
    return &pluginContext{contextID: contextID}
}

type pluginContext struct {
    contextID uint32
}

// OnPluginStart is called when the plugin starts
func (*pluginContext) OnPluginStart(pluginConfigurationSize int) types.OnPluginStartStatus {
    return types.OnPluginStartStatusOK
}

// NewHttpContext creates a new context for each HTTP request
func (*pluginContext) NewHttpContext(contextID uint32) types.HttpContext {
    return &httpContext{contextID: contextID}
}

type httpContext struct {
    contextID uint32
    tenantID  string
}

// OnHttpRequestHeaders is called when request headers arrive
func (ctx *httpContext) OnHttpRequestHeaders(numHeaders int, endOfStream bool) types.Action {
    // Extract the tenant ID header
    tenantID, err := proxywasm.GetHttpRequestHeader("x-tenant-id")
    if err != nil || tenantID == "" {
        tenantID = "unknown"
    }
    ctx.tenantID = tenantID
    return types.ActionContinue
}

// OnHttpResponseHeaders is called when response headers arrive
// This is where metrics are emitted with full request context
func (ctx *httpContext) OnHttpResponseHeaders(numHeaders int, endOfStream bool) types.Action {
    status, _ := proxywasm.GetHttpResponseHeader(":status")

    // Increment a custom counter with tenant_id dimension
    // Metric name format: <prefix>.<metric_name>
    metricName := "tenant_requests_total." + ctx.tenantID + "." + status
    if err := proxywasm.IncrementSharedData(metricName, 1); err != nil {
        proxywasm.LogWarnf("Failed to increment metric: %v", err)
    }

    return types.ActionContinue
}

// OnHttpStreamDone is called when the stream completes
func (ctx *httpContext) OnHttpStreamDone() {}
```

### Deploying the WASM Plugin

```yaml
# wasm-plugin.yaml
# Deploy the WASM plugin via Istio's WasmPlugin CRD
apiVersion: extensions.istio.io/v1alpha1
kind: WasmPlugin
metadata:
  name: tenant-metrics
  namespace: production
spec:
  # Apply to all pods in the production namespace
  selector:
    matchLabels: {}
  # WASM binary stored in OCI registry
  url: oci://ghcr.io/my-org/wasm-plugins/tenant-metrics:v1.2.0
  # Verify the WASM plugin image signature
  imagePullSecret: ghcr-credentials
  # Plugin phase: AUTHN, AUTHZ, or STATS
  phase: STATS
  # Priority: lower number = higher priority within the same phase
  priority: 10
  # Plugin configuration passed to OnPluginStart
  pluginConfig:
    metric_prefix: "istio_custom"
    cardinality_limit: 1000
```

## Prometheus Recording Rules for Istio

```yaml
# prometheus-rules-istio.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: istio-recording-rules
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: istio.rules
      interval: 30s
      rules:
        # Pre-compute success rate by workload to avoid expensive queries in dashboards
        - record: workload:istio_requests:rate5m
          expr: |
            sum(rate(istio_requests_total[5m]))
            by (source_workload, source_workload_namespace,
                destination_workload, destination_workload_namespace)

        - record: workload:istio_request_duration_milliseconds:p99_rate5m
          expr: |
            histogram_quantile(0.99,
              sum(rate(istio_request_duration_milliseconds_bucket[5m]))
              by (le, destination_workload, destination_workload_namespace)
            )

        - record: workload:istio_request_duration_milliseconds:p50_rate5m
          expr: |
            histogram_quantile(0.50,
              sum(rate(istio_request_duration_milliseconds_bucket[5m]))
              by (le, destination_workload, destination_workload_namespace)
            )

        # Success rate (non-5xx responses) by destination workload
        - record: workload:istio_requests_success_rate:rate5m
          expr: |
            (
              sum(rate(istio_requests_total{response_code!~"5.."}[5m]))
              by (destination_workload, destination_workload_namespace)
            ) /
            (
              sum(rate(istio_requests_total[5m]))
              by (destination_workload, destination_workload_namespace)
            )

    - name: istio.alerts
      rules:
        # Alert when success rate drops below 99% for 5 minutes
        - alert: IstioWorkloadHighErrorRate
          expr: |
            workload:istio_requests_success_rate:rate5m < 0.99
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High error rate on {{ $labels.destination_workload }}"
            description: "Success rate for {{ $labels.destination_workload_namespace }}/{{ $labels.destination_workload }} is {{ $value | humanizePercentage }}"

        # Alert on high p99 latency
        - alert: IstioWorkloadHighLatency
          expr: |
            workload:istio_request_duration_milliseconds:p99_rate5m > 500
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High p99 latency on {{ $labels.destination_workload }}"
            description: "p99 latency for {{ $labels.destination_workload_namespace }}/{{ $labels.destination_workload }} is {{ $value }}ms"

        # Alert when Envoy proxy restarts are detected
        - alert: IstioSidecarRestarts
          expr: |
            increase(kube_pod_container_status_restarts_total{
              container="istio-proxy"
            }[15m]) > 0
          for: 0m
          labels:
            severity: info
          annotations:
            summary: "Istio sidecar restarted in {{ $labels.namespace }}/{{ $labels.pod }}"
```

## Grafana Dashboards for Istio

### Istio Service Dashboard Key Queries

```promql
# Request rate by response code (for a specific service)
# Used in the "Requests" panel
sum(rate(istio_requests_total{
  destination_service_name="$service",
  destination_service_namespace="$namespace"
}[1m])) by (response_code)

# p50, p95, p99 latency (for a specific service)
# Used in the "Latency" panel
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket{
    destination_service_name="$service",
    destination_service_namespace="$namespace"
  }[1m])) by (le)
)

# Inbound vs outbound traffic (bytes)
sum(rate(istio_request_bytes_sum{
  destination_service_name="$service"
}[1m]))

# TCP connection count
sum(istio_tcp_connections_opened_total{
  destination_service_name="$service"
}) - sum(istio_tcp_connections_closed_total{
  destination_service_name="$service"
})
```

## Accessing Envoy Admin Interface for Debugging

```bash
# Port-forward to the Envoy admin interface of a specific pod
kubectl port-forward pod/my-app-7d4b9c-xk2lm 15000:15000

# In another terminal, query the admin interface:

# View all Envoy statistics (large output)
curl -s http://localhost:15000/stats | grep -i "retry\|circuit_breaker\|overflow" | head -30

# View Envoy configuration as JSON
curl -s http://localhost:15000/config_dump | jq '.configs[] | select(.["@type"] | contains("listeners"))'

# View active clusters and their health
curl -s http://localhost:15000/clusters | head -50

# View current listeners
curl -s http://localhost:15000/listeners

# Check circuit breaker state
curl -s http://localhost:15000/stats | grep "circuit_breakers"

# View tracing configuration
curl -s http://localhost:15000/config_dump | jq '.configs[] | select(.["@type"] | contains("tracing"))'

# Reset statistics (useful for before/after debugging)
curl -X POST http://localhost:15000/reset_counters

# Health check
curl http://localhost:15000/ready

# View memory usage
curl -s http://localhost:15000/memory
```

## Istio Debug Proxy Tool

```bash
# istioctl proxy-status shows sync status of all proxies
istioctl proxy-status

# Get detailed config for a specific proxy
istioctl proxy-config all my-app-7d4b9c-xk2lm.production

# Inspect just the listener configuration
istioctl proxy-config listeners my-app-7d4b9c-xk2lm.production

# Inspect cluster configuration (what services this proxy knows about)
istioctl proxy-config clusters my-app-7d4b9c-xk2lm.production | grep my-database

# Inspect route configuration
istioctl proxy-config routes my-app-7d4b9c-xk2lm.production --name 8080 -o json

# Inspect endpoints for a specific cluster
istioctl proxy-config endpoints my-app-7d4b9c-xk2lm.production \
  --cluster "outbound|8080||my-database.production.svc.cluster.local"

# Analyze the mesh configuration for issues
istioctl analyze --namespace production

# Check if mTLS is properly configured between two services
istioctl x authz check my-app-7d4b9c-xk2lm.production \
  -n production \
  --to my-database
```

## Summary

Istio's observability stack provides three complementary signal types that together give complete visibility into service mesh traffic. The Telemetry API v2 controls metric generation with fine-grained control over dimensions and filtering, avoiding the cardinality problems that come from indiscriminate labeling. The access log pipeline supports both inline JSON logging and OTLP export to centralized log management systems. Distributed tracing with B3 header propagation connects individual Envoy spans into full request traces across dozens of services, with sampling strategies that balance cost against coverage. Kiali integrates all three signals into a visual topology map that makes dependency analysis and anomaly detection intuitive. WASM plugins extend any of these signals with custom business logic compiled directly into the proxy, without requiring any changes to application code. The combination of recording rules, alerting rules, and Grafana dashboards converts raw Envoy statistics into actionable service health signals for operations teams.
