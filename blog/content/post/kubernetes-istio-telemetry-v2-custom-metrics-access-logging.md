---
title: "Kubernetes Istio Telemetry v2: Custom Metrics and Access Logging at Scale"
date: 2030-12-04T00:00:00-05:00
draft: false
tags: ["Istio", "Kubernetes", "Observability", "Metrics", "Prometheus", "Service Mesh", "WASM"]
categories:
- Kubernetes
- Observability
- Service Mesh
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Istio Telemetry API v2 configuration, custom metric dimensions, access log configuration, WebAssembly extensions for telemetry, Prometheus integration, and cardinality management for large service mesh deployments."
more_link: "yes"
url: "/kubernetes-istio-telemetry-v2-custom-metrics-access-logging/"
---

Istio's Telemetry API v2 represents a fundamental shift in how service mesh observability is configured. The older MixerPolicy-based telemetry system was deprecated and removed; the new in-proxy telemetry via Envoy statistics and WASM extensions is faster, more flexible, and scales to thousands of services. But the flexibility comes with complexity: configuring custom metric dimensions, managing access log cardinality, integrating WASM-based telemetry extensions, and keeping Prometheus label cardinality under control in a mesh with hundreds of services are non-trivial operational challenges.

This guide covers the Telemetry API v2 architecture, custom metric dimensions using the `stats` filter, structured access log configuration, WASM extension deployment for telemetry enrichment, Prometheus integration patterns, and cardinality management strategies for large mesh deployments.

<!--more-->

# Kubernetes Istio Telemetry v2: Custom Metrics and Access Logging at Scale

## Telemetry API v2 Architecture

The Telemetry API v2 is built on three foundational components:

1. **Envoy Stats Filter**: A native Envoy filter (not WASM) that generates standard Istio metrics — `istio_requests_total`, `istio_request_duration_milliseconds`, `istio_request_bytes`, `istio_response_bytes`. This replaced the Mixer-based metrics extension.

2. **Access Logging**: Configured via the `envoy.access_loggers` filter chain, supporting structured JSON output to stdout, file, or gRPC access log service.

3. **WASM Extensions**: Custom WebAssembly modules deployed via the `WasmPlugin` API, capable of modifying metric dimensions, adding custom access log fields, or implementing bespoke telemetry logic.

The Telemetry custom resource (CR) is the primary configuration surface. It has mesh-scope, namespace-scope, and workload-scope application, following the standard Istio configuration hierarchy.

## Understanding the Telemetry Resource

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: mesh-default
  namespace: istio-system
spec:
  # Applies to the entire mesh (no selector = mesh-wide)

  metrics:
    - providers:
        - name: prometheus
      # Override specific metric configurations
      overrides:
        - match:
            metric: ALL_METRICS
          tagOverrides:
            # Remove high-cardinality labels by default
            destination_version:
              operation: REMOVE
            source_version:
              operation: REMOVE

  accessLogging:
    - providers:
        - name: envoy
      # Disable access logging for health checks
      disabled: false
      filter:
        expression: "response.code >= 400"  # Only log errors
```

The `Telemetry` resource is namespace-scoped. A resource in `istio-system` without a selector applies to the entire mesh. A resource in `production` with a selector applies to matched workloads in that namespace.

## Configuring Custom Metric Dimensions

The default Istio metrics have a fixed set of labels (dimensions). To add custom dimensions — for example, a tenant ID from a request header, or a service version from a pod label — you use the Telemetry API with tag overrides.

### Adding Custom Dimensions from Request Headers

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: custom-dimensions-production
  namespace: production
spec:
  metrics:
    - providers:
        - name: prometheus
      overrides:
        - match:
            metric: REQUEST_COUNT
            mode: CLIENT_AND_SERVER
          tagOverrides:
            # Add tenant_id from the request header
            tenant_id:
              value: "request.headers['x-tenant-id'] | 'unknown'"

            # Add the gRPC method for gRPC services
            grpc_method:
              value: "request.headers[':path'] | ''"

            # Add response content type
            response_type:
              value: "response.headers['content-type'] | 'unknown'"
```

The expression language used in `tagOverrides` is the Common Expression Language (CEL) with Envoy attribute extensions. Available attributes include:

