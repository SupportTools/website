---
title: "Kubernetes Ingress NGINX: Advanced Configuration and Tuning"
date: 2029-04-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NGINX", "Ingress", "Performance", "Security", "Load Balancing"]
categories: ["Kubernetes", "Networking", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced guide to Kubernetes Ingress NGINX: ConfigMap tuning for performance, server-snippet and configuration-snippet annotations, custom error pages, rate limiting with burst, geographic IP blocking, upstream hashing, and proxy buffer optimization for production traffic."
more_link: "yes"
url: "/kubernetes-ingress-nginx-advanced-tuning/"
---

The NGINX Ingress Controller is the most widely deployed ingress solution for Kubernetes, handling HTTP/HTTPS traffic for millions of production workloads. Its default configuration is conservative and suitable for low-traffic development environments. Production deployments serving thousands of requests per second require careful tuning of worker processes, connection limits, proxy buffering, keepalive, rate limiting, and upstream selection. This guide covers every major configuration surface with production-tested values.

<!--more-->

# Kubernetes Ingress NGINX: Advanced Configuration and Tuning

## Section 1: Architecture Overview

The Ingress NGINX controller consists of two primary components:

```
Kubernetes API Server
       |
       | Watch Ingress/Service/Endpoint objects
       v
NGINX Ingress Controller Pod
  ├─ Controller binary (Go)
  │   └─ Renders nginx.conf from Ingress objects + ConfigMap
  └─ NGINX (C)
      ├─ Worker processes (handle actual traffic)
      └─ Lua modules (rate limiting, auth, dynamic routing)
```

Configuration enters via two mechanisms:
1. **ConfigMap**: Global NGINX settings that apply to all Ingresses
2. **Annotations**: Per-Ingress overrides for specific routing behaviors

## Section 2: ConfigMap Global Tuning

The ConfigMap is the primary tuning surface for global NGINX behavior. It must be named according to the controller's `--configmap` flag (default: `ingress-nginx/ingress-nginx-controller`).

### Production ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # === Worker Processes ===
  # Default: auto (one per CPU core)
  # For high-traffic clusters: set to number of cores minus 1
  worker-processes: "auto"

  # Worker connections (max concurrent connections per worker)
  # Total capacity = worker-processes * worker-connections
  # Default: 16384 — increase for high-traffic
  max-worker-connections: "65536"

  # Worker CPU affinity (pin workers to CPUs to reduce context switching)
  worker-cpu-affinity: "auto"

  # === Keep-Alive ===
  # Client keepalive timeout (downstream: browser/client to NGINX)
  keep-alive: "75"

  # Client keepalive request count before connection close
  keep-alive-requests: "10000"

  # Upstream keepalive connections (NGINX to backend pod)
  # Default: 320 — critical for performance; eliminates TCP handshake overhead
  upstream-keepalive-connections: "320"

  # Upstream keepalive timeout
  upstream-keepalive-timeout: "60"

  # Upstream keepalive requests per connection before renewal
  upstream-keepalive-requests: "10000"

  # === Proxy Settings ===
  # Proxy connection timeout to upstream
  proxy-connect-timeout: "10"

  # Proxy send/read timeout
  proxy-send-timeout: "60"
  proxy-read-timeout: "60"

  # Enable HTTP/2 (requires HTTPS)
  use-http2: "true"

  # === Proxy Buffering ===
  # Buffering prevents upstream from waiting for slow clients
  proxy-buffering: "on"

  # Buffer size for response headers
  proxy-buffer-size: "16k"

  # Number and size of proxy buffers for response body
  proxy-buffers-number: "8"
  proxy-buffers-size: "16k"

  # Busy buffers size (maximum data sent while response not fully read)
  proxy-busy-buffers-size: "32k"

  # Temp file size (0 = disable temp files, keep in memory)
  # Set to 0 for low-latency, large value for large responses
  proxy-temp-path: "/tmp/nginx"

  # === Gzip Compression ===
  use-gzip: "true"
  gzip-level: "5"
  gzip-min-length: "1024"
  gzip-types: "application/atom+xml application/javascript application/x-javascript application/json application/rss+xml application/vnd.ms-fontobject application/x-font-ttf application/x-web-app-manifest+json application/xhtml+xml application/xml font/opentype image/svg+xml image/x-icon text/css text/plain text/x-component"

  # === TLS Settings ===
  # TLS protocols (disable TLS 1.0 and 1.1)
  ssl-protocols: "TLSv1.2 TLSv1.3"

  # TLS ciphers (Mozilla Intermediate compatibility)
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"

  # HSTS header
  hsts: "true"
  hsts-max-age: "15724800"
  hsts-include-subdomains: "false"
  hsts-preload: "false"

  # SSL session cache
  ssl-session-cache: "true"
  ssl-session-cache-size: "10m"
  ssl-session-timeout: "10m"

  # OCSP stapling
  enable-ocsp: "true"

  # === Headers ===
  # Add X-Request-ID for tracing
  generate-request-id: "true"
  proxy-add-original-uri-header: "true"

  # Remove server header (security)
  server-tokens: "false"

  # Custom server name (or blank to remove)
  server-name-hash-bucket-size: "256"

  # === Logging ===
  # Access log format (with request ID for correlation)
  log-format-upstream: '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" $request_length $request_time [$proxy_upstream_name] [$proxy_alternative_upstream_name] $upstream_addr $upstream_response_length $upstream_response_time $upstream_status $req_id'

  # Disable access logs for health checks (reduce noise)
  disable-access-log: "false"

  # Log level (debug/info/notice/warn/error/crit/alert/emerg)
  error-log-level: "warn"

  # === Rate Limiting Globals ===
  # Limit req zone size (shared memory for rate limit state)
  limit-req-status-code: "429"

  # === Real IP ===
  # Trust load balancer IPs for X-Forwarded-For
  use-forwarded-headers: "true"
  forwarded-for-header: "X-Forwarded-For"
  compute-full-forwarded-for: "true"

  # Trusted load balancer CIDRs (AWS ELB, GCP LB, etc.)
  proxy-real-ip-cidr: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

  # === Connection Limiting ===
  # Max body size (increase for file upload endpoints)
  proxy-body-size: "8m"

  # === Lua Settings (for advanced features) ===
  lua-shared-dicts: "configuration_data:20m,certificate_data:10m,balancer_ewma:10m,balancer_ewma_last_touched_at:10m,balancer_ewma_locks:1m"
```

### Applying the ConfigMap

```bash
# Apply via kubectl
kubectl apply -f ingress-nginx-configmap.yaml

# Verify it was applied
kubectl get configmap ingress-nginx-controller -n ingress-nginx -o yaml

# The controller picks up changes automatically (no restart needed)
# Watch for reload events
kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx --follow \
  | grep -i "reload\|config"
```

## Section 3: Per-Ingress Annotations

Annotations override global settings for specific Ingress resources.

### Complete Annotated Ingress Example

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-server
  namespace: production
  annotations:
    # === Ingress Class ===
    kubernetes.io/ingress.class: "nginx"  # or use spec.ingressClassName

    # === SSL/TLS ===
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"

    # === Proxy Timeouts (per-service override) ===
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "5"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"

    # === Proxy Buffer (disable for streaming APIs) ===
    nginx.ingress.kubernetes.io/proxy-buffering: "off"  # For SSE/WebSocket
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"

    # === Body Size ===
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"  # File upload endpoint

    # === Rate Limiting ===
    # Global rate limit: 100 requests per second across all clients
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-rpm: "6000"
    # Per-connection rate limit (requests per second per IP)
    nginx.ingress.kubernetes.io/limit-connections: "20"
    # Burst allowance (requests allowed in excess before throttling)
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "3"

    # === CORS ===
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://app.example.com,https://admin.example.com"
    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"
    nginx.ingress.kubernetes.io/cors-allow-headers: "DNT,X-CustomHeader,X-Request-ID,Authorization,Content-Type,Accept"
    nginx.ingress.kubernetes.io/cors-allow-credentials: "true"
    nginx.ingress.kubernetes.io/cors-max-age: "86400"

    # === Upstream Selection ===
    # Use consistent hashing (sticky sessions without cookies)
    nginx.ingress.kubernetes.io/upstream-hash-by: "$remote_addr"
    # Or hash by cookie value (more stable across IP changes)
    nginx.ingress.kubernetes.io/upstream-hash-by: "$cookie_session_id"

    # Load balancing algorithm
    nginx.ingress.kubernetes.io/load-balance: "ewma"  # Least-latency

    # === WebSocket Support ===
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"

    # === Auth ===
    nginx.ingress.kubernetes.io/auth-url: "https://auth.example.com/verify"
    nginx.ingress.kubernetes.io/auth-method: "GET"
    nginx.ingress.kubernetes.io/auth-response-headers: "X-Auth-User, X-Auth-Roles"
    nginx.ingress.kubernetes.io/auth-signin: "https://auth.example.com/login"

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
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-server
            port:
              number: 8080
```

## Section 4: Server Snippets and Configuration Snippets

Snippets allow raw NGINX configuration to be injected into the generated config.

### server-snippet: Injected Inside server{} Block

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-with-custom-nginx
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/server-snippet: |
      # Block specific User-Agents (scrapers, scanners)
      if ($http_user_agent ~* "(masscan|nikto|sqlmap|nmap|zgrab|curl|python-requests)") {
          return 403;
      }

      # Require specific header for API access (simple API gateway pattern)
      if ($http_x_api_version !~ "^v[0-9]+$") {
          return 400 "Missing or invalid X-API-Version header";
      }

      # Rate limit for specific paths
      location /api/export {
          limit_req zone=export_zone burst=2 nodelay;
          proxy_pass http://upstream;
      }

      # Custom logging for specific paths
      location /api/admin {
          access_log /var/log/nginx/admin_access.log combined;
          proxy_pass http://upstream;
      }
spec:
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-server
            port:
              number: 8080
```

### configuration-snippet: Injected Inside location{} Block

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: secure-api
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Add security headers for all responses
      add_header X-Frame-Options "SAMEORIGIN" always;
      add_header X-Content-Type-Options "nosniff" always;
      add_header X-XSS-Protection "1; mode=block" always;
      add_header Referrer-Policy "strict-origin-when-cross-origin" always;
      add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

      # Content Security Policy
      add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';" always;

      # Cache control for API responses
      add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate" always;
      add_header Pragma "no-cache" always;
      add_header Expires "0" always;

      # Pass backend service name to upstream for logging
      proxy_set_header X-Service-Name $service_name;
      proxy_set_header X-Namespace $namespace;
```

### Global Server Snippet via ConfigMap

```yaml
# ConfigMap server-snippet applies to ALL virtual hosts
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  server-snippet: |
    # Block HTTPS traffic to /server-status globally
    location /server-status {
        return 404;
    }

    # Global block for common scanner paths
    location ~* "/(\.git|\.env|\.htaccess|wp-admin|phpmyadmin)" {
        return 404;
    }
```

## Section 5: Rate Limiting

NGINX Ingress supports two rate limiting mechanisms: per-IP limits (leaky bucket) and connection limits.

### Rate Limiting Zones

```yaml
# ConfigMap: define shared memory zones for rate limiting
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Custom rate limit zones (use with server-snippet in specific Ingresses)
  http-snippet: |
    # Zone for aggressive client protection (10MB = ~160k IPs)
    limit_req_zone $binary_remote_addr zone=per_ip_standard:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=per_ip_strict:10m rate=2r/s;
    limit_req_zone $binary_remote_addr zone=export_zone:1m rate=1r/m;

    # Zone by API key (for authenticated rate limiting)
    map $http_x_api_key $api_key_zone_key {
        default $binary_remote_addr;  # Unauthenticated: rate limit by IP
        ~.+     $http_x_api_key;       # Authenticated: rate limit by API key
    }
    limit_req_zone $api_key_zone_key zone=per_apikey:10m rate=100r/s;
```

### Per-Ingress Rate Limiting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: public-api
  namespace: production
  annotations:
    # Simple rate limiting via annotations (creates automatic zone)
    nginx.ingress.kubernetes.io/limit-rps: "50"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"  # Allow burst up to 250rps
    nginx.ingress.kubernetes.io/limit-connections: "10"       # Max 10 concurrent per IP

    # Whitelist internal IPs from rate limiting
    nginx.ingress.kubernetes.io/limit-whitelist: "10.0.0.0/8,172.16.0.0/12"
```

### Advanced Rate Limiting with server-snippet

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-tiered-ratelimit
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/server-snippet: |
      # Tiered rate limiting based on path
      location /api/v1/search {
          limit_req zone=per_ip_strict burst=10 nodelay;
          limit_req_status 429;
          proxy_pass http://api_upstream;
      }

      location /api/v1/bulk {
          limit_req zone=export_zone burst=1 nodelay;
          limit_req_status 429;
          proxy_pass http://api_upstream;
      }

      location /api/v1/webhook {
          # No rate limit for webhooks (authenticated separately)
          proxy_pass http://api_upstream;
      }
```

## Section 6: Custom Error Pages

```yaml
# Deploy a custom error page service
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
        image: nginxinc/nginx-unprivileged:alpine
        ports:
        - containerPort: 8080
        volumeMounts:
        - name: error-pages
          mountPath: /usr/share/nginx/html
      volumes:
      - name: error-pages
        configMap:
          name: custom-error-pages
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
  name: custom-error-pages
  namespace: ingress-nginx
data:
  404.html: |
    <!DOCTYPE html>
    <html>
    <head><title>404 Not Found - Example Service</title></head>
    <body>
      <h1>404 - Page Not Found</h1>
      <p>The requested resource could not be found.</p>
      <p><a href="https://status.example.com">Check service status</a></p>
    </body>
    </html>
  503.html: |
    <!DOCTYPE html>
    <html>
    <head>
      <title>Service Unavailable</title>
      <meta http-equiv="refresh" content="30">
    </head>
    <body>
      <h1>Service Temporarily Unavailable</h1>
      <p>We are experiencing technical difficulties. Please try again in a moment.</p>
      <p><a href="https://status.example.com">Check service status</a></p>
    </body>
    </html>
```

```yaml
# ConfigMap: enable custom error pages for all Ingresses
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Custom error pages (points to the error-pages service)
  custom-http-errors: "404,503,502,500"

  # In Ingress controller Helm values:
  # controller.extraArgs.default-backend=ingress-nginx/custom-error-pages:80
```

```yaml
# Per-Ingress custom error page override
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-with-custom-errors
  annotations:
    nginx.ingress.kubernetes.io/custom-http-errors: "404,503"
    nginx.ingress.kubernetes.io/default-backend: custom-error-pages
```

## Section 7: Geographic IP Blocking

NGINX's GeoIP2 module enables geographic-based access control:

```yaml
# Enable GeoIP2 in Helm values
controller:
  extraVolumes:
  - name: geoip2-db
    emptyDir: {}
  extraInitContainers:
  - name: download-geoip2
    image: maxmindinc/geoipupdate:latest
    env:
    - name: GEOIPUPDATE_ACCOUNT_ID
      valueFrom:
        secretKeyRef:
          name: geoip-credentials
          key: account-id
    - name: GEOIPUPDATE_LICENSE_KEY
      valueFrom:
        secretKeyRef:
          name: geoip-credentials
          key: license-key
    - name: GEOIPUPDATE_EDITION_IDS
      value: "GeoLite2-Country GeoLite2-City"
    - name: GEOIPUPDATE_DB_DIR
      value: "/geoip2-db"
    volumeMounts:
    - name: geoip2-db
      mountPath: /geoip2-db
  extraVolumeMounts:
  - name: geoip2-db
    mountPath: /etc/nginx/geoip2-db
```

```yaml
# ConfigMap: configure GeoIP2 blocking
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Load GeoIP2 databases
  http-snippet: |
    geoip2 /etc/nginx/geoip2-db/GeoLite2-Country.mmdb {
        $geoip2_country_code country iso_code;
    }

    # Block list of country codes
    map $geoip2_country_code $blocked_country {
        default     0;
        CN          1;  # China
        RU          1;  # Russia
        KP          1;  # North Korea
        IR          1;  # Iran
    }
```

```yaml
# Per-Ingress geographic blocking
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: us-only-service
  annotations:
    nginx.ingress.kubernetes.io/server-snippet: |
      # Allow only US traffic
      if ($geoip2_country_code != "US") {
          return 403 "Access restricted to US only.";
      }
```

## Section 8: Upstream Hashing and Session Affinity

### Cookie-Based Session Affinity

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: stateful-app
  annotations:
    # Enable session affinity (sticky sessions)
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/affinity-mode: "persistent"  # or "balanced"

    # Cookie configuration
    nginx.ingress.kubernetes.io/session-cookie-name: "INGRESSCOOKIE"
    nginx.ingress.kubernetes.io/session-cookie-expires: "172800"  # 2 days
    nginx.ingress.kubernetes.io/session-cookie-max-age: "172800"
    nginx.ingress.kubernetes.io/session-cookie-path: "/"
    nginx.ingress.kubernetes.io/session-cookie-secure: "true"
    nginx.ingress.kubernetes.io/session-cookie-samesite: "Strict"
    nginx.ingress.kubernetes.io/session-cookie-conditional-samesite-none: "true"
```

### Consistent Hash-Based Routing

```yaml
# Hash by client IP for stateless apps with warm caches
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cache-aware-service
  annotations:
    # Route same client to same backend (cache warmth)
    nginx.ingress.kubernetes.io/upstream-hash-by: "$binary_remote_addr"

    # Or hash by a header value (for API gateway with client IDs)
    nginx.ingress.kubernetes.io/upstream-hash-by: "$http_x_client_id"

    # Subset: only some backends in the consistent hash ring
    nginx.ingress.kubernetes.io/upstream-hash-by-subset: "true"
    nginx.ingress.kubernetes.io/upstream-hash-by-subset-size: "3"
```

### Load Balancing Algorithms

```yaml
# Available algorithms:
# round_robin (default): distribute evenly
# ewma: Exponentially Weighted Moving Average — routes to lowest latency backend
# ip_hash: deprecated, use upstream-hash-by instead
# least_conn: route to backend with fewest active connections

nginx.ingress.kubernetes.io/load-balance: "ewma"
```

## Section 9: Proxy Buffering Optimization

### Buffering for Different Use Cases

```yaml
# === Standard API (enable buffering for throughput) ===
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rest-api
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffering: "on"
    nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "8"
---
# === Streaming / Server-Sent Events (disable buffering) ===
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: streaming-api
  annotations:
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
---
# === WebSocket ===
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: websocket-service
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    # WebSocket upgrade headers (automatically handled by nginx-ingress >= 0.21)
    nginx.ingress.kubernetes.io/websocket-services: "websocket-svc"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
---
# === Large file upload ===
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: upload-service
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "5000m"
    nginx.ingress.kubernetes.io/proxy-request-buffering: "off"  # Stream directly to backend
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/client-body-buffer-size: "128k"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
```

## Section 10: Monitoring and Performance Metrics

### Prometheus ServiceMonitor

```yaml
# Prometheus ServiceMonitor for NGINX Ingress metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ingress-nginx
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
    - ingress-nginx
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
  endpoints:
  - port: metrics
    path: /metrics
    interval: 30s
    relabelings:
    - sourceLabels: [__address__]
      targetLabel: instance
```

### Key Prometheus Queries

```promql
# Request rate by ingress
sum(rate(nginx_ingress_controller_requests[5m])) by (ingress, namespace, service, status)

# Error rate (5xx responses)
sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) by (ingress)
/
sum(rate(nginx_ingress_controller_requests[5m])) by (ingress)

