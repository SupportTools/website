---
title: "Kubernetes Ingress Advanced Patterns: NGINX, Traefik, and Gateway API Migration"
date: 2027-08-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Ingress", "NGINX", "Traefik", "Networking"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Kubernetes ingress patterns covering NGINX canary annotations, rate limiting with Lua, Traefik middleware chains, mutual TLS termination, WebSocket support, and migrating from Ingress to Gateway API HTTPRoute."
more_link: "yes"
url: "/kubernetes-ingress-advanced-patterns-guide/"
---

Kubernetes Ingress controllers have evolved from simple L7 reverse proxies into sophisticated traffic management platforms capable of canary deployments, mutual TLS, rate limiting, and WebSocket handling. As the ecosystem transitions toward the Gateway API, teams operating production Ingress controllers must understand both the current annotation-driven model and the declarative, role-oriented Gateway API that replaces it. This guide covers production-grade patterns for NGINX and Traefik, then provides a migration path to Gateway API HTTPRoutes.

<!--more-->

## Section 1: NGINX Ingress Controller Production Deployment

### High-Availability Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
  template:
    metadata:
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "10254"
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app.kubernetes.io/name: ingress-nginx
            topologyKey: kubernetes.io/hostname
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: ingress-nginx
      containers:
      - name: controller
        image: registry.k8s.io/ingress-nginx/controller:v1.10.0
        args:
        - /nginx-ingress-controller
        - --election-id=ingress-nginx-leader
        - --controller-class=k8s.io/ingress-nginx
        - --configmap=$(POD_NAMESPACE)/ingress-nginx-controller
        - --tcp-services-configmap=$(POD_NAMESPACE)/tcp-services
        - --validating-webhook=:8443
        - --validating-webhook-certificate=/usr/local/certificates/cert
        - --validating-webhook-key=/usr/local/certificates/key
        resources:
          requests:
            cpu: 100m
            memory: 90Mi
          limits:
            cpu: 1
            memory: 512Mi
        readinessProbe:
          httpGet:
            path: /healthz
            port: 10254
          initialDelaySeconds: 10
          periodSeconds: 10
```

### Global ConfigMap Tuning

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Worker processes and connections
  worker-processes: "auto"
  max-worker-connections: "16384"
  worker-cpu-affinity: "auto"

  # Keep-alive and timeouts
  keep-alive: "75"
  keep-alive-requests: "1000"
  upstream-keepalive-connections: "320"
  upstream-keepalive-timeout: "60"
  upstream-keepalive-requests: "1000"

  # Timeouts
  proxy-connect-timeout: "5"
  proxy-send-timeout: "60"
  proxy-read-timeout: "60"

  # Buffer sizes
  proxy-buffer-size: "16k"
  proxy-buffers-number: "4"

  # Enable GZIP
  use-gzip: "true"
  gzip-level: "5"
  gzip-min-length: "1000"

  # Security headers
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384"
  hsts: "true"
  hsts-max-age: "31536000"
  hsts-include-subdomains: "true"

  # Real IP from load balancer
  use-forwarded-headers: "true"
  forwarded-for-header: "X-Forwarded-For"
  compute-full-forwarded-for: "true"
  proxy-real-ip-cidr: "0.0.0.0/0"
```

## Section 2: NGINX Canary Annotations

NGINX Ingress supports canary deployments via annotations on a secondary Ingress resource.

```yaml
# Stable deployment Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-stable
  namespace: production
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
            name: api-stable
            port:
              number: 80
---
# Canary Ingress (routes 10% of traffic to v2)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-canary
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    # Alternative: route based on header
    # nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
    # nginx.ingress.kubernetes.io/canary-by-header-value: "always"
    # Alternative: route based on cookie
    # nginx.ingress.kubernetes.io/canary-by-cookie: "canary"
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
            name: api-canary
            port:
              number: 80
```

### Progressive Canary Weight Updates

```bash
# Gradually increase canary weight
for weight in 10 25 50 75 100; do
  kubectl annotate ingress api-canary -n production \
    "nginx.ingress.kubernetes.io/canary-weight=${weight}" \
    --overwrite
  echo "Canary weight set to ${weight}%"

  # Wait and check error rate
  sleep 300
  ERROR_RATE=$(kubectl exec -n monitoring prometheus-0 -- \
    promtool query instant \
    'rate(nginx_ingress_controller_requests{status=~"5.."}[5m]) / rate(nginx_ingress_controller_requests[5m])' \
    | grep value | awk '{print $2}')

  if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
    echo "Error rate ${ERROR_RATE} exceeds 1%, rolling back"
    kubectl annotate ingress api-canary -n production \
      "nginx.ingress.kubernetes.io/canary-weight=0" \
      --overwrite
    break
  fi
done
```

## Section 3: NGINX Rate Limiting

### Global Rate Limiting via ConfigMap

```yaml
data:
  limit-connections: "100"
  limit-req-status-code: "429"
  limit-conn-status-code: "503"
```