```
request.headers         - Map of request headers
response.headers        - Map of response headers
request.method          - HTTP method
request.path            - URL path
request.url_path        - URL path without query string
response.code           - HTTP response status code
source.labels           - Map of source pod labels
destination.labels      - Map of destination pod labels
connection.mtls         - Whether mTLS is active
```

### Disabling Default Dimensions

High-cardinality dimensions inflate Prometheus memory usage. Remove dimensions that are not useful:

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: reduce-cardinality
  namespace: istio-system
spec:
  metrics:
    - providers:
        - name: prometheus
      overrides:
        - match:
            metric: ALL_METRICS
          tagOverrides:
            # Remove version labels — use separate version tracking
            destination_version:
              operation: REMOVE
            source_version:
              operation: REMOVE
            # Remove canonical service revision
            destination_canonical_revision:
              operation: REMOVE
            source_canonical_revision:
              operation: REMOVE
            # Normalize response_flags to reduce cardinality
            response_flags:
              operation: REMOVE
```

### Conditional Dimension Addition

Add dimensions only for specific services or request patterns:

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: api-gateway-metrics
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-gateway
  metrics:
    - providers:
        - name: prometheus
      overrides:
        - match:
            metric: REQUEST_COUNT
          tagOverrides:
            # Add the API route for the gateway
            api_route:
              value: "request.headers['x-forwarded-prefix'] | request.url_path"
            # Add authenticated user type
            user_type:
              value: >-
                request.headers['x-user-role'] == 'admin' ? 'admin' :
                request.headers['x-user-role'] != '' ? 'user' : 'anonymous'
```

### Disabling Specific Metrics

For services that generate noise without useful signal, disable individual metrics:

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: health-check-filter
  namespace: production
spec:
  selector:
    matchLabels:
      app: backend-service
  metrics:
    - providers:
        - name: prometheus
      overrides:
        # Disable request bytes metric — not needed for this service
        - match:
            metric: REQUEST_BYTES
          disabled: true
        # Disable response bytes metric
        - match:
            metric: RESPONSE_BYTES
          disabled: true
```

## Access Log Configuration

### Default Access Log Format

Istio's default access log format is a JSON structure written to stdout. Configure it at mesh level or per workload:

```yaml
# mesh config (in the istio ConfigMap)
accessLogEncoding: JSON
accessLogFormat: |
  {
    "start_time": "%START_TIME%",
    "method": "%REQ(:METHOD)%",
    "path": "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%",
    "protocol": "%PROTOCOL%",
    "response_code": "%RESPONSE_CODE%",
    "response_flags": "%RESPONSE_FLAGS%",
    "response_code_details": "%RESPONSE_CODE_DETAILS%",
    "connection_termination_details": "%CONNECTION_TERMINATION_DETAILS%",
    "upstream_transport_failure_reason": "%UPSTREAM_TRANSPORT_FAILURE_REASON%",
    "bytes_received": "%BYTES_RECEIVED%",
    "bytes_sent": "%BYTES_SENT%",
    "duration": "%DURATION%",
    "upstream_service_time": "%RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)%",
    "x_forwarded_for": "%REQ(X-FORWARDED-FOR)%",
    "user_agent": "%REQ(USER-AGENT)%",
    "request_id": "%REQ(X-REQUEST-ID)%",
    "authority": "%REQ(:AUTHORITY)%",
    "upstream_host": "%UPSTREAM_HOST%",
    "upstream_cluster": "%UPSTREAM_CLUSTER%",
    "upstream_local_address": "%UPSTREAM_LOCAL_ADDRESS%",
    "downstream_local_address": "%DOWNSTREAM_LOCAL_ADDRESS%",
    "downstream_remote_address": "%DOWNSTREAM_REMOTE_ADDRESS%",
    "requested_server_name": "%REQUESTED_SERVER_NAME%",
    "route_name": "%ROUTE_NAME%"
  }
```

### Telemetry API Access Log Configuration

Use the Telemetry API for workload-specific logging:

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: access-logging-production
  namespace: production
spec:
  accessLogging:
    - providers:
        - name: envoy
      # Filter: only log non-2xx and non-3xx responses
      filter:
        expression: "response.code >= 400 || response.code == 0"

    # Additional provider: OTel access log for trace correlation
    - providers:
        - name: otel
      disabled: false
```

