---
title: "Envoy Proxy: Advanced xDS Configuration and Traffic Management on Kubernetes"
date: 2027-03-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Envoy", "Service Mesh", "Networking", "xDS"]
categories: ["Kubernetes", "Networking", "Service Mesh"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep-dive guide to Envoy Proxy configuration on Kubernetes covering xDS API (LDS/RDS/CDS/EDS), dynamic configuration via control plane, HTTP filters (JWT auth, rate limiting, CORS, compression), circuit breaking, outlier detection, retry policies, and observability with Zipkin/Jaeger."
more_link: "yes"
url: "/envoy-proxy-kubernetes-advanced-configuration-guide/"
---

Envoy Proxy is the data-plane component underlying Istio, Contour, Ambassador, and Gloo. Understanding its configuration model directly — rather than through higher-level abstractions — gives platform engineers the precision to implement advanced traffic management behaviors that operator-level abstractions cannot express: custom HTTP filter chains, fine-grained circuit breaker thresholds per upstream cluster, outlier detection tuned to specific SLO targets, and distributed tracing header propagation across heterogeneous service stacks.

This guide covers Envoy's core architecture, the xDS API v3, static and dynamic configuration, every major HTTP filter category, and production observability patterns. Examples are grounded in real Kubernetes deployment scenarios rather than toy configurations.

<!--more-->

## Envoy Architecture: Listeners, Routes, Clusters, and Endpoints

Envoy's configuration model mirrors the lifecycle of an incoming request through four logical constructs.

**Listeners** bind to a network address and port and define how incoming connections are accepted. Each listener has a filter chain that specifies the protocol-level processing pipeline. An HTTPS listener decrypts TLS and passes the plaintext connection to an HTTP connection manager filter.

**Routes** (Route Configuration) define how HTTP requests are matched and forwarded. A route configuration contains virtual hosts, each with a list of routes that match on prefix, path, headers, or query parameters and direct traffic to a named cluster or perform a redirect/direct response.

**Clusters** represent upstream services. A cluster defines the load balancing policy, connection pool settings, circuit breaker thresholds, TLS settings for upstream connections, and health check configuration. Clusters reference endpoints either statically or through EDS.

**Endpoints** are the individual IP:port pairs that make up a cluster. In a Kubernetes deployment, endpoints correspond to pod IPs discovered from the Kubernetes API.

### xDS API v3 Resource Types

The xDS APIs allow a control plane to push configuration updates to Envoy without restarting the proxy. Each resource type has a corresponding xDS API.

| API | Resource | Controls |
|---|---|---|
| LDS | Listener | Port bindings, filter chains |
| RDS | RouteConfiguration | Virtual hosts, route matching, traffic splitting |
| CDS | Cluster | Upstream service definitions, LB policy |
| EDS | ClusterLoadAssignment | Endpoint IPs and health status |
| SDS | Secret | TLS certificates for downstream/upstream |
| VHDS | VirtualHost | Virtual host updates independent of full RDS |

## Bootstrap Configuration

The bootstrap configuration is the only static file Envoy reads at startup. It points to the control plane xDS server and optionally defines static resources and admin interface settings.

```yaml
# envoy-bootstrap.yaml
# Envoy bootstrap configuration for dynamic xDS from a control plane
admin:
  address:
    socket_address:
      protocol: TCP
      address: 127.0.0.1   # Only expose admin on loopback
      port_value: 9901

# Static resources define resources that are always present regardless of xDS updates
static_resources:
  clusters:
    # The control plane cluster for xDS discovery
    - name: xds_cluster
      connect_timeout: 5s
      type: STATIC
      load_assignment:
        cluster_name: xds_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: xds-control-plane.envoy-system.svc.cluster.local
                      port_value: 18000
      http2_protocol_options: {}   # xDS requires HTTP/2
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          common_tls_context:
            tls_certificates:
              - certificate_chain:
                  filename: /etc/envoy/certs/tls.crt
                key:
                  filename: /etc/envoy/certs/tls.key
            validation_context:
              trusted_ca:
                filename: /etc/envoy/certs/ca.crt

# Dynamic resources tell Envoy where to fetch LDS and CDS configuration
dynamic_resources:
  lds_config:
    api_config_source:
      api_type: GRPC
      transport_api_version: V3
      grpc_services:
        - envoy_grpc:
            cluster_name: xds_cluster
      set_node_on_first_message_only: true
  cds_config:
    api_config_source:
      api_type: GRPC
      transport_api_version: V3
      grpc_services:
        - envoy_grpc:
            cluster_name: xds_cluster

node:
  id: envoy-gateway-01         # Unique identifier for this Envoy instance
  cluster: edge-gateway        # Logical cluster name used by the control plane for grouping

layered_runtime:
  layers:
    - name: static_layer_0
      static_layer:
        # Override default runtime values
        envoy.reloadable_features.enable_grpc_async_client_cache: true
        # Increase connection pool size for high-traffic clusters
        overload.global_downstream_max_connections: 50000
```

## Static Configuration for Standalone Deployment

For sidecar or standalone deployments where dynamic xDS is not used, full static configuration is more appropriate.

```yaml
# envoy-static.yaml
# Complete static Envoy configuration for a production ingress proxy
admin:
  address:
    socket_address:
      address: 0.0.0.0
      port_value: 9901

static_resources:
  listeners:
    # HTTPS listener on port 8443
    - name: https_listener
      address:
        socket_address:
          protocol: TCP
          address: 0.0.0.0
          port_value: 8443
      listener_filters:
        # Detect TLS before creating a filter chain
        - name: envoy.filters.listener.tls_inspector
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector
      filter_chains:
        - filter_chain_match:
            transport_protocol: tls
          transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              common_tls_context:
                tls_certificates:
                  - certificate_chain:
                      filename: /etc/envoy/certs/tls.crt
                    key:
                      filename: /etc/envoy/certs/tls.key
                alpn_protocols:
                  - h2
                  - http/1.1
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: ingress_https
                use_remote_address: true
                # Forward the original client IP in x-forwarded-for
                xff_num_trusted_hops: 1
                codec_type: AUTO
                route_config:
                  name: local_route
                  virtual_hosts:
                    - name: api_service
                      domains:
                        - "api.support.tools"
                      routes:
                        - match:
                            prefix: "/v1/"
                          route:
                            cluster: api_v1_cluster
                            timeout: 30s
                            retry_policy:
                              retry_on: "5xx,reset,connect-failure"
                              num_retries: 3
                              per_try_timeout: 10s
                        - match:
                            prefix: "/v2/"
                          route:
                            cluster: api_v2_cluster
                            timeout: 30s
                        - match:
                            prefix: "/"
                          redirect:
                            path_redirect: "/v2/"
                # HTTP filter chain — processed in order for each request
                http_filters:
                  # JWT authentication (validates Bearer tokens)
                  - name: envoy.filters.http.jwt_authn
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.jwt_authn.v3.JwtAuthentication
                      providers:
                        auth0_provider:
                          issuer: "https://auth.support.tools/"
                          audiences:
                            - "https://api.support.tools"
                          remote_jwks:
                            http_uri:
                              uri: "https://auth.support.tools/.well-known/jwks.json"
                              cluster: auth_jwks_cluster
                              timeout: 5s
                            cache_duration:
                              seconds: 300  # Cache JWKS for 5 minutes
                          forward: true     # Forward the JWT to the upstream
                          payload_in_metadata: jwt_payload
                      rules:
                        # Require JWT on all API routes
                        - match:
                            prefix: "/v1/"
                          requires:
                            provider_name: auth0_provider
                        - match:
                            prefix: "/v2/"
                          requires:
                            provider_name: auth0_provider
                        # Health check endpoint does not require authentication
                        - match:
                            prefix: "/healthz"

                  # Rate limiting via external rate limit service
                  - name: envoy.filters.http.ratelimit
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.ratelimit.v3.RateLimit
                      domain: api_gateway
                      stage: 0
                      rate_limit_service:
                        grpc_service:
                          envoy_grpc:
                            cluster_name: ratelimit_cluster
                        transport_api_version: V3
                      failure_mode_deny: false  # Allow requests when rate limit service is unavailable

                  # CORS filter for browser clients
                  - name: envoy.filters.http.cors
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.cors.v3.CorsPolicy

                  # Gzip compression for response bodies
                  - name: envoy.filters.http.compression
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.compressor.v3.Compressor
                      response_direction_config:
                        common_config:
                          min_content_length: 1024   # Only compress responses >= 1KB
                          content_type:
                            - text/html
                            - text/plain
                            - application/json
                            - application/javascript
                        disable_on_etag_header: true
                      compressor_library:
                        name: envoy.compression.gzip.compressor
                        typed_config:
                          "@type": type.googleapis.com/envoy.extensions.compression.gzip.compressor.v3.Gzip
                          memory_level: 9
                          compression_level: BEST_SPEED
                          compression_strategy: DEFAULT_STRATEGY

                  # Router — must be the last filter in the chain
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                      suppress_envoy_headers: false  # Keep x-envoy-* headers for debugging

                # Access logging to stdout
                access_log:
                  - name: envoy.access_loggers.stdout
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog
                      log_format:
                        json_format:
                          timestamp: "%START_TIME%"
                          method: "%REQ(:METHOD)%"
                          path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
                          protocol: "%PROTOCOL%"
                          response_code: "%RESPONSE_CODE%"
                          response_flags: "%RESPONSE_FLAGS%"
                          bytes_received: "%BYTES_RECEIVED%"
                          bytes_sent: "%BYTES_SENT%"
                          duration_ms: "%DURATION%"
                          upstream_host: "%UPSTREAM_HOST%"
                          upstream_cluster: "%UPSTREAM_CLUSTER%"
                          x_forwarded_for: "%REQ(X-FORWARDED-FOR)%"
                          request_id: "%REQ(X-REQUEST-ID)%"
                          user_agent: "%REQ(USER-AGENT)%"

  clusters:
    # API v1 upstream cluster
    - name: api_v1_cluster
      connect_timeout: 5s
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      load_assignment:
        cluster_name: api_v1_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: api-v1.default.svc.cluster.local
                      port_value: 8080
      # HTTP/2 for upstream connections (use with gRPC backends)
      http2_protocol_options: {}
      # Circuit breaker configuration
      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 1024        # Maximum concurrent TCP connections
            max_pending_requests: 1024   # Maximum queued requests
            max_requests: 2048           # Maximum concurrent HTTP requests
            max_retries: 10              # Maximum concurrent retries
          - priority: HIGH
            max_connections: 2048
            max_pending_requests: 2048
            max_requests: 4096
            max_retries: 20
      # Outlier detection — automatic unhealthy host removal
      outlier_detection:
        consecutive_5xx: 5           # Eject after 5 consecutive 5xx responses
        interval: 10s                # Evaluation interval
        base_ejection_time: 30s      # Minimum ejection duration
        max_ejection_percent: 50     # Maximum % of hosts ejected simultaneously
        consecutive_gateway_failure: 3
        enforcing_consecutive_5xx: 100
        enforcing_success_rate: 100
        success_rate_minimum_hosts: 2
        success_rate_request_volume: 100
        success_rate_stdev_factor: 1900  # Eject if success rate < mean - 1.9*stdev
      # Active health checking
      health_checks:
        - timeout: 5s
          interval: 10s
          unhealthy_threshold: 3
          healthy_threshold: 2
          http_health_check:
            path: /healthz
            expected_statuses:
              - start: 200
                end: 200
      # Upstream TLS
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          common_tls_context:
            validation_context:
              trusted_ca:
                filename: /etc/ssl/certs/ca-certificates.crt
          sni: api-v1.default.svc.cluster.local

    # API v2 upstream cluster with weighted load balancing between canary and stable
    - name: api_v2_cluster
      connect_timeout: 5s
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      load_assignment:
        cluster_name: api_v2_cluster
        endpoints:
          # Stable: 90% of traffic
          - locality:
              region: us-east-1
              zone: stable
            load_balancing_weight: 90
            lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: api-v2-stable.default.svc.cluster.local
                      port_value: 8080
          # Canary: 10% of traffic
          - locality:
              region: us-east-1
              zone: canary
            load_balancing_weight: 10
            lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: api-v2-canary.default.svc.cluster.local
                      port_value: 8080
      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 512
            max_pending_requests: 512
            max_requests: 1024
            max_retries: 5

    # Auth JWKS cluster for JWT key fetching
    - name: auth_jwks_cluster
      connect_timeout: 5s
      type: LOGICAL_DNS
      load_assignment:
        cluster_name: auth_jwks_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: auth.support.tools
                      port_value: 443
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          sni: auth.support.tools

    # External rate limit service
    - name: ratelimit_cluster
      connect_timeout: 5s
      type: STRICT_DNS
      http2_protocol_options: {}
      load_assignment:
        cluster_name: ratelimit_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: ratelimit.envoy-system.svc.cluster.local
                      port_value: 8081
```

## Rate Limiting with External Rate Limit Service

Envoy's external rate limiting delegates rate limit decisions to an external gRPC service that implements the Envoy RateLimit API. This separation allows rate limit rules to be stored in Redis and updated without reloading Envoy.

### Rate Limit Service Deployment

```yaml
# ratelimit-deployment.yaml
# Envoy Rate Limit Service using Redis as backend
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ratelimit
  namespace: envoy-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ratelimit
  template:
    metadata:
      labels:
        app: ratelimit
    spec:
      containers:
        - name: ratelimit
          image: envoyproxy/ratelimit:master
          command:
            - /bin/ratelimit
          env:
            - name: LOG_LEVEL
              value: "WARN"
            - name: REDIS_SOCKET_TYPE
              value: "tcp"
            - name: REDIS_URL
              value: "redis-master.envoy-system.svc.cluster.local:6379"
            - name: RUNTIME_ROOT
              value: "/data"
            - name: RUNTIME_SUBDIRECTORY
              value: "ratelimit"
            - name: RUNTIME_WATCH_ROOT
              value: "false"
            - name: USE_STATSD
              value: "false"
          ports:
            - name: grpc
              containerPort: 8081
            - name: http
              containerPort: 8080
            - name: debug
              containerPort: 6070
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          volumeMounts:
            - name: ratelimit-config
              mountPath: /data/ratelimit/config
      volumes:
        - name: ratelimit-config
          configMap:
            name: ratelimit-config
---
# ConfigMap with rate limit rules
apiVersion: v1
kind: ConfigMap
metadata:
  name: ratelimit-config
  namespace: envoy-system
data:
  config.yaml: |
    domain: api_gateway
    descriptors:
      # Per-IP rate limit: 1000 requests per minute
      - key: remote_address
        rate_limit:
          unit: MINUTE
          requests_per_unit: 1000

      # Per-authenticated-user rate limit: 5000 requests per minute
      - key: jwt_sub
        rate_limit:
          unit: MINUTE
          requests_per_unit: 5000

      # Per-endpoint rate limit for expensive operations
      - key: header_match
        value: POST_orders
        rate_limit:
          unit: SECOND
          requests_per_unit: 100

      # Burst protection: maximum 50 requests per second per IP
      - key: remote_address
        rate_limit:
          unit: SECOND
          requests_per_unit: 50
```

### Configuring Rate Limit Actions in Routes

```yaml
# Rate limit actions embedded in a route configuration (RDS)
# These descriptors are sent to the external rate limit service
virtual_hosts:
  - name: api_service
    domains:
      - "api.support.tools"
    routes:
      - match:
          prefix: "/v2/orders"
          headers:
            - name: ":method"
              string_match:
                exact: POST
        route:
          cluster: api_v2_cluster
          # Rate limit descriptors for this specific route
          rate_limits:
            - stage: 0
              actions:
                # Include the remote IP address in the descriptor
                - remote_address: {}
            - stage: 0
              actions:
                # Include a header-based match for method-specific limits
                - header_value_match:
                    descriptor_value: POST_orders
                    headers:
                      - name: ":method"
                        string_match:
                          exact: POST
```

## Circuit Breaking Configuration

Circuit breakers prevent cascade failures by limiting the volume of requests sent to an upstream cluster. When a threshold is exceeded, Envoy returns an overflow response (503) without forwarding to the backend.

```yaml
# Circuit breaker thresholds in a cluster definition
circuit_breakers:
  thresholds:
    # DEFAULT priority applies to most requests
    - priority: DEFAULT
      # Maximum concurrent TCP connections to all endpoints in the cluster
      max_connections: 1024
      # Maximum queued HTTP requests waiting for a connection
      max_pending_requests: 512
      # Maximum concurrent active HTTP requests
      max_requests: 2048
      # Maximum concurrent retries (retries count against this limit)
      max_retries: 64
      # Track circuit breaker state per host rather than per cluster
      track_remaining: true

    # HIGH priority applies to requests with x-envoy-upstream-rq-per-try-timeout set
    - priority: HIGH
      max_connections: 2048
      max_pending_requests: 1024
      max_requests: 4096
      max_retries: 128
```

The circuit breaker state is exposed via the admin interface:

```bash
# Check circuit breaker overflow counters
curl -s http://localhost:9901/stats | grep circuit_breakers

# Example output:
# cluster.api_v1_cluster.circuit_breakers.default.cx_open: 0
# cluster.api_v1_cluster.circuit_breakers.default.cx_pool_open: 0
# cluster.api_v1_cluster.circuit_breakers.default.rq_open: 0
# cluster.api_v1_cluster.circuit_breakers.default.rq_pending_open: 0
# cluster.api_v1_cluster.circuit_breakers.default.rq_retry_open: 0
# cluster.api_v1_cluster.upstream_cx_overflow: 0
# cluster.api_v1_cluster.upstream_rq_pending_overflow: 0
# cluster.api_v1_cluster.upstream_rq_retry_overflow: 0
```

## Outlier Detection

Outlier detection automatically ejects unhealthy upstream hosts based on observed error rates. Unlike active health checks, outlier detection reacts to actual request failures rather than synthetic health check results.

```yaml
# Comprehensive outlier detection configuration
outlier_detection:
  # Eject after N consecutive 5xx responses from a single host
  consecutive_5xx: 5

  # Eject after N consecutive gateway errors (connection failure, reset, timeout)
  consecutive_gateway_failure: 3

  # Interval between outlier analysis sweeps
  interval: 10s

  # Minimum ejection duration (doubles on each successive ejection)
  base_ejection_time: 30s

  # Maximum percentage of hosts that can be ejected simultaneously
  # Setting to 100 allows all hosts to be ejected if all are failing
  max_ejection_percent: 50

  # Percentage enforcement for consecutive_5xx (0-100)
  # 100 = always eject when threshold is reached
  enforcing_consecutive_5xx: 100
  enforcing_consecutive_gateway_failure: 100

  # Success rate based ejection
  # Requires at least success_rate_minimum_hosts reporting before evaluating
  success_rate_minimum_hosts: 3

  # Minimum requests per host in the analysis window before evaluating success rate
  success_rate_request_volume: 100

  # Eject hosts whose success rate is below: mean - (stdev * factor / 1000)
  # 1900 = mean - 1.9 standard deviations
  success_rate_stdev_factor: 1900

  # Enforce success rate ejection at this percentage
  enforcing_success_rate: 100

  # Split external (5xx) and local (connection, reset) errors for separate tracking
  split_external_local_origin_errors: true
  consecutive_local_origin_failure: 3
  enforcing_consecutive_local_origin_failure: 100
  enforcing_local_origin_success_rate: 100
```

## Distributed Tracing with Zipkin

Envoy propagates distributed tracing headers and reports spans to a Zipkin-compatible collector. This requires the tracing configuration in the `HttpConnectionManager` and a Zipkin cluster.

```yaml
# Distributed tracing configuration inside HttpConnectionManager
tracing:
  provider:
    name: envoy.tracers.zipkin
    typed_config:
      "@type": type.googleapis.com/envoy.config.trace.v3.ZipkinConfig
      collector_cluster: zipkin_cluster
      collector_endpoint: "/api/v2/spans"
      collector_endpoint_version: HTTP_JSON
      # Shared spans allow the span to be shared between Envoy and the upstream
      shared_span_context: true
      trace_id_128bit: true

# Sampling percentage (0.0 to 100.0)
# Set per-route with x-envoy-force-trace header to force tracing for specific requests
client_sampling:
  value: 5.0     # Sample 5% of requests
random_sampling:
  value: 5.0
overall_sampling:
  value: 5.0

# Custom tags added to every trace span
custom_tags:
  - tag: environment
    literal:
      value: production
  - tag: cluster_name
    environment:
      name: CLUSTER_NAME
      default_value: unknown
  - tag: request_id
    request_header:
      name: x-request-id
      default_value: unknown
```

```yaml
# Zipkin cluster in static_resources
- name: zipkin_cluster
  connect_timeout: 5s
  type: STRICT_DNS
  load_assignment:
    cluster_name: zipkin_cluster
    endpoints:
      - lb_endpoints:
          - endpoint:
              address:
                socket_address:
                  address: zipkin.tracing.svc.cluster.local
                  port_value: 9411
```

## Prometheus Stats via /stats/prometheus

Envoy exposes thousands of internal statistics in Prometheus format through the admin interface. For production, scrape this endpoint with a dedicated ServiceMonitor.

```yaml
# envoy-pod-metrics-scrape.yaml
# Envoy DaemonSet with Prometheus scrape annotations
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: envoy-gateway
  namespace: envoy-system
spec:
  selector:
    matchLabels:
      app: envoy-gateway
  template:
    metadata:
      labels:
        app: envoy-gateway
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9901"
        prometheus.io/path: "/stats/prometheus"
    spec:
      containers:
        - name: envoy
          image: envoyproxy/envoy:v1.30.1
          args:
            - -c
            - /etc/envoy/envoy.yaml
            - --log-level
            - warn
            - --service-node
            - $(POD_NAME)
            - --service-cluster
            - edge-gateway
          ports:
            - name: http
              containerPort: 8080
              hostPort: 8080
            - name: https
              containerPort: 8443
              hostPort: 8443
            - name: admin
              containerPort: 9901
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          resources:
            requests:
              cpu: 200m
              memory: 128Mi
            limits:
              cpu: 2000m
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /ready
              port: 9901
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 9901
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: envoy-config
              mountPath: /etc/envoy
              readOnly: true
            - name: envoy-certs
              mountPath: /etc/envoy/certs
              readOnly: true
      volumes:
        - name: envoy-config
          configMap:
            name: envoy-config
        - name: envoy-certs
          secret:
            secretName: envoy-gateway-tls
---
# ServiceMonitor for Prometheus Operator to scrape the admin interface
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy-gateway
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: envoy-gateway
  namespaceSelector:
    matchNames:
      - envoy-system
  endpoints:
    - port: admin
      path: /stats/prometheus
      interval: 15s
```

### Key Prometheus Metrics for Envoy

```promql
# Request rate per cluster (HTTP/gRPC)
rate(envoy_cluster_upstream_rq_total{cluster_name="api_v1_cluster"}[5m])

# 99th percentile upstream request latency
histogram_quantile(0.99, rate(envoy_cluster_upstream_rq_time_bucket{cluster_name="api_v1_cluster"}[5m]))

# Circuit breaker overflow rate
rate(envoy_cluster_upstream_rq_pending_overflow{cluster_name="api_v1_cluster"}[5m])

# Outlier detection ejections
increase(envoy_cluster_outlier_detection_ejections_total{cluster_name="api_v1_cluster"}[10m])

# Active connections per cluster
envoy_cluster_upstream_cx_active{cluster_name="api_v1_cluster"}

# Downstream (client) request rate to the listener
rate(envoy_http_downstream_rq_total{http_conn_manager_prefix="ingress_https"}[5m])

# 5xx error rate from downstream perspective
rate(envoy_http_downstream_rq_5xx{http_conn_manager_prefix="ingress_https"}[5m])
  / rate(envoy_http_downstream_rq_total{http_conn_manager_prefix="ingress_https"}[5m])
```

## Admin Interface Operations

The Envoy admin interface provides runtime introspection and limited configuration mutation capabilities. Always bind it to loopback in production.

```bash
# Check Envoy server state (version, uptime, hot restart count)
curl -s http://localhost:9901/server_info | jq .

# List all clusters and their endpoints with health status
curl -s http://localhost:9901/clusters

# Dump the current listener configuration (LDS state)
curl -s http://localhost:9901/config_dump | jq '.configs[] | select(.["@type"] | contains("ListenersConfigDump"))'

# Dump the current route configuration (RDS state)
curl -s http://localhost:9901/config_dump | jq '.configs[] | select(.["@type"] | contains("RoutesConfigDump"))'

# Force a specific cluster's circuit breaker open (for testing)
curl -X POST "http://localhost:9901/runtime_modify?cluster.api_v1_cluster.circuit_breakers.default.max_requests=0"

# Reset circuit breaker override
curl -X POST "http://localhost:9901/runtime_remove?key=cluster.api_v1_cluster.circuit_breakers.default.max_requests"

# View the current runtime override values
curl -s http://localhost:9901/runtime | jq .

# Drain connections gracefully (pre-shutdown)
curl -X POST http://localhost:9901/drain_listeners?graceful

# Health check the Envoy instance
curl -s http://localhost:9901/healthcheck/ok
```

## Retry Policy Configuration

Retry policies define when and how many times Envoy retries failed requests before returning an error to the downstream client.

```yaml
# Retry policy on a route
routes:
  - match:
      prefix: "/v2/"
    route:
      cluster: api_v2_cluster
      timeout: 30s
      retry_policy:
        # Retry on these conditions (comma-separated)
        # 5xx: any 5xx response code
        # reset: connection reset or HTTP2 reset
        # connect-failure: upstream connection failure
        # retriable-4xx: HTTP 409 Conflict (idempotent retry)
        # retriable-status-codes: codes listed in x-envoy-retriable-status-codes header
        retry_on: "5xx,reset,connect-failure,retriable-4xx"

        # Maximum number of retry attempts
        num_retries: 3

        # Timeout for each individual attempt (not the total timeout)
        per_try_timeout: 10s

        # Retry budget: limit concurrent retries to 20% of active requests
        # Prevents retry storms during outages
        retry_budget:
          budget_percent:
            value: 20.0
          min_retry_concurrency: 3

        # Host selection retry plugins: do not retry to the same host
        host_selection_retry_max_attempts: 3
        retriable_status_codes:
          - 503

        # Exponential backoff between retries
        retry_back_off:
          base_interval: 0.1s   # 100ms base
          max_interval: 3s      # Cap at 3 seconds
```

## Summary

Direct Envoy configuration provides control over traffic management that higher-level operators cannot fully expose. The bootstrap file points to a control plane xDS server or defines static resources directly. The HTTP connection manager filter chain — JWT authentication, rate limiting, CORS, compression, and router — processes requests in a well-defined pipeline with each filter able to terminate the chain or modify request and response headers. Circuit breakers, outlier detection, and retry policies with backoff work together to isolate upstream failures without requiring application-level resilience logic. Prometheus stats via the admin interface, combined with ServiceMonitor and targeted PromQL queries, give platform teams the observability surface needed to identify latency regressions, cascade failure onset, and circuit breaker saturation before they impact end users.