### Per-Ingress Rate Limiting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-rate-limited
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/limit-rps: "50"
    nginx.ingress.kubernetes.io/limit-rpm: "1000"
    nginx.ingress.kubernetes.io/limit-connections: "20"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"
    nginx.ingress.kubernetes.io/limit-whitelist: "10.0.0.0/8,172.16.0.0/12"
spec:
  ingressClassName: nginx
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /api/
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
```

### Custom Lua Rate Limiting

For sophisticated rate limiting (per-user, per-API-key), inject Lua via server-snippet:

```yaml
annotations:
  nginx.ingress.kubernetes.io/server-snippet: |
    lua_shared_dict api_limit 10m;

  nginx.ingress.kubernetes.io/configuration-snippet: |
    access_by_lua_block {
      local limit_req = require "resty.limit.req"
      local lim, err = limit_req.new("api_limit", 200, 100)
      if not lim then
        ngx.log(ngx.ERR, "failed to instantiate rate limiter: ", err)
        return ngx.exit(500)
      end

      local key = ngx.var.http_x_api_key or ngx.var.remote_addr
      local delay, err = lim:incoming(key, true)
      if not delay then
        if err == "rejected" then
          ngx.header["Retry-After"] = "1"
          return ngx.exit(429)
        end
        ngx.log(ngx.ERR, "failed to limit req: ", err)
        return ngx.exit(500)
      end

      if delay >= 0.001 then
        ngx.sleep(delay)
      end
    }
```

## Section 4: Mutual TLS Termination at the Ingress

### Generate Client Certificates

```bash
# Create CA for client certificates
openssl genrsa -out client-ca.key 4096
openssl req -new -x509 -days 3650 -key client-ca.key \
  -out client-ca.crt \
  -subj "/CN=Client CA/O=Example Corp"

# Create a client certificate
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr \
  -subj "/CN=service-account/O=production"
openssl x509 -req -days 365 -in client.csr \
  -CA client-ca.crt -CAkey client-ca.key -CAcreateserial \
  -out client.crt

# Store CA in Kubernetes secret
kubectl create secret generic client-ca \
  --from-file=ca.crt=client-ca.crt \
  -n production
```

### mTLS Ingress Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mtls-api
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/auth-tls-verify-client: "on"
    nginx.ingress.kubernetes.io/auth-tls-secret: "production/client-ca"
    nginx.ingress.kubernetes.io/auth-tls-verify-depth: "2"
    nginx.ingress.kubernetes.io/auth-tls-pass-certificate-to-upstream: "true"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header X-SSL-Client-Cert $ssl_client_escaped_cert;
      proxy_set_header X-SSL-Client-DN $ssl_client_s_dn;
      proxy_set_header X-SSL-Client-Verify $ssl_client_verify;
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

## Section 5: WebSocket Support

WebSocket connections require HTTP Upgrade and long-lived TCP connections. NGINX Ingress handles this with proxy_read_timeout and Upgrade header passthrough.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: websocket-app
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_http_version 1.1;
spec:
  ingressClassName: nginx
  rules:
  - host: ws.example.com
    http:
      paths:
      - path: /ws
        pathType: Prefix
        backend:
          service:
            name: websocket-service
            port:
              number: 8080
```

## Section 6: Traefik Middleware Chains

Traefik's middleware system composes reusable request-transformation logic.

### Core Middleware Types

```yaml
# Rate limiting middleware
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
        depth: 1
---
# Authentication middleware
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: jwt-auth
  namespace: production
spec:
  forwardAuth:
    address: http://auth-service.production.svc.cluster.local/verify
    trustForwardHeader: true
    authResponseHeaders:
    - X-User-ID
    - X-User-Role
---
# Circuit breaker middleware
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: circuit-breaker
  namespace: production
spec:
  circuitBreaker:
    expression: "ResponseCodeRatio(500, 600, 0, 600) > 0.30"
    checkPeriod: 10s
    fallbackDuration: 30s
    recoveryDuration: 10s
---
# Retry middleware
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: retry
  namespace: production
spec:
  retry:
    attempts: 3
    initialInterval: 100ms
---
# Headers middleware
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: security-headers
  namespace: production
spec:
  headers:
    sslRedirect: true
    stsSeconds: 31536000
    stsIncludeSubdomains: true
    forceSTSHeader: true
    contentTypeNosniff: true
    browserXssFilter: true
    referrerPolicy: "strict-origin-when-cross-origin"
    customResponseHeaders:
      X-Frame-Options: "SAMEORIGIN"
      Permissions-Policy: "geolocation=(), microphone=(), camera=()"
```

### Applying Middleware Chain to IngressRoute

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: api
  namespace: production
spec:
  entryPoints:
  - websecure
  routes:
  - match: Host(`api.example.com`) && PathPrefix(`/api/v1`)
    kind: Rule
    middlewares:
    - name: rate-limit
      namespace: production
    - name: jwt-auth
      namespace: production
    - name: circuit-breaker
      namespace: production
    - name: retry
      namespace: production
    - name: security-headers
      namespace: production
    services:
    - name: api-service
      port: 80
      weight: 100
      responseForwarding:
        flushInterval: 100ms
  tls:
    certResolver: letsencrypt
    domains:
    - main: api.example.com