# P99 request latency
histogram_quantile(0.99,
  sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le, ingress)
)

# Upstream response time P99
histogram_quantile(0.99,
  sum(rate(nginx_ingress_controller_response_duration_seconds_bucket[5m])) by (le, service)
)

# Active connections per controller
nginx_ingress_controller_nginx_process_connections{state="active"}

# Config reload failures
nginx_ingress_controller_config_last_reload_successful == 0

# Bytes sent/received
rate(nginx_ingress_controller_bytes_sent_total[5m])
rate(nginx_ingress_controller_bytes_received_total[5m])
```

### Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ingress-nginx-alerts
  namespace: monitoring
spec:
  groups:
  - name: ingress-nginx.rules
    rules:
    - alert: IngressNginxHighErrorRate
      expr: |
        (
          sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) by (ingress, namespace)
          /
          sum(rate(nginx_ingress_controller_requests[5m])) by (ingress, namespace)
        ) > 0.05
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "High error rate on ingress {{ $labels.ingress }}"
        description: "{{ $value | humanizePercentage }} of requests are returning 5xx"

    - alert: IngressNginxHighLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])) by (le, ingress)
        ) > 2
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High P99 latency on ingress {{ $labels.ingress }}"
        description: "P99 latency is {{ $value }}s"

    - alert: IngressNginxConfigReloadFailed
      expr: nginx_ingress_controller_config_last_reload_successful == 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "NGINX config reload failed"
        description: "The NGINX Ingress Controller failed to apply a configuration change"
```

