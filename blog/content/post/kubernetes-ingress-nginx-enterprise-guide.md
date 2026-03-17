---
title: "NGINX Ingress Controller: Enterprise Configuration and Performance Tuning"
date: 2028-01-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NGINX", "Ingress", "Performance", "WAF", "ModSecurity", "Prometheus", "Rate Limiting"]
categories: ["Kubernetes", "Networking", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to NGINX Ingress Controller enterprise configuration covering upstream keepalives, SSL termination, rate limiting, CORS, ModSecurity WAF integration, Lua scripting, Prometheus metrics, and canary deployment annotations."
more_link: "yes"
url: "/kubernetes-ingress-nginx-enterprise-guide/"
---

The NGINX Ingress Controller is the most widely deployed ingress solution in Kubernetes, yet most production deployments barely scratch the surface of its capabilities. Default configurations leave significant performance, security, and reliability improvements on the table. This guide addresses every major tuning dimension—from kernel-level socket options through application-layer WAF enforcement—providing production-validated configurations for enterprise environments handling tens of thousands of requests per second.

<!--more-->

# NGINX Ingress Controller: Enterprise Configuration and Performance Tuning

## Section 1: Controller Deployment and Base Configuration

### Helm-Based Deployment with Enterprise Values

Production deployments require careful resource sizing, pod anti-affinity, and topology spread constraints to prevent ingress controller pods from becoming a single point of failure.

```yaml
# values-production.yaml
# Deploy with: helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
#   -n ingress-nginx --create-namespace -f values-production.yaml

controller:
  # Image pinning prevents unexpected upstream changes
  image:
    tag: "v1.10.1"
    digest: "sha256:e24aa96dadee3a9ba9621ca5e76773cfd72c6bf9f5db23b64f1ee2bf10c27ef0"

  replicaCount: 3

  # Ensure pods spread across availability zones
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app.kubernetes.io/component: controller

  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: controller
          topologyKey: kubernetes.io/hostname

  # Dedicate nodes to ingress workloads for predictable latency
  nodeSelector:
    node-role.kubernetes.io/ingress: "true"

  tolerations:
    - key: "dedicated"
      operator: "Equal"
      value: "ingress"
      effect: "NoSchedule"

  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 4000m
      memory: 2Gi

  # Enable metrics scraping
  metrics:
    enabled: true
    serviceMonitor:
      enabled: true
      namespace: monitoring
      additionalLabels:
        release: prometheus-stack

  # Configure admission webhook for config validation
  admissionWebhooks:
    enabled: true
    timeoutSeconds: 10

  # Pod disruption budget for rolling updates
  podDisruptionBudget:
    minAvailable: 2

  # Graceful termination
  terminationGracePeriodSeconds: 300

  # Allow the controller to bind to privileged ports without root
  containerPort:
    http: 80
    https: 443

  service:
    type: LoadBalancer
    externalTrafficPolicy: Local  # Preserve client IP, skip extra hop
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
      service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "tcp"

  # Global ConfigMap settings — see Section 2 for full reference
  config:
    use-forwarded-headers: "true"
    compute-full-forwarded-for: "true"
    use-proxy-protocol: "false"
    log-format-upstream: >-
      {"time":"$time_iso8601","remote_addr":"$proxy_protocol_addr",
      "x_forwarded_for":"$proxy_add_x_forwarded_for","request_id":"$req_id",
      "remote_user":"$remote_user","bytes_sent":$bytes_sent,
      "request_time":$request_time,"status":$status,
      "vhost":"$host","request_proto":"$server_protocol",
      "path":"$uri","request_query":"$args",
      "request_length":$request_length,"duration":$request_time,
      "method":"$request_method","http_referrer":"$http_referer",
      "http_user_agent":"$http_user_agent"}
```

### ConfigMap Tuning: nginx.conf Global Parameters

The ingress-nginx ConfigMap exposes hundreds of nginx.conf directives. The following settings address the most impactful production tuning parameters.

```yaml
# ingress-nginx-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # ── Worker Processes ──────────────────────────────────────────────────────
  # "auto" matches CPU count; pin to specific count for NUMA-aware systems
  worker-processes: "auto"
  worker-cpu-affinity: "auto"

  # ── Connection Handling ───────────────────────────────────────────────────
  # Each worker can handle this many simultaneous connections
  max-worker-connections: "65536"
  # Reduces syscall overhead by accepting multiple connections per epoll event
  multi-accept: "on"

  # ── Upstream Keepalives (Critical for performance) ────────────────────────
  # Number of idle keepalive connections per upstream server cached per worker
  upstream-keepalive-connections: "320"
  # Maximum requests over a single keepalive connection before recycling
  upstream-keepalive-requests: "10000"
  # Idle timeout before the controller closes an unused keepalive connection
  upstream-keepalive-timeout: "60"

  # ── Timeouts ──────────────────────────────────────────────────────────────
  proxy-connect-timeout: "5"       # Timeout establishing upstream TCP connection
  proxy-send-timeout: "60"         # Timeout sending request to upstream
  proxy-read-timeout: "60"         # Timeout reading response from upstream
  proxy-body-size: "50m"           # Maximum request body size

  # ── Buffering ─────────────────────────────────────────────────────────────
  proxy-buffering: "on"
  proxy-buffer-size: "16k"         # First buffer for response headers
  proxy-buffers-number: "8"        # Number of response body buffers per request
  # Total proxy buffer: proxy-buffers-number * proxy-buffer-size = 128k

  # ── SSL/TLS ───────────────────────────────────────────────────────────────
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"
  ssl-session-cache: "shared:SSL:100m"  # Shared SSL session cache, 100 MB
  ssl-session-timeout: "1d"
  ssl-session-tickets: "off"       # Disable for perfect forward secrecy
  ssl-early-data: "off"            # Disable TLS 1.3 0-RTT replay vulnerability

  # HSTS — ensure all traffic uses HTTPS for 2 years
  hsts: "true"
  hsts-max-age: "63072000"
  hsts-include-subdomains: "true"
  hsts-preload: "true"

  # ── OCSP Stapling ─────────────────────────────────────────────────────────
  enable-ocsp: "true"

  # ── HTTP/2 ────────────────────────────────────────────────────────────────
  use-http2: "true"
  http2-max-field-size: "16k"
  http2-max-header-size: "32k"
  http2-max-requests: "1000"

  # ── Compression ───────────────────────────────────────────────────────────
  use-gzip: "true"
  gzip-level: "5"
  gzip-types: "application/atom+xml application/javascript application/json application/rss+xml application/vnd.ms-fontobject application/x-font-opentype application/x-font-truetype application/x-font-ttf application/x-javascript application/xhtml+xml application/xml font/eot font/opentype font/otf font/truetype image/svg+xml image/vnd.microsoft.icon text/css text/javascript text/plain text/xml"
  enable-brotli: "true"
  brotli-level: "6"

  # ── Security Headers ──────────────────────────────────────────────────────
  hide-headers: "X-Powered-By,Server"
  server-tokens: "false"

  # ── Access Logging ────────────────────────────────────────────────────────
  # Exclude health checks from access logs to reduce noise
  skip-access-log-urls: "/healthz,/readyz,/metrics"

  # ── Real IP Resolution ────────────────────────────────────────────────────
  # Trust these CIDRs as proxy sources for X-Forwarded-For
  proxy-real-ip-cidr: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
  forwarded-for-header: "X-Forwarded-For"

  # ── Open File Cache ───────────────────────────────────────────────────────
  # Cache file descriptors for static assets
  enable-opentracing: "false"

  # ── Custom Headers Added to All Responses ─────────────────────────────────
  add-headers: "ingress-nginx/custom-headers"
```

### Custom Response Headers ConfigMap

```yaml
# custom-headers-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: custom-headers
  namespace: ingress-nginx
data:
  # Security headers applied to all responses globally
  X-Frame-Options: "SAMEORIGIN"
  X-Content-Type-Options: "nosniff"
  X-XSS-Protection: "1; mode=block"
  Referrer-Policy: "strict-origin-when-cross-origin"
  Permissions-Policy: "camera=(), microphone=(), geolocation=(), payment=()"
  # Unique request ID for distributed tracing correlation
  X-Request-ID: "$req_id"
```

## Section 2: Rate Limiting

### Global and Per-Ingress Rate Limiting

NGINX Ingress supports rate limiting at multiple levels. Global defaults are set in the ConfigMap while per-Ingress overrides use annotations.

```yaml
# rate-limit-configmap-additions.yaml
# Add to ingress-nginx-controller ConfigMap data section
data:
  # Default rate limit zone — 10 MB shared memory, ~160,000 IP addresses
  limit-req-status-code: "429"
  limit-conn-status-code: "429"
```

```yaml
# ingress-with-rate-limiting.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service
  namespace: production
  annotations:
    # ── Rate Limiting Annotations ─────────────────────────────────────────
    # Requests per second from a single IP (token bucket)
    nginx.ingress.kubernetes.io/limit-rps: "50"
    # Burst above the RPS limit before returning 429
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"
    # Connections from a single IP
    nginx.ingress.kubernetes.io/limit-connections: "20"
    # Whitelist internal CIDR ranges from rate limiting
    nginx.ingress.kubernetes.io/limit-whitelist: "10.0.0.0/8,172.16.0.0/12"
    # Rate limit by $binary_remote_addr (IP) or custom key
    nginx.ingress.kubernetes.io/limit-req-zone-variable: "$binary_remote_addr"

    # ── Timeouts per Ingress ──────────────────────────────────────────────
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"

spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-secret
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

### Advanced Rate Limiting via ConfigMap Snippet

For user-based rate limiting using JWT claims or API keys, custom nginx snippets provide the necessary flexibility.

```yaml
# per-user-rate-limit-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service-advanced-ratelimit
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/server-snippet: |
      # Define rate limit zones in server context
      # Zone based on API key header — 10 MB, 100 req/s per key
      limit_req_zone $http_x_api_key zone=apikey_limit:10m rate=100r/s;
      limit_req_zone $binary_remote_addr zone=ip_limit:10m rate=20r/s;

    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Apply both zones — most restrictive wins
      limit_req zone=apikey_limit burst=200 nodelay;
      limit_req zone=ip_limit burst=40 nodelay;

      # Return structured JSON for rate limit errors
      limit_req_status 429;
      limit_conn_status 429;
spec:
  ingressClassName: nginx
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /v2/
            pathType: Prefix
            backend:
              service:
                name: api-v2-service
                port:
                  number: 8080
```

## Section 3: CORS Configuration

```yaml
# cors-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cors-enabled-service
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://app.example.com,https://admin.example.com"
    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, PATCH, OPTIONS"
    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization,Content-Type,Accept,Origin,X-Requested-With,X-API-Key,X-Request-ID"
    nginx.ingress.kubernetes.io/cors-expose-headers: "X-Request-ID,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset"
    nginx.ingress.kubernetes.io/cors-allow-credentials: "true"
    nginx.ingress.kubernetes.io/cors-max-age: "86400"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-secret
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

## Section 4: ModSecurity WAF Integration

### Enabling ModSecurity with OWASP Core Rule Set

ModSecurity v3 is bundled with ingress-nginx builds tagged with the `-chroot` suffix and standard builds v1.3+. The OWASP CRS (Core Rule Set) provides broad protection against OWASP Top 10 attacks.

```yaml
# modsecurity-configmap.yaml
# Add to ingress-nginx-controller ConfigMap
data:
  # Enable ModSecurity globally
  enable-modsecurity: "true"
  # Enable OWASP CRS
  enable-owasp-modsecurity-crs: "true"
  # Anomaly threshold — requests scoring above this are blocked
  # Default CRS threshold is 5 (paranoia level 1)
  modsecurity-snippet: |
    # Global ModSecurity configuration snippet
    # Tune anomaly scoring thresholds
    SecRuleUpdateActionById 949110 "t:none,deny,status:403,\
      logdata:'Inbound Anomaly Score Exceeded (Total Score: %{TX.ANOMALY_SCORE})'"
    SecRuleUpdateActionById 980130 "t:none,deny,status:403,\
      logdata:'Outbound Anomaly Score Exceeded (Total Score: %{TX.OUTBOUND_ANOMALY_SCORE})'"

    # Set inbound anomaly threshold to 10 (paranoia level 1 with buffer)
    SecAction \
      "id:900110,phase:1,nolog,pass,t:none,\
      setvar:tx.inbound_anomaly_score_threshold=10"

    # Set outbound anomaly threshold
    SecAction \
      "id:900120,phase:1,nolog,pass,t:none,\
      setvar:tx.outbound_anomaly_score_threshold=4"

    # Enable detection-only mode for initial tuning (comment out for blocking)
    # SecRuleEngine DetectionOnly
    SecRuleEngine On

    # Increase request body limit for file uploads
    SecRequestBodyLimit 52428800
    SecRequestBodyNoFilesLimit 1048576

    # Disable rules causing high false positive rates for specific apps
    # Rule 920300: Missing Accept header (common in API clients)
    SecRuleRemoveById 920300
    # Rule 920420: Request content type not allowed (relaxed for API consumers)
    # SecRuleRemoveById 920420
```

```yaml
# modsecurity-per-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: protected-api
  namespace: production
  annotations:
    # Enable WAF on this specific ingress
    nginx.ingress.kubernetes.io/enable-modsecurity: "true"
    nginx.ingress.kubernetes.io/enable-owasp-modsecurity-crs: "true"
    nginx.ingress.kubernetes.io/modsecurity-snippet: |
      # Per-service WAF tuning
      # Disable rule causing false positives on this endpoint
      SecRuleRemoveById 942100  # SQL injection via libinjection (disable if query params contain SQL-like strings)
      SecRuleRemoveById 942200  # Detects MySQL comment-/space-obfuscated injections

      # Add custom rule to block specific user agents
      SecRule REQUEST_HEADERS:User-Agent "@pmf /etc/nginx/modsec/blocked-agents.conf" \
        "id:10001,phase:1,deny,status:403,log,msg:'Blocked User Agent'"
spec:
  ingressClassName: nginx
  rules:
    - host: protected-api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: protected-api
                port:
                  number: 8080
```

## Section 5: Custom Error Pages

```yaml
# custom-error-pages-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-error-pages
  namespace: ingress-nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      app: custom-error-pages
  template:
    metadata:
      labels:
        app: custom-error-pages
    spec:
      containers:
        - name: error-pages
          image: nginx:1.25-alpine
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: error-pages
              mountPath: /usr/share/nginx/html/error-pages
          resources:
            requests:
              cpu: 50m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 64Mi
      volumes:
        - name: error-pages
          configMap:
            name: error-pages-content
---
apiVersion: v1
kind: Service
metadata:
  name: custom-error-pages
  namespace: ingress-nginx
spec:
  selector:
    app: custom-error-pages
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: error-pages-content
  namespace: ingress-nginx
data:
  404.html: |
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>404 - Resource Not Found</title></head>
    <body>
      <h1>404 - Resource Not Found</h1>
      <p>The requested resource could not be located.</p>
      <p>Request ID: $req_id</p>
    </body>
    </html>
  503.html: |
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>503 - Service Temporarily Unavailable</title></head>
    <body>
      <h1>Service Temporarily Unavailable</h1>
      <p>The service is temporarily unavailable. Please try again shortly.</p>
    </body>
    </html>
```

```yaml
# wire custom error pages into the global configmap
data:
  custom-http-errors: "404,500,502,503,504"
  # The default backend must point to the error pages service
```

```yaml
# global default backend for error pages
defaultBackend:
  enabled: true
  name: custom-error-pages
  service:
    port: 80
```

## Section 6: Lua Scripting for Dynamic Behavior

Ingress-nginx includes OpenResty's LuaJIT, enabling dynamic request manipulation without reloading nginx.

```yaml
# lua-snippet-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: lua-enhanced-service
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/server-snippet: |
      # Lua-based dynamic routing by request content
      location /api/v1/ {
        rewrite_by_lua_block {
          local uri = ngx.var.uri
          local args = ngx.req.get_uri_args()

          -- Route canary traffic based on cookie
          local cookie = ngx.var.cookie_canary_group
          if cookie == "beta" then
            ngx.var.proxy_upstream_name = "production-api-v2-canary-80"
          end
        }

        # Standard proxy pass
        proxy_pass http://upstream_balancer;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
      }

    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Add request timing header using Lua
      header_filter_by_lua_block {
        local latency = (ngx.now() - ngx.req.start_time()) * 1000
        ngx.header["X-Response-Time-Ms"] = string.format("%.2f", latency)
      }

      # Log custom fields using Lua
      log_by_lua_block {
        local latency = (ngx.now() - ngx.req.start_time()) * 1000
        if latency > 1000 then
          ngx.log(ngx.WARN, "slow_request uri=", ngx.var.uri,
                  " latency_ms=", string.format("%.2f", latency),
                  " upstream=", ngx.var.upstream_addr)
        end
      }
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
                  number: 8080
```

## Section 7: Canary Deployments

```yaml
# canary-ingress-stable.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-stable
  namespace: production
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-secret
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
                  number: 8080
---
# canary-ingress-v2.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-canary
  namespace: production
  annotations:
    # Mark this as the canary ingress
    nginx.ingress.kubernetes.io/canary: "true"

    # ── Canary Strategy 1: Weight-based (10% traffic to canary) ──────────
    nginx.ingress.kubernetes.io/canary-weight: "10"

    # ── Canary Strategy 2: Header-based (exact match) ────────────────────
    # nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
    # nginx.ingress.kubernetes.io/canary-by-header-value: "always"

    # ── Canary Strategy 3: Cookie-based ──────────────────────────────────
    # nginx.ingress.kubernetes.io/canary-by-cookie: "canary_session"

    # Combine weight + header: header always wins, weight applies to rest
    nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
    nginx.ingress.kubernetes.io/canary-by-header-value: "always"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-secret
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
                  number: 8080
```

## Section 8: SSL Termination and Certificate Management

### cert-manager Integration

```yaml
# cert-manager-cluster-issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-production-account-key
    solvers:
      - http01:
          ingress:
            class: nginx
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890ABC
        selector:
          dnsZones:
            - "example.com"
            - "*.example.com"
---
# tls-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tls-terminated-service
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
    # Force HTTPS redirect
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    # Enable HSTS at the ingress level (also set in global ConfigMap)
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "Strict-Transport-Security: max-age=63072000; includeSubDomains; preload";
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - service.example.com
      secretName: service-tls  # cert-manager creates this secret
  rules:
    - host: service.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: main-service
                port:
                  number: 8080
```

### mTLS for Service-to-Service Authentication

```yaml
# mtls-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mtls-protected-service
  namespace: production
  annotations:
    # Require client certificate verification
    nginx.ingress.kubernetes.io/auth-tls-verify-client: "on"
    # Secret containing CA certificate used to verify client certs
    nginx.ingress.kubernetes.io/auth-tls-secret: "production/client-ca-secret"
    nginx.ingress.kubernetes.io/auth-tls-verify-depth: "2"
    # Pass client certificate details to upstream for application-level verification
    nginx.ingress.kubernetes.io/auth-tls-pass-certificate-to-upstream: "true"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Forward client certificate subject to the backend
      proxy_set_header X-SSL-Client-CN $ssl_client_s_dn_cn;
      proxy_set_header X-SSL-Client-Verify $ssl_client_verify;
      proxy_set_header X-SSL-Client-Serial $ssl_client_serial;
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - internal-api.example.com
      secretName: internal-api-tls
  rules:
    - host: internal-api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: internal-api
                port:
                  number: 8080
```

## Section 9: Prometheus Metrics and Alerting

### ServiceMonitor and Alert Rules

```yaml
# nginx-ingress-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ingress-nginx-controller
  namespace: monitoring
  labels:
    release: prometheus-stack
spec:
  namespaceSelector:
    matchNames:
      - ingress-nginx
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
      app.kubernetes.io/component: controller
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      honorLabels: true
---
# nginx-ingress-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: nginx-ingress-alerts
  namespace: monitoring
  labels:
    release: prometheus-stack
spec:
  groups:
    - name: nginx-ingress.rules
      interval: 30s
      rules:
        # Alert when error rate exceeds 5% over 5 minutes
        - alert: NginxIngressHighErrorRate
          expr: |
            (
              sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) by (ingress, namespace)
              /
              sum(rate(nginx_ingress_controller_requests[5m])) by (ingress, namespace)
            ) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High 5xx error rate on ingress {{ $labels.ingress }}"
            description: "Ingress {{ $labels.ingress }} in namespace {{ $labels.namespace }} has a 5xx error rate of {{ $value | humanizePercentage }} over the last 5 minutes."
            runbook_url: "https://wiki.example.com/runbooks/nginx-high-error-rate"

        # Alert when P99 latency exceeds 2 seconds
        - alert: NginxIngressHighLatency
          expr: |
            histogram_quantile(0.99,
              sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le, ingress, namespace)
            ) > 2
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High P99 latency on ingress {{ $labels.ingress }}"
            description: "P99 latency is {{ $value | humanizeDuration }} for ingress {{ $labels.ingress }}"

        # Alert when ingress controller pod count drops
        - alert: NginxIngressControllerDown
          expr: kube_deployment_status_replicas_available{deployment="ingress-nginx-controller"} < 2
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "NGINX Ingress Controller has fewer than 2 available replicas"
            description: "Only {{ $value }} ingress controller replicas are available. Minimum required: 2."

        # Recording rule — pre-compute request rate per ingress
        - record: ingress:nginx_ingress_controller_requests:rate5m
          expr: |
            sum(rate(nginx_ingress_controller_requests[5m])) by (ingress, namespace, status)
```

## Section 10: Troubleshooting and Operational Procedures

### Validating Ingress Configuration

```bash
#!/bin/bash
# validate-ingress-config.sh
# Validate NGINX configuration without restarting the controller

NAMESPACE="ingress-nginx"
CONTROLLER_POD=$(kubectl get pods -n ${NAMESPACE} \
  -l app.kubernetes.io/component=controller \
  -o jsonpath='{.items[0].metadata.name}')

# Test NGINX configuration syntax
echo "=== Testing NGINX configuration syntax ==="
kubectl exec -n ${NAMESPACE} ${CONTROLLER_POD} -- \
  nginx -t -c /etc/nginx/nginx.conf

# Dump current effective configuration
echo "=== Dumping current nginx.conf ==="
kubectl exec -n ${NAMESPACE} ${CONTROLLER_POD} -- \
  cat /etc/nginx/nginx.conf | head -200

# List all upstream blocks
echo "=== Upstream servers ==="
kubectl exec -n ${NAMESPACE} ${CONTROLLER_POD} -- \
  nginx -T 2>/dev/null | grep -A5 "upstream "

# Check controller logs for configuration errors
echo "=== Recent controller errors ==="
kubectl logs -n ${NAMESPACE} ${CONTROLLER_POD} \
  --since=5m | grep -E "ERROR|WARN|error|failed"
```

### Checking Rate Limit Status

```bash
#!/bin/bash
# check-rate-limits.sh
# Monitor rate limit rejections in real time

NAMESPACE="ingress-nginx"

# Stream access logs filtering for 429 responses
kubectl logs -n ${NAMESPACE} \
  -l app.kubernetes.io/component=controller \
  --follow --timestamps \
  | grep '"status":429' \
  | jq -r '[.time, .remote_addr, .path, .status] | @tsv'
```

### Performance Benchmarking

```bash
#!/bin/bash
# benchmark-ingress.sh
# Basic ingress performance benchmark using wrk

TARGET_URL="https://api.example.com/health"
DURATION=60       # seconds
CONNECTIONS=100   # concurrent connections
THREADS=8         # worker threads

echo "Benchmarking ${TARGET_URL} for ${DURATION}s"
echo "Connections: ${CONNECTIONS}, Threads: ${THREADS}"
echo "======================================================="

wrk -t${THREADS} \
    -c${CONNECTIONS} \
    -d${DURATION}s \
    --latency \
    -H "Accept: application/json" \
    ${TARGET_URL}

# Expected output interpretation:
# Requests/sec: target > 10000 for a healthy 3-replica controller
# Latency P99: should be < 100ms for static backends
# Socket errors: should be 0 for a properly configured controller
```

## Section 11: Operational Runbook

### Controller Upgrade Procedure

```bash
#!/bin/bash
# upgrade-ingress-controller.sh
# Zero-downtime upgrade procedure for ingress-nginx

set -euo pipefail

NEW_VERSION="${1:-v1.10.1}"
NAMESPACE="ingress-nginx"
RELEASE_NAME="ingress-nginx"

echo "Upgrading ingress-nginx to ${NEW_VERSION}"

# 1. Verify current state
echo "--- Current deployment state ---"
kubectl get deployment -n ${NAMESPACE} ${RELEASE_NAME}-controller -o wide

# 2. Check PodDisruptionBudget is configured
echo "--- PodDisruptionBudget ---"
kubectl get pdb -n ${NAMESPACE}

# 3. Perform Helm upgrade with incremental rollout
helm upgrade ${RELEASE_NAME} ingress-nginx/ingress-nginx \
  --namespace ${NAMESPACE} \
  --reuse-values \
  --set controller.image.tag="${NEW_VERSION}" \
  --set controller.updateStrategy.rollingUpdate.maxSurge=1 \
  --set controller.updateStrategy.rollingUpdate.maxUnavailable=0 \
  --wait \
  --timeout=10m

# 4. Verify rollout completed
echo "--- Post-upgrade status ---"
kubectl rollout status deployment/${RELEASE_NAME}-controller -n ${NAMESPACE}
kubectl get pods -n ${NAMESPACE} -l app.kubernetes.io/component=controller

# 5. Smoke test key ingresses
echo "--- Smoke testing ingresses ---"
for INGRESS_HOST in api.example.com app.example.com; do
  HTTP_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" \
    "https://${INGRESS_HOST}/health")
  echo "  ${INGRESS_HOST}: HTTP ${HTTP_STATUS}"
done

echo "Upgrade complete."
```

## Summary

A production-ready NGINX Ingress Controller deployment requires configuration across multiple layers. The most impactful performance improvements come from upstream keepalive connections (avoiding TCP handshake overhead on every request), proper SSL session caching, and HTTP/2 multiplexing. Security posture is substantially improved by enabling ModSecurity with OWASP CRS, enforcing mTLS for internal services, and configuring granular rate limiting. Canary annotations enable progressive delivery without external tooling. Prometheus metrics and pre-built alerting rules ensure operational visibility into error rates, latency distributions, and availability.

Key configuration priorities in order of impact:
1. Upstream keepalive connections — eliminate per-request TCP overhead
2. SSL session cache — amortize TLS handshake cost across sessions
3. Rate limiting — protect upstream services from traffic spikes and abuse
4. ModSecurity WAF — layer-7 protection without application changes
5. Prometheus alerting — SLO-based observability for the ingress tier