```

## Section 7: Traefik Dynamic Configuration and Service Discovery

```yaml
# Traefik static configuration (Helm values)
additionalArguments:
- "--providers.kubernetesingress.allowexternalnameservices=true"
- "--providers.kubernetescrd.allowexternalnameservices=true"
- "--accesslog=true"
- "--accesslog.format=json"
- "--accesslog.fields.headers.defaultmode=keep"
- "--metrics.prometheus=true"
- "--metrics.prometheus.addentrypointslabels=true"
- "--metrics.prometheus.addserviceslabels=true"
- "--tracing.jaeger=true"
- "--tracing.jaeger.samplingparam=1.0"
- "--tracing.jaeger.localagentHostPort=jaeger-agent.monitoring:6831"
```

## Section 8: Gateway API Migration

The Gateway API introduces role-oriented resource separation: infrastructure operators manage `GatewayClass` and `Gateway` objects, while application developers manage `HTTPRoute`, `TCPRoute`, and `GRPCRoute` objects.

### Resource Hierarchy

```
GatewayClass (cluster-scoped)
  └── Gateway (namespaced, references GatewayClass)
        └── HTTPRoute (namespaced, references Gateway)
              └── Backend Service
```

### GatewayClass and Gateway

```yaml
# GatewayClass (configured by platform team)
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx
spec:
  controllerName: k8s.nginx.org/nginx-gateway-controller
---
# Gateway (configured by platform team)
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: gateway-infra
spec:
  gatewayClassName: nginx
  listeners:
  - name: http
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: "allowed"
  - name: https
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - name: wildcard-tls
        namespace: gateway-infra
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: "allowed"
```

### HTTPRoute (Replaces Ingress)

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  # Path-based routing
  - matches:
    - path:
        type: PathPrefix
        value: /api/v1
    backendRefs:
    - name: api-v1-service
      port: 80
      weight: 90
    - name: api-v2-service
      port: 80
      weight: 10     # 10% canary
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: X-Request-Source
          value: gateway
  # Header-based routing
  - matches:
    - headers:
      - name: X-Beta-User
        value: "true"
    backendRefs:
    - name: api-beta-service
      port: 80
  # Redirect HTTP to HTTPS
  - matches:
    - path:
        type: PathPrefix
        value: /
    filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
```

### Migrating from Ingress to HTTPRoute

```bash
# Step 1: Install Gateway API CRDs
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml

# Step 2: Deploy a Gateway-API-compatible controller alongside NGINX Ingress
helm install nginx-gateway-fabric oci://ghcr.io/nginxinc/charts/nginx-gateway-fabric \
  --namespace nginx-gateway \
  --create-namespace

# Step 3: Create parallel HTTPRoute for each Ingress
# (both route to the same backend during migration)

# Step 4: Validate HTTPRoute is receiving traffic
kubectl get httproute api -n production -o jsonpath='{.status.parents}'

# Step 5: Remove Ingress objects after validating HTTPRoute
kubectl delete ingress api-stable api-canary -n production
```

## Section 9: GRPCRoute for gRPC Services

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata:
  name: grpc-api
  namespace: production
spec:
  parentRefs:
  - name: production-gateway
    namespace: gateway-infra
    sectionName: https
  hostnames:
  - "grpc.example.com"
  rules:
  - matches:
    - method:
        service: example.UserService
        method: GetUser
    backendRefs:
    - name: user-service
      port: 9090
  - matches:
    - method:
        service: example.OrderService
    backendRefs:
    - name: order-service
      port: 9090
```

## Section 10: ReferenceGrant for Cross-Namespace Routing

The Gateway API restricts cross-namespace references by default. Use ReferenceGrant to explicitly allow a Gateway to reference backends in other namespaces.

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gateway-to-production
  namespace: production
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: gateway-infra
  to:
  - group: ""
    kind: Service
```

## Section 11: Ingress Performance Benchmarking

```bash
# Benchmark NGINX Ingress throughput with wrk
wrk -t12 -c400 -d30s --latency https://api.example.com/api/v1/health

# Compare with Gateway API controller
wrk -t12 -c400 -d30s --latency https://api.example.com/api/v1/health

# Monitor NGINX Ingress metrics
kubectl port-forward -n ingress-nginx \
  $(kubectl get pod -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx -o name | head -1) \
  10254:10254 &

curl -s http://localhost:10254/metrics | grep -E "nginx_ingress_controller_requests_total|nginx_ingress_controller_response_duration_seconds"
```

## Summary

NGINX Ingress and Traefik cover the majority of production L7 traffic management requirements through annotation-driven canary deployments, Lua-based rate limiting, mutual TLS termination, and WebSocket support. The Gateway API provides a more structured, role-oriented replacement that separates infrastructure concerns from application routing, enables cross-namespace route delegation, and introduces native support for gRPC and TCP routes. Migration should be incremental: deploy the Gateway API controller in parallel, validate HTTPRoutes against existing backends, and delete Ingress objects only after confirming correct routing behavior.