## Section 11: Helm Chart Configuration Reference

```yaml
# values.yaml for ingress-nginx Helm chart (production)
controller:
  # Replica count (use HPA in production)
  replicaCount: 2

  # Use DaemonSet for node-per-controller deployments
  kind: Deployment

  # Resources
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2
      memory: 2Gi

  # Pod anti-affinity
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app.kubernetes.io/name: ingress-nginx
        topologyKey: kubernetes.io/hostname

  # PodDisruptionBudget
  podAnnotations:
    {}
  podDisruptionBudget:
    enabled: true
    minAvailable: 1

  # Metrics endpoint
  metrics:
    enabled: true
    service:
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "10254"

  # Extra args
  extraArgs:
    enable-ssl-passthrough: "false"
    default-ssl-certificate: "ingress-nginx/wildcard-tls"
    annotations-prefix: "nginx.ingress.kubernetes.io"

  # Node selector (pin to dedicated ingress nodes)
  nodeSelector:
    node-role: ingress

  # Tolerations for ingress nodes
  tolerations:
  - key: "node-role"
    operator: "Equal"
    value: "ingress"
    effect: "NoSchedule"

  # HPA
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilizationPercentage: 60
    targetMemoryUtilizationPercentage: 70

  # Admission webhooks (validate Ingress before apply)
  admissionWebhooks:
    enabled: true
    failurePolicy: Fail

  # Enable real IP processing
  config:
    use-proxy-protocol: "false"  # Set true if behind AWS NLB with proxy protocol
    use-forwarded-headers: "true"
    compute-full-forwarded-for: "true"
    proxy-real-ip-cidr: "10.0.0.0/8,172.16.0.0/12"

  # Service type
  service:
    type: LoadBalancer
    annotations:
      # AWS NLB
      service.beta.kubernetes.io/aws-load-balancer-type: "external"
      service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "instance"
      service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
      service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout: "120"
    externalTrafficPolicy: Local  # Preserve client IP
```

## Conclusion

The NGINX Ingress Controller's configuration surface is extensive, enabling precise tuning of every aspect of HTTP proxy behavior. The three-layer configuration model — global ConfigMap, per-Ingress annotations, and server/configuration snippets — provides flexibility to apply global defaults while allowing workload-specific overrides.

For production deployments, the highest-impact tuning items are: increase `upstream-keepalive-connections` to eliminate TCP handshake overhead to backends, configure appropriate rate limiting per Ingress to prevent abuse, disable proxy buffering for streaming and WebSocket endpoints, tune `proxy-read-timeout` to match application SLAs, and monitor P99 latency per ingress with Prometheus alerts to catch regressions early.
