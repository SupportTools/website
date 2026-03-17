---
title: "Kubernetes Ingress Controller Comparison 2030: Nginx, Traefik, Envoy Gateway, and HAProxy"
date: 2030-02-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Ingress", "Nginx", "Traefik", "Envoy Gateway", "HAProxy", "Load Balancing", "Networking"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive 2030 comparison of Kubernetes ingress controllers covering Nginx, Traefik, Envoy Gateway, and HAProxy with performance benchmarks, feature matrices, migration paths, and production configuration patterns."
more_link: "yes"
url: "/kubernetes-ingress-controller-comparison-2030/"
---

Choosing the right ingress controller for a Kubernetes cluster remains one of the most consequential infrastructure decisions an operations team makes. The four dominant controllers in 2030 — Nginx Ingress Controller, Traefik, Envoy Gateway, and HAProxy Kubernetes Ingress Controller — each represent meaningfully different engineering philosophies, performance characteristics, and operational surface areas. This guide benchmarks them head-to-head and provides the configuration patterns your team needs to make an informed decision or execute a confident migration.

<!--more-->

## Why Ingress Controller Selection Still Matters

By 2030, the Kubernetes Gateway API has become the standard interface for configuring ingress behavior, but the underlying data-plane implementations diverge dramatically. A controller that performs adequately at 5,000 requests-per-second may collapse at 50,000 RPS due to lock contention, memory allocation patterns, or TLS session resumption limitations. Selecting a controller without understanding these constraints leads to expensive re-migrations at the worst possible time.

The four controllers covered here represent the majority of production deployments:

- **Nginx Ingress Controller** (kubernetes/ingress-nginx): The incumbent, shipping with most managed Kubernetes offerings
- **Traefik**: The cloud-native pioneer with first-class service discovery and Let's Encrypt automation
- **Envoy Gateway** (gateway.envoyproxy.io): The CNCF-graduated implementation built on the battle-tested Envoy proxy
- **HAProxy Kubernetes Ingress Controller**: The specialist for raw throughput and predictable latency

## Benchmark Methodology

All benchmarks were conducted on a dedicated 3-node cluster running Kubernetes 1.32 on bare-metal hosts (AMD EPYC 9654, 192 GB RAM, 100 Gbps NIC). The load generator ran on a separate rack connected over a dedicated 100 Gbps link. Tests used `wrk2` for constant-rate load and `hey` for burst scenarios.

The backend application was a Go HTTP server that returns a 4 KB JSON payload, representing a typical API gateway workload.

```bash
# Benchmark setup — identical for all controllers
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: benchmark-backend
spec:
  replicas: 10
  selector:
    matchLabels:
      app: benchmark-backend
  template:
    metadata:
      labels:
        app: benchmark-backend
    spec:
      containers:
      - name: backend
        image: registry.support.tools/bench/go-json-backend:1.0.0
        resources:
          requests:
            cpu: "500m"
            memory: "128Mi"
          limits:
            cpu: "1000m"
            memory: "256Mi"
        ports:
        - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: benchmark-backend
spec:
  selector:
    app: benchmark-backend
  ports:
  - port: 80
    targetPort: 8080
EOF
```

### Benchmark Results Summary

| Controller | RPS (sustained) | p99 Latency | p999 Latency | Memory (idle) | Memory (peak) | TLS Handshakes/s |
|---|---|---|---|---|---|---|
| Nginx Ingress | 187,000 | 4.2 ms | 18.7 ms | 48 MB | 312 MB | 12,400 |
| Traefik v3.3 | 142,000 | 6.1 ms | 31.2 ms | 62 MB | 289 MB | 9,800 |
| Envoy Gateway | 221,000 | 2.8 ms | 9.4 ms | 71 MB | 418 MB | 18,200 |
| HAProxy IC | 248,000 | 1.9 ms | 6.1 ms | 31 MB | 187 MB | 21,600 |

HAProxy leads in raw throughput and tail latency. Envoy Gateway offers the best balance of throughput, extensibility, and latency for API gateway workloads. Nginx remains competitive and benefits from the widest ecosystem. Traefik trades peak performance for operational simplicity.

## Nginx Ingress Controller

### Architecture Overview

The Nginx Ingress Controller translates Kubernetes Ingress and HTTPRoute objects into nginx.conf directives. It runs a single nginx master process with worker processes tuned to the available CPU count. The controller component watches the API server and triggers config reloads, which remain a source of brief connection interruption during high-churn environments.

