---
title: "NGINX Ingress Controller Advanced Configuration: Rate Limiting, Auth, and Custom Snippets"
date: 2027-06-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NGINX", "Ingress", "Rate Limiting", "Security"]
categories:
- Kubernetes
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth enterprise guide to NGINX Ingress Controller configuration: rate limiting, external authentication with OAuth2 Proxy, custom snippets, ModSecurity WAF integration, upstream tuning, and production monitoring."
more_link: "yes"
url: "/kubernetes-ingress-nginx-advanced-configuration-guide/"
---

The NGINX Ingress Controller is the most widely deployed Kubernetes ingress solution, handling HTTP/HTTPS traffic routing, SSL termination, and request manipulation for millions of production clusters. Its default configuration serves most use cases, but production environments demand fine-grained control: rate limiting to prevent abuse, external authentication delegation, custom header manipulation, WAF integration, and upstream connection pool tuning. This guide covers advanced configuration patterns from the ConfigMap global layer through per-Ingress annotation overrides, with tested examples for each feature area.

<!--more-->

## Section 1: Architecture and Configuration Layers

The NGINX Ingress Controller operates with a two-tier configuration model:

1. **ConfigMap (global)**: Settings in the controller's ConfigMap apply to the entire NGINX configuration and all Ingress resources.
2. **Ingress annotations**: Per-Ingress annotations override or augment specific behaviors for individual routes.

Understanding which settings belong at which layer prevents configuration conflicts and simplifies troubleshooting.

### Controller Deployment with Helm

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.replicaCount=3 \
  --set controller.metrics.enabled=true \
  --set controller.metrics.serviceMonitor.enabled=true \
  --set controller.podAnnotations."prometheus\.io/scrape"=true \
  --set controller.podAnnotations."prometheus\.io/port"=10254 \
  --set controller.config.use-forwarded-headers=true \
  --set controller.config.compute-full-forwarded-for=true \
  --set controller.config.use-proxy-protocol=false
```

### Verify Controller Version and Configuration

```bash
# Check controller version
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  /nginx-ingress-controller --version

# View current ConfigMap
kubectl get configmap ingress-nginx-controller -n ingress-nginx -o yaml

# View generated NGINX config
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  cat /etc/nginx/nginx.conf | head -100
```

## Section 2: ConfigMap Global Settings

The ConfigMap `ingress-nginx-controller` in the `ingress-nginx` namespace controls NGINX global directives.

### Recommended Production ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Worker processes and connections
  worker-processes: "auto"
  max-worker-connections: "65536"
  worker-cpu-affinity: "auto"

  # Keep-alive tuning
  upstream-keepalive-connections: "320"
  upstream-keepalive-requests: "10000"
  upstream-keepalive-time: "1h"
  upstream-keepalive-timeout: "60"
  keep-alive: "75"
  keep-alive-requests: "10000"

  # Buffer sizes
  proxy-buffer-size: "16k"
  proxy-buffers-number: "8"
  proxy-busy-buffers-size: "32k"
  large-client-header-buffers: "4 16k"
  client-header-buffer-size: "16k"
  client-body-buffer-size: "1m"

  # Timeouts
  proxy-connect-timeout: "10"
  proxy-send-timeout: "60"
  proxy-read-timeout: "60"
  proxy-next-upstream: "error timeout"
  proxy-next-upstream-timeout: "0"
  proxy-next-upstream-tries: "3"

  # Compression
  use-gzip: "true"
  gzip-level: "5"
  gzip-types: "application/json application/javascript application/xml text/css text/plain text/xml"

  # SSL settings
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384"
  ssl-session-cache: "shared:SSL:50m"
  ssl-session-timeout: "1d"
  ssl-session-tickets: "off"
  ssl-reject-handshake: "false"

  # HSTS
  hsts: "true"
  hsts-max-age: "31536000"
  hsts-include-subdomains: "true"
  hsts-preload: "true"

  # Headers
  hide-headers: "Server,X-Powered-By"
  server-tokens: "false"
  add-headers: "ingress-nginx/custom-headers"

  # Logging
  log-format-upstream: '{"time":"$time_iso8601","remote_addr":"$proxy_protocol_addr","x_forwarded_for":"$proxy_add_x_forwarded_for","request_id":"$req_id","remote_user":"$remote_user","bytes_sent":$bytes_sent,"request_time":$request_time,"status":$status,"vhost":"$host","request_proto":"$server_protocol","path":"$uri","request_query":"$args","request_length":$request_length,"duration":$request_time,"method":"$request_method","http_referrer":"$http_referer","http_user_agent":"$http_user_agent"}'
  access-log-path: "/var/log/nginx/access.log"
  error-log-path: "/var/log/nginx/error.log"

  # Miscellaneous
  use-forwarded-headers: "true"
  compute-full-forwarded-for: "true"
  forwarded-for-header: "X-Forwarded-For"
  proxy-real-ip-cidr: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
  enable-real-ip: "true"
  allow-snippet-annotations: "true"
  annotations-risk-level: "Critical"
```