### Custom Access Log Provider with OTel

Configure an OpenTelemetry access log provider to route logs to your observability stack:

```yaml
# istiod configmap / mesh config
extensionProviders:
  - name: otel
    opentelemetry:
      service: opentelemetry-collector.observability.svc.cluster.local
      port: 4317

  - name: envoy-json
    envoyFileAccessLog:
      path: /dev/stdout
      logFormat:
        labels:
          start_time: "%START_TIME%"
          method: "%REQ(:METHOD)%"
          path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
          response_code: "%RESPONSE_CODE%"
          duration_ms: "%DURATION%"
          upstream_host: "%UPSTREAM_HOST%"
          trace_id: "%REQ(X-B3-TRACEID)%"
          span_id: "%REQ(X-B3-SPANID)%"
          request_id: "%REQ(X-REQUEST-ID)%"
          # Dynamic metadata from WASM plugins
          tenant_id: "%DYNAMIC_METADATA(envoy.filters.http.wasm:tenant_id)%"
```

### Filtering Access Logs to Reduce Volume

In a mesh handling millions of requests per minute, logging every request is expensive. Use CEL expressions to filter selectively:

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: selective-access-logging
  namespace: istio-system
spec:
  accessLogging:
    - providers:
        - name: envoy
      # Log: errors, slow requests, sampled successful requests
      filter:
        expression: >-
          response.code >= 400 ||
          response.code == 0 ||
          request.total_size > 1048576 ||
          response.duration > 5000
```

For sampling-based logging of successful requests (log 1% of 2xx responses):

```yaml
filter:
  expression: >-
    response.code >= 400 ||
    (response.code < 400 &&
     (request.headers['x-request-id'] | '0').endsWith('0'))
```

This logs errors always and 2xx responses approximately 10% of the time (when the request ID ends with '0').

## WASM Extensions for Telemetry

WebAssembly extensions allow you to run custom code in the Envoy data plane without modifying Istio or Envoy itself. For telemetry, WASM extensions are useful for:

- Extracting custom labels from JWT claims or custom auth headers
- Adding business-context dimensions (tenant tier, product line)
- Implementing custom sampling logic

### WasmPlugin Resource

```yaml
apiVersion: extensions.istio.io/v1alpha1
kind: WasmPlugin
metadata:
  name: tenant-extractor
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-gateway

  # Reference to the WASM module image
  url: oci://ghcr.io/myorg/wasm-plugins/tenant-extractor:v1.2.0

  # SHA256 verification of the module
  sha256: a7b9c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef

  # Phase in the filter chain
  phase: STATS

  # Priority within the phase (higher = runs later)
  priority: 10

  # Configuration passed to the WASM module
  pluginConfig:
    jwt_header: "x-jwt-payload"
    tenant_metadata_key: "tenant_id"
    default_tenant: "unknown"
```

### Writing a WASM Telemetry Extension in TinyGo

```go
// tenant-extractor/main.go
// Build with: tinygo build -o tenant-extractor.wasm -scheduler=none -target=wasi main.go

package main

import (
    "encoding/base64"
    "encoding/json"
    "strings"

    "github.com/tetratelabs/proxy-wasm-go-sdk/proxywasm"
    "github.com/tetratelabs/proxy-wasm-go-sdk/proxywasm/types"
)

type pluginContext struct {
    types.DefaultPluginContext
    jwtHeader   string
    metadataKey string
    defaultTenant string
}

type httpContext struct {
    types.DefaultHttpContext
    contextID    uint32
    pluginConfig *pluginContext
}

func main() {
    proxywasm.SetVMContext(&vmContext{})
}

type vmContext struct{}

func (*vmContext) OnVMStart(vmConfigurationSize int) types.OnVMStartStatus {
    return types.OnVMStartStatusOK
}

func (*vmContext) NewPluginContext(contextID uint32) types.PluginContext {
    return &pluginContext{
        jwtHeader:     "x-jwt-payload",
        metadataKey:   "tenant_id",
        defaultTenant: "unknown",
    }
}