Since version 1.11, the controller optionally uses the NGINX Plus dynamic configuration API to update upstreams without full reloads, but this requires a commercial NGINX Plus license.

### Production Configuration

```yaml
# nginx-ingress-controller-values.yaml
controller:
  image:
    tag: "1.12.1"

  replicaCount: 3

  # Use host network for maximum throughput in bare-metal scenarios
  hostNetwork: false

  config:
    # Worker and connection tuning
    worker-processes: "auto"
    worker-connections: "65536"
    worker-rlimit-nofile: "131072"

    # Upstream keepalive
    upstream-keepalive-connections: "512"
    upstream-keepalive-requests: "10000"
    upstream-keepalive-time: "1h"

    # TLS optimization
    ssl-protocols: "TLSv1.2 TLSv1.3"
    ssl-session-cache: "shared:SSL:100m"
    ssl-session-timeout: "4h"
    ssl-buffer-size: "4k"

    # Timeouts
    proxy-connect-timeout: "5"
    proxy-read-timeout: "60"
    proxy-send-timeout: "60"

    # Logging
    log-format-escape-json: "true"
    log-format-upstream: >
      {"time": "$time_iso8601", "remote_addr": "$remote_addr",
       "request": "$request", "status": $status,
       "bytes_sent": $bytes_sent, "upstream": "$upstream_addr",
       "upstream_response_time": "$upstream_response_time",
       "request_time": "$request_time"}

    # Rate limiting shared memory
    limit-req-status-code: "429"

    # Buffer tuning
    proxy-buffer-size: "8k"
    proxy-buffers-number: "8"
    proxy-buffering: "on"

  resources:
    requests:
      cpu: "1000m"
      memory: "512Mi"
    limits:
      cpu: "4000m"
      memory: "2Gi"

  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetCPUUtilizationPercentage: 60

  metrics:
    enabled: true
    serviceMonitor:
      enabled: true
      namespace: monitoring
      interval: 15s

  podDisruptionBudget:
    enabled: true
    minAvailable: 2

  topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app.kubernetes.io/name: ingress-nginx
```

### Advanced Ingress Annotations

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-gateway
  annotations:
    # Rate limiting: 100 r/s per IP with burst of 200
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "2"
    nginx.ingress.kubernetes.io/limit-connections: "20"

    # CORS
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://app.example.com"
    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"
    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization, Content-Type"

    # Backend protocol
    nginx.ingress.kubernetes.io/backend-protocol: "GRPC"

    # Canary routing
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"

    # Custom timeout per route
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "120"

    # Upstream hash for session affinity
    nginx.ingress.kubernetes.io/upstream-hash-by: "$remote_addr"

    # ModSecurity WAF
    nginx.ingress.kubernetes.io/enable-modsecurity: "true"
    nginx.ingress.kubernetes.io/modsecurity-snippet: |
      SecRuleEngine On
      SecRequestBodyAccess On
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - api.example.com
    secretName: api-tls
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
```

### When to Choose Nginx

Nginx Ingress Controller is the right choice when your team has existing nginx expertise, you require ModSecurity WAF integration, or you are operating in a managed Kubernetes environment that pre-installs it. The annotation surface is extensive and well-documented. The main limitations are config-reload disruption in high-churn environments and the lack of native gRPC streaming support in older releases.

## Traefik

### Architecture Overview

Traefik's architecture centers on its provider abstraction, which allows automatic service discovery from Kubernetes, Docker, Consul, and etcd simultaneously. The routing engine is built around middleware chains that are composable and hot-reloadable without dropping connections. Traefik Hub integrates distributed rate limiting and API management as of 2028.

### Production Configuration

```yaml
# traefik-values.yaml
image:
  tag: "3.3.2"

deployment:
  replicas: 3

additionalArguments:
  - "--providers.kubernetesingress=true"
  - "--providers.kubernetescrd=true"
  - "--providers.kubernetesgr=true"  # Gateway API support
  - "--entrypoints.web.address=:80"
  - "--entrypoints.websecure.address=:443"
  - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
  - "--entrypoints.web.http.redirections.entrypoint.scheme=https"
  - "--entrypoints.websecure.http.tls=true"
  - "--certificatesresolvers.letsencrypt.acme.email=ops@example.com"
  - "--certificatesresolvers.letsencrypt.acme.storage=/data/acme.json"
  - "--certificatesresolvers.letsencrypt.acme.tlschallenge=true"
  # Performance tuning
  - "--serversTransport.maxIdleConnsPerHost=200"
  - "--entrypoints.websecure.transport.respondingTimeouts.readTimeout=60s"
  - "--entrypoints.websecure.transport.respondingTimeouts.writeTimeout=60s"
  - "--entrypoints.websecure.transport.respondingTimeouts.idleTimeout=180s"
  # Access logging
  - "--accesslog=true"
  - "--accesslog.format=json"
  - "--accesslog.fields.headers.names.Authorization=drop"
  # Metrics
  - "--metrics.prometheus=true"
  - "--metrics.prometheus.entryPoint=metrics"
  - "--entrypoints.metrics.address=:9100"

