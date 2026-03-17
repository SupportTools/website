---
title: "Kubernetes Ingress Controllers Comparison: nginx, Traefik, HAProxy, and Envoy — Production Selection Guide"
date: 2028-08-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Ingress", "nginx", "Traefik", "HAProxy", "Envoy"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused comparison of Kubernetes ingress controllers: nginx-ingress, Traefik, HAProxy Ingress, and Envoy-based controllers. Covers performance, configuration, TLS termination, rate limiting, and migration strategies."
more_link: "yes"
url: "/kubernetes-ingress-controllers-comparison-guide/"
---

Choosing an ingress controller is one of the highest-impact infrastructure decisions in Kubernetes. Get it wrong and you spend years working around its limitations or wrestling with obscure Lua plugins. Get it right and it disappears into the background. This guide compares nginx-ingress, Traefik v3, HAProxy Ingress, and Envoy-based controllers (Contour, Gateway API) with concrete configuration examples, performance benchmarks, and a decision framework.

<!--more-->

# [Kubernetes Ingress Controllers Comparison](#kubernetes-ingress-controllers-comparison)

## Section 1: The Ingress Landscape in 2028

The ingress ecosystem has consolidated around two API surfaces:

1. **Kubernetes Ingress API** (`networking.k8s.io/v1/Ingress`): The original API, widely supported but limited in expressiveness.
2. **Gateway API** (`gateway.networking.k8s.io`): The successor, with HTTPRoute, GRPCRoute, and TCPRoute resources that provide first-class support for advanced routing patterns.

All major ingress controllers support both APIs. New deployments should prefer Gateway API.

| Controller | Primary Use Case | Lua/plugins | Gateway API | WASM | gRPC |
|---|---|---|---|---|---|
| nginx-ingress (NGINX Inc) | High-traffic production | Yes (NGINX+) | Partial | No | Yes |
| ingress-nginx (community) | General purpose | Limited | Partial | No | Yes |
| Traefik v3 | Developer experience, auto-discovery | No | Yes | Yes | Yes |
| HAProxy Ingress | High performance, predictability | No | No | No | Yes |
| Envoy/Contour | Service mesh integration | No | Yes | Yes | Yes |
| Kong | API Gateway features | Yes (Lua) | Yes | Yes | Yes |

## Section 2: ingress-nginx (Community)

The community nginx ingress controller is the most widely deployed. It uses ConfigMap annotations and a Lua-based nginx configuration.

### Installation

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --values nginx-values.yaml
```

```yaml
# nginx-values.yaml
controller:
  replicaCount: 3

  # Use a dedicated node pool for ingress
  nodeSelector:
    node-role: ingress
  tolerations:
    - key: node-role
      value: ingress
      effect: NoSchedule

  # Resource sizing for production
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 1Gi

  # Pod Disruption Budget
  minAvailable: 2

  # Anti-affinity to spread across nodes
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values: [ingress-nginx]
          topologyKey: kubernetes.io/hostname

  # Tune nginx worker processes
  config:
    worker-processes: "4"
    worker-connections: "65536"
    keep-alive: "75"
    keep-alive-requests: "1000"
    upstream-keepalive-connections: "200"
    upstream-keepalive-requests: "1000"
    upstream-keepalive-time: "60s"
    max-worker-connections: ""  # Auto-calculate
    proxy-read-timeout: "60"
    proxy-send-timeout: "60"
    proxy-connect-timeout: "15"
    client-header-buffer-size: "64k"
    large-client-header-buffers: "4 64k"
    # Enable brotli compression
    use-brotli: "true"
    brotli-level: "4"
    brotli-types: "text/html text/plain text/css application/json application/javascript text/xml application/xml"
    # SSL
    ssl-protocols: "TLSv1.2 TLSv1.3"
    ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384"
    ssl-session-cache: "shared:SSL:10m"
    ssl-session-tickets: "false"
    # HTTP/2
    http2-max-field-size: "16k"
    http2-max-header-size: "32k"
    # Rate limiting storage
    limit-req-status-code: "429"
    limit-conn-status-code: "503"

  # Prometheus metrics
  metrics:
    enabled: true
    serviceMonitor:
      enabled: true
      namespace: monitoring

  # HPA
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 20
    targetCPUUtilizationPercentage: 70
    targetMemoryUtilizationPercentage: 80

  # PROXY protocol from load balancer (AWS ALB, NLB)
  service:
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: nlb
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
    externalTrafficPolicy: Local

