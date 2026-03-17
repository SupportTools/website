---
title: "Kubernetes Envoy Proxy as a Standalone Sidecar: Advanced Filter Chains and Dynamic Configuration with xDS"
date: 2031-09-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Envoy", "xDS", "Service Mesh", "Sidecar", "Proxy", "Networking"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into running Envoy as a standalone sidecar in Kubernetes, covering advanced filter chain configuration, dynamic xDS control planes, and production-ready traffic management patterns."
more_link: "yes"
url: "/kubernetes-envoy-sidecar-advanced-filter-chains-xds-configuration/"
---

Envoy proxy is the engine beneath most modern service meshes, but running it as a standalone sidecar — without a full control plane like Istio — gives you precise, surgical control over traffic behavior for high-stakes workloads. When you need advanced HTTP/gRPC filter chains, circuit breaking, rate limiting, and dynamic configuration without the operational overhead of a complete mesh, the standalone Envoy sidecar pattern is a compelling alternative that production teams often overlook.

This guide covers everything from injecting Envoy as a sidecar in Kubernetes, building advanced filter chains, configuring dynamic xDS-based management, and wiring up observability in enterprise environments.

<!--more-->

# Kubernetes Envoy Proxy as a Standalone Sidecar

## Why Standalone Envoy Instead of a Full Service Mesh

Full service meshes like Istio and Linkerd are excellent, but they introduce control plane complexity, operator knowledge requirements, and cluster-wide rollout challenges. A standalone Envoy sidecar is appropriate when:

- You need Envoy's capabilities on a single application or small set of services without mesh-wide policy
- Your team owns the Envoy configuration directly and wants full fidelity over filter chains
- You are incrementally adopting a mesh and need an intermediate step
- You are building a custom control plane that speaks xDS natively
- You need specialized filter chains (Lua scripting, external authorization, custom gRPC filters) not exposed cleanly by mesh abstractions

The tradeoff is that you own the configuration fully. This guide shows you how to do it correctly.

## Understanding Envoy Architecture

Before building sidecar configurations, it is important to understand Envoy's internal model.

### Listeners, Filter Chains, and Clusters

Envoy's core abstractions are:

- **Listeners**: Bind to a port/address and accept connections
- **Filter chains**: Ordered list of network or HTTP filters applied to matching connections
- **Routes**: Match conditions on HTTP requests and direct traffic to clusters
- **Clusters**: Upstream connection pools (your backend services)
- **Endpoints**: Individual instances within a cluster

The data plane pipeline is:

```
Downstream Connection
        |
        v
   [ Listener ]
        |
        v
 [ Filter Chain Match ] --- (SNI, ALPN, destination IP/port)
        |
        v
 [ Network Filters ] --- (TCP proxy, HTTP connection manager, etc.)
        |
        v
 [ HTTP Filters ] --- (router, rate limit, ext_authz, Lua, etc.)
        |
        v
   [ Route Table ]
        |
        v
    [ Cluster ]
        |
        v
   [ Endpoint ]
```

### Static vs Dynamic Configuration

Envoy supports two configuration modes:

- **Static**: Everything defined in `envoy.yaml` at startup. Simple but requires restarts for changes.
- **Dynamic (xDS)**: Envoy connects to a control plane over gRPC and receives configuration updates in real time via the xDS APIs (LDS, RDS, CDS, EDS, SDS).

For production standalone sidecars, a hybrid approach works well: static bootstrap with xDS for dynamic updates.

## Injecting Envoy as a Sidecar

### Manual Sidecar Injection Pattern