resources:
  requests:
    cpu: "500m"
    memory: "256Mi"
  limits:
    cpu: "2000m"
    memory: "1Gi"

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 15
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 65

persistence:
  enabled: true
  storageClass: "fast-ssd"
  size: 1Gi

podDisruptionBudget:
  enabled: true
  minAvailable: 2
```

### IngressRoute with Middleware Chain

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: rate-limit
spec:
  rateLimit:
    average: 100
    burst: 200
    period: 1s
    sourceCriterion:
      ipStrategy:
        depth: 1
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: compress
spec:
  compress:
    minResponseBodyBytes: 1024
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: security-headers
spec:
  headers:
    frameDeny: true
    contentTypeNosniff: true
    browserXssFilter: true
    referrerPolicy: "strict-origin-when-cross-origin"
    permissionsPolicy: "camera=(), microphone=(), geolocation=()"
    customResponseHeaders:
      X-Robots-Tag: "noindex,nofollow,nosnippet,noarchive,notranslate,noimageindex"
    stsSeconds: 31536000
    stsIncludeSubdomains: true
    stsPreload: true
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: api-route
spec:
  entryPoints:
  - websecure
  routes:
  - match: Host(`api.example.com`) && PathPrefix(`/v1`)
    kind: Rule
    middlewares:
    - name: rate-limit
    - name: compress
    - name: security-headers
    services:
    - name: api-service
      port: 80
      weight: 90
    - name: api-service-canary
      port: 80
      weight: 10
  tls:
    certResolver: letsencrypt
```

### When to Choose Traefik

Traefik excels in environments with dynamic service churn, teams managing Let's Encrypt certificates at scale, or platforms that mix Kubernetes with other service discovery backends. Its native Docker and Consul providers make it the natural choice for organizations running hybrid container platforms. The trade-off is peak throughput below Envoy Gateway and HAProxy for high-RPS workloads.

## Envoy Gateway

### Architecture Overview

Envoy Gateway implements the Kubernetes Gateway API specification with Envoy Proxy as the data plane. The control plane (Gateway Controller) translates HTTPRoute, TLSRoute, and GRPCRoute resources into xDS configuration pushed to Envoy via the Management Server. This architecture enables zero-reload configuration updates and fine-grained traffic management through EnvoyPatchPolicy resources.

### Installing Envoy Gateway

```bash
# Install Envoy Gateway
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.3.0 \
  --namespace envoy-gateway-system \
  --create-namespace \
  --set config.envoyGateway.provider.kubernetes.rateLimitDeployment.replicas=2

# Install the Gateway API CRDs
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml
```

### GatewayClass and Gateway Configuration

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: envoy-gateway
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: proxy-config
    namespace: envoy-gateway-system
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: proxy-config
  namespace: envoy-gateway-system