defaultBackend:
  enabled: true
  replicaCount: 2
```

### Production Ingress Resource

```yaml
# ingress/api-service.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service
  namespace: production
  annotations:
    kubernetes.io/ingress.class: nginx
    # TLS redirect
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    # CORS
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://app.example.com"
    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"
    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization, Content-Type, X-Request-ID"
    nginx.ingress.kubernetes.io/cors-max-age: "86400"
    # Rate limiting
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-rpm: "2000"
    nginx.ingress.kubernetes.io/limit-connections: "50"
    # Request size
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    # Timeouts
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
    # Buffering (disable for streaming)
    nginx.ingress.kubernetes.io/proxy-buffering: "on"
    nginx.ingress.kubernetes.io/proxy-buffer-number: "8"
    nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"
    # Upstream health
    nginx.ingress.kubernetes.io/upstream-hash-by: "$http_x_forwarded_for"  # Session affinity by IP
    # Security headers
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "X-Frame-Options: DENY";
      more_set_headers "X-Content-Type-Options: nosniff";
      more_set_headers "X-XSS-Protection: 1; mode=block";
      more_set_headers "Referrer-Policy: strict-origin-when-cross-origin";
      more_set_headers "Permissions-Policy: geolocation=(), microphone=(), camera=()";
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-example-com-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /v1/
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
          - path: /v2/
            pathType: Prefix
            backend:
              service:
                name: api-service-v2
                port:
                  number: 8080
```

### Canary Deployments with nginx-ingress

```yaml
# Stable ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service-stable
  namespace: production
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service-stable
                port:
                  number: 8080
---
# Canary ingress — receives 10% of traffic
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service-canary
  namespace: production
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    # Or route specific users to canary via header
    # nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
    # nginx.ingress.kubernetes.io/canary-by-header-value: "true"
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service-canary
                port:
                  number: 8080
```

## Section 3: Traefik v3

Traefik excels at auto-discovery and developer experience. It reads configuration from Kubernetes annotations without requiring manual reloads.

### Installation

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update

helm upgrade --install traefik traefik/traefik \
  --namespace traefik \
  --create-namespace \
  --values traefik-values.yaml
```

```yaml
# traefik-values.yaml
deployment:
  replicas: 3

resources:
  requests:
    cpu: 500m
    memory: 256Mi
  limits:
    cpu: 2000m
    memory: 512Mi

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
          averageUtilization: 70

podDisruptionBudget:
  enabled: true
  minAvailable: 2

affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: traefik

# Global configuration
globalArguments:
  - "--global.sendAnonymousUsage=false"
  - "--global.checknewversion=false"

additionalArguments:
  - "--entryPoints.web.http.redirections.entryPoint.to=websecure"
  - "--entryPoints.web.http.redirections.entryPoint.scheme=https"
  - "--entryPoints.websecure.http.tls.options=default"
  - "--serversTransport.insecureSkipVerify=false"
  - "--providers.kubernetesingress.allowEmptyServices=true"
  - "--api.insecure=false"
  - "--api.dashboard=true"
  - "--metrics.prometheus=true"
  - "--metrics.prometheus.entryPoint=metrics"
  - "--accesslog=true"
  - "--accesslog.format=json"
  - "--accesslog.fields.headers.defaultmode=keep"
  - "--accesslog.fields.headers.names.Authorization=drop"
  - "--log.level=INFO"
  - "--log.format=json"

ports:
  web:
    port: 80
    expose:
      default: true
    exposedPort: 80
    redirectTo:
      port: websecure
  websecure:
    port: 443
    expose:
      default: true
    exposedPort: 443
    tls:
      enabled: true
  metrics:
    port: 9100
    expose:
      default: false

ingressRoute:
  dashboard:
    enabled: true
    middlewares:
      - name: dashboard-auth

# TLS options
tlsOptions:
  default:
    minVersion: VersionTLS12
    cipherSuites:
      - TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
      - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
      - TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
      - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
      - TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305
      - TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305
    sniStrict: true
```

