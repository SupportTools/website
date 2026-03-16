---
title: "Contour Ingress Controller: HTTPProxy and Envoy for Kubernetes"
date: 2027-01-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Contour", "Ingress", "Envoy", "Networking"]
categories: ["Kubernetes", "Networking", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete production guide to Contour ingress controller covering HTTPProxy CRD, TLS delegation, rate limiting, health checking, WebSocket support, Prometheus monitoring, and migration from nginx-ingress."
more_link: "yes"
url: "/contour-ingress-controller-envoy-proxy-kubernetes-guide/"
---

The standard Kubernetes `Ingress` resource was designed for simplicity, not enterprise routing requirements. Annotation-overloaded nginx-ingress configurations quickly become brittle and hard to audit. **Contour** solves this by introducing the **HTTPProxy** CRD — a first-class, composable routing primitive — while delegating data-plane work to Envoy Proxy, one of the most capable and battle-tested reverse proxies available. The result is an ingress controller with strong configuration safety guarantees, rich routing semantics, and deep Prometheus integration.

This guide covers Contour's architecture, HTTPProxy configuration patterns, TLS delegation, rate limiting, health checking, WebSocket support, observability, and migration from nginx-ingress.

<!--more-->

## Architecture

Contour runs as two distinct components.

**contour** is the control plane. It watches Kubernetes objects (Ingress, HTTPProxy, Gateway API resources, TLSCertificateDelegation) and translates them into Envoy xDS (discovery service) configuration. The control plane connects to Envoy over gRPC and pushes configuration updates without reloading the proxy process — eliminating the downtime-during-reload issue that plagued older nginx-based controllers.

**envoy** is the data plane DaemonSet (or Deployment). Each node runs an Envoy pod that handles actual traffic. Envoy connects to the contour control plane and receives configuration via the Envoy xDS protocol. Because Envoy is a separate process with a hot-reload capable bootstrap, configuration changes take effect within milliseconds.

```
Traffic Flow
Client → Envoy DaemonSet (port 80/443) → Pod

Configuration Flow
HTTPProxy CRDs → contour control plane → xDS gRPC → Envoy
TLS Secrets   →                        ↗
```

### Why This Architecture Matters

The separation between control plane and data plane provides several operational benefits:

- **No reload latency**: Envoy applies configuration changes dynamically without dropping connections.
- **Namespace delegation**: HTTPProxy allows namespaced delegation of subpaths and TLS certificates, enabling self-service routing for tenant teams without cluster-admin access.
- **Configuration validation**: contour validates HTTPProxy objects and reports status conditions — operators know immediately if a proxy is invalid rather than discovering it from failing requests.

## Installation

### Helm Installation

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

kubectl create namespace projectcontour

helm upgrade --install contour bitnami/contour \
  --namespace projectcontour \
  --version 17.0.3 \
  --set contour.replicaCount=2 \
  --set contour.resources.requests.cpu=100m \
  --set contour.resources.requests.memory=128Mi \
  --set contour.resources.limits.cpu="1" \
  --set contour.resources.limits.memory=512Mi \
  --set envoy.kind=daemonset \
  --set envoy.hostPorts.enable=true \
  --set envoy.hostPorts.http=80 \
  --set envoy.hostPorts.https=443 \
  --set envoy.resources.requests.cpu=100m \
  --set envoy.resources.requests.memory=256Mi \
  --set envoy.resources.limits.cpu="4" \
  --set envoy.resources.limits.memory=2Gi \
  --set metrics.serviceMonitor.enabled=true \
  --wait
```

### Apply the ContourConfiguration

```yaml
apiVersion: projectcontour.io/v1alpha1
kind: ContourConfiguration
metadata:
  name: contour
  namespace: projectcontour
spec:
  xdsServer:
    type: contour
  ingress:
    classNames:
      - contour
  debug:
    logLevel: info
  health:
    address: 0.0.0.0
    port: 8000
  metrics:
    address: 0.0.0.0
    port: 8002
  envoy:
    defaultHTTPVersions:
      - HTTP/1.1
      - HTTP/2
    listener:
      useProxyProtocol: false
      disableAllowChunkedLength: false
      connectionBalancer: ""
      tls:
        minimumProtocolVersion: "1.2"
        maximumProtocolVersion: "1.3"
        cipherSuites:
          - ECDHE-ECDSA-AES128-GCM-SHA256
          - ECDHE-RSA-AES128-GCM-SHA256
          - ECDHE-ECDSA-AES256-GCM-SHA384
          - ECDHE-RSA-AES256-GCM-SHA384
    timeouts:
      requestTimeout: 60s
      connectionIdleTimeout: 60s
      streamIdleTimeout: 5m
      maxConnectionDuration: 0s
      delayedCloseTimeout: 1s
      connectionShutdownGracePeriod: 5s
    cluster:
      dnsLookupFamily: auto
    network:
      adminPort: 9001
      numTrustedHops: 1
  gateway:
    controllerName: projectcontour.io/gateway-controller
```

## HTTPProxy vs Ingress

The `Ingress` resource uses annotations for any behaviour beyond basic path routing. These annotations are controller-specific, undocumented in the Kubernetes API, and invisible to admission webhooks. A misconfigured annotation silently fails.

**HTTPProxy** expresses all routing semantics in typed, validated YAML. Contour reports an HTTPProxy's status as `Valid` or `Invalid` with a descriptive message, giving operators immediate feedback.

### Basic HTTPProxy

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: webapp
  namespace: production
spec:
  virtualhost:
    fqdn: webapp.example.com
    tls:
      secretName: webapp-tls
  routes:
    # Root path to main service
    - conditions:
        - prefix: /
      services:
        - name: webapp
          port: 8080
      timeoutPolicy:
        response: 30s
        idle: 60s
      retryPolicy:
        count: 3
        perTryTimeout: 10s
        retriableStatusCodes:
          - 502
          - 503
          - 504
      loadBalancerPolicy:
        strategy: Cookie
```

### Route Conditions and Header Manipulation

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: api-gateway
  namespace: production
spec:
  virtualhost:
    fqdn: api.example.com
    tls:
      secretName: api-tls
  routes:
    # Version-based routing via header
    - conditions:
        - prefix: /v2/
        - header:
            name: Accept
            contains: application/json
      services:
        - name: api-v2
          port: 8080
      requestHeadersPolicy:
        set:
          - name: X-Forwarded-Prefix
            value: /v2
      responseHeadersPolicy:
        set:
          - name: X-API-Version
            value: v2
        remove:
          - X-Internal-Server-Id

    # Default v1 route
    - conditions:
        - prefix: /v1/
      services:
        - name: api-v1
          port: 8080

    # Health check endpoint — no auth required
    - conditions:
        - exact: /health
      services:
        - name: api-v1
          port: 8080
      permitInsecure: true
```

## TLS Delegation

TLS delegation allows a platform team to manage wildcard or root-domain certificates in one namespace and delegate their use to tenant HTTPProxies in other namespaces. Tenants can use the certificate without ever having access to the Secret.

```yaml
# Platform team creates this in the 'tls-secrets' namespace
apiVersion: projectcontour.io/v1
kind: TLSCertificateDelegation
metadata:
  name: wildcard-delegation
  namespace: tls-secrets
spec:
  delegations:
    # Allow all namespaces to use the wildcard cert
    - secretName: wildcard-example-com
      targetNamespaces:
        - "*"
    # Or restrict to specific namespaces
    - secretName: internal-wildcard
      targetNamespaces:
        - production
        - staging
```

```yaml
# Tenant HTTPProxy in the 'production' namespace references the delegated cert
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: tenant-app
  namespace: production
spec:
  virtualhost:
    fqdn: tenant.example.com
    tls:
      secretName: tls-secrets/wildcard-example-com   # namespace/secret-name
  routes:
    - conditions:
        - prefix: /
      services:
        - name: tenant-app
          port: 8080
```

## Delegation via Inclusion

HTTPProxy supports delegation of path prefixes to child HTTPProxy objects in the same or different namespaces. This enables self-service routing: tenant teams create HTTPProxy objects for their own paths without needing access to the root virtual host.

```yaml
# Root HTTPProxy owned by the platform team
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: root-proxy
  namespace: projectcontour
spec:
  virtualhost:
    fqdn: apps.example.com
    tls:
      secretName: tls-secrets/wildcard-example-com
  includes:
    # Delegate /team-alpha/ to team alpha's namespace
    - name: team-alpha-proxy
      namespace: team-alpha
      conditions:
        - prefix: /team-alpha/
    # Delegate /team-beta/ to team beta's namespace
    - name: team-beta-proxy
      namespace: team-beta
      conditions:
        - prefix: /team-beta/
---
# Child HTTPProxy in team-alpha namespace (team alpha controls this)
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: team-alpha-proxy
  namespace: team-alpha
spec:
  routes:
    - conditions:
        - prefix: /team-alpha/api/
      services:
        - name: alpha-api
          port: 8080
    - conditions:
        - prefix: /team-alpha/
      services:
        - name: alpha-frontend
          port: 3000
```

## Load Balancing Strategies

Contour exposes Envoy's full suite of load balancing algorithms:

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: lb-examples
  namespace: production
spec:
  virtualhost:
    fqdn: lb-demo.example.com
  routes:
    # Round-robin (default)
    - conditions:
        - prefix: /rr/
      services:
        - name: backend-rr
          port: 8080
      loadBalancerPolicy:
        strategy: RoundRobin

    # Least-requests — sends to the upstream with fewest active requests
    - conditions:
        - prefix: /lr/
      services:
        - name: backend-lr
          port: 8080
      loadBalancerPolicy:
        strategy: WeightedLeastRequest

    # Cookie-based session affinity
    - conditions:
        - prefix: /sticky/
      services:
        - name: backend-sticky
          port: 8080
      loadBalancerPolicy:
        strategy: Cookie

    # Header-based consistent hash (useful for gRPC streaming)
    - conditions:
        - prefix: /grpc/
      services:
        - name: grpc-backend
          port: 50051
      loadBalancerPolicy:
        strategy: RequestHash
        requestHashPolicies:
          - headerHashOptions:
              headerName: x-user-id
            terminal: true
          - hashSourceIP: true
```

## Health Checking

Contour configures active health checks that Envoy sends directly to upstream pods, independent of Kubernetes readiness probes:

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: health-checked-app
  namespace: production
spec:
  virtualhost:
    fqdn: app.example.com
  routes:
    - conditions:
        - prefix: /
      services:
        - name: app
          port: 8080
          healthPort: 9090    # separate health check port if the app uses one
      healthCheckPolicy:
        path: /healthz
        intervalSeconds: 5
        timeoutSeconds: 2
        unhealthyThresholdCount: 3
        healthyThresholdCount: 2
        host: health-check.internal
```

## Rate Limiting with Global Rate Limit Service

Contour integrates with an external rate limit service using the Envoy rate limit API. Deploy a Redis-backed rate limit service first, then configure Contour:

```yaml
# ContourConfiguration — point to the rate limit service
apiVersion: projectcontour.io/v1alpha1
kind: ContourConfiguration
metadata:
  name: contour
  namespace: projectcontour
spec:
  rateLimitService:
    extensionService: projectcontour/ratelimit
    domain: contour
    failOpen: false           # reject requests if rate limit service is down
    enableXRateLimitHeaders: true
    enableResourceExhaustedCode: true
```

```yaml
# ExtensionService pointing to the deployed rate limit server
apiVersion: projectcontour.io/v1alpha1
kind: ExtensionService
metadata:
  name: ratelimit
  namespace: projectcontour
spec:
  protocol: h2c
  services:
    - name: ratelimit
      port: 8081
  timeoutPolicy:
    response: 100ms
    idle: 30s
```

Apply per-virtual-host rate limits:

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: rate-limited-api
  namespace: production
spec:
  virtualhost:
    fqdn: api.example.com
    tls:
      secretName: api-tls
    rateLimitPolicy:
      global:
        descriptors:
          # Limit by client IP: 100 requests per minute
          - entries:
              - remoteAddress: {}
          # Limit by Authorization header (per-token)
          - entries:
              - requestHeader:
                  headerName: Authorization
                  descriptorKey: auth_token
  routes:
    - conditions:
        - prefix: /api/expensive/
      services:
        - name: expensive-service
          port: 8080
      rateLimitPolicy:
        global:
          descriptors:
            # Tighter limit on expensive endpoints
            - entries:
                - remoteAddress: {}
                - genericKey:
                    value: expensive
        local:
          requests: 10
          unit: second
          burst: 20
```

## Upstream TLS

When backends serve HTTPS internally (mutual TLS within the cluster, or backends with their own certificates):

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: upstream-tls
  namespace: production
spec:
  virtualhost:
    fqdn: secure-app.example.com
    tls:
      secretName: frontend-tls
  routes:
    - conditions:
        - prefix: /
      services:
        - name: backend-with-tls
          port: 8443
          protocol: tls
          # Validate the backend's certificate
          validation:
            caSecret: backend-ca
            subjectName: backend.production.svc.cluster.local
```

## WebSocket Support

WebSocket upgrades require a specific setting on the route:

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: websocket-app
  namespace: production
spec:
  virtualhost:
    fqdn: ws.example.com
    tls:
      secretName: ws-tls
  routes:
    - conditions:
        - prefix: /ws/
      enableWebsockets: true
      services:
        - name: websocket-backend
          port: 8080
      timeoutPolicy:
        # WebSocket connections are long-lived — extend timeouts
        response: infinity
        idle: 10m
    - conditions:
        - prefix: /
      services:
        - name: websocket-backend
          port: 8080
```

## CORS Configuration

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: cors-enabled-api
  namespace: production
spec:
  virtualhost:
    fqdn: api.example.com
    tls:
      secretName: api-tls
    corsPolicy:
      allowCredentials: true
      allowOrigin:
        - https://app.example.com
        - https://admin.example.com
      allowMethods:
        - GET
        - POST
        - PUT
        - DELETE
        - OPTIONS
      allowHeaders:
        - Authorization
        - Content-Type
        - X-Request-Id
      exposeHeaders:
        - X-Request-Id
        - X-RateLimit-Limit
        - X-RateLimit-Remaining
      maxAge: "86400"
  routes:
    - conditions:
        - prefix: /
      services:
        - name: api
          port: 8080
```

## Prometheus Monitoring

Contour and Envoy both expose Prometheus metrics. A comprehensive monitoring setup:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: contour
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - projectcontour
  selector:
    matchLabels:
      app.kubernetes.io/name: contour
      app.kubernetes.io/component: contour
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - projectcontour
  selector:
    matchLabels:
      app.kubernetes.io/name: contour
      app.kubernetes.io/component: envoy
  endpoints:
    - port: metrics
      interval: 15s
      path: /stats/prometheus
```

### Critical Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: contour-alerts
  namespace: monitoring
spec:
  groups:
    - name: contour.rules
      rules:
        - alert: ContourHTTPProxyInvalid
          expr: |
            contour_httpproxy_invalid_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Invalid HTTPProxy objects detected"
            description: "{{ $value }} HTTPProxy objects are in Invalid state"

        - alert: ContourEnvoyHighErrorRate
          expr: |
            rate(envoy_cluster_upstream_rq_5xx[5m]) /
            rate(envoy_cluster_upstream_rq_total[5m]) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High 5xx error rate on cluster {{ $labels.envoy_cluster_name }}"

        - alert: ContourEnvoyHighP99Latency
          expr: |
            histogram_quantile(0.99,
              rate(envoy_http_downstream_rq_time_bucket[5m])
            ) > 2000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "p99 latency above 2s on {{ $labels.envoy_http_conn_manager_prefix }}"

        - alert: ContourEnvoyPendingRequests
          expr: |
            envoy_cluster_upstream_rq_pending_active > 100
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "High pending request queue on {{ $labels.envoy_cluster_name }}"
```

### Key Metrics Reference

| Metric | Description |
|---|---|
| `contour_httpproxy_valid_total` | Count of valid HTTPProxy objects |
| `contour_httpproxy_invalid_total` | Count of invalid HTTPProxy objects |
| `envoy_http_downstream_rq_total` | Total downstream requests |
| `envoy_http_downstream_rq_5xx` | Downstream 5xx errors |
| `envoy_http_downstream_rq_time_bucket` | Request duration histogram |
| `envoy_cluster_upstream_rq_total` | Total upstream requests per cluster |
| `envoy_cluster_upstream_cx_active` | Active upstream connections |
| `envoy_cluster_upstream_rq_pending_active` | Pending requests (upstream queue) |

## Migration from nginx-ingress

### Annotation to HTTPProxy Mapping

| nginx annotation | HTTPProxy equivalent |
|---|---|
| `nginx.ingress.kubernetes.io/rewrite-target` | `requestHeadersPolicy` + `conditions.prefix` |
| `nginx.ingress.kubernetes.io/proxy-read-timeout` | `timeoutPolicy.response` |
| `nginx.ingress.kubernetes.io/proxy-body-size` | `ContourConfiguration.envoy.maxRequestHeadersKilobytes` |
| `nginx.ingress.kubernetes.io/ssl-redirect` | Default (Contour always redirects HTTP to HTTPS when TLS is configured) |
| `nginx.ingress.kubernetes.io/enable-cors` | `virtualhost.corsPolicy` |
| `nginx.ingress.kubernetes.io/limit-rps` | `rateLimitPolicy.local` |
| `nginx.ingress.kubernetes.io/upstream-hash-by` | `loadBalancerPolicy.strategy: RequestHash` |
| `nginx.ingress.kubernetes.io/websocket-services` | `routes[].enableWebsockets: true` |
| `nginx.ingress.kubernetes.io/affinity: cookie` | `loadBalancerPolicy.strategy: Cookie` |

### Migration Strategy

The safest migration path keeps both controllers running simultaneously during the transition:

```bash
# Step 1: Install Contour alongside existing nginx-ingress
# Use a different IngressClass to avoid conflicts
helm upgrade --install contour bitnami/contour \
  --namespace projectcontour \
  --set "contour.ingressClass=contour" \
  --wait

# Step 2: For each Ingress object, create an equivalent HTTPProxy
# Use the contour IngressClass on the new HTTPProxy
# Test with an internal DNS entry pointing at the Contour LoadBalancer

# Step 3: Update DNS to point service FQDNs at the Contour LoadBalancer
# one service at a time, monitoring error rates

# Step 4: After all services migrated, remove nginx-ingress
kubectl delete namespace ingress-nginx
```

### Conversion Script

```bash
#!/usr/bin/env bash
# List Ingress objects that still reference nginx IngressClass
# to track migration progress

kubectl get ingress --all-namespaces \
  -o jsonpath='{range .items[?(@.spec.ingressClassName=="nginx")]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'

# Check HTTPProxy status across all namespaces
kubectl get httpproxy --all-namespaces \
  -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,FQDN:.spec.virtualhost.fqdn,STATUS:.status.currentStatus'
```

Contour consistently delivers better runtime predictability than annotation-heavy nginx-ingress configurations, particularly for organisations that enforce GitOps workflows where typed, validated CRDs are easier to review in pull requests than opaque annotation strings.