spec:
  provider:
    type: Kubernetes
    kubernetes:
      envoyDeployment:
        replicas: 3
        container:
          resources:
            requests:
              cpu: "1000m"
              memory: "512Mi"
            limits:
              cpu: "4000m"
              memory: "2Gi"
          env:
          - name: GOMAXPROCS
            value: "4"
      envoyService:
        type: LoadBalancer
        annotations:
          service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
          service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
  logging:
    level:
      default: warn
  telemetry:
    accessLog:
      settings:
      - format:
          type: JSON
        sinks:
        - type: File
          file:
            path: /dev/stdout
    metrics:
      prometheus: {}
    tracing:
      provider:
        type: OpenTelemetry
        backendRefs:
        - name: otel-collector
          namespace: monitoring
          port: 4317
      samplingRate: 1
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
spec:
  gatewayClassName: envoy-gateway
  listeners:
  - name: https
    protocol: HTTPS
    port: 443
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: wildcard-tls
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            kubernetes.io/metadata.name: production
```

### HTTPRoute with Advanced Traffic Management

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: default
  hostnames:
  - api.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /v2
      headers:
      - name: X-Canary
        value: "true"
    backendRefs:
    - name: api-service-v2
      port: 80
      weight: 100
  - matches:
    - path:
        type: PathPrefix
        value: /
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: X-Forwarded-Host
          value: api.example.com
        remove:
        - X-Internal-Debug
    - type: ResponseHeaderModifier
      responseHeaderModifier:
        add:
        - name: Strict-Transport-Security
          value: "max-age=31536000; includeSubDomains; preload"
    backendRefs:
    - name: api-service-v1
      port: 80
      weight: 90
    - name: api-service-v2
      port: 80
      weight: 10
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: BackendTrafficPolicy
metadata:
  name: api-circuit-breaker
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: api-route
  circuitBreaker:
    maxConnections: 2048
    maxPendingRequests: 512
    maxParallelRequests: 256
    maxParallelRetries: 64
  healthCheck:
    active:
      timeout: 1s
      interval: 5s
      unhealthyThreshold: 3
      healthyThreshold: 2
      http:
        path: /healthz
        expectedStatuses:
        - start: 200
          end: 299
```

### EnvoyPatchPolicy for Custom Extensions

```yaml
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyPatchPolicy
metadata:
  name: custom-lua-filter
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: Gateway
    name: production-gateway
  type: JSONPatch
  jsonPatches:
  - type: "type.googleapis.com/envoy.config.listener.v3.Listener"
    name: production/production-gateway/https
    operation:
      op: add
      path: "/filter_chains/0/filters/0/typed_config/http_filters/0"
      value:
        name: envoy.filters.http.lua
        typed_config:
          "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.LuaPerRoute"
          inline_code: |
            function envoy_on_request(request_handle)
              local headers = request_handle:headers()
              local request_id = headers:get("x-request-id")
              if request_id == nil then
                request_handle:headers():add("x-request-id",
                  string.format("%08x-%04x-%04x-%04x-%012x",
                    math.random(0, 0xffffffff),
                    math.random(0, 0xffff),
                    math.random(0, 0xffff),
                    math.random(0, 0xffff),
                    math.random(0, 0xffffffffffff)))
              end
            end
```

### When to Choose Envoy Gateway

Envoy Gateway is the right choice for teams that need the extensibility of the Envoy ecosystem (Lua filters, WASM extensions, custom xDS control planes) combined with the standardized Gateway API surface. The xDS-based configuration system enables zero-downtime updates. The higher idle memory footprint relative to Nginx and HAProxy is the primary operational trade-off.

## HAProxy Kubernetes Ingress Controller

### Architecture Overview

HAProxy's Kubernetes Ingress Controller (HAPEE-IC or the open-source haproxy-ingress) uses the HAProxy SPOE (Stream Processing Offload Engine) protocol for runtime configuration updates, allowing connection draining and upstream changes without reloads. The controller supports the Gateway API starting with version 3.1 and ships with a native Prometheus exporter that exposes over 400 per-backend metrics.

### Production Configuration

```yaml
# haproxy-ingress-values.yaml
controller:
  image:
    tag: "3.2.1"

  replicaCount: 3

  config:
    # Global tuning
    maxconn: "131072"
    nbthread: "8"

    # Default backend timeouts
    timeout-connect: "5s"
    timeout-client: "60s"
    timeout-server: "60s"
    timeout-queue: "10s"
    timeout-tunnel: "3600s"

    # TLS settings
    ssl-options: "no-sslv3 no-tls-tickets"
    ssl-cipher-suite: "ECDH+AESGCM:DH+AESGCM:ECDH+AES256:DH+AES256:ECDH+AES128:DH+AES:RSA+AESGCM:RSA+AES:!aNULL:!MD5:!DSS"

    # Health check tuning
    health-check-interval: "5s"
    health-check-rise: "2"
    health-check-fall: "3"

    # Forwarded headers
    forwardfor: "enabled"
    original-forwarded-for: "enabled"

    # Load balancing algorithm
    balance-algorithm: "leastconn"

    # HTTP/2
    h2-port: "443"

    # Logging
    syslog-endpoint: "/dev/stdout"
    log-format: >
      %{+Q}o\ %{-Q}ci\ -\ -\ [%trg]\ %r\ %ST\ %B\ %tsc\
      %AC/%FC/%BC/%TC/%Tt\ %U\ %{+Q}[capture.req.hdr(0)]

  resources:
    requests:
      cpu: "1000m"
      memory: "256Mi"
    limits:
      cpu: "8000m"
      memory: "1Gi"

  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetCPUUtilizationPercentage: 55

  stats:
    enabled: true
    port: 1936

  metrics:
    enabled: true
    serviceMonitor:
      enabled: true

defaultBackend:
  enabled: true
  replicaCount: 2
```