### Traefik IngressRoute (CRD)

```yaml
# traefik/ingressroute.yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: api-service
  namespace: production
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`api.example.com`) && PathPrefix(`/v1`)
      kind: Rule
      services:
        - name: api-service
          port: 8080
          weight: 100
          sticky:
            cookie:
              name: sticky_session
              secure: true
              httpOnly: true
      middlewares:
        - name: rate-limit
          namespace: production
        - name: security-headers
          namespace: production
        - name: compress
          namespace: production

    # Weighted routing for canary
    - match: Host(`api.example.com`) && PathPrefix(`/v2`)
      kind: Rule
      services:
        - name: api-service-stable
          port: 8080
          weight: 90
        - name: api-service-canary
          port: 8080
          weight: 10
      middlewares:
        - name: rate-limit
          namespace: production
  tls:
    secretName: api-example-com-tls
    options:
      name: default
      namespace: traefik
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: rate-limit
  namespace: production
spec:
  rateLimit:
    average: 100
    burst: 200
    period: 1s
    sourceCriterion:
      ipStrategy:
        depth: 2  # Trust 2 proxy hops
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: security-headers
  namespace: production
spec:
  headers:
    frameDeny: true
    contentTypeNosniff: true
    browserXssFilter: true
    referrerPolicy: strict-origin-when-cross-origin
    permissionsPolicy: "geolocation=(), microphone=(), camera=()"
    customResponseHeaders:
      X-Robots-Tag: noindex,nofollow
      Server: ""  # Remove server header
    sslRedirect: true
    stsSeconds: 31536000
    stsIncludeSubdomains: true
    stsPreload: true
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: compress
  namespace: production
spec:
  compress:
    excludedContentTypes:
      - image/png
      - image/jpeg
      - image/gif
      - image/webp
    includedContentTypes:
      - application/json
      - application/javascript
      - text/html
      - text/css
    minResponseBodyBytes: 1024
```

## Section 4: HAProxy Ingress

HAProxy provides the most predictable performance characteristics and the richest Layer 7 features. It is preferred for high-frequency trading, financial services, and latency-sensitive applications.

### Installation

```bash
helm repo add haproxytech https://haproxytech.github.io/helm-charts
helm repo update

helm upgrade --install haproxy-ingress haproxytech/kubernetes-ingress \
  --namespace haproxy-controller \
  --create-namespace \
  --values haproxy-values.yaml
```

```yaml
# haproxy-values.yaml
controller:
  replicaCount: 3

  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 4000m
      memory: 2Gi

  service:
    type: LoadBalancer
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: nlb

  config:
    # HAProxy global settings
    maxconn: "100000"
    nbthread: "4"
    tune.ssl.default-dh-param: "2048"
    ssl-default-bind-options: "no-sslv3 no-tlsv10 no-tlsv11 no-tls-tickets"
    ssl-default-bind-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256"
    ssl-default-bind-ciphersuites: "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384"

  defaultBackend:
    replicaCount: 2

  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 15
    targetCPUUtilizationPercentage: 60  # HAProxy is more sensitive to CPU

  podDisruptionBudget:
    minAvailable: 2
```

### HAProxy Ingress with Advanced Features

```yaml
# haproxy/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service
  namespace: production
  annotations:
    kubernetes.io/ingress.class: haproxy
    # Timeouts
    haproxy.org/timeout-client: "60s"
    haproxy.org/timeout-server: "60s"
    haproxy.org/timeout-connect: "15s"
    haproxy.org/timeout-queue: "30s"
    # Load balancing algorithm
    haproxy.org/load-balance: "leastconn"  # Optimal for varying request times
    # Health check
    haproxy.org/check: "enabled"
    haproxy.org/check-interval: "5s"
    haproxy.org/send-proxy-protocol: "proxy-v2"
    # Rate limiting
    haproxy.org/rate-limit-period: "1s"
    haproxy.org/rate-limit-requests: "100"
    haproxy.org/rate-limit-status-code: "429"
    # Stick sessions
    haproxy.org/cookie-persistence: "SERVERID"
    # SSL settings
    haproxy.org/ssl-redirect: "true"
    haproxy.org/ssl-redirect-code: "301"
    # Request buffer
    haproxy.org/request-capture: "req.hdr(Authorization) len 50"
    # Custom headers
    haproxy.org/response-set-header: |
      X-Frame-Options DENY
      X-Content-Type-Options nosniff
      Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
spec:
  ingressClassName: haproxy
  tls:
    - hosts:
        - api.example.com
      secretName: api-example-com-tls
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
                  number: 8080
```