### Custom Headers ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: custom-headers
  namespace: ingress-nginx
data:
  X-Content-Type-Options: "nosniff"
  X-Frame-Options: "SAMEORIGIN"
  X-XSS-Protection: "1; mode=block"
  Referrer-Policy: "strict-origin-when-cross-origin"
  Permissions-Policy: "geolocation=(), microphone=(), camera=()"
```

### Reload NGINX After ConfigMap Changes

ConfigMap changes are picked up automatically within the sync period (default 60s). Force immediate reload:

```bash
kubectl rollout restart deployment/ingress-nginx-controller -n ingress-nginx
kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx
```

## Section 3: Rate Limiting

NGINX Ingress implements rate limiting via the `nginx.ingress.kubernetes.io/limit-*` annotations, which map to NGINX's `limit_req_zone` and `limit_req` directives.

### Basic Rate Limiting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/limit-connections: "20"
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-rpm: "500"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"
    nginx.ingress.kubernetes.io/limit-rate: "0"
    nginx.ingress.kubernetes.io/limit-rate-after: "0"
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
            name: api-service
            port:
              number: 8080
```

### Advanced Rate Limiting with Custom Snippets

For more sophisticated rate limiting (per-endpoint, shared zones across upstreams):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress-advanced
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/server-snippet: |
      limit_req_zone $binary_remote_addr zone=api_per_ip:10m rate=30r/s;
      limit_req_zone $http_authorization zone=api_per_token:10m rate=100r/s;
    nginx.ingress.kubernetes.io/configuration-snippet: |
      limit_req zone=api_per_ip burst=50 nodelay;
      limit_req zone=api_per_token burst=200 nodelay;
      limit_req_status 429;
      add_header Retry-After 1 always;
      add_header X-RateLimit-Limit 30 always;
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

### Whitelisting IPs from Rate Limiting

```yaml
annotations:
  nginx.ingress.kubernetes.io/whitelist-source-range: "10.0.0.0/8,172.16.0.0/12"
  nginx.ingress.kubernetes.io/limit-rps: "50"
  nginx.ingress.kubernetes.io/configuration-snippet: |
    limit_req_status 429;
    add_header X-RateLimit-Remaining $limit_req_status always;
```

### Configuring Rate Limit Response Body

```yaml
# In ConfigMap
data:
  limit-req-status-code: "429"
  custom-http-errors: "429"

# Custom error page via ConfigMap
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-errors
  namespace: ingress-nginx
data:
  "429": |
    HTTP/1.1 429 Too Many Requests
    Content-Type: application/json
    {"error": "rate_limit_exceeded", "message": "Too many requests. Please retry after 1 second.", "retry_after": 1}
```

## Section 4: External Authentication with OAuth2 Proxy

OAuth2 Proxy provides authentication delegation for Ingress resources. The NGINX Ingress controller uses the `auth-url` and `auth-signin` annotations to forward authentication to an external service.