Unlike Istio's automatic injection, standalone Envoy sidecars are added manually to Pod specs. Here is a complete Deployment manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
      annotations:
        # Prometheus scraping via Envoy admin port
        prometheus.io/scrape: "true"
        prometheus.io/port: "9901"
        prometheus.io/path: "/stats/prometheus"
    spec:
      initContainers:
        # iptables redirect: intercept all inbound traffic to Envoy
        - name: envoy-init
          image: envoyproxy/envoy:v1.29.0
          command: ["/bin/sh", "-c"]
          args:
            - |
              iptables -t nat -A PREROUTING -p tcp --dport 8080 -j REDIRECT --to-port 15001
              iptables -t nat -A OUTPUT -p tcp -m owner ! --uid-owner 1337 -j REDIRECT --to-port 15001
          securityContext:
            capabilities:
              add:
                - NET_ADMIN
            runAsNonRoot: false
            runAsUser: 0

      containers:
        - name: payment-service
          image: registry.example.com/payment-service:v2.4.1
          ports:
            - containerPort: 8080
          env:
            - name: SERVER_PORT
              value: "8080"

        - name: envoy-sidecar
          image: envoyproxy/envoy:v1.29.0
          args:
            - "-c"
            - "/etc/envoy/envoy.yaml"
            - "--service-cluster"
            - "payment-service"
            - "--service-node"
            - "$(POD_NAME).$(POD_NAMESPACE)"
            - "--log-level"
            - "warn"
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
            - name: envoy-inbound
              containerPort: 15001
            - name: envoy-admin
              containerPort: 9901
          volumeMounts:
            - name: envoy-config
              mountPath: /etc/envoy
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
          securityContext:
            runAsUser: 1337
            runAsGroup: 1337
            allowPrivilegeEscalation: false
          readinessProbe:
            httpGet:
              path: /ready
              port: 9901
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /server_info
              port: 9901
            initialDelaySeconds: 10
            periodSeconds: 30

      volumes:
        - name: envoy-config
          configMap:
            name: payment-service-envoy-config
```

### The Envoy ConfigMap

The ConfigMap holds the static Envoy configuration:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: payment-service-envoy-config
  namespace: payments
data:
  envoy.yaml: |
    admin:
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 9901

    static_resources:
      listeners: []
      clusters: []

    dynamic_resources:
      ads_config:
        api_type: GRPC
        transport_api_version: V3
        grpc_services:
          - envoy_grpc:
              cluster_name: xds_cluster
        set_node_on_first_message_only: true
      lds_config:
        resource_api_version: V3
        ads: {}
      cds_config:
        resource_api_version: V3
        ads: {}

    node:
      cluster: payment-service
      metadata:
        app: payment-service
        version: v2.4.1
        namespace: payments

    layered_runtime:
      layers:
        - name: static_layer
          static_layer:
            envoy.reloadable_features.enable_deprecated_v2_api: false
            overload:
              global_downstream_max_connections: 50000
```

For purely static configurations without xDS, the `dynamic_resources` section is replaced with full static listener/cluster definitions.

## Advanced Static Filter Chain Configuration

### HTTP Connection Manager with Full HTTP/2 and gRPC Support

The HTTP connection manager (HCM) is the workhorse HTTP filter. Here is an enterprise-grade configuration:

```yaml
static_resources:
  listeners:
    - name: inbound_listener
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 15001
      listener_filters:
        - name: envoy.filters.listener.tls_inspector
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector
        - name: envoy.filters.listener.http_inspector
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.listener.http_inspector.v3.HttpInspector

      filter_chains:
        # Chain for plaintext HTTP/1.1 and HTTP/2
        - filter_chain_match:
            transport_protocol: raw_buffer
            application_protocols: ["http/1.1", "h2c"]
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: inbound_http
                codec_type: AUTO
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
                          duration: "%DURATION%"
                          upstream_host: "%UPSTREAM_HOST%"
                          request_id: "%REQ(X-REQUEST-ID)%"
                          upstream_service_time: "%RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)%"
                          bytes_received: "%BYTES_RECEIVED%"
                          bytes_sent: "%BYTES_SENT%"
                          downstream_remote_address: "%DOWNSTREAM_REMOTE_ADDRESS%"

                http2_protocol_options:
                  initial_stream_window_size: 65536
                  initial_connection_window_size: 1048576
                  max_concurrent_streams: 100
                  allow_connect: true

                stream_idle_timeout: 300s
                request_timeout: 60s
                drain_timeout: 30s

                use_remote_address: true
                xff_num_trusted_hops: 1
                skip_xff_append: false

                normalize_path: true
                merge_slashes: true
                path_with_escaped_slashes_action: UNESCAPE_AND_REDIRECT

                http_filters:
                  - name: envoy.filters.http.health_check
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.health_check.v3.HealthCheck
                      pass_through_mode: false
                      headers:
                        - name: ":path"
                          string_match:
                            exact: "/healthz"

                  - name: envoy.filters.http.ratelimit
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.ratelimit.v3.RateLimit
                      domain: payments
                      failure_mode_deny: false
                      timeout: 20ms
                      rate_limit_service:
                        grpc_service:
                          envoy_grpc:
                            cluster_name: ratelimit_cluster
                        transport_api_version: V3

                  - name: envoy.filters.http.ext_authz
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
                      failure_mode_allow: false
                      grpc_service:
                        envoy_grpc:
                          cluster_name: ext_authz_cluster
                        timeout: 10ms
                      include_peer_certificate: true

                  - name: envoy.filters.http.lua
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.LuaPerRoute
                      inline_code: |
                        function envoy_on_request(request_handle)
                          -- Add correlation ID if not present
                          local req_id = request_handle:headers():get("x-request-id")
                          if req_id == nil or req_id == "" then
                            request_handle:headers():add("x-request-id", request_handle:streamInfo():dynamicMetadata():get("random_uuid"))
                          end
                          -- Remove internal headers from external clients
                          request_handle:headers():remove("x-internal-admin-token")
                        end

                        function envoy_on_response(response_handle)
                          -- Add security headers
                          response_handle:headers():add("x-content-type-options", "nosniff")
                          response_handle:headers():add("x-frame-options", "DENY")
                          response_handle:headers():remove("server")
                        end

                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                      suppress_envoy_headers: false

                route_config:
                  name: inbound_route
                  virtual_hosts:
                    - name: payment_service
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/api/v1/payments"
                          route:
                            cluster: payment_service_local
                            timeout: 30s
                            retry_policy:
                              retry_on: "5xx,reset,connect-failure,retriable-4xx"
                              num_retries: 3
                              per_try_timeout: 10s
                              retry_back_off:
                                base_interval: 25ms
                                max_interval: 1s
                        - match:
                            prefix: "/api/v1/refunds"
                          route:
                            cluster: payment_service_local
                            timeout: 60s
                        - match:
                            prefix: "/"
                          route:
                            cluster: payment_service_local
                            timeout: 10s
                      response_headers_to_add:
                        - header:
                            key: "x-served-by"
                            value: "envoy-sidecar"
                          keep_empty_value: false
```

### mTLS Filter Chain for Service-to-Service Communication

When Envoy handles mTLS termination directly without a mesh, use the TLS inspector and separate filter chains:

```yaml
        # Chain for mTLS connections
        - filter_chain_match:
            transport_protocol: tls
            server_names: ["payment-service.payments.svc.cluster.local"]
          transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              require_client_certificate: true
              common_tls_context:
                tls_certificates:
                  - certificate_chain:
                      filename: /etc/ssl/certs/server.crt
                    private_key:
                      filename: /etc/ssl/private/server.key
                validation_context:
                  trusted_ca:
                    filename: /etc/ssl/certs/ca.crt
                  match_typed_subject_alt_names:
                    - san_type: URI
                      matcher:
                        prefix: "spiffe://cluster.local/"
                alpn_protocols:
                  - h2
                  - http/1.1
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: inbound_mtls
                # ... same HCM config as above
```

### Circuit Breaking Configuration

Circuit breaking prevents cascade failures. Configure it at the cluster level:

```yaml
  clusters:
    - name: payment_service_local
      type: STATIC
      connect_timeout: 1s
      lb_policy: LEAST_REQUEST
      load_assignment:
        cluster_name: payment_service_local
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: 127.0.0.1
                      port_value: 8080
      circuit_breakers:
        thresholds:
          - priority: DEFAULT
            max_connections: 1000
            max_pending_requests: 500
            max_requests: 1000
            max_retries: 3
            track_remaining: true
          - priority: HIGH
            max_connections: 2000
            max_pending_requests: 1000
            max_requests: 2000
            max_retries: 10
      outlier_detection:
        consecutive_5xx: 5
        interval: 10s
        base_ejection_time: 30s
        max_ejection_percent: 50
        consecutive_gateway_failure: 3
        success_rate_minimum_hosts: 5
        success_rate_request_volume: 100
        success_rate_stdev_factor: 1900
      health_checks:
        - timeout: 2s
          interval: 10s
          healthy_threshold: 2
          unhealthy_threshold: 3
          http_health_check:
            path: "/healthz"
            expected_statuses:
              - start: 200
                end: 299
      upstream_connection_options:
        tcp_keepalive:
          keepalive_time: 30
          keepalive_interval: 10
          keepalive_probes: 5
```

## Dynamic xDS Configuration

### Building a Minimal Go xDS Control Plane

For teams building custom control planes, here is the structure of a Go xDS server using the `go-control-plane` library:

```go
package main

import (
    "context"
    "log"
    "net"
    "sync"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/keepalive"

    clusterservice "github.com/envoyproxy/go-control-plane/envoy/service/cluster/v3"
    discoverygrpc "github.com/envoyproxy/go-control-plane/envoy/service/discovery/v3"
    endpointservice "github.com/envoyproxy/go-control-plane/envoy/service/endpoint/v3"
    listenerservice "github.com/envoyproxy/go-control-plane/envoy/service/listener/v3"
    routeservice "github.com/envoyproxy/go-control-plane/envoy/service/route/v3"

    "github.com/envoyproxy/go-control-plane/pkg/cache/v3"
    "github.com/envoyproxy/go-control-plane/pkg/server/v3"
    "github.com/envoyproxy/go-control-plane/pkg/test/v3"

    core "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
    endpoint "github.com/envoyproxy/go-control-plane/envoy/config/endpoint/v3"
    cluster "github.com/envoyproxy/go-control-plane/envoy/config/cluster/v3"
    listener "github.com/envoyproxy/go-control-plane/envoy/config/listener/v3"
    route "github.com/envoyproxy/go-control-plane/envoy/config/route/v3"
    hcm "github.com/envoyproxy/go-control-plane/envoy/extensions/filters/network/http_connection_manager/v3"
    "github.com/envoyproxy/go-control-plane/pkg/resource/v3"
    "google.golang.org/protobuf/types/known/durationpb"
    "google.golang.org/protobuf/types/known/wrapperspb"
)

type XDSServer struct {
    snapshotCache cache.SnapshotCache
    mu            sync.RWMutex
    version       int64
}

func NewXDSServer() *XDSServer {
    snapshotCache := cache.NewSnapshotCache(false, cache.IDHash{}, nil)
    return &XDSServer{
        snapshotCache: snapshotCache,
    }
}

func (x *XDSServer) UpdateSnapshot(nodeID string, endpoints []string) error {
    x.mu.Lock()
    defer x.mu.Unlock()
    x.version++

    // Build load assignment
    var lbEndpoints []*endpoint.LbEndpoint
    for _, ep := range endpoints {
        host, port := parseEndpoint(ep)
        lbEndpoints = append(lbEndpoints, &endpoint.LbEndpoint{
            HostIdentifier: &endpoint.LbEndpoint_Endpoint{
                Endpoint: &endpoint.Endpoint{
                    Address: &core.Address{
                        Address: &core.Address_SocketAddress{
                            SocketAddress: &core.SocketAddress{
                                Address:       host,
                                PortSpecifier: &core.SocketAddress_PortValue{PortValue: port},
                            },
                        },
                    },
                },
            },
        })
    }

    clusterLoadAssignment := &endpoint.ClusterLoadAssignment{
        ClusterName: "payment-service",
        Endpoints: []*endpoint.LocalityLbEndpoints{
            {LbEndpoints: lbEndpoints},
        },
    }

    // Build cluster
    paymentCluster := &cluster.Cluster{
        Name:                 "payment-service",
        ConnectTimeout:       durationpb.New(1 * time.Second),
        ClusterDiscoveryType: &cluster.Cluster_Type{Type: cluster.Cluster_EDS},
        EdsClusterConfig: &cluster.Cluster_EdsClusterConfig{
            EdsConfig: &core.ConfigSource{
                ConfigSourceSpecifier: &core.ConfigSource_Ads{Ads: &core.AggregatedConfigSource{}},
            },
        },
        LbPolicy: cluster.Cluster_LEAST_REQUEST,
        CircuitBreakers: &cluster.CircuitBreakers{
            Thresholds: []*cluster.CircuitBreakers_Thresholds{
                {
                    MaxConnections:    wrapperspb.UInt32(1000),
                    MaxPendingRequests: wrapperspb.UInt32(500),
                    MaxRequests:       wrapperspb.UInt32(1000),
                },
            },
        },
    }

    // Build route config
    routeConfig := &route.RouteConfiguration{
        Name: "payment-route",
        VirtualHosts: []*route.VirtualHost{
            {
                Name:    "payment-service",
                Domains: []string{"*"},
                Routes: []*route.Route{
                    {
                        Match: &route.RouteMatch{
                            PathSpecifier: &route.RouteMatch_Prefix{Prefix: "/"},
                        },
                        Action: &route.Route_Route{
                            Route: &route.RouteAction{
                                ClusterSpecifier: &route.RouteAction_Cluster{
                                    Cluster: "payment-service",
                                },
                                Timeout: durationpb.New(30 * time.Second),
                            },
                        },
                    },
                },
            },
        },
    }

    // Build HCM filter
    hcmFilter, err := buildHCMFilter(routeConfig)
    if err != nil {
        return err
    }

    // Build listener
    paymentListener := &listener.Listener{
        Name: "inbound-listener",
        Address: &core.Address{
            Address: &core.Address_SocketAddress{
                SocketAddress: &core.SocketAddress{
                    Address:       "0.0.0.0",
                    PortSpecifier: &core.SocketAddress_PortValue{PortValue: 15001},
                },
            },
        },
        FilterChains: []*listener.FilterChain{
            {Filters: []*listener.Filter{hcmFilter}},
        },
    }

    snap, err := cache.NewSnapshot(
        fmt.Sprintf("%d", x.version),
        map[resource.Type][]types.Resource{
            resource.ClusterType:  {paymentCluster},
            resource.RouteType:    {routeConfig},
            resource.ListenerType: {paymentListener},
            resource.EndpointType: {clusterLoadAssignment},
        },
    )
    if err != nil {
        return err
    }

    return x.snapshotCache.SetSnapshot(context.Background(), nodeID, snap)
}

func (x *XDSServer) Serve(addr string) error {
    srv := server.NewServer(context.Background(), x.snapshotCache, &test.Callbacks{})

    grpcServer := grpc.NewServer(
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle: 15 * time.Second,
            Time:              5 * time.Second,
            Timeout:           1 * time.Second,
        }),
    )

    discoverygrpc.RegisterAggregatedDiscoveryServiceServer(grpcServer, srv)
    listenerservice.RegisterListenerDiscoveryServiceServer(grpcServer, srv)
    clusterservice.RegisterClusterDiscoveryServiceServer(grpcServer, srv)
    routeservice.RegisterRouteDiscoveryServiceServer(grpcServer, srv)
    endpointservice.RegisterEndpointDiscoveryServiceServer(grpcServer, srv)

    lis, err := net.Listen("tcp", addr)
    if err != nil {
        return err
    }

    log.Printf("xDS server listening on %s", addr)
    return grpcServer.Serve(lis)
}
```