func (p *pluginContext) OnPluginStart(pluginConfigurationSize int) types.OnPluginStartStatus {
    data, err := proxywasm.GetPluginConfiguration()
    if err != nil {
        return types.OnPluginStartStatusOK
    }
    var config map[string]string
    if err := json.Unmarshal(data, &config); err != nil {
        return types.OnPluginStartStatusOK
    }
    if v, ok := config["jwt_header"]; ok {
        p.jwtHeader = v
    }
    if v, ok := config["tenant_metadata_key"]; ok {
        p.metadataKey = v
    }
    if v, ok := config["default_tenant"]; ok {
        p.defaultTenant = v
    }
    return types.OnPluginStartStatusOK
}

func (p *pluginContext) NewHttpContext(contextID uint32) types.HttpContext {
    return &httpContext{contextID: contextID, pluginConfig: p}
}

func (h *httpContext) OnHttpRequestHeaders(numHeaders int, endOfStream bool) types.Action {
    // Extract JWT payload from header
    jwtPayload, err := proxywasm.GetHttpRequestHeader(h.pluginConfig.jwtHeader)
    if err != nil || jwtPayload == "" {
        // Set default tenant in dynamic metadata for metrics
        proxywasm.SetProperty(
            []string{"envoy.filters.http.wasm", h.pluginConfig.metadataKey},
            []byte(h.pluginConfig.defaultTenant),
        )
        return types.ActionContinue
    }

    // Decode JWT payload (base64url without padding)
    // This is the middle segment of the JWT
    parts := strings.Split(jwtPayload, ".")
    if len(parts) < 2 {
        proxywasm.SetProperty(
            []string{"envoy.filters.http.wasm", h.pluginConfig.metadataKey},
            []byte(h.pluginConfig.defaultTenant),
        )
        return types.ActionContinue
    }

    // Add padding if needed
    payload := parts[1]
    switch len(payload) % 4 {
    case 2:
        payload += "=="
    case 3:
        payload += "="
    }

    decoded, err := base64.StdEncoding.DecodeString(payload)
    if err != nil {
        proxywasm.SetProperty(
            []string{"envoy.filters.http.wasm", h.pluginConfig.metadataKey},
            []byte(h.pluginConfig.defaultTenant),
        )
        return types.ActionContinue
    }

    var claims map[string]interface{}
    if err := json.Unmarshal(decoded, &claims); err != nil {
        proxywasm.SetProperty(
            []string{"envoy.filters.http.wasm", h.pluginConfig.metadataKey},
            []byte(h.pluginConfig.defaultTenant),
        )
        return types.ActionContinue
    }

    tenantID, ok := claims["tenant_id"].(string)
    if !ok || tenantID == "" {
        tenantID = h.pluginConfig.defaultTenant
    }

    // Set in dynamic metadata — accessible to access logs and metrics
    proxywasm.SetProperty(
        []string{"envoy.filters.http.wasm", h.pluginConfig.metadataKey},
        []byte(tenantID),
    )

    // Also add to response headers for downstream consumers
    proxywasm.AddHttpRequestHeader("x-tenant-resolved", tenantID)

    return types.ActionContinue
}
```

### Building and Packaging WASM Extensions

```dockerfile
# Dockerfile for WASM plugin image
FROM tinygo/tinygo:0.33.0 AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY main.go .
RUN tinygo build \
    -o /app/tenant-extractor.wasm \
    -scheduler=none \
    -target=wasi \
    ./main.go

# Package as OCI image for WasmPlugin API
FROM scratch AS final
COPY --from=builder /app/tenant-extractor.wasm /plugin.wasm
```

Build and push:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/myorg/wasm-plugins/tenant-extractor:v1.2.0 \
  --push .
```

### Using WASM Metadata in Telemetry

Reference the WASM-set metadata in Telemetry tag overrides:

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: wasm-enhanced-metrics
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-gateway
  metrics:
    - providers:
        - name: prometheus
      overrides:
        - match:
            metric: REQUEST_COUNT
          tagOverrides:
            # Read the tenant_id set by the WASM plugin
            tenant_id:
              value: "filter_state['envoy.filters.http.wasm']['tenant_id'] | 'unknown'"