### Deploy OAuth2 Proxy

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oauth2-proxy
  namespace: auth
spec:
  replicas: 2
  selector:
    matchLabels:
      app: oauth2-proxy
  template:
    metadata:
      labels:
        app: oauth2-proxy
    spec:
      containers:
      - name: oauth2-proxy
        image: quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
        args:
        - --provider=oidc
        - --oidc-issuer-url=https://sso.company.com/realms/main
        - --client-id=kubernetes-ingress
        - --redirect-url=https://auth.example.com/oauth2/callback
        - --email-domain=company.com
        - --upstream=file:///dev/null
        - --cookie-secure=true
        - --cookie-samesite=lax
        - --cookie-refresh=1h
        - --cookie-expire=24h
        - --session-store-type=redis
        - --redis-connection-url=redis://redis.auth.svc.cluster.local:6379
        - --set-xauthrequest=true
        - --pass-access-token=true
        - --pass-user-headers=true
        - --skip-provider-button=true
        - --http-address=0.0.0.0:4180
        env:
        - name: OAUTH2_PROXY_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: oauth2-proxy-secret
              key: client-secret
        - name: OAUTH2_PROXY_COOKIE_SECRET
          valueFrom:
            secretKeyRef:
              name: oauth2-proxy-secret
              key: cookie-secret
        ports:
        - containerPort: 4180
        readinessProbe:
          httpGet:
            path: /ping
            port: 4180
          initialDelaySeconds: 5
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: oauth2-proxy
  namespace: auth
spec:
  selector:
    app: oauth2-proxy
  ports:
  - port: 4180
    targetPort: 4180
```

### Ingress with OAuth2 Authentication

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: protected-app
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/auth-url: "https://auth.example.com/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://auth.example.com/oauth2/start?rd=$escaped_request_uri"
    nginx.ingress.kubernetes.io/auth-response-headers: "X-Auth-Request-User, X-Auth-Request-Email, X-Auth-Request-Access-Token"
    nginx.ingress.kubernetes.io/auth-snippet: |
      proxy_set_header X-Original-URI $request_uri;
      proxy_set_header X-Original-Method $request_method;
    nginx.ingress.kubernetes.io/configuration-snippet: |
      auth_request_set $auth_user $upstream_http_x_auth_request_user;
      auth_request_set $auth_email $upstream_http_x_auth_request_email;
      proxy_set_header X-Authenticated-User $auth_user;
      proxy_set_header X-Authenticated-Email $auth_email;
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - app.example.com
    secretName: app-tls-secret
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: protected-app-service
            port:
              number: 8080
```

### Allowing Specific Paths to Bypass Authentication

```yaml
annotations:
  nginx.ingress.kubernetes.io/auth-url: "https://auth.example.com/oauth2/auth"
  nginx.ingress.kubernetes.io/auth-signin: "https://auth.example.com/oauth2/start?rd=$escaped_request_uri"
  nginx.ingress.kubernetes.io/configuration-snippet: |
    # Skip auth for health check and webhook paths
    if ($uri ~* "^/(health|metrics|webhook)") {
      return 200;
    }
```

Alternatively, create a separate Ingress resource for public paths without the auth annotations.

## Section 5: Custom Headers and URL Rewrites

### Upstream Request Header Manipulation

```yaml
annotations:
  nginx.ingress.kubernetes.io/configuration-snippet: |
    proxy_set_header X-Request-ID $req_id;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Cluster-Client-IP $http_x_forwarded_for;
    # Remove sensitive upstream headers
    proxy_hide_header X-Internal-Token;
    proxy_hide_header X-Backend-Server;
    # Add correlation ID
    more_set_headers "X-Correlation-ID: $req_id";
```

### Response Header Manipulation

```yaml
annotations:
  nginx.ingress.kubernetes.io/configuration-snippet: |
    more_set_headers "X-Content-Type-Options: nosniff";
    more_set_headers "X-Frame-Options: DENY";
    more_clear_headers "X-Powered-By";
    more_clear_headers "Server";
```