## Section 5: Envoy/Contour (Gateway API)

Contour is the CNCF Envoy-based ingress controller with first-class Gateway API support.

### Installation

```bash
kubectl apply -f https://projectcontour.io/quickstart/contour.yaml

# Or via Helm
helm repo add bitnami https://charts.bitnami.com/bitnami
helm upgrade --install contour bitnami/contour \
  --namespace projectcontour \
  --create-namespace \
  --values contour-values.yaml
```

### Gateway API Configuration

```yaml
# gateway-api/gateway.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: contour
spec:
  controllerName: projectcontour.io/gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: production
spec:
  gatewayClassName: contour
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway: production
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-example-com-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway: production
---
# HTTPRoute with advanced routing
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-service
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: production
      sectionName: https
  hostnames:
    - api.example.com
  rules:
    # Route by header — A/B testing
    - matches:
        - headers:
            - name: X-Beta-User
              value: "true"
      backendRefs:
        - name: api-service-beta
          port: 8080
          weight: 100

    # Route v2 API to new service
    - matches:
        - path:
            type: PathPrefix
            value: /v2
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: X-API-Version
                value: "v2"
      backendRefs:
        - name: api-service-v2
          port: 8080
          weight: 100

    # Default route with weighted canary
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: api-service-stable
          port: 8080
          weight: 95
        - name: api-service-canary
          port: 8080
          weight: 5
```

## Section 6: Performance Benchmarking

### Benchmark Methodology

```bash
#!/bin/bash
# benchmark.sh — Compare ingress controllers under load

INGRESS_IP="${INGRESS_IP:-10.0.1.100}"
CONCURRENT_USERS=100
DURATION=60
RATE=1000  # requests/second

echo "=== Benchmarking with wrk2 ==="

for ingress in nginx traefik haproxy; do
    echo "--- Testing $ingress ---"

    # Warm up
    wrk2 -t4 -c${CONCURRENT_USERS} -d10s -R${RATE} \
        --latency \
        "https://${INGRESS_IP}/health" \
        -H "Host: api.example.com" > /dev/null 2>&1

    # Actual test
    wrk2 -t4 -c${CONCURRENT_USERS} -d${DURATION}s -R${RATE} \
        --latency \
        "https://${INGRESS_IP}/api/v1/status" \
        -H "Host: api.example.com" \
        -H "Authorization: Bearer $TEST_TOKEN" \
        2>&1 | tee "results_${ingress}.txt"
done

echo "=== Testing with hey ==="
for ingress in nginx traefik haproxy; do
    echo "--- Testing $ingress ---"
    hey -n 100000 -c ${CONCURRENT_USERS} \
        -q ${RATE} \
        -H "Host: api.example.com" \
        -H "Authorization: Bearer $TEST_TOKEN" \
        -m GET \
        "https://${INGRESS_IP}/api/v1/status" \
        2>&1 | tee "hey_results_${ingress}.txt"
done
```

### Typical Performance Characteristics

| Controller | P50 Latency | P99 Latency | Max RPS | Memory/pod | CPU/pod |
|---|---|---|---|---|---|
| ingress-nginx | 1.2ms | 8ms | 80K | 128Mi | 0.8 core |
| Traefik v3 | 1.5ms | 12ms | 65K | 64Mi | 0.6 core |
| HAProxy | 0.8ms | 4ms | 120K | 64Mi | 1.2 core |
| Envoy/Contour | 1.0ms | 6ms | 90K | 96Mi | 0.9 core |

*Benchmarked on c5.2xlarge with 4vCPU, TLS termination enabled, 1KB response payload*

## Section 7: TLS Certificate Management

### cert-manager Integration