```

## Prometheus Integration

### Prometheus Scrape Configuration for Istio

Istio exposes metrics on port 15020 (the merged Prometheus port that combines application and sidecar metrics):

```yaml
# prometheus scrape config
scrape_configs:
  - job_name: 'istio-mesh'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      # Only scrape pods with the Istio sidecar
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: 'true'
      # Use the merged metrics port (15020)
      - source_labels: [__address__]
        action: replace
        regex: ([^:]+)(?::\d+)?
        replacement: $1:15020
        target_label: __address__
      - action: labelmap
        regex: __meta_kubernetes_pod_label_(.+)
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
```

### PodMonitor for Operator-Managed Prometheus

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: istio-sidecar-metrics
  namespace: istio-system
  labels:
    monitoring: istio
spec:
  selector:
    matchExpressions:
      - key: security.istio.io/tlsMode
        operator: Exists
  namespaceSelector:
    any: true
  podMetricsEndpoints:
    - port: http-envoy-prom
      path: /stats/prometheus
      interval: 15s
      honorLabels: true
      relabelings:
        - action: labeldrop
          regex: "__meta_kubernetes_pod_label_pod_template_hash"
```

### Key Istio Metrics for Dashboards

```promql
# Request rate by service
sum(rate(istio_requests_total[5m])) by (destination_service_name, destination_namespace)

# Error rate (5xx responses)
sum(rate(istio_requests_total{response_code=~"5.."}[5m])) by (destination_service_name)
/
sum(rate(istio_requests_total[5m])) by (destination_service_name)

# P99 latency by service
histogram_quantile(0.99,
  sum(rate(istio_request_duration_milliseconds_bucket[5m]))
  by (destination_service_name, le)
)

# mTLS usage per service
sum(rate(istio_requests_total{connection_security_policy="mutual_tls"}[5m]))
by (destination_service_name)
/
sum(rate(istio_requests_total[5m]))
by (destination_service_name)

# Bytes sent per service
sum(rate(istio_response_bytes_sum[5m])) by (destination_service_name)

# Custom dimension: per-tenant request rate (requires WASM plugin)
sum(rate(istio_requests_total[5m])) by (tenant_id, destination_service_name)
```

## Cardinality Management for Large Meshes

In a mesh with 200 services and 10 custom dimensions, the cardinality of `istio_requests_total` can easily reach 10^6 unique time series. Each Prometheus time series consumes approximately 3KB of RAM. At a million series, that is 3GB for a single metric.

### Cardinality Analysis

```bash
# List metrics with highest series count
curl -s http://prometheus:9090/api/v1/label/__name__/values | \
  jq -r '.data[]' | \
  while read metric; do
    count=$(curl -s "http://prometheus:9090/api/v1/query?query=count({__name__=\"$metric\"})" | \
      jq -r '.data.result[0].value[1] // "0"')
    echo "$count $metric"
  done | sort -rn | head -20

# Analyze cardinality of a specific label
curl -s 'http://prometheus:9090/api/v1/label/tenant_id/values' | \
  jq '.data | length'
```

### Cardinality Reduction Strategies

**Strategy 1: Remove high-cardinality labels at the Telemetry level**

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: cardinality-reduction
  namespace: istio-system
spec:
  metrics:
    - providers:
        - name: prometheus
      overrides:
        - match:
            metric: ALL_METRICS
          tagOverrides:
            # Path is high-cardinality (e.g., /api/users/12345)
            # Remove it from the default metrics
            request_path:
              operation: REMOVE
```

**Strategy 2: Bucket high-cardinality values**

```yaml
tagOverrides:
  # Convert specific path patterns to route groups
  api_route:
    value: >-
      request.url_path.startsWith('/api/users/') ? '/api/users/{id}' :
      request.url_path.startsWith('/api/orders/') ? '/api/orders/{id}' :
      request.url_path