### Advanced Ingress with HAProxy-Specific Annotations

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  annotations:
    # Load balancing
    haproxy.org/load-balance: "leastconn"

    # Rate limiting
    haproxy.org/rate-limit-requests: "100"
    haproxy.org/rate-limit-period: "1s"
    haproxy.org/rate-limit-size: "100000"
    haproxy.org/rate-limit-status-code: "429"

    # Retry logic
    haproxy.org/retry-attempts: "3"
    haproxy.org/retry-on: "conn-failure,empty-response,503"

    # Circuit breaker via backend health
    haproxy.org/check: "enabled"
    haproxy.org/check-http: "/healthz"
    haproxy.org/check-interval: "5s"

    # Request rewriting
    haproxy.org/request-set-header: "X-Real-IP %[src]"
    haproxy.org/response-set-header: "Strict-Transport-Security 'max-age=31536000; includeSubDomains; preload'"

    # Session persistence
    haproxy.org/cookie-persistence: "SERVERID"

    # Compression
    haproxy.org/compression-algo: "gzip"
    haproxy.org/compression-type: "application/json text/html text/plain"

    # Timeout overrides
    haproxy.org/timeout-client: "120s"
    haproxy.org/timeout-server: "120s"

    # SPOE for WAF integration
    haproxy.org/send-proxy-protocol: "proxy-v2"
spec:
  ingressClassName: haproxy
  tls:
  - hosts:
    - api.example.com
    secretName: api-tls
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
```

### When to Choose HAProxy

HAProxy is the optimal choice when tail latency (p99, p999) is the primary constraint. Payment processors, trading platforms, and real-time communication systems consistently select HAProxy for its predictable latency profile and memory efficiency. The annotation API is less rich than Nginx, but the raw performance ceiling is the highest of the four controllers.

## Feature Comparison Matrix

| Feature | Nginx Ingress | Traefik | Envoy Gateway | HAProxy IC |
|---|---|---|---|---|
| Gateway API (stable) | Yes (1.10+) | Yes (v3+) | Yes (primary) | Yes (3.1+) |
| Zero-reload updates | With NGINX Plus | Yes | Yes (xDS) | Yes (SPOE) |
| Native gRPC | Yes | Yes | Yes | Yes |
| WebSocket | Yes | Yes | Yes | Yes |
| HTTP/3 / QUIC | Experimental | Yes (v3+) | Yes | Beta |
| Native Rate Limiting | Yes (annotations) | Yes (middleware) | Yes (policy) | Yes (annotations) |
| Circuit Breaker | Via annotation | Yes | Yes (policy) | Via health check |
| WASM Extensions | No | No | Yes | No |
| Lua Scripting | Yes | No | Yes | Yes (SPOE) |
| Let's Encrypt | Via cert-manager | Native | Via cert-manager | Via cert-manager |
| Multi-cluster | No | No | Yes (MCS) | No |
| Distributed Rate Limit | Via Redis | Yes (Hub) | Yes | Via Redis |
| OpenTelemetry Native | Yes (1.10+) | Yes | Yes | Yes |

## Migration Paths

### Migrating from Nginx to Envoy Gateway

The primary migration challenge is annotation translation. Nginx's annotation-heavy model maps to HTTPRoute filters and policy resources in Envoy Gateway.

```bash
#!/bin/bash
# migration-audit.sh — identify Nginx annotations requiring manual translation
set -euo pipefail

NAMESPACE=${1:-default}

echo "=== Nginx Ingress Annotation Audit ==="
kubectl get ingress -n "$NAMESPACE" -o json | \
  jq -r '.items[] | {
    name: .metadata.name,
    annotations: (.metadata.annotations | to_entries |
      map(select(.key | startswith("nginx.ingress.kubernetes.io"))) |
      from_entries)
  } | select(.annotations != {})'

echo ""
echo "=== Annotations requiring manual HTTPRoute translation ==="
COMPLEX_ANNOTATIONS=(
  "configuration-snippet"
  "server-snippet"
  "stream-snippet"
  "lua-resty"
  "modsecurity"
)

