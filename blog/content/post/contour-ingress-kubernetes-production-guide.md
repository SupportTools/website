---
title: "Contour Ingress Controller: HTTPProxy CRD and Advanced Routing on Kubernetes"
date: 2027-03-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Contour", "Ingress", "HTTPProxy", "Envoy"]
categories: ["Kubernetes", "Networking", "Ingress"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Contour Ingress Controller on Kubernetes covering HTTPProxy CRD for advanced routing, TLS termination with cert-manager, request routing conditions, rate limiting, timeout policies, delegation to team namespaces, and Prometheus monitoring."
more_link: "yes"
url: "/contour-ingress-kubernetes-production-guide/"
---

Contour is a Kubernetes Ingress controller built on Envoy that exposes routing logic through the `HTTPProxy` custom resource definition rather than annotation soup on a standard `Ingress` resource. Where nginx Ingress controllers require dozens of proprietary annotations to achieve header-based routing, weighted traffic splitting, or per-route timeout policies, Contour encodes those behaviors as structured YAML fields in `HTTPProxy` objects. Teams get readable, validatable configuration with IDE completion and admission webhook validation, rather than raw annotation strings that fail silently at runtime.

This guide covers Contour's architecture, Helm deployment with production values, the full HTTPProxy CRD surface, TLS with cert-manager and cross-namespace delegation, rate limiting, load balancing strategies, and Prometheus monitoring.

<!--more-->

## Contour vs NGINX Ingress vs Traefik

Choosing an Ingress controller affects the expressiveness of routing rules, operational complexity, and integration with the rest of the platform.

### Feature Comparison

| Feature | Contour | NGINX Ingress | Traefik |
|---|---|---|---|
| Advanced routing CRD | HTTPProxy | Annotations only | IngressRoute |
| Data plane | Envoy | NGINX | Traefik (built-in) |
| HTTP/2 and gRPC | Yes (native) | Yes (with config) | Yes |
| WebSocket | Yes | Yes | Yes |
| Weight-based splitting | Yes (HTTPProxy) | Annotation (limited) | Yes (IngressRoute) |
| Header-based routing | Yes | Limited annotation | Yes |
| Namespace delegation | Yes (HTTPProxy delegate) | No | No |
| Rate limiting | Yes (GlobalRateLimitPolicy) | Annotation | Middleware CRD |
| TLS certificate delegation | Yes (TLSCertificateDelegation) | No | No |
| xDS dynamic config | Yes | No | No |
| Prometheus metrics | Yes (built-in) | Yes | Yes |

### When to Choose Contour

Contour is the optimal choice when:
- Multiple teams share a cluster and need to manage routing in their own namespaces without cluster-admin access
- Advanced routing logic (header matching, multiple conditions) is required without annotation proliferation
- gRPC routing with proper HTTP/2 semantics is needed
- Envoy's circuit breaking, outlier detection, and retry logic should be accessible via declarative configuration

## Contour Architecture

Contour consists of two components that communicate over xDS.

**Contour control plane**: A Go binary that watches Kubernetes resources (`HTTPProxy`, `Ingress`, `Service`, `Endpoints`, `Secrets`) and translates them into xDS resource updates (LDS, RDS, CDS, EDS). It runs as a Deployment and exposes the xDS API over gRPC on port 8001.

**Envoy data plane**: The Envoy proxy instances that receive xDS updates from the Contour control plane and handle actual HTTP/HTTPS traffic. Envoy runs as a DaemonSet (one pod per node) or Deployment (fixed replicas) depending on the traffic model.

The separation of concerns means Contour upgrades do not restart Envoy, and xDS config pushes are incremental — only changed resources are retransmitted.

## Helm Deployment with Production Values

```bash
# Add the Bitnami chart repository (packages Contour and Envoy together)
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Inspect available configuration options
helm show values bitnami/contour | head -200
```

```yaml
# contour-values.yaml
# Production Contour deployment values
contour:
  image:
    repository: ghcr.io/projectcontour/contour
    tag: v1.29.1
    pullPolicy: IfNotPresent

  replicaCount: 2

  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

  # Pod anti-affinity to spread control plane across nodes
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: contour
          topologyKey: kubernetes.io/hostname

  # Leader election for active-standby Contour pods
  leaderElection:
    enabled: true

  # Contour configuration file
  configFileContents:
    # Ingress class name this Contour instance manages
    ingress-class-name: contour

    # TLS settings
    tls:
      minimum-protocol-version: TLSv1.2
      cipher-suites:
        - '[ECDHE-ECDSA-AES128-GCM-SHA256|ECDHE-ECDSA-CHACHA20-POLY1305]'
        - '[ECDHE-RSA-AES128-GCM-SHA256|ECDHE-RSA-CHACHA20-POLY1305]'
        - 'ECDHE-ECDSA-AES256-GCM-SHA384'
        - 'ECDHE-RSA-AES256-GCM-SHA384'

    # Default timeouts applied to all routes unless overridden by HTTPProxy
    timeouts:
      request-timeout: 60s
      connection-idle-timeout: 60s
      stream-idle-timeout: 5m
      max-connection-duration: 0s    # Unlimited connection duration
      connection-shutdown-grace-period: 5s

    # Envoy listener settings
    listener:
      use-proxy-protocol: false
      connection-balancer: "exact"   # Even connection distribution across Envoy worker threads

    # Access logging format (JSON for structured logging pipelines)
    accesslog-format: json
    json-fields:
      - "@timestamp"
      - "authority"
      - "bytes_received"
      - "bytes_sent"
      - "downstream_local_address"
      - "downstream_remote_address"
      - "duration"
      - "method"
      - "path"
      - "protocol"
      - "request_id"
      - "requested_server_name"
      - "response_code"
      - "response_flags"
      - "uber_trace_id"
      - "upstream_cluster"
      - "upstream_host"
      - "upstream_local_address"
      - "upstream_service_time"
      - "user_agent"
      - "x_forwarded_for"

    # Metrics endpoint
    metrics:
      address: 0.0.0.0
      port: 8000

    # Health check endpoint
    health:
      address: 0.0.0.0
      port: 8000

envoy:
  image:
    repository: docker.io/envoyproxy/envoy
    tag: v1.30.1
    pullPolicy: IfNotPresent

  # Run as DaemonSet for predictable capacity (one Envoy per node)
  kind: DaemonSet

  resources:
    requests:
      cpu: 500m
      memory: 256Mi
    limits:
      cpu: 4000m
      memory: 1Gi

  # Host networking gives Envoy direct access to node ports (useful for LoadBalancer type)
  hostNetwork: false
  hostPorts:
    enable: false

  service:
    type: LoadBalancer
    # For AWS EKS with NLB
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
      service.beta.kubernetes.io/aws-load-balancer-backend-protocol: tcp

  terminationGracePeriodSeconds: 300

  # Health check port exposed for load balancer target group health checks
  healthPort: 8002

  # Prometheus metrics port on the Envoy pod
  metrics:
    port: 8002
    serviceMonitor:
      enabled: true

rbac:
  create: true

# Global rate limit policy (requires a rate limit service)
# rateLimitService:
#   extensionService: envoy-system/ratelimit
#   domain: contour

ingressClass:
  name: contour
  create: true
  default: false   # Do not make this the default class; teams must opt in
```

```bash
# Deploy Contour with production values
helm upgrade --install contour bitnami/contour \
  --namespace envoy-system \
  --create-namespace \
  --values contour-values.yaml \
  --wait --timeout 10m
```

## HTTPProxy CRD: Core Concepts

The `HTTPProxy` resource is the primary routing configuration object in Contour. It replaces the Kubernetes `Ingress` resource with a more expressive schema.

### Simple HTTPProxy

```yaml
# simple-httpproxy.yaml
# Basic HTTPProxy routing to a single upstream service
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: api-gateway
  namespace: default
spec:
  # Virtual host configuration — top-level HTTPProxy only
  virtualhost:
    fqdn: api.support.tools
    # TLS configuration
    tls:
      secretName: api-tls-cert

  # Route definitions
  routes:
    - conditions:
        - prefix: /
      services:
        - name: api-service
          port: 8080
      # Timeout policy for this route
      timeoutPolicy:
        response: 30s
        idle: 60s
      # Retry policy
      retryPolicy:
        count: 3
        perTryTimeout: 10s
        retryOn:
          - 5xx
          - reset
          - connect-failure
```

## Advanced Routing with HTTPProxy Conditions

HTTPProxy conditions support matching on path prefix, exact path, regex path, query parameters, and request headers. Multiple conditions within a single route are AND-ed together.

```yaml
# advanced-routing-httpproxy.yaml
# HTTPProxy with header-based routing and traffic splitting
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: orders-api
  namespace: orders
spec:
  virtualhost:
    fqdn: api.support.tools
    tls:
      secretName: api-tls-cert

  routes:
    # Route internal preview traffic to the canary version
    - conditions:
        - prefix: /api/v2/orders
        - header:
            name: X-Preview-Version
            present: true
      services:
        - name: orders-api-canary
          port: 8080
      loadBalancerPolicy:
        strategy: Random
      timeoutPolicy:
        response: 30s
        idle: 60s

    # Route 10% of production traffic to the canary version
    - conditions:
        - prefix: /api/v2/orders
      services:
        - name: orders-api-stable
          port: 8080
          weight: 90   # 90% of traffic goes to stable
        - name: orders-api-canary
          port: 8080
          weight: 10   # 10% of traffic goes to canary
      loadBalancerPolicy:
        strategy: WeightedLeastRequest
      timeoutPolicy:
        response: 30s

    # Route all other /api/v2/ traffic to the stable version
    - conditions:
        - prefix: /api/v2/
      services:
        - name: orders-api-stable
          port: 8080
      timeoutPolicy:
        response: 30s
        idle: 60s
      retryPolicy:
        count: 2
        perTryTimeout: 15s
        retryOn:
          - 5xx
          - retriable-status-codes
        retriableStatusCodes:
          - 503

    # Health check endpoint — no timeout, no retry
    - conditions:
        - prefix: /healthz
      services:
        - name: orders-api-stable
          port: 8080

    # Redirect HTTP to HTTPS
    - conditions:
        - prefix: /
      requestRedirectPolicy:
        scheme: https
        statusCode: 301
```

### Header Matching Conditions

```yaml
# Header-based routing conditions
routes:
  # Route mobile clients to the mobile-optimized backend
  - conditions:
      - prefix: /api/
      - header:
          name: User-Agent
          contains: "MobileApp"
    services:
      - name: api-mobile
        port: 8080

  # Route admin users based on a custom header injected by the auth layer
  - conditions:
      - prefix: /api/admin/
      - header:
          name: X-User-Role
          exact: admin
    services:
      - name: api-admin
        port: 8080

  # Reject requests with a specific header (security enforcement)
  - conditions:
      - prefix: /api/
      - header:
          name: X-Debug-Bypass
          present: true
    # Return 403 for requests with the bypass header
    directResponsePolicy:
      statusCode: 403
      body: "Debug bypass header is not permitted in production"
```

## TLS Termination with cert-manager

Contour terminates TLS using certificates stored in Kubernetes Secrets. cert-manager automates certificate issuance and renewal.

```yaml
# contour-tls-cert.yaml
# Certificate for the primary API domain
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls-cert
  namespace: default
spec:
  secretName: api-tls-cert
  duration: 2160h    # 90 days
  renewBefore: 360h  # Renew 15 days before expiry
  dnsNames:
    - api.support.tools
    - "*.api.support.tools"
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

### TLSCertificateDelegation for Cross-Namespace TLS

By default, an HTTPProxy can only reference TLS secrets in its own namespace. `TLSCertificateDelegation` allows a certificate stored in one namespace (e.g., the infrastructure team's namespace) to be used by HTTPProxy resources in other namespaces.

```yaml
# tls-delegation.yaml
# Allow the wildcard certificate in the infra namespace to be used by team namespaces
apiVersion: projectcontour.io/v1
kind: TLSCertificateDelegation
metadata:
  name: wildcard-cert-delegation
  # This resource lives in the namespace that owns the certificate
  namespace: infra
spec:
  delegations:
    # Allow the orders namespace to reference the wildcard-tls secret
    - secretName: wildcard-support-tools-tls
      targetNamespaces:
        - orders
        - payments
        - notifications
---
# Team HTTPProxy referencing the delegated certificate
# Note the cross-namespace secret reference syntax: namespace/secretName
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: orders-api
  namespace: orders
spec:
  virtualhost:
    fqdn: orders-api.support.tools
    tls:
      # Cross-namespace reference using the delegation
      secretName: infra/wildcard-support-tools-tls
  routes:
    - conditions:
        - prefix: /
      services:
        - name: orders-service
          port: 8080
```

## HTTPProxy Delegation: Self-Service Namespace Routing

HTTPProxy delegation allows a root HTTPProxy (owned by the platform team in the cluster namespace) to delegate routing for a path prefix to child HTTPProxy resources in team namespaces. Teams manage their own routes without cluster-admin access.

### Root HTTPProxy (Platform Team)

```yaml
# root-httpproxy.yaml
# Root HTTPProxy in the infra namespace — owned by the platform team
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: root-gateway
  namespace: infra
spec:
  virtualhost:
    fqdn: api.support.tools
    tls:
      secretName: wildcard-support-tools-tls

  routes:
    # Global health check — handled by the platform team's service
    - conditions:
        - exact: /healthz
      services:
        - name: platform-health
          port: 8080

  # Delegate /orders/ to the orders namespace
  includes:
    - name: orders-routes
      namespace: orders
      conditions:
        - prefix: /orders/

    # Delegate /payments/ to the payments namespace
    - name: payments-routes
      namespace: payments
      conditions:
        - prefix: /payments/

    # Delegate /notifications/ to the notifications namespace
    - name: notifications-routes
      namespace: notifications
      conditions:
        - prefix: /notifications/
```

### Child HTTPProxy (Team Namespace)

```yaml
# child-httpproxy.yaml
# Child HTTPProxy in the orders namespace — owned by the orders team
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: orders-routes
  namespace: orders
  # No virtualhost field — child HTTPProxy inherits from the parent
spec:
  routes:
    # /orders/v1/ → orders-api-v1 service
    - conditions:
        - prefix: /orders/v1/
      services:
        - name: orders-api-v1
          port: 8080
      timeoutPolicy:
        response: 30s
        idle: 120s

    # /orders/v2/ → orders-api-v2 service with canary split
    - conditions:
        - prefix: /orders/v2/
      services:
        - name: orders-api-v2-stable
          port: 8080
          weight: 95
        - name: orders-api-v2-canary
          port: 8080
          weight: 5

    # /orders/websocket/ → WebSocket-capable service
    - conditions:
        - prefix: /orders/websocket/
      services:
        - name: orders-websocket
          port: 8080
      # WebSocket connections require longer idle timeout
      timeoutPolicy:
        response: infinity  # No response timeout for WebSocket
        idle: 3600s         # 1 hour idle timeout
      enableWebsockets: true
```

## Load Balancing Strategies

Contour exposes Envoy's load balancing algorithms through the HTTPProxy `loadBalancerPolicy` field.

```yaml
# Load balancing strategy examples
routes:
  # Round robin (default) — simple even distribution
  - conditions:
      - prefix: /api/
    loadBalancerPolicy:
      strategy: RoundRobin
    services:
      - name: api-service
        port: 8080

  # Random — useful when backends have similar capacity
  - conditions:
      - prefix: /static/
    loadBalancerPolicy:
      strategy: Random
    services:
      - name: static-service
        port: 8080

  # WeightedLeastRequest — routes to the host with fewer active requests,
  # weighted by the configured weights
  - conditions:
      - prefix: /heavy/
    loadBalancerPolicy:
      strategy: WeightedLeastRequest
    services:
      - name: heavy-service
        port: 8080

  # Cookie-based session affinity — sticky sessions via a cookie
  - conditions:
      - prefix: /session/
    loadBalancerPolicy:
      strategy: Cookie
      requestHashPolicies:
        - headerHashOptions:
            headerName: X-Session-ID
          terminal: true   # Stop hash computation after this policy
    services:
      - name: session-service
        port: 8080

  # RequestHash — route based on a header value (consistent hashing)
  - conditions:
      - prefix: /cache/
    loadBalancerPolicy:
      strategy: RequestHash
      requestHashPolicies:
        - headerHashOptions:
            headerName: X-Cache-Key
          terminal: true
    services:
      - name: cache-service
        port: 8080
```

## Rate Limiting with GlobalRateLimitPolicy

Contour integrates with an external rate limit service (the same Envoy Rate Limit Service used standalone) through a `GlobalRateLimitPolicy` resource.

```yaml
# rate-limit-extension.yaml
# ExtensionService pointing to the rate limit gRPC server
apiVersion: projectcontour.io/v1alpha1
kind: ExtensionService
metadata:
  name: ratelimit
  namespace: envoy-system
spec:
  services:
    - name: ratelimit-grpc
      port: 8081
  protocol: h2
  timeoutPolicy:
    response: 500ms
    idle: 60s
---
# HTTPProxy with per-route rate limiting
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: orders-api-ratelimited
  namespace: orders
spec:
  virtualhost:
    fqdn: api.support.tools
    tls:
      secretName: infra/wildcard-support-tools-tls
    # Attach the rate limit service to this virtual host
    rateLimitPolicy:
      global:
        descriptors:
          # Include the remote IP in the rate limit descriptor
          - entries:
              - remoteAddress: {}

  routes:
    - conditions:
        - prefix: /orders/
      services:
        - name: orders-service
          port: 8080
      # Per-route rate limit descriptor (appended to the virtualhost descriptor)
      rateLimitPolicy:
        global:
          descriptors:
            # Route-specific descriptor: remote IP + path prefix
            - entries:
                - remoteAddress: {}
                - genericKey:
                    value: orders_route
        local:
          # Local rate limiting without the external service (token bucket)
          requests: 1000
          unit: second
          burst: 200
```

## Timeout and Retry Policies

Timeout policies in Contour apply at the route level and override the global defaults set in the Contour configuration file.

```yaml
# timeout-retry-httpproxy.yaml
# HTTPProxy with comprehensive timeout and retry configuration
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: orders-with-policies
  namespace: orders
spec:
  routes:
    # Fast path: tight timeout, no retry (idempotent reads)
    - conditions:
        - prefix: /orders/list
      services:
        - name: orders-service
          port: 8080
      timeoutPolicy:
        response: 5s      # Total response deadline
        idle: 30s         # Close connection after 30s of inactivity
      # No retry policy — return errors immediately to the client

    # Slow path: extended timeout, retry on transient errors
    - conditions:
        - prefix: /orders/export
      services:
        - name: orders-service
          port: 8080
      timeoutPolicy:
        response: 300s    # 5 minutes for large export operations
        idle: 300s

    # Order creation: retry on 503 only (idempotent with dedup)
    - conditions:
        - prefix: /orders/create
      services:
        - name: orders-service
          port: 8080
      timeoutPolicy:
        response: 30s
        idle: 60s
      retryPolicy:
        count: 3
        perTryTimeout: 10s
        retryOn:
          - reset
          - connect-failure
          - retriable-status-codes
        retriableStatusCodes:
          - 503

    # WebSocket upgrade path: infinite timeout, no retry
    - conditions:
        - prefix: /orders/live
      services:
        - name: orders-websocket
          port: 8080
      timeoutPolicy:
        response: infinity  # WebSocket connections should not time out
        idle: 3600s
      enableWebsockets: true
```

## Request and Response Header Manipulation

Contour supports adding, setting, and removing HTTP headers at the route and service level.

```yaml
# header-manipulation-httpproxy.yaml
# HTTPProxy with request and response header manipulation
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: orders-with-headers
  namespace: orders
spec:
  routes:
    - conditions:
        - prefix: /api/
      services:
        - name: orders-service
          port: 8080

      # Headers added to the request before forwarding to the upstream
      requestHeadersPolicy:
        set:
          # Overwrite the Host header (useful for internal routing)
          - name: Host
            value: orders-service.orders.svc.cluster.local
          # Add a header indicating the request came through Contour
          - name: X-Ingress-Controller
            value: contour-v1.29.1
        # Remove sensitive headers before forwarding
        remove:
          - X-Debug-Internal
          - X-Internal-Token

      # Headers added to the response before returning to the client
      responseHeadersPolicy:
        set:
          # Add security headers
          - name: Strict-Transport-Security
            value: "max-age=31536000; includeSubDomains; preload"
          - name: X-Content-Type-Options
            value: "nosniff"
          - name: X-Frame-Options
            value: "DENY"
          - name: Content-Security-Policy
            value: "default-src 'self'; script-src 'self' 'unsafe-inline'"
        remove:
          # Remove version disclosure headers
          - Server
          - X-Powered-By
```

## Prometheus Monitoring

Contour and Envoy both expose Prometheus metrics. Contour exposes its own metrics (xDS push counts, error rates) and Envoy exposes detailed traffic metrics.

```yaml
# contour-monitoring.yaml
# ServiceMonitor for Contour control plane metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: contour
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: contour
  namespaceSelector:
    matchNames:
      - envoy-system
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
---
# ServiceMonitor for Envoy data plane metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: envoy
  namespaceSelector:
    matchNames:
      - envoy-system
  endpoints:
    - port: metrics
      interval: 15s
      path: /stats/prometheus
---
# PrometheusRule for Contour alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: contour-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: contour.ingress
      interval: 1m
      rules:
        - alert: ContourHTTPProxyInvalid
          expr: contour_httpproxy_invalid_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "One or more HTTPProxy resources are invalid"
            description: "{{ $value }} HTTPProxy resource(s) are in an invalid state. Run 'kubectl get httpproxy -A' to identify them."

        - alert: ContourEnvoyConnectionError
          expr: rate(contour_envoy_cache_operation_total{operation="update",type="error"}[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Contour is experiencing xDS update errors with Envoy"

        - alert: EnvoyHighErrorRate
          expr: |
            rate(envoy_cluster_upstream_rq_5xx[5m])
              / rate(envoy_cluster_upstream_rq_total[5m]) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Envoy upstream 5xx error rate is above 5%"
            description: "Cluster {{ $labels.envoy_cluster_name }} has a {{ $value | humanizePercentage }} 5xx error rate."

        - alert: EnvoyHighP99Latency
          expr: |
            histogram_quantile(0.99,
              rate(envoy_cluster_upstream_rq_time_bucket[5m])
            ) > 2000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Envoy upstream p99 latency is above 2 seconds"
            description: "Cluster {{ $labels.envoy_cluster_name }} p99 latency is {{ $value | humanizeDuration }}."
```

### Key Grafana Dashboard Queries

```promql
# Request rate through Contour-managed virtual hosts
sum(rate(envoy_http_downstream_rq_total{envoy_http_conn_manager_prefix="ingress_https"}[5m]))

# Per-service request rate (by upstream cluster)
sum by (envoy_cluster_name) (rate(envoy_cluster_upstream_rq_total[5m]))

# HTTPProxy resource status distribution
contour_httpproxy_total

# Invalid HTTPProxy count
contour_httpproxy_invalid_total

# Envoy active downstream connections
sum(envoy_http_downstream_cx_active)

# Per-cluster connection pool saturation
envoy_cluster_upstream_cx_active / envoy_cluster_circuit_breakers_default_cx_open
```

## Troubleshooting HTTPProxy Conditions

The `HTTPProxy` resource reports its status through the `Status.Conditions` field. An HTTPProxy in an error state does not receive traffic.

```bash
# Check the status of all HTTPProxy resources in a namespace
kubectl get httpproxy -n orders -o wide

# Example output showing a valid and an invalid proxy:
# NAME                    FQDN                     TLS SECRET                STATUS   STATUS DESCRIPTION
# orders-api              api.support.tools         infra/wildcard-tls        valid    Valid HTTPProxy
# orders-api-broken       broken.support.tools      missing-secret            invalid  Spec.Virtualhost.TLS Secret "missing-secret" not found

# Get the full conditions for a specific HTTPProxy
kubectl get httpproxy orders-api -n orders -o jsonpath='{.status.conditions}' | jq .

# Common status conditions and their meanings:
# - Valid: All routes and services are correctly configured
# - Invalid: Configuration error (missing service, bad secret reference, delegation conflict)
# - Orphaned: The HTTPProxy is a child but no parent HTTPProxy includes it

# Debug HTTPProxy delegation chain issues
kubectl describe httpproxy orders-api -n orders

# Force Contour to reload by restarting the control plane (no traffic disruption)
kubectl rollout restart deployment/contour -n envoy-system
```

### Common HTTPProxy Error Patterns

```bash
# Delegation target not found: the child HTTPProxy name/namespace is wrong
# Fix: ensure the child HTTPProxy name and namespace match exactly in the parent's includes

# Invalid: Spec.Virtualhost.TLS Secret not found
# Fix: create the certificate or TLSCertificateDelegation before the HTTPProxy

# Orphaned: HTTPProxy is not referenced by any parent
# Fix: add an includes entry in the root HTTPProxy pointing to this child

# Service not found: the referenced Service does not exist
kubectl get service -n orders orders-service

# Check that the Service has the expected port
kubectl describe service -n orders orders-service | grep Port

# Validate that endpoints are registered (pods are running and healthy)
kubectl get endpoints -n orders orders-service
```

## Summary

Contour's HTTPProxy CRD provides a structured, validatable alternative to annotation-based Ingress configuration. The delegation model enables multi-team self-service routing: the platform team owns the root HTTPProxy and virtual host definition while application teams manage routes within their namespaces without cluster-admin access. TLS with cert-manager and `TLSCertificateDelegation` enables certificate sharing across namespace boundaries with explicit delegation grants. Load balancing strategies ranging from round-robin to consistent hash, combined with per-route timeout, retry, and header manipulation policies, cover the majority of production traffic management requirements without dropping to raw Envoy configuration. Prometheus monitoring via ServiceMonitor and PrometheusRule resources provides the observability foundation needed to detect routing misconfigurations, latency regressions, and error rate spikes before they become user-visible incidents.