```

**Strategy 3: Metric relabeling in Prometheus**

Use `metric_relabel_configs` to drop high-cardinality time series before they enter the TSDB:

```yaml
scrape_configs:
  - job_name: 'istio-mesh'
    # ... kubernetes_sd_configs ...
    metric_relabel_configs:
      # Drop response code detail labels
      - source_labels: [response_code_details]
        action: labeldrop

      # Replace specific tenant IDs with tier groupings
      - source_labels: [tenant_id]
        regex: 'enterprise-.*'
        target_label: tenant_tier
        replacement: enterprise
      - source_labels: [tenant_id]
        regex: 'free-.*'
        target_label: tenant_tier
        replacement: free
      # Drop the original high-cardinality label
      - action: labeldrop
        regex: tenant_id
```

**Strategy 4: Recording rules for aggregation**

Pre-aggregate high-dimensional metrics to reduce query load:

```yaml
# prometheus recording rules
groups:
  - name: istio.aggregated
    interval: 1m
    rules:
      # Aggregate request rate by service (drop pod-level dimensions)
      - record: istio:service:request_rate5m
        expr: |
          sum(rate(istio_requests_total[5m]))
          by (destination_service_name, destination_namespace, response_code)

      # P99 latency by service
      - record: istio:service:latency_p99
        expr: |
          histogram_quantile(0.99,
            sum(rate(istio_request_duration_milliseconds_bucket[5m]))
            by (destination_service_name, destination_namespace, le)
          )
```

## Telemetry for gRPC Services

gRPC services require additional configuration since the default HTTP metrics do not capture gRPC-specific dimensions:

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: grpc-enhanced-metrics
  namespace: production
spec:
  selector:
    matchLabels:
      protocol: grpc
  metrics:
    - providers:
        - name: prometheus
      overrides:
        - match:
            metric: REQUEST_COUNT
          tagOverrides:
            # gRPC service and method from the path
            grpc_service:
              value: "request.url_path.split('/')[1] | 'unknown'"
            grpc_method:
              value: "request.url_path.split('/')[2] | 'unknown'"
            # gRPC status code (different from HTTP status code)
            grpc_status:
              value: "response.headers['grpc-status'] | 'unknown'"
```

## Troubleshooting Telemetry Issues

### Verifying Telemetry Resource Application

```bash
# Check if a Telemetry resource is applied to a workload
istioctl analyze -n production

# Verify merged config for a specific pod
istioctl proxy-config listener <pod-name> -n production -o json | \
  jq '.[].filterChains[].filters[] | select(.name=="envoy.filters.network.http_connection_manager") | .typedConfig.httpFilters[] | select(.name | contains("stats"))'

# Check Envoy stats filter configuration
kubectl exec -n production <pod-name> -c istio-proxy -- \
  curl -s localhost:15000/config_dump | \
  jq '.configs[] | select(.["@type"] | contains("HttpConnectionManager")) | .dynamic_listeners'
```

### Missing Metrics

When custom dimensions are not appearing:

```bash
# Check if the stats filter is enabled
kubectl exec -n production <pod-name> -c istio-proxy -- \
  curl -s localhost:15000/stats | grep istio_requests_total

# Check for errors in the istio-proxy container
kubectl logs -n production <pod-name> -c istio-proxy | grep -i "stats\|telemetry\|wasm"

# Verify the WASM plugin is loaded
kubectl exec -n production <pod-name> -c istio-proxy -- \
  curl -s localhost:15000/config_dump | jq '.configs[] | select(.["@type"] | contains("Wasm"))'
```

### High Cardinality Alert

Set up an alert to catch cardinality explosions:

```yaml
groups:
  - name: prometheus.cardinality
    rules:
      - alert: IstioMetricsHighCardinality
        expr: |
          count(istio_requests_total) > 500000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Istio request metrics have high cardinality"
          description: "istio_requests_total has {{ $value }} unique series. Review custom dimensions."
```

## Summary

Istio Telemetry API v2 provides a production-ready framework for custom metrics and access logging that scales with your mesh. The key operational principles are: add custom dimensions sparingly and bucket high-cardinality values, use CEL expressions in access log filters to reduce volume while preserving signal, deploy WASM plugins for business-context enrichment where the standard attribute set is insufficient, and proactively manage Prometheus cardinality through metric relabeling and recording rules. With these practices, Istio telemetry becomes a precise observability tool rather than a cardinality problem.