### URL Rewriting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-rewrite
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /api/$2
    nginx.ingress.kubernetes.io/use-regex: "true"
spec:
  ingressClassName: nginx
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /v1(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: api-v1-service
            port:
              number: 8080
      - path: /v2(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: api-v2-service
            port:
              number: 8080
```

### Redirect Rules

```yaml
annotations:
  # Permanent redirect for a path
  nginx.ingress.kubernetes.io/permanent-redirect: "https://new.example.com$request_uri"
  nginx.ingress.kubernetes.io/permanent-redirect-code: "301"

  # Temporary redirect
  nginx.ingress.kubernetes.io/temporal-redirect: "https://maintenance.example.com"

  # Force SSL redirect
  nginx.ingress.kubernetes.io/ssl-redirect: "true"
  nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
```

## Section 6: Upstream Connection Management

### Upstream Hashing for Session Affinity

```yaml
annotations:
  # Cookie-based affinity (default)
  nginx.ingress.kubernetes.io/affinity: "cookie"
  nginx.ingress.kubernetes.io/affinity-mode: "persistent"
  nginx.ingress.kubernetes.io/session-cookie-name: "INGRESSSESSION"
  nginx.ingress.kubernetes.io/session-cookie-max-age: "172800"
  nginx.ingress.kubernetes.io/session-cookie-samesite: "Lax"
  nginx.ingress.kubernetes.io/session-cookie-conditional-samesite-none: "false"
  nginx.ingress.kubernetes.io/session-cookie-secure: "true"
  nginx.ingress.kubernetes.io/session-cookie-path: "/"

  # IP hash-based affinity
  nginx.ingress.kubernetes.io/upstream-hash-by: "$binary_remote_addr"

  # Header-based routing
  nginx.ingress.kubernetes.io/upstream-hash-by: "$http_x_user_id"
```

### Upstream Health Checks

```yaml
annotations:
  nginx.ingress.kubernetes.io/healthcheck-path: "/health"
  nginx.ingress.kubernetes.io/healthcheck-interval: "5"
  nginx.ingress.kubernetes.io/healthcheck-timeout: "3"
  nginx.ingress.kubernetes.io/healthcheck-status-codes: "200-399"
  nginx.ingress.kubernetes.io/healthcheck-interval: "5"
```

For active health checks (requires NGINX Plus or the nginx-plus controller variant):

```yaml
annotations:
  nginx.ingress.kubernetes.io/server-snippet: |
    health_check interval=5s fails=3 passes=2 uri=/health match=health_response;
    match health_response {
      status 200-399;
      body ~ "\"status\":\"ok\"";
    }
```

### Upstream Keepalive Configuration

```yaml
annotations:
  nginx.ingress.kubernetes.io/upstream-keepalive-connections: "100"
  nginx.ingress.kubernetes.io/upstream-keepalive-timeout: "60"
  nginx.ingress.kubernetes.io/upstream-keepalive-requests: "1000"
  nginx.ingress.kubernetes.io/configuration-snippet: |
    keepalive_timeout 75s;
    keepalive_requests 10000;
```

### Load Balancing Algorithm

```yaml
annotations:
  # Round robin (default): no annotation needed
  # Least connections
  nginx.ingress.kubernetes.io/load-balance: "ewma"
  # IP hash
  nginx.ingress.kubernetes.io/load-balance: "ip_hash"
  # Random with two choices
  nginx.ingress.kubernetes.io/load-balance: "random two least_conn"
```

## Section 7: SSL Passthrough and TLS Configuration

### SSL Passthrough

SSL passthrough forwards encrypted TLS traffic directly to backend pods without terminating at the ingress. Required for protocols that do not support TLS termination at a proxy (mutual TLS with client certificates, some database protocols).

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ssl-passthrough-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
    nginx.ingress.kubernetes.io/ssl-passthrough-proxy-port: "8443"
spec:
  ingressClassName: nginx
  rules:
  - host: mtls-service.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: mtls-service
            port:
              number: 8443
```

SSL passthrough requires the controller to be deployed with `--enable-ssl-passthrough` flag:

```bash
helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --reuse-values \
  --set controller.extraArgs.enable-ssl-passthrough=true
```

### Mutual TLS (Client Certificate Verification)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mtls-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/auth-tls-secret: "production/client-ca-secret"
    nginx.ingress.kubernetes.io/auth-tls-verify-client: "on"
    nginx.ingress.kubernetes.io/auth-tls-verify-depth: "2"
    nginx.ingress.kubernetes.io/auth-tls-error-page: "https://auth.example.com/cert-error"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header X-Client-Cert $ssl_client_escaped_cert;
      proxy_set_header X-Client-Cert-Subject $ssl_client_s_dn;
      proxy_set_header X-Client-Cert-Issuer $ssl_client_i_dn;
      proxy_set_header X-Client-Cert-Serial $ssl_client_serial;
      proxy_set_header X-Client-Verify $ssl_client_verify;
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - secure-api.example.com
    secretName: server-tls-secret
  rules:
  - host: secure-api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: secure-api-service
            port:
              number: 8080
```

Create the client CA secret:

```bash
kubectl create secret generic client-ca-secret \
  --from-file=ca.crt=./client-ca.pem \
  -n production
```

## Section 8: CORS Configuration

### Simple CORS

```yaml
annotations:
  nginx.ingress.kubernetes.io/enable-cors: "true"
  nginx.ingress.kubernetes.io/cors-allow-origin: "https://app.example.com,https://admin.example.com"
  nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"
  nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization, Content-Type, X-Request-ID"
  nginx.ingress.kubernetes.io/cors-expose-headers: "X-Request-ID, X-Correlation-ID"
  nginx.ingress.kubernetes.io/cors-allow-credentials: "true"
  nginx.ingress.kubernetes.io/cors-max-age: "86400"
```

### Advanced CORS with Dynamic Origin Validation

```yaml
annotations:
  nginx.ingress.kubernetes.io/configuration-snippet: |
    set $cors_origin "";
    if ($http_origin ~* "^https://(app|admin|api)\.example\.com$") {
      set $cors_origin $http_origin;
    }
    if ($cors_origin != "") {
      add_header Access-Control-Allow-Origin $cors_origin always;
      add_header Access-Control-Allow-Credentials true always;
      add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
      add_header Access-Control-Allow-Headers "Authorization, Content-Type, X-Request-ID" always;
      add_header Vary Origin always;
    }
    if ($request_method = OPTIONS) {
      add_header Access-Control-Max-Age 86400;
      add_header Content-Length 0;
      return 204;
    }
```

## Section 9: ModSecurity WAF Integration

The NGINX Ingress Controller includes ModSecurity support with the OWASP Core Rule Set (CRS).

### Enable ModSecurity in ConfigMap

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
    SecRuleEngine On
    SecRequestBodyAccess On
    SecResponseBodyAccess Off
    SecRequestBodyLimit 13107200
    SecRequestBodyNoFilesLimit 131072
    SecAuditEngine RelevantOnly
    SecAuditLogParts ABIJDEFHZ
    SecAuditLogType Serial
    SecAuditLog /dev/stdout
    SecStatusEngine Off
    # Paranoia level 1 (default)
    SecAction "id:900000,phase:1,nolog,pass,t:none,setvar:tx.paranoia_level=1"
    SecAction "id:900001,phase:1,nolog,pass,t:none,setvar:tx.detecting_paranoia_level=2"
    # Detection-only mode (log but don't block)
    SecDefaultAction "phase:1,log,pass"
    SecDefaultAction "phase:2,log,pass"
```

### Per-Ingress ModSecurity Rules

```yaml
annotations:
  nginx.ingress.kubernetes.io/enable-modsecurity: "true"
  nginx.ingress.kubernetes.io/enable-owasp-modsecurity-crs: "true"
  nginx.ingress.kubernetes.io/modsecurity-snippet: |
    SecRuleEngine On
    # Disable specific rules that cause false positives
    SecRuleRemoveById 920350
    SecRuleRemoveById 942100
    # Custom rule for this application
    SecRule REQUEST_HEADERS:Content-Type "@contains application/xml" \
      "id:1001,phase:1,log,block,\
       msg:'XML content type is not allowed',\
       severity:CRITICAL"
```

### ModSecurity Audit Log Analysis

```bash
# View ModSecurity audit logs
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller | \
  grep -A 10 "ModSecurity"

# Check for blocked requests
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller | \
  grep "Access denied"

# Parse JSON audit logs
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller --since=1h | \
  grep "ModSecurity" | \
  jq -r 'select(.level == "warn") | [.time, .message] | @csv'
```

## Section 10: Metrics and Monitoring

### Prometheus Metrics

The NGINX Ingress Controller exposes Prometheus metrics at `/metrics` on port 10254.

```bash
# Key metrics to monitor
curl -s http://ingress-nginx-controller:10254/metrics | grep -E \
  "nginx_ingress_controller_requests|nginx_ingress_controller_success|nginx_ingress_controller_nginx_process"
```

Key metrics:

| Metric | Description |
|--------|-------------|
| `nginx_ingress_controller_requests` | Request count by status, method, host, path |
| `nginx_ingress_controller_request_duration_seconds` | Request latency histogram |
| `nginx_ingress_controller_response_duration_seconds` | Response write latency |
| `nginx_ingress_controller_request_size` | Request body size histogram |
| `nginx_ingress_controller_response_size` | Response body size histogram |
| `nginx_ingress_controller_nginx_process_connections` | Active connections |
| `nginx_ingress_controller_success` | Successful configuration reloads |
| `nginx_ingress_controller_config_last_reload_successful` | Last reload status |

### Grafana Dashboard

Import the official NGINX Ingress Grafana dashboard (ID: 9614) or the community dashboard (ID: 14314):

```bash
# Import via Grafana API
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"dashboard":{"id":9614},"overwrite":false}' \
  http://admin:admin@grafana.monitoring.svc.cluster.local/api/dashboards/import
```

### PrometheusRule Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: nginx-ingress-alerts
  namespace: monitoring
spec:
  groups:
  - name: nginx-ingress
    rules:
    - alert: NginxIngressConfigReloadFailure
      expr: nginx_ingress_controller_config_last_reload_successful == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "NGINX Ingress configuration reload failed"
        description: "NGINX Ingress controller {{ $labels.controller_pod }} failed to reload config"

    - alert: NginxIngressHighErrorRate
      expr: |
        sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m]))
        /
        sum(rate(nginx_ingress_controller_requests[5m])) > 0.05
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "NGINX Ingress high 5xx error rate"
        description: "5xx error rate is {{ $value | humanizePercentage }} over the last 5 minutes"

    - alert: NginxIngressHighLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m]))
          by (le, ingress, namespace)
        ) > 2.0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "NGINX Ingress high latency"
        description: "99th percentile latency for {{ $labels.ingress }} in {{ $labels.namespace }} is {{ $value }}s"

    - alert: NginxIngressCertExpiringSoon
      expr: |
        nginx_ingress_controller_ssl_expire_time_seconds - time() < 604800
      labels:
        severity: warning
      annotations:
        summary: "NGINX Ingress TLS certificate expiring soon"
        description: "TLS certificate for {{ $labels.host }} expires in less than 7 days"