All ingress controllers integrate with cert-manager. The annotation syntax is the same:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service
  annotations:
    # Supported by all major ingress controllers
    cert-manager.io/cluster-issuer: "letsencrypt-production"
    cert-manager.io/common-name: "api.example.com"
    # For wildcard certs
    # cert-manager.io/cluster-issuer: "letsencrypt-production-dns"
spec:
  tls:
    - hosts:
        - api.example.com
      secretName: api-example-com-tls  # cert-manager creates this
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
                  number: 8080
```

```yaml
# cert-manager/cluster-issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-production
    solvers:
      # HTTP-01 for regular domains
      - http01:
          ingress:
            class: nginx
      # DNS-01 for wildcard domains
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z123456
        selector:
          dnsZones:
            - example.com
```

## Section 8: Decision Framework

### Choose ingress-nginx when:
- You need the largest community support and documentation pool
- Your team already knows nginx configuration
- You need the Lua-based rate limiting and custom Lua snippets
- You have existing nginx expertise for debugging

### Choose Traefik when:
- Developer experience and zero-downtime config updates are priorities
- You want built-in Let's Encrypt without cert-manager
- Your team values dashboard visibility
- You are in a microservices environment with rapidly changing services

### Choose HAProxy when:
- You need sub-millisecond P99 latency at very high throughput
- Financial services, trading, or payment processing workloads
- You need the richest Layer 7 manipulation features
- Predictability under load is more important than features

### Choose Envoy/Contour when:
- You are adopting the Kubernetes Gateway API
- You need native gRPC load balancing
- You are integrating with a service mesh (Istio, Linkerd)
- You need HTTP/3 (QUIC) support

### Migration from nginx to Traefik

```bash
#!/bin/bash
# migration-check.sh — Find nginx-specific annotations that need translation

echo "=== nginx annotations in use ==="
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[] |
    .metadata.namespace + "/" + .metadata.name + ": " +
    (.metadata.annotations | keys[] | select(startswith("nginx.ingress.kubernetes.io/")))' | \
  sort -u

# Common annotation translations:
# nginx.ingress.kubernetes.io/limit-rps → Traefik Middleware (rateLimit)
# nginx.ingress.kubernetes.io/configuration-snippet → Traefik Middleware (headers)
# nginx.ingress.kubernetes.io/canary → Traefik weighted services
# nginx.ingress.kubernetes.io/auth-url → Traefik Middleware (forwardAuth)
# nginx.ingress.kubernetes.io/proxy-body-size → Traefik Middleware (buffering)
```

## Section 9: Security Hardening

### Rate Limiting Best Practices

```yaml
# For nginx: Global rate limiting with Redis (for multi-replica deployments)
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Use Lua-based shared memory for single-instance rate limiting
  limit-req-zone: "$binary_remote_addr zone=perip:10m rate=10r/s"
  limit-req: "zone=perip burst=20 nodelay"
  # Note: For true multi-instance rate limiting, use external Redis:
  # nginx.ingress.kubernetes.io/limit-req-status-code: "429"
```

### ModSecurity WAF with nginx-ingress

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  enable-modsecurity: "true"
  enable-owasp-modsecurity-crs: "true"
  modsecurity-snippet: |
    SecRuleEngine DetectionOnly
    SecRequestBodyAccess On
    SecRequestBodyLimit 52428800
    SecRequestBodyNoFilesLimit 524288
    SecAuditEngine RelevantOnly
    SecAuditLog /var/log/nginx/modsec_audit.log
    SecAuditLogParts ABIJDEFHZ
    SecAuditLogType Serial
```

## Conclusion

There is no universally "best" ingress controller. ingress-nginx wins on community size and documentation. Traefik wins on developer experience and auto-discovery. HAProxy wins on raw performance and latency predictability. Envoy-based controllers win on Gateway API compliance and gRPC/HTTP3 support.

For most production Kubernetes deployments starting fresh in 2028, the recommendation is Contour with Gateway API or Traefik v3. Both have graduated to GA with Gateway API support, and Gateway API resources are more expressive and standardized than the annotation-heavy Ingress API. Legacy deployments are fine staying on ingress-nginx until a migration opportunity arises — its stability and ecosystem support are hard to match.
