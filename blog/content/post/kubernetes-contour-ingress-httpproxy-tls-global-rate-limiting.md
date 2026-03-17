---
title: "Kubernetes Contour Ingress Controller: HTTPProxy, TLS Termination, and Global Rate Limiting"
date: 2031-09-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Contour", "Ingress", "Envoy", "TLS", "Rate Limiting", "HTTPProxy"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy and configure Contour as a production Kubernetes ingress controller with HTTPProxy CRDs, automated TLS via cert-manager, path-based routing, and global rate limiting with Envoy's rate limit service."
more_link: "yes"
url: "/kubernetes-contour-ingress-httpproxy-tls-global-rate-limiting/"
---

Contour is the Envoy-based ingress controller developed by VMware that extends standard Kubernetes Ingress with the HTTPProxy CRD — a namespace-safe, delegation-aware resource that solves the multi-team ingress management problem. When combined with cert-manager for automated TLS and Envoy's rate limit service for global throttling, it provides enterprise-grade traffic management without the operational complexity of a service mesh.

<!--more-->

# Kubernetes Contour Ingress Controller: HTTPProxy, TLS Termination, and Global Rate Limiting

## Why Contour over Nginx Ingress

| Feature | Nginx Ingress | Contour/Envoy |
|---------|--------------|---------------|
| Configuration model | Annotations on Ingress | HTTPProxy CRD (structured) |
| Multi-team delegation | Not supported | HTTPProxy includes/delegates |
| Dynamic reconfiguration | Reload (brief interruption) | xDS API (zero disruption) |
| Rate limiting | nginx_module (per-ingress) | Envoy RLS (global, cross-replica) |
| gRPC proxying | Workarounds required | Native |
| Observability | Access log | Rich Envoy metrics + tracing |
| WebSocket support | Annotation required | Native |