```

### Access Log Analysis

```bash
# High-error hosts in the last hour
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller --since=1h | \
  jq -r 'select(.status >= 500) | .vhost' | \
  sort | uniq -c | sort -rn | head -20

# Slowest requests
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller --since=1h | \
  jq -r '. | [.request_time, .method, .path, .vhost, .status] | @csv' | \
  sort -t',' -k1 -rn | head -20

# Request rate by status code
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller --since=1h | \
  jq -r '.status' | \
  sort | uniq -c | sort -rn
```

## Section 11: Advanced Snippet Patterns

### Request ID Generation and Propagation

```yaml
annotations:
  nginx.ingress.kubernetes.io/configuration-snippet: |
    # Generate or inherit request ID
    set $req_id $http_x_request_id;
    if ($req_id = "") {
      set $req_id $request_id;
    }
    proxy_set_header X-Request-ID $req_id;
    add_header X-Request-ID $req_id always;
```

### Canary Deployments via Annotations

```yaml
# Main Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: main-app
  namespace: production
spec:
  ingressClassName: nginx
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: app-v1
            port:
              number: 8080
---
# Canary Ingress (10% of traffic)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: canary-app
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    # Or header-based canary
    nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
    nginx.ingress.kubernetes.io/canary-by-header-value: "v2"
    # Or cookie-based
    nginx.ingress.kubernetes.io/canary-by-cookie: "canary"
