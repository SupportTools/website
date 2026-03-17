---
title: "Kubernetes Envoy Proxy Configuration: Direct Deployment Without Service Mesh"
date: 2031-05-02T00:00:00-05:00
draft: false
tags: ["Envoy", "Kubernetes", "Proxy", "Load Balancing", "TLS", "Circuit Breaker", "Rate Limiting"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy and configure Envoy proxy directly on Kubernetes without a service mesh, covering bootstrap configuration, xDS dynamic resources, TLS termination, circuit breaker, rate limiting filter, and admin interface."
more_link: "yes"
url: "/kubernetes-envoy-proxy-configuration-direct-deployment-without-service-mesh/"
---

Envoy proxy is the data plane behind every major service mesh, but it is equally powerful deployed standalone as an edge proxy, API gateway, or sidecar without the operational overhead of a full service mesh control plane. This guide covers direct Envoy deployment on Kubernetes with static and dynamic configuration, TLS termination, circuit breaking, and rate limiting.

<!--more-->

# Kubernetes Envoy Proxy Configuration: Direct Deployment Without Service Mesh

## Section 1: When to Use Envoy Without a Service Mesh

Service meshes like Istio and Linkerd provide tremendous value, but they add operational complexity that not every team can absorb. Envoy deployed directly makes sense in these scenarios:

- **Single ingress point** - Envoy as a sophisticated edge proxy replacing nginx
- **Sidecar for specific services** - Apply proxy behavior to a subset of services
- **gRPC transcoding** - Convert REST to gRPC at the edge
- **Custom routing logic** - Route based on headers, JWT claims, or metadata
- **Rate limiting gateway** - Centralized rate limit service without full mesh

The key difference from a service mesh is that you manage the Envoy configuration directly (via ConfigMap or xDS server) rather than having the control plane generate it.

## Section 2: Envoy Architecture and Bootstrap Configuration

Envoy's configuration has a specific hierarchy:

```
Bootstrap (envoy.yaml)
├── static_resources
│   ├── listeners[]       - What ports to listen on
│   ├── clusters[]        - Upstream backends
│   └── secrets[]         - TLS certificates
├── dynamic_resources
│   ├── lds_config        - Listener Discovery Service
│   ├── cds_config        - Cluster Discovery Service
│   └── ads_config        - Aggregated Discovery Service
└── admin                 - Admin API
```

A minimal working bootstrap configuration:

```yaml
# envoy-config.yaml - minimal bootstrap
admin:
  access_log_path: /dev/null
  address:
    socket_address:
      address: 0.0.0.0
      port_value: 9901

static_resources:
  listeners:
    - name: listener_0
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 8080
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: ingress_http
                route_config:
                  name: local_route
                  virtual_hosts:
                    - name: backend
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/"
                          route:
                            cluster: service_backend
                            timeout: 30s
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

  clusters:
    - name: service_backend
      connect_timeout: 5s
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      load_assignment:
        cluster_name: service_backend
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: backend-service
                      port_value: 8080
```

## Section 3: Full Production HTTP Connection Manager

```yaml
# envoy-production.yaml
admin:
  access_log_path: /dev/stdout
  address:
    socket_address:
      address: 127.0.0.1  # Only accessible from localhost/same pod
      port_value: 9901

static_resources:
  listeners:
    - name: listener_http
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 8080
      listener_filters:
        - name: "envoy.filters.listener.proxy_protocol"
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.listener.proxy_protocol.v3.ProxyProtocol
          rules: []
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                codec_type: AUTO
                stat_prefix: ingress_http
                use_remote_address: true
                xff_num_trusted_hops: 1

                # Access logging
                access_log:
                  - name: envoy.access_loggers.stdout
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog
                      log_format:
                        json_format:
                          start_time: "%START_TIME%"
                          method: "%REQ(:METHOD)%"
                          path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
                          protocol: "%PROTOCOL%"
                          response_code: "%RESPONSE_CODE%"
                          response_flags: "%RESPONSE_FLAGS%"
                          bytes_received: "%BYTES_RECEIVED%"
                          bytes_sent: "%BYTES_SENT%"
                          duration: "%DURATION%"
                          upstream_host: "%UPSTREAM_HOST%"
                          upstream_cluster: "%UPSTREAM_CLUSTER%"
                          x_forwarded_for: "%REQ(X-FORWARDED-FOR)%"
                          request_id: "%REQ(X-REQUEST-ID)%"
                          user_agent: "%REQ(USER-AGENT)%"

                # HTTP/2 settings
                http2_protocol_options:
                  allow_connect: true
                  initial_stream_window_size: 65536
                  initial_connection_window_size: 1048576
                  max_concurrent_streams: 100

                # Connection settings
                stream_idle_timeout: 300s
                request_timeout: 60s
                drain_timeout: 5s

                # Headers to add/remove
                request_headers_to_add:
                  - header:
                      key: x-request-id
                      value: "%REQ(X-REQUEST-ID)%"
                    keep_empty_value: false
                request_headers_to_remove:
                  - x-internal-secret

                route_config:
                  name: main_route
                  virtual_hosts:
                    - name: api-backend
                      domains:
                        - "api.example.com"
                        - "api.example.com:8080"
                      routes:
                        # Health check endpoint - no auth required
                        - match:
                            prefix: "/healthz"
                          direct_response:
                            status: 200
                            body:
                              inline_string: "OK"

                        # API v2 routes to v2 cluster
                        - match:
                            prefix: "/api/v2"
                            headers:
                              - name: "x-api-version"
                                string_match:
                                  exact: "2"
                          route:
                            cluster: service_v2
                            timeout: 30s
                            retry_policy:
                              retry_on: "5xx,reset,connect-failure"
                              num_retries: 3
                              per_try_timeout: 10s
                              retry_back_off:
                                base_interval: 0.1s
                                max_interval: 1s

                        # Default routes
                        - match:
                            prefix: "/api"
                          route:
                            cluster: service_v1
                            timeout: 30s
                            hash_policy:
                              - header:
                                  header_name: x-user-id

                        # Redirect old paths
                        - match:
                            prefix: "/v1"
                          redirect:
                            prefix_rewrite: "/api/v1"
                            response_code: MOVED_PERMANENTLY

                        # Websocket upgrade
                        - match:
                            prefix: "/ws"
                          route:
                            cluster: websocket_backend
                            timeout: 0s  # No timeout for WebSocket
                            upgrade_configs:
                              - upgrade_type: websocket

                    - name: catch_all
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/"
                          direct_response:
                            status: 404
                            body:
                              inline_string: '{"error": "not_found"}'

                http_filters:
                  # Rate limiting (calls external rate limit service)
                  - name: envoy.filters.http.ratelimit
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.ratelimit.v3.RateLimit
                      domain: api-gateway
                      request_type: both
                      stage: 0
                      rate_limit_service:
                        grpc_service:
                          envoy_grpc:
                            cluster_name: rate_limit_service
                          timeout: 0.25s
                        transport_api_version: V3

                  # Local rate limiting (no external service required)
                  - name: envoy.filters.http.local_ratelimit
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.local_ratelimit.v3.LocalRateLimit
                      stat_prefix: http_local_rate_limiter
                      token_bucket:
                        max_tokens: 10000
                        tokens_per_fill: 1000
                        fill_interval: 1s
                      filter_enabled:
                        runtime_key: local_rate_limit_enabled
                        default_value:
                          numerator: 100
                          denominator: HUNDRED
                      filter_enforced:
                        runtime_key: local_rate_limit_enforced
                        default_value:
                          numerator: 100
                          denominator: HUNDRED
                      response_headers_to_add:
                        - append_action: OVERWRITE_IF_EXISTS_OR_ADD
                          header:
                            key: x-local-rate-limit
                            value: "true"

                  # CORS filter
                  - name: envoy.filters.http.cors
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.cors.v3.CorsPolicy

                  # Router (must be last)
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                      suppress_envoy_headers: false

    # HTTPS listener
    - name: listener_https
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 8443
      filter_chains:
        - transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              common_tls_context:
                tls_certificates:
                  - certificate_chain:
                      filename: /etc/envoy/tls/tls.crt
                    private_key:
                      filename: /etc/envoy/tls/tls.key
                alpn_protocols:
                  - h2
                  - http/1.1
                tls_params:
                  tls_minimum_protocol_version: TLSv1_2
                  tls_maximum_protocol_version: TLSv1_3
                  cipher_suites:
                    - ECDHE-ECDSA-AES128-GCM-SHA256
                    - ECDHE-RSA-AES128-GCM-SHA256
                    - ECDHE-ECDSA-AES256-GCM-SHA384
                    - ECDHE-RSA-AES256-GCM-SHA384
              require_client_certificate: false
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: ingress_https
                route_config:
                  name: https_route
                  virtual_hosts:
                    - name: backend
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/"
                          route:
                            cluster: service_v1
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

  clusters:
    # Backend service v1
    - name: service_v1
      connect_timeout: 5s
      type: STRICT_DNS
      dns_lookup_family: V4_ONLY
      lb_policy: LEAST_REQUEST
      load_assignment:
        cluster_name: service_v1
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: backend-v1-service.default.svc.cluster.local
                      port_value: 8080

      # Health checking
      health_checks:
        - timeout: 5s
          interval: 10s
          healthy_threshold: 2
          unhealthy_threshold: 3
          http_health_check:
            path: /healthz
            expected_statuses:
              - start: 200
                end: 299

      # Circuit breaker
      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 1000
            max_pending_requests: 1000
            max_requests: 10000
            max_retries: 3
            track_remaining: true
          - priority: HIGH
            max_connections: 2000
            max_pending_requests: 500
            max_requests: 20000
            max_retries: 5

      # Outlier detection (passive health checking)
      outlier_detection:
        consecutive_5xx: 5
        consecutive_gateway_failure: 3
        interval: 10s
        base_ejection_time: 30s
        max_ejection_percent: 50
        min_health_percent: 50
        success_rate_minimum_hosts: 5
        success_rate_request_volume: 100
        success_rate_stdev_factor: 1900
        enforcing_consecutive_5xx: 100
        enforcing_success_rate: 100

      # Connection pool settings
      upstream_connection_options:
        tcp_keepalive:
          keepalive_time: 300

      # mTLS to upstream
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
          common_tls_context:
            tls_certificates:
              - certificate_chain:
                  filename: /etc/envoy/client-tls/tls.crt
                private_key:
                  filename: /etc/envoy/client-tls/tls.key
            validation_context:
              trusted_ca:
                filename: /etc/envoy/ca/ca.crt
          sni: backend-v1-service.default.svc.cluster.local

    # Service v2
    - name: service_v2
      connect_timeout: 5s
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      load_assignment:
        cluster_name: service_v2
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: backend-v2-service.default.svc.cluster.local
                      port_value: 8080

    # Rate limit service (external ratelimit server)
    - name: rate_limit_service
      type: STRICT_DNS
      connect_timeout: 0.25s
      lb_policy: ROUND_ROBIN
      http2_protocol_options: {}  # gRPC requires HTTP/2
      load_assignment:
        cluster_name: rate_limit_service
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: ratelimit-service.default.svc.cluster.local
                      port_value: 8081

    # WebSocket backend
    - name: websocket_backend
      connect_timeout: 5s
      type: STRICT_DNS
      lb_policy: ROUND_ROBIN
      load_assignment:
        cluster_name: websocket_backend
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: ws-service.default.svc.cluster.local
                      port_value: 8080
```

## Section 4: Kubernetes Deployment

```yaml
# envoy-deployment.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: envoy-config
  namespace: default
data:
  envoy.yaml: |
    # Contents of envoy-production.yaml above
    # (abbreviated for clarity)
    admin:
      address:
        socket_address:
          address: 127.0.0.1
          port_value: 9901
    static_resources:
      listeners: []
      clusters: []

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: envoy-proxy
  namespace: default
  labels:
    app: envoy-proxy
    version: v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: envoy-proxy
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: envoy-proxy
        version: v1
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9901"
        prometheus.io/path: "/stats/prometheus"
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: envoy-proxy
                topologyKey: kubernetes.io/hostname

      containers:
        - name: envoy
          image: envoyproxy/envoy:v1.29.2
          args:
            - -c
            - /etc/envoy/envoy.yaml
            - --log-level
            - warn
            - --log-format
            - "[%Y-%m-%d %T.%e][%t][%l][%n] [%g:%#] %v"
            - --drain-time-s
            - "30"
            - --parent-shutdown-time-s
            - "60"
            - --service-cluster
            - envoy-proxy
            - --service-node
            - $(POD_NAME)

          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace

          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
            - name: https
              containerPort: 8443
              protocol: TCP
            - name: admin
              containerPort: 9901
              protocol: TCP

          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 2000m
              memory: 512Mi

          volumeMounts:
            - name: envoy-config
              mountPath: /etc/envoy
              readOnly: true
            - name: tls-certs
              mountPath: /etc/envoy/tls
              readOnly: true
            - name: tmp
              mountPath: /tmp

          livenessProbe:
            httpGet:
              path: /ready
              port: 9901
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3

          readinessProbe:
            httpGet:
              path: /ready
              port: 9901
            initialDelaySeconds: 3
            periodSeconds: 5
            failureThreshold: 2

          lifecycle:
            preStop:
              exec:
                # Send drain signal, then wait for connections to finish
                command: ["/bin/sh", "-c",
                  "wget -qO- --post-data='' http://localhost:9901/healthcheck/fail && sleep 10"]

          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
            capabilities:
              drop: ["ALL"]
              add: ["NET_BIND_SERVICE"]

      volumes:
        - name: envoy-config
          configMap:
            name: envoy-config
        - name: tls-certs
          secret:
            secretName: envoy-tls-certs
        - name: tmp
          emptyDir: {}

      terminationGracePeriodSeconds: 70

---
apiVersion: v1
kind: Service
metadata:
  name: envoy-proxy
  namespace: default
  labels:
    app: envoy-proxy
spec:
  type: LoadBalancer
  selector:
    app: envoy-proxy
  ports:
    - name: http
      port: 80
      targetPort: 8080
      protocol: TCP
    - name: https
      port: 443
      targetPort: 8443
      protocol: TCP

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: envoy-proxy-pdb
  namespace: default
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: envoy-proxy
```

## Section 5: Dynamic Configuration with xDS

For large deployments, manage Envoy configuration dynamically using an xDS control plane:

```yaml
# envoy-dynamic-bootstrap.yaml
# Bootstrap that points Envoy to an xDS server for all configuration
admin:
  address:
    socket_address:
      address: 127.0.0.1
      port_value: 9901

dynamic_resources:
  ads_config:
    api_type: GRPC
    transport_api_version: V3
    grpc_services:
      - envoy_grpc:
          cluster_name: xds_cluster
    set_node_on_first_message_only: true
  cds_config:
    ads: {}
    resource_api_version: V3
  lds_config:
    ads: {}
    resource_api_version: V3

static_resources:
  clusters:
    - name: xds_cluster
      connect_timeout: 5s
      type: STRICT_DNS
      http2_protocol_options: {}
      load_assignment:
        cluster_name: xds_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: xds-server.default.svc.cluster.local
                      port_value: 18000

node:
  cluster: envoy-cluster
  id: envoy-proxy-$(POD_NAME)
  metadata:
    app: envoy-proxy
    namespace: default
```

A simple Go xDS server:

```go
// cmd/xds-server/main.go
package main

import (
	"context"
	"log"
	"net"
	"time"

	clusterservice "github.com/envoyproxy/go-control-plane/envoy/service/cluster/v3"
	discoverygrpc "github.com/envoyproxy/go-control-plane/envoy/service/discovery/v3"
	endpointservice "github.com/envoyproxy/go-control-plane/envoy/service/endpoint/v3"
	listenerservice "github.com/envoyproxy/go-control-plane/envoy/service/listener/v3"
	routeservice "github.com/envoyproxy/go-control-plane/envoy/service/route/v3"
	runtimeservice "github.com/envoyproxy/go-control-plane/envoy/service/runtime/v3"
	secretservice "github.com/envoyproxy/go-control-plane/envoy/service/secret/v3"
	"github.com/envoyproxy/go-control-plane/pkg/cache/v3"
	"github.com/envoyproxy/go-control-plane/pkg/server/v3"
	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"
)

func main() {
	snapshotCache := cache.NewSnapshotCache(false, cache.IDHash{}, nil)

	// Build initial snapshot
	snapshot, err := buildSnapshot("1")
	if err != nil {
		log.Fatalf("failed to build snapshot: %v", err)
	}

	if err := snapshotCache.SetSnapshot(context.Background(), "envoy-cluster", snapshot); err != nil {
		log.Fatalf("failed to set snapshot: %v", err)
	}

	xdsServer := server.NewServer(context.Background(), snapshotCache, nil)

	grpcServer := grpc.NewServer(
		grpc.KeepaliveParams(keepalive.ServerParameters{
			Time:    30 * time.Second,
			Timeout: 5 * time.Second,
		}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             5 * time.Second,
			PermitWithoutStream: true,
		}),
	)

	discoverygrpc.RegisterAggregatedDiscoveryServiceServer(grpcServer, xdsServer)
	endpointservice.RegisterEndpointDiscoveryServiceServer(grpcServer, xdsServer)
	clusterservice.RegisterClusterDiscoveryServiceServer(grpcServer, xdsServer)
	routeservice.RegisterRouteDiscoveryServiceServer(grpcServer, xdsServer)
	listenerservice.RegisterListenerDiscoveryServiceServer(grpcServer, xdsServer)
	secretservice.RegisterSecretDiscoveryServiceServer(grpcServer, xdsServer)
	runtimeservice.RegisterRuntimeDiscoveryServiceServer(grpcServer, xdsServer)

	lis, err := net.Listen("tcp", ":18000")
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}

	log.Printf("xDS server listening on :18000")
	if err := grpcServer.Serve(lis); err != nil {
		log.Fatalf("failed to serve: %v", err)
	}
}
```

## Section 6: TLS Origination to Upstream

Configure Envoy to terminate TLS from downstream and originate new TLS to upstream (TLS bridging):

```yaml
# TLS termination at Envoy + mTLS to upstream
clusters:
  - name: secure_backend
    connect_timeout: 5s
    type: STRICT_DNS
    lb_policy: ROUND_ROBIN
    load_assignment:
      cluster_name: secure_backend
      endpoints:
        - lb_endpoints:
            - endpoint:
                address:
                  socket_address:
                    address: secure-service.default.svc.cluster.local
                    port_value: 8443

    # TLS origination configuration
    transport_socket:
      name: envoy.transport_sockets.tls
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
        common_tls_context:
          # Client certificate for mTLS
          tls_certificates:
            - certificate_chain:
                filename: /etc/envoy/client-tls/tls.crt
              private_key:
                filename: /etc/envoy/client-tls/tls.key

          # Validate server certificate
          validation_context:
            trusted_ca:
              filename: /etc/envoy/ca/ca.crt
            match_typed_subject_alt_names:
              - san_type: DNS
                matcher:
                  exact: "secure-service.default.svc.cluster.local"

        sni: secure-service.default.svc.cluster.local
```

## Section 7: Rate Limiting with go-ratelimit

Deploy an external rate limit service alongside Envoy:

```yaml
# ratelimit-service.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ratelimit-config
  namespace: default
data:
  config.yaml: |
    domain: api-gateway
    descriptors:
      # Global rate limit: 10000 requests per minute per domain
      - key: remote_address
        rate_limit:
          unit: minute
          requests_per_unit: 1000

      # Per-user rate limit
      - key: user_id
        rate_limit:
          unit: minute
          requests_per_unit: 100

      # Per-endpoint rate limit
      - key: header_match
        value: POST_/api/payments
        rate_limit:
          unit: second
          requests_per_unit: 10

      - key: header_match
        value: GET_/api/payments
        rate_limit:
          unit: second
          requests_per_unit: 100

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ratelimit-service
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ratelimit-service
  template:
    metadata:
      labels:
        app: ratelimit-service
    spec:
      containers:
        - name: ratelimit
          image: envoyproxy/ratelimit:latest
          args:
            - /bin/ratelimit
          env:
            - name: REDIS_SOCKET_TYPE
              value: tcp
            - name: REDIS_URL
              value: redis:6379
            - name: USE_STATSD
              value: "false"
            - name: LOG_LEVEL
              value: warn
            - name: RUNTIME_ROOT
              value: /data
            - name: RUNTIME_SUBDIRECTORY
              value: ratelimit
            - name: RUNTIME_WATCH_ROOT
              value: "false"
            - name: RUNTIME_IGNOREDOTFILES
              value: "true"
            - name: PORT
              value: "8080"
            - name: GRPC_PORT
              value: "8081"
          ports:
            - containerPort: 8081
              name: grpc
          volumeMounts:
            - name: ratelimit-config
              mountPath: /data/ratelimit/config
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
      volumes:
        - name: ratelimit-config
          configMap:
            name: ratelimit-config
```

Configure Envoy to call the rate limit service:

```yaml
# In the virtual_host routes, add rate limit actions:
routes:
  - match:
      prefix: "/api"
    route:
      cluster: service_v1
    typed_per_filter_config:
      envoy.filters.http.ratelimit:
        "@type": type.googleapis.com/envoy.extensions.filters.http.ratelimit.v3.RateLimitPerRoute
        vh_rate_limits: INCLUDE

  # Rate limit configuration in the virtual_host level
rate_limits:
  - actions:
      # Use client IP
      - remote_address: {}
  - actions:
      # Use user ID header
      - request_headers:
          header_name: x-user-id
          descriptor_key: user_id
  - actions:
      # Use method + path combination
      - header_value_match:
          descriptor_value: "POST_/api/payments"
          headers:
            - name: ":method"
              string_match:
                exact: POST
            - name: ":path"
              string_match:
                prefix: "/api/payments"
```

## Section 8: Admin Interface and Observability

```bash
# Access the admin API (port-forward for security)
kubectl port-forward deployment/envoy-proxy 9901:9901

# Check cluster health
curl -s http://localhost:9901/clusters | grep -E "health_flags|cx_active|rq_active"

# View circuit breaker state
curl -s http://localhost:9901/clusters | grep -E "circuit_breakers|cx_open"

# Check live configuration
curl -s http://localhost:9901/config_dump | python3 -m json.tool | less

# View stats
curl -s http://localhost:9901/stats | grep -E "upstream_rq_5xx|upstream_cx_overflow"

# Prometheus metrics
curl -s http://localhost:9901/stats/prometheus | grep -E "envoy_cluster_upstream"

# Drain connections gracefully
curl -X POST http://localhost:9901/drain_listeners

# Reset stats
curl -X POST http://localhost:9901/reset_counters

# Check individual listener
curl -s http://localhost:9901/listeners

# Hot restart (zero-downtime config reload)
curl -X POST "http://localhost:9901/quitquitquit"
# Envoy will restart and reload the config
```

Key Envoy stats to monitor:

```
# Circuit breaker stats
envoy_cluster_circuit_breakers_default_cx_open{cluster_name="service_v1"}
envoy_cluster_circuit_breakers_default_rq_open{cluster_name="service_v1"}

# Request stats
envoy_cluster_upstream_rq_total{cluster_name="service_v1"}
envoy_cluster_upstream_rq_5xx{cluster_name="service_v1"}
envoy_cluster_upstream_rq_timeout{cluster_name="service_v1"}
envoy_cluster_upstream_rq_retry{cluster_name="service_v1"}

# Connection stats
envoy_cluster_upstream_cx_active{cluster_name="service_v1"}
envoy_cluster_upstream_cx_connect_fail{cluster_name="service_v1"}

# Outlier detection
envoy_cluster_outlier_detection_ejections_active{cluster_name="service_v1"}
envoy_cluster_outlier_detection_ejections_total{cluster_name="service_v1"}
```

## Section 9: Configuration Hot Reload

Reload Envoy configuration without restarting the pod:

```bash
# Method 1: Update ConfigMap and trigger a rolling restart
kubectl create configmap envoy-config \
  --from-file=envoy.yaml=envoy-new-config.yaml \
  --dry-run=client -o yaml | \
  kubectl apply -f -

# Trigger rolling restart
kubectl rollout restart deployment/envoy-proxy

# Watch rollout
kubectl rollout status deployment/envoy-proxy

# Method 2: Use Envoy's hot restart capability
# In the init container, set up the epoch directory
# Then signal Envoy to hot restart via:
kill -SIGUSR2 $(cat /var/run/envoy.pid)
```

## Section 10: Debugging and Troubleshooting

```bash
# Enable debug logging for specific components
curl -X POST "http://localhost:9901/logging?level=debug"
curl -X POST "http://localhost:9901/logging?connection=debug"
curl -X POST "http://localhost:9901/logging?http=debug"

# Check if circuit breaker is open
curl -s http://localhost:9901/stats | grep "cx_open\|rq_open" | grep -v " 0$"

# View upstream health
curl -s http://localhost:9901/clusters | \
  awk '/^service_v1/,/^[a-z]/' | \
  grep -E "health_flags|cx_active|hostname"

# Check TLS handshake failures
curl -s http://localhost:9901/stats | grep ssl

# View route table
curl -s http://localhost:9901/config_dump | \
  python3 -c "
import json, sys
cfg = json.load(sys.stdin)
for c in cfg.get('configs', []):
    if c.get('@type', '').endswith('RoutesConfigDump'):
        print(json.dumps(c, indent=2))
"

# Check for rejected connections (upstream overflow)
curl -s http://localhost:9901/stats | grep "upstream_rq_pending_overflow\|upstream_cx_overflow"
```

## Summary

Envoy deployed directly on Kubernetes without a service mesh provides:

1. **Full control** over proxy configuration without control plane abstraction
2. **Efficient resource use** - no Pilot/Istiod overhead for simple proxy scenarios
3. **Gradual adoption** - add Envoy to specific services before committing to a full mesh
4. **Static configuration** scales to hundreds of routes in a single ConfigMap
5. **xDS dynamic configuration** scales to thousands of clusters with a custom control plane
6. **Circuit breaker and outlier detection** protects against cascading failures
7. **Local rate limiting** provides request throttling without external dependencies

The Envoy admin API is essential for production operations - always port-forward to it for debugging rather than exposing it publicly. Monitor `upstream_rq_5xx` and `outlier_detection_ejections_active` as the first signal of backend issues.