Contour uses Envoy as the data plane and configures it via xDS (Envoy's gRPC-based discovery API), eliminating configuration reload interruptions entirely.

## Installation

### Helm Installation (Recommended)

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

kubectl create namespace projectcontour

helm install contour bitnami/contour \
  --namespace projectcontour \
  --set envoy.service.type=LoadBalancer \
  --set envoy.service.annotations."service\.beta\.kubernetes\.io/aws-load-balancer-type"=nlb \
  --set envoy.readinessProbe.periodSeconds=3 \
  --set contour.resources.requests.cpu=100m \
  --set contour.resources.requests.memory=256Mi \
  --set envoy.resources.requests.cpu=200m \
  --set envoy.resources.requests.memory=512Mi

# Verify
kubectl get pods -n projectcontour
# NAME                        READY   STATUS    RESTARTS   AGE
# contour-67b5d8f9b8-4p7kz    1/1     Running   0          2m
# contour-67b5d8f9b8-9x2nt    1/1     Running   0          2m
# envoy-9h4xm                 2/2     Running   0          2m
# envoy-fk7p2                 2/2     Running   0          2m
# envoy-zt8nq                 2/2     Running   0          2m

# Get the external IP/hostname
kubectl get svc -n projectcontour envoy
# NAME    TYPE           CLUSTER-IP    EXTERNAL-IP
# envoy   LoadBalancer   10.96.50.13   a1b2c3d4e5.elb.amazonaws.com
```

### cert-manager Integration

```bash
# Install cert-manager
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set crds.enabled=true

# Create a ClusterIssuer for Let's Encrypt
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: contour
EOF
```

## HTTPProxy Basics

HTTPProxy is Contour's primary CRD. It is namespace-scoped, safe for delegation to application teams, and supports features unavailable in standard Ingress.

### Simple HTTPProxy

```yaml
# Simple single-service proxy
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: api-gateway
  namespace: production
spec:
  virtualhost:
    fqdn: api.example.com
    tls:
      secretName: api-tls-cert           # Created by cert-manager below
  routes:
    - conditions:
        - prefix: /v1
      services:
        - name: api-v1
          port: 8080
    - conditions:
        - prefix: /v2
      services:
        - name: api-v2
          port: 8080
    - conditions:
        - prefix: /
      services:
        - name: api-v2    # Default route to latest
          port: 8080
```

### Automated TLS with cert-manager

Contour integrates with cert-manager via the `projectcontour.io/tls-cert-namespace` annotation or by having cert-manager provision the secret directly:

```yaml
# Certificate resource — cert-manager creates the secret
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls-cert
  namespace: production
spec:
  secretName: api-tls-cert
  duration: 2160h      # 90 days
  renewBefore: 360h    # Renew 15 days before expiry
  subject:
    organizations:
      - Example Corp
  dnsNames:
    - api.example.com
    - api-v2.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

For wildcard certificates using DNS-01 challenge:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-tls
  namespace: projectcontour
spec:
  secretName: wildcard-tls
  dnsNames:
    - "*.example.com"
    - "example.com"
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  # AWS Route53 DNS-01 solver
  solvers:
    - dns01:
        route53:
          region: us-east-1
          accessKeyIDSecretRef:
            name: route53-credentials
            key: access-key-id
          secretAccessKeySecretRef:
            name: route53-credentials
            key: secret-access-key
```

Reference the wildcard certificate in HTTPProxy:

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: wildcard-proxy
  namespace: production
spec:
  virtualhost:
    fqdn: "*.example.com"
    tls:
      secretName: wildcard-tls
      minimumProtocolVersion: "1.2"
      cipherSuites:
        - "[ECDHE-ECDSA-AES128-GCM-SHA256|ECDHE-ECDSA-CHACHA20-POLY1305]"
        - "[ECDHE-RSA-AES128-GCM-SHA256|ECDHE-RSA-CHACHA20-POLY1305]"
  routes:
    - services:
        - name: wildcard-backend
          port: 80
```

## HTTPProxy Delegation

Delegation lets a root HTTPProxy in one namespace extend ownership of route paths to HTTPProxy objects in other namespaces — enabling platform teams to own TLS termination while application teams manage their routes.

### Root HTTPProxy (Platform Team, `ingress` namespace)

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: company-root
  namespace: ingress
spec:
  virtualhost:
    fqdn: app.example.com
    tls:
      secretName: app-wildcard-tls
  routes:
    # Platform-managed routes
    - conditions:
        - prefix: /health
      services:
        - name: health-check
          port: 80

  # Delegate /api to the api-team namespace
  includes:
    - name: api-routes
      namespace: api-team
      conditions:
        - prefix: /api

  # Delegate /frontend to the frontend-team namespace
    - name: frontend-routes
      namespace: frontend-team
      conditions:
        - prefix: /frontend
```

### Delegated HTTPProxy (Application Team, `api-team` namespace)

```yaml
# api-team can only define routes under /api — the root enforces the prefix
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: api-routes
  namespace: api-team
spec:
  # No virtualhost — this is a delegated proxy
  routes:
    - conditions:
        - prefix: /api/v1/users
      services:
        - name: user-service
          port: 8080
      timeoutPolicy:
        response: 10s
        idle: 60s

    - conditions:
        - prefix: /api/v1/orders
      services:
        - name: order-service
          port: 8080
      retryPolicy:
        count: 3
        perTryTimeout: 5s

    - conditions:
        - prefix: /api/v1/
          header:
            name: X-API-Version
            present: true
      services:
        - name: versioned-api
          port: 8080
```

## Advanced Routing

### Header-Based Routing and Manipulation

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: advanced-routing
  namespace: production
spec:
  virtualhost:
    fqdn: service.example.com
    tls:
      secretName: service-tls
  routes:
    # Route beta users to the canary deployment
    - conditions:
        - prefix: /
          header:
            name: X-Beta-User
            exact: "true"
      services:
        - name: service-canary
          port: 8080
      requestHeadersPolicy:
        set:
          - name: X-Canary
            value: "true"
      responseHeadersPolicy:
        set:
          - name: X-Served-By
            value: canary

    # Weight-based canary: 10% to new version
    - conditions:
        - prefix: /api
      services:
        - name: service-stable
          port: 8080
          weight: 90
        - name: service-canary
          port: 8080
          weight: 10

    # Remove sensitive response headers
    - conditions:
        - prefix: /
      services:
        - name: service-stable
          port: 8080
      responseHeadersPolicy:
        remove:
          - Server
          - X-Powered-By
          - X-AspNet-Version
```

### URL Rewriting

```yaml
routes:
  # Rewrite /api/v1 prefix before forwarding
  - conditions:
      - prefix: /api/v1
    services:
      - name: backend
        port: 8080
    pathRewritePolicy:
      replacePrefix:
        - prefix: /api/v1
          replacement: /v1

  # Rewrite hostname
  - conditions:
      - prefix: /legacy
    services:
      - name: legacy-backend
        port: 80
    requestHeadersPolicy:
      set:
        - name: Host
          value: legacy-internal.svc.cluster.local
```

## Global Rate Limiting

Envoy supports two types of rate limiting:

1. **Local rate limiting**: Per-Envoy-pod, not shared across replicas.
2. **Global rate limiting**: Uses an external rate limit service (RLS) that all Envoy pods consult — guarantees cluster-wide limits.

### Deploy the Rate Limit Service

```bash
# Contour ships with a reference implementation using Redis
kubectl apply -f https://projectcontour.io/examples/ratelimit-service.yaml
```

Or deploy manually:

```yaml
# Redis for rate limit storage
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-ratelimit
  namespace: projectcontour
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis-ratelimit
  template:
    metadata:
      labels:
        app: redis-ratelimit
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: redis-ratelimit
  namespace: projectcontour
spec:
  selector:
    app: redis-ratelimit
  ports:
    - port: 6379
---
# Envoy rate limit service (go-control-plane based)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ratelimit
  namespace: projectcontour
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
          command: ["/bin/ratelimit"]
          env:
            - name: LOG_LEVEL
              value: warn
            - name: REDIS_SOCKET_TYPE
              value: tcp
            - name: REDIS_URL
              value: redis-ratelimit.projectcontour.svc.cluster.local:6379
            - name: USE_STATSD
              value: "false"
            - name: RUNTIME_ROOT
              value: /data
            - name: RUNTIME_SUBDIRECTORY
              value: ratelimit
          ports:
            - containerPort: 8080    # gRPC
            - containerPort: 8081    # HTTP (stats)
          volumeMounts:
            - name: config
              mountPath: /data/ratelimit/config
      volumes:
        - name: config
          configMap:
            name: ratelimit-config
---
apiVersion: v1
kind: Service
metadata:
  name: ratelimit
  namespace: projectcontour
spec:
  selector:
    app: ratelimit
  ports:
    - name: grpc
      port: 8080
      targetPort: 8080
```

### Rate Limit Configuration

```yaml
# Rate limit rules ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: ratelimit-config
  namespace: projectcontour
data:
  config.yaml: |
    domain: contour
    descriptors:
      # Global: limit all requests to api.example.com
      - key: virtual_host
        value: api.example.com
        descriptors:
          - key: generic_key
            value: global
            rate_limit:
              unit: second
              requests_per_unit: 10000

      # Per-IP limit: 100 requests/minute per client IP
      - key: remote_address
        rate_limit:
          unit: minute
          requests_per_unit: 100

      # Per-route limit: /api/v1/search is expensive
      - key: virtual_host
        value: api.example.com
        descriptors:
          - key: header_match
            value: /api/v1/search
            rate_limit:
              unit: second
              requests_per_unit: 20

      # Per-API-key limit: authenticated clients get higher limits
      - key: header_match
        value: api_key
        rate_limit:
          unit: minute
          requests_per_unit: 1000

      # Authenticated users: 5x higher limit than anonymous
      - key: generic_key
        value: authenticated
        rate_limit:
          unit: minute
          requests_per_unit: 500
```

### Configure Contour to Use the Rate Limit Service

```yaml
# Contour ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: contour
  namespace: projectcontour
data:
  contour.yaml: |
    rateLimitService:
      extensionService: projectcontour/ratelimit
      domain: contour
      failOpen: false          # true = allow traffic if RLS is unavailable
      enableXRateLimitHeaders: true   # Add X-RateLimit-* headers to responses
    disableAllowChunkedLength: false
    disableMergeSlashes: false
```

### Apply Rate Limits to HTTPProxy

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
          # Global per-vhost descriptor
          - entries:
              - genericKey:
                  key: virtual_host
                  value: api.example.com
              - genericKey:
                  key: generic_key
                  value: global

  routes:
    - conditions:
        - prefix: /api/v1/search
      services:
        - name: search-service
          port: 8080
      rateLimitPolicy:
        global:
          descriptors:
            # Per-route limit on expensive endpoint
            - entries:
                - genericKey:
                    key: virtual_host
                    value: api.example.com
                - requestHeaderValueMatch:
                    headers:
                      - name: ":path"
                        contains: /api/v1/search
                    value: /api/v1/search

    - conditions:
        - prefix: /
      services:
        - name: api-backend
          port: 8080
      rateLimitPolicy:
        global:
          descriptors:
            # Per-client-IP rate limit
            - entries:
                - remoteAddress: {}
            # Per-API-key limit (if header present)
            - entries:
                - requestHeader:
                    headerName: X-API-Key
                    descriptorKey: api_key
```

### Local Rate Limiting (per-pod, no RLS required)

```yaml
routes:
  - conditions:
      - prefix: /api
    services:
      - name: api-backend
        port: 8080
    rateLimitPolicy:
      local:
        requests: 100
        unit: second
        burst: 50           # Allow bursts up to 50 requests over the limit
        responseStatusCode: 429
        headers:
          - name: X-RateLimit-Limit
            value: "100"
```

## Health Checks and Circuit Breaking

```yaml
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: resilient-service
  namespace: production
spec:
  virtualhost:
    fqdn: service.example.com
    tls:
      secretName: service-tls
  routes:
    - conditions:
        - prefix: /
      services:
        - name: backend
          port: 8080

          # Circuit breaker settings
          circuitBreakerPolicy:
            maxConnections: 1000          # Max concurrent TCP connections
            maxPendingRequests: 100       # Requests waiting for a connection
            maxRequests: 500             # Max concurrent requests
            maxRetries: 3               # Max concurrent retries

          # Upstream health checks (active probing)
          healthCheckPolicy:
            path: /health
            intervalSeconds: 5
            timeoutSeconds: 2
            unhealthyThresholdCount: 3
            healthyThresholdCount: 2

      # Timeout policies
      timeoutPolicy:
        response: 30s
        idle: 5m
        idleConnection: 10m

      # Retry on 503 and connection failures
      retryPolicy:
        count: 3
        perTryTimeout: 10s
        retriableStatusCodes:
          - 503
          - 502
```

## Monitoring with Prometheus

```yaml
# Contour ServiceMonitor
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: contour
  namespace: projectcontour
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: contour
  endpoints:
    - port: metrics
      interval: 15s
      path: /metrics

---
# Envoy ServiceMonitor
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: envoy
  namespace: projectcontour
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: envoy
  endpoints:
    - port: metrics
      interval: 15s
      path: /stats/prometheus
```

Key Envoy metrics to alert on:

```yaml
# PrometheusRule
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: contour-alerts
  namespace: projectcontour
spec:
  groups:
    - name: contour.envoy
      rules:
        - alert: EnvoyHighUpstreamErrorRate
          expr: |
            sum(rate(envoy_cluster_upstream_rq_xx{envoy_response_code_class="5"}[5m]))
            /
            sum(rate(envoy_cluster_upstream_rq_total[5m])) > 0.05
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Envoy upstream error rate > 5%: {{ $value | humanizePercentage }}"

        - alert: EnvoyRateLimitDrops
          expr: |
            rate(ratelimit_service_rate_limit_over_limit_total[5m]) > 100
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Rate limit drops: {{ $value | humanize }}/sec"

        - alert: EnvoyCircuitBreakerOpen
          expr: |
            envoy_cluster_circuit_breakers_default_cx_open > 0
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Circuit breaker open for cluster {{ $labels.envoy_cluster_name }}"
```

## Troubleshooting

### HTTPProxy Status

```bash
# Check HTTPProxy status — "valid" means configuration was accepted
kubectl get httpproxy -n production
# NAME          FQDN                   TLS SECRET    STATUS   STATUS DESCRIPTION
# api-gateway   api.example.com        api-tls-cert  valid    Valid HTTPProxy

# Check for errors
kubectl describe httpproxy api-gateway -n production | grep -A5 Status

# Common errors:
# "Namespace not permitted" — delegation namespace not allowed by root proxy
# "service not found" — referenced service does not exist
# "Secret not found" — TLS secret missing or in wrong namespace
```

### Envoy Admin Interface

```bash
# Forward Envoy admin port to localhost
kubectl port-forward -n projectcontour ds/envoy 9001:9001

# Check virtual hosts and routes
curl -s http://localhost:9001/config_dump | \
  python3 -c "import sys,json; d=json.load(sys.stdin); [print(json.dumps(r, indent=2)) for c in d['configs'] if 'static_virtual_hosts' in str(c) for r in c.get('dynamic_resources',{}).get('virtual_hosts',[])]"

# Check cluster health
curl -s http://localhost:9001/clusters | grep -E "(::health_flags|upstream_cx_active)"

# Rate limit stats
curl -s http://localhost:9001/stats | grep ratelimit
```

## Summary

Contour with HTTPProxy provides a structured, delegation-safe ingress model for multi-team Kubernetes environments:

1. **HTTPProxy delegation** separates concerns between platform teams (TLS, root virtual hosts) and application teams (route definitions) without sharing RBAC on sensitive resources.
2. **Dynamic xDS configuration** means adding or changing routes never interrupts active connections — critical for zero-downtime deployments.
3. **cert-manager integration** automates the full TLS lifecycle from ACME challenges through renewal without manual intervention.
4. **Global rate limiting** via the Envoy Rate Limit Service enforces cluster-wide throughput limits that scale across all Envoy replicas, preventing any single client from overwhelming backends.
5. **Circuit breakers and active health checks** provide resilience by isolating failing backends and automatically restoring traffic when they recover.

For organizations already using Envoy in a service mesh, Contour's xDS API allows sharing the same Envoy binary for both ingress and east-west traffic, reducing the operational surface area.