spec:
  ingressClassName: nginx
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: app-v2
            port:
              number: 8080
```

### Request Body Size Limits

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-body-size: "100m"
  nginx.ingress.kubernetes.io/proxy-buffering: "off"
  nginx.ingress.kubernetes.io/configuration-snippet: |
    client_max_body_size 100m;
    client_body_timeout 120s;
    send_timeout 120s;
```

### WebSocket Support

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  nginx.ingress.kubernetes.io/configuration-snippet: |
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
```

## Section 12: Troubleshooting Common Issues

### Configuration Not Applied

```bash
# Check if Ingress is picked up by controller
kubectl get ingress -n production
kubectl describe ingress api-ingress -n production

# Check controller logs for parsing errors
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller --since=5m | \
  grep -i "error\|warn\|invalid"

# Validate the generated NGINX config
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  nginx -t

# Check admission webhook logs
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller --since=5m | \
  grep "admission"
```

### 502/503 Errors from Upstream

```bash
# Check upstream pod health
kubectl get pods -n production -l app.kubernetes.io/name=api-service

# Check service endpoints
kubectl get endpoints api-service -n production

# Test upstream connectivity from ingress pod
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  wget -q -O- http://api-service.production.svc.cluster.local:8080/health

# Check for network policy blocking ingress controller
kubectl get networkpolicy -n production
```

### Rate Limit Not Taking Effect

```bash
# Verify snippet annotations are allowed
kubectl get configmap ingress-nginx-controller -n ingress-nginx -o jsonpath='{.data.allow-snippet-annotations}'

# Check if annotations-risk-level is set correctly
kubectl get configmap ingress-nginx-controller -n ingress-nginx -o jsonpath='{.data.annotations-risk-level}'
# Should be "Critical" for server-snippet support

# Reload and check NGINX config for limit_req directives
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  grep -n "limit_req" /etc/nginx/nginx.conf
```

### SSL Certificate Issues

```bash
# Check cert-manager certificate status
kubectl get certificate -n production

# Check Ingress TLS secret
kubectl get secret app-tls-secret -n production -o jsonpath='{.data.tls\.crt}' | \
  base64 -d | openssl x509 -text -noout | grep -E "Subject:|Not After:"

# Force certificate renewal
kubectl annotate ingress api-ingress \
  cert-manager.io/issue-temporary-certificate="true" \
  -n production
```

---

The NGINX Ingress Controller's annotation system provides a comprehensive surface for production-grade traffic management without requiring direct NGINX configuration expertise. The patterns in this guide — from rate limiting through WAF integration to canary deployments — compose cleanly together and scale from single-application ingress through enterprise-wide traffic policy enforcement. The monitoring section ensures operational visibility is built in from the start, with alerts for configuration failures, error rates, latency degradation, and certificate expiry covering the most common production failure modes.