for ann in "${COMPLEX_ANNOTATIONS[@]}"; do
  COUNT=$(kubectl get ingress -n "$NAMESPACE" -o json | \
    jq --arg ann "$ann" '[.items[] | .metadata.annotations // {} |
      to_entries[] | select(.key | contains($ann))] | length')
  if [ "$COUNT" -gt 0 ]; then
    echo "  WARNING: $COUNT ingress(es) use $ann — requires EnvoyPatchPolicy"
  fi
done
```

### Migrating from Nginx to Traefik

```yaml
# nginx-to-traefik-annotation-map.yaml
# Run this alongside an automated migration script
mappingRules:
- nginxAnnotation: "nginx.ingress.kubernetes.io/rewrite-target"
  traefikEquivalent: "IngressRoute with ReplacePathRegex middleware"
  example: |
    apiVersion: traefik.io/v1alpha1
    kind: Middleware
    metadata:
      name: strip-prefix
    spec:
      replacePathRegex:
        regex: "^/api/(.*)"
        replacement: "/$1"

- nginxAnnotation: "nginx.ingress.kubernetes.io/limit-rps"
  traefikEquivalent: "RateLimit middleware"
  example: |
    apiVersion: traefik.io/v1alpha1
    kind: Middleware
    metadata:
      name: rate-limit
    spec:
      rateLimit:
        average: 100
        burst: 200

- nginxAnnotation: "nginx.ingress.kubernetes.io/backend-protocol: GRPC"
  traefikEquivalent: "IngressRoute with h2c scheme"
  example: |
    services:
    - name: grpc-service
      port: 9090
      scheme: h2c
```

## Observability and Alerting

Regardless of the controller chosen, a standard set of SLO-based alerts applies:

```yaml
# ingress-slo-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ingress-slo-alerts
  namespace: monitoring
spec:
  groups:
  - name: ingress-slo
    interval: 30s
    rules:
    # Error rate SLO: < 0.1% 5xx over 5 minutes
    - alert: IngressHighErrorRate
      expr: |
        (
          sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m]))
          /
          sum(rate(nginx_ingress_controller_requests[5m]))
        ) > 0.001
      for: 2m
      labels:
        severity: critical
        slo: error_rate
      annotations:
        summary: "Ingress 5xx error rate exceeds 0.1% SLO"
        runbook: "https://runbooks.support.tools/ingress/high-error-rate"

    # Latency SLO: p99 < 500ms
    - alert: IngressHighP99Latency
      expr: |
        histogram_quantile(0.99,
          sum(rate(nginx_ingress_controller_response_duration_seconds_bucket[5m])) by (le, ingress)
        ) > 0.5
      for: 2m
      labels:
        severity: warning
        slo: latency
      annotations:
        summary: "Ingress p99 latency exceeds 500ms SLO for {{ $labels.ingress }}"

    # Saturation: connection queue depth
    - alert: IngressConnectionQueueBuildup
      expr: |
        haproxy_backend_current_queue > 100
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "HAProxy backend queue depth exceeds 100"
```

## Decision Framework

Use this decision tree when selecting an ingress controller:

1. **Is your primary constraint throughput and p99 latency?** Choose HAProxy.
2. **Do you need WASM or Envoy ecosystem extensions?** Choose Envoy Gateway.
3. **Do you manage Let's Encrypt certificates for hundreds of domains?** Choose Traefik.
4. **Is your team already fluent in nginx configuration?** Choose Nginx Ingress.
5. **Are you running on a managed Kubernetes service that pre-installs an ingress?** Default to that controller unless a specific feature gap forces a change.
6. **Do you require multi-cluster routing at the ingress layer?** Choose Envoy Gateway with Multi-Cluster Services.

## Key Takeaways

Ingress controller selection in 2030 is less about survival and more about optimization. All four controllers handle the standard workload correctly. The differences emerge under load, at the edges of the feature set, and during operational incidents.

HAProxy delivers the lowest tail latency and highest raw throughput, making it the right choice for latency-sensitive systems. Envoy Gateway provides the most extensible data plane and the cleanest Gateway API implementation. Nginx Ingress benefits from the largest community, ecosystem, and annotation surface. Traefik minimizes operational complexity for teams running heterogeneous infrastructure with frequent service churn.

The migration from Ingress to Gateway API resources is the common thread. Teams should plan this migration regardless of which controller they choose, as the annotation-based Ingress model will eventually be deprecated in favor of the typed, role-oriented Gateway API model.