### Deploying the xDS Control Plane in Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: xds-control-plane
  namespace: envoy-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: xds-control-plane
  template:
    metadata:
      labels:
        app: xds-control-plane
    spec:
      serviceAccountName: xds-control-plane
      containers:
        - name: xds-server
          image: registry.example.com/xds-control-plane:v1.0.0
          ports:
            - name: grpc-xds
              containerPort: 18000
            - name: metrics
              containerPort: 8080
          env:
            - name: WATCH_NAMESPACE
              value: ""
            - name: XDS_PORT
              value: "18000"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            grpc:
              port: 18000
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: xds-control-plane
  namespace: envoy-system
spec:
  selector:
    app: xds-control-plane
  ports:
    - name: grpc-xds
      port: 18000
      targetPort: 18000
  type: ClusterIP
```

## Observability and Debugging

### Prometheus Metrics via Admin Interface

Envoy exposes Prometheus metrics at `http://<pod-ip>:9901/stats/prometheus`. Key metrics to alert on:

```yaml
# Prometheus ServiceMonitor
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy-sidecar-metrics
  namespace: payments
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: payment-service
  endpoints:
    - port: envoy-admin
      path: /stats/prometheus
      interval: 15s
      scrapeTimeout: 10s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
```

Key Envoy metrics for alerting:

```promql
# Active connections
sum(envoy_cluster_upstream_cx_active{cluster_name="payment-service"}) by (pod)

# Request rate
rate(envoy_http_downstream_rq_total{stat_prefix="inbound_http"}[5m])

# Error rate (5xx)
rate(envoy_http_downstream_rq_5xx{stat_prefix="inbound_http"}[5m])
  / rate(envoy_http_downstream_rq_total{stat_prefix="inbound_http"}[5m])

# P99 latency
histogram_quantile(0.99,
  rate(envoy_http_downstream_rq_time_bucket{stat_prefix="inbound_http"}[5m])
)

# Circuit breaker opens
increase(envoy_cluster_circuit_breakers_default_cx_open{cluster_name="payment-service"}[5m])

# Upstream pending requests overflow
increase(envoy_cluster_upstream_rq_pending_overflow{cluster_name="payment-service"}[5m])
```

### Runtime Config Dumps via Admin API

You can inspect Envoy's live configuration without restarting:

```bash
# Dump current listener configuration
kubectl exec -it payment-service-xxx -c envoy-sidecar -- \
  curl -s localhost:9901/config_dump | jq '.configs[] | select(.["@type"] | contains("ListenersConfigDump"))'

# Dump cluster health status
kubectl exec -it payment-service-xxx -c envoy-sidecar -- \
  curl -s localhost:9901/clusters

# View current runtime values
kubectl exec -it payment-service-xxx -c envoy-sidecar -- \
  curl -s localhost:9901/runtime

# Check circuit breaker state
kubectl exec -it payment-service-xxx -c envoy-sidecar -- \
  curl -s localhost:9901/stats | grep circuit_breakers

# Modify runtime value without restart
kubectl exec -it payment-service-xxx -c envoy-sidecar -- \
  curl -X POST localhost:9901/runtime_modify?upstream.healthy_panic_threshold=0
```

### Enabling Access Logging to a File

For integration with log aggregation pipelines:

```yaml
access_log:
  - name: envoy.access_loggers.file
    typed_config:
      "@type": type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog
      path: /dev/stdout
      log_format:
        json_format:
          "@timestamp": "%START_TIME%"
          "client.ip": "%DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT%"
          "http.request.method": "%REQ(:METHOD)%"
          "url.path": "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
          "http.response.status_code": "%RESPONSE_CODE%"
          "event.duration": "%DURATION%"
          "upstream.address": "%UPSTREAM_HOST%"
          "tracing.trace_id": "%REQ(X-B3-TRACEID)%"
```

## Performance Tuning

### Worker Thread Configuration

For high-throughput services, tune Envoy's concurrency:

```yaml
# In the bootstrap config
concurrency: 4  # Match to CPU limit / 2

# Or via command line
args:
  - "--concurrency"
  - "4"
```

### Buffer Tuning

```yaml
# Per-listener buffer limits
per_connection_buffer_limit_bytes: 32768  # 32KB, reduce for memory-constrained pods

# Per-cluster
max_requests_per_connection: 1000
```

### Connection Pool Tuning

```yaml
clusters:
  - name: payment_service_local
    # ...
    typed_extension_protocol_options:
      envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
        "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
        upstream_http_protocol_options: {}
        common_http_protocol_options:
          idle_timeout: 90s
          max_connection_duration: 0s
          max_headers_count: 100
          max_stream_duration: 0s
        explicit_http_config:
          http2_protocol_options:
            initial_stream_window_size: 65536
            initial_connection_window_size: 1048576
            max_concurrent_streams: 100
```

## Common Production Issues and Troubleshooting

### Issue: Envoy Reports Unhealthy Upstream

```bash
# Check upstream health
kubectl exec -it payment-service-xxx -c envoy-sidecar -- \
  curl -s localhost:9901/clusters | grep -A5 "payment_service_local"

# Look for:
# health_flags::healthy
# cx_none_healthy (no healthy endpoints)
```

Resolution: Verify health check configuration matches the application's actual health endpoint. Add `ignore_health_on_host_removal: true` if you are using EDS and need graceful endpoint removal.

### Issue: High Tail Latency from Retry Storms

When retry budgets are not configured, retries amplify load. Add explicit retry budgets:

```yaml
retry_policy:
  retry_on: "5xx,reset"
  num_retries: 2
  retry_budget:
    budget_percent:
      value: 20.0
    min_retry_concurrency: 3
```

### Issue: 503 "no healthy upstream" During Rollouts

This happens when circuit breakers open during pod disruptions. Configure panic thresholds:

```yaml
# Runtime override during maintenance
curl -X POST "localhost:9901/runtime_modify?upstream.healthy_panic_threshold=10"
```

Or set via cluster configuration:
```yaml
common_lb_config:
  healthy_panic_threshold:
    value: 10.0  # Allow 10% unhealthy threshold before panic mode
```

### Issue: Memory Growth in Sidecar

Envoy does not release memory to OS efficiently. Set a memory limit and use the overload manager:

```yaml
overload_manager:
  refresh_interval: 0.25s
  resource_monitors:
    - name: envoy.resource_monitors.fixed_heap
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.resource_monitors.fixed_heap.v3.FixedHeapConfig
        max_heap_size_bytes: 209715200  # 200MB
  actions:
    - name: envoy.overload_actions.shrink_heap
      triggers:
        - name: envoy.resource_monitors.fixed_heap
          threshold:
            value: 0.90
    - name: envoy.overload_actions.stop_accepting_requests
      triggers:
        - name: envoy.resource_monitors.fixed_heap
          threshold:
            value: 0.95
```

## Summary

Running Envoy as a standalone sidecar gives you precise control over your service's traffic behavior without the full overhead of a service mesh control plane. The key principles are:

1. Use the init container iptables pattern for transparent traffic interception
2. Build filter chains with defense in depth: health checks first, then rate limiting, then external authorization, then routing
3. Configure circuit breakers and outlier detection at every cluster
4. Expose Prometheus metrics and build dashboards around the key traffic, error rate, and circuit breaker signals
5. Use the admin API for live debugging and non-disruptive runtime configuration changes
6. For dynamic environments, invest in a minimal xDS control plane using `go-control-plane` to push configuration updates without sidecar restarts

The combination of static bootstrap with xDS-driven dynamic updates gives you the best of both worlds: reliable startup behavior and the ability to respond to infrastructure changes in real time.
