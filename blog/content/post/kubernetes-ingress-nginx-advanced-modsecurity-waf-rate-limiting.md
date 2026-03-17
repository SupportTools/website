---
title: "Kubernetes Ingress-NGINX Advanced: Custom Snippets, ModSecurity WAF, and Rate Limiting"
date: 2030-12-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NGINX", "Ingress", "ModSecurity", "WAF", "Rate Limiting", "Security", "OWASP"]
categories:
- Kubernetes
- Security
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into advanced Ingress-NGINX configuration covering custom nginx.conf snippets, ModSecurity CRS WAF integration, rate limiting by IP and header, upstream hashing for session affinity, SSL passthrough, and OWASP rule tuning to reduce false positives in production."
more_link: "yes"
url: "/kubernetes-ingress-nginx-advanced-modsecurity-waf-rate-limiting/"
---

Ingress-NGINX is the most widely deployed Kubernetes ingress controller, but most deployments only scratch the surface of its capabilities. The default configuration handles basic HTTP/HTTPS routing, but production traffic requires WAF protection against injection attacks, sophisticated rate limiting that distinguishes legitimate traffic from abuse, and fine-grained nginx configuration for specific application behaviors. This guide covers the full range of advanced Ingress-NGINX configuration for production Kubernetes deployments.

<!--more-->

# Kubernetes Ingress-NGINX Advanced: Custom Snippets, ModSecurity WAF, and Rate Limiting

## Installation and Base Configuration

### Production Helm Install

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --version 4.9.1 \
  --set controller.replicaCount=3 \
  --set controller.resources.requests.cpu=100m \
  --set controller.resources.requests.memory=128Mi \
  --set controller.resources.limits.cpu=2000m \
  --set controller.resources.limits.memory=1Gi \
  --set controller.autoscaling.enabled=true \
  --set controller.autoscaling.minReplicas=3 \
  --set controller.autoscaling.maxReplicas=10 \
  --set controller.metrics.enabled=true \
  --set controller.metrics.serviceMonitor.enabled=true \
  --set controller.podAntiAffinity.enabled=true \
  --set controller.topologySpreadConstraints[0].maxSkew=1 \
  --set controller.topologySpreadConstraints[0].topologyKey=kubernetes.io/hostname \
  --set controller.topologySpreadConstraints[0].whenUnsatisfiable=DoNotSchedule
```

### Global ConfigMap Tuning

The nginx ConfigMap controls global behavior:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Worker process configuration
  worker-processes: "auto"
  worker-rlimit-nofile: "65536"
  max-worker-connections: "65536"
  worker-cpu-affinity: "auto"

  # Connection handling
  upstream-keepalive-connections: "200"
  upstream-keepalive-time: "1h"
  upstream-keepalive-requests: "10000"

  # Buffer sizes
  proxy-buffer-size: "128k"
  proxy-buffers-number: "4"
  large-client-header-buffers: "4 16k"

  # Timeout configuration
  proxy-connect-timeout: "10"
  proxy-read-timeout: "120"
  proxy-send-timeout: "120"

  # Logging
  log-format-upstream: >
    {"time":"$time_iso8601","remote_addr":"$proxy_protocol_addr",
    "x-forward-for":"$proxy_add_x_forwarded_for",
    "request_id":"$req_id","remote_user":"$remote_user",
    "bytes_sent":$bytes_sent,"request_time":$request_time,
    "status":$status,"vhost":"$host","request_uri":"$uri",
    "request_length":$request_length,"duration":$request_time,
    "method":"$request_method","http_referrer":"$http_referer",
    "http_user_agent":"$http_user_agent","upstream_addr":"$upstream_addr",
    "upstream_status":"$upstream_status",
    "upstream_response_time":"$upstream_response_time",
    "ssl_protocol":"$ssl_protocol","ssl_cipher":"$ssl_cipher"}
  access-log-path: "/var/log/nginx/access.log"
  error-log-path: "/var/log/nginx/error.log"

  # Security headers
  hide-headers: "X-Powered-By,Server"
  server-tokens: "false"

  # SSL configuration
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384"
  ssl-prefer-server-ciphers: "true"
  ssl-session-cache: "shared:SSL:10m"
  ssl-session-timeout: "10m"
  ssl-session-tickets: "false"  # Disable for Perfect Forward Secrecy

  # HSTS
  hsts: "true"
  hsts-max-age: "15724800"
  hsts-include-subdomains: "true"
  hsts-preload: "true"

  # Enable gzip compression
  use-gzip: "true"
  gzip-level: "5"
  gzip-types: "text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript"

  # Body size limits
  proxy-body-size: "50m"

  # Real IP configuration (for load balancers)
  use-forwarded-headers: "true"
  forwarded-for-header: "X-Forwarded-For"
  compute-full-forwarded-for: "true"
```

## Custom nginx.conf Snippets

Snippets are the escape hatch for custom nginx configuration not exposed as first-class annotations. Use them carefully as they bypass validation.

### Server Snippet for Custom Security Headers

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "X-Frame-Options: DENY";
      more_set_headers "X-Content-Type-Options: nosniff";
      more_set_headers "X-XSS-Protection: 1; mode=block";
      more_set_headers "Referrer-Policy: strict-origin-when-cross-origin";
      more_set_headers "Permissions-Policy: camera=(), microphone=(), geolocation=()";
      more_set_headers "Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' cdn.example.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: cdn.example.com; font-src 'self' cdn.example.com; connect-src 'self' api.example.com; frame-ancestors 'none'";

    nginx.ingress.kubernetes.io/server-snippet: |
      # Block common scanner user agents
      if ($http_user_agent ~* "(?:nikto|nmap|sqlmap|masscan|zgrab|nessus|openvas|acunetix|dirbuster|gobuster)") {
        return 403;
      }

      # Block requests with no Host header
      if ($host = '') {
        return 400;
      }

      # Custom error page configuration
      error_page 404 /custom-404.html;
      error_page 500 502 503 504 /custom-50x.html;
```

### Global Server Snippets via ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  http-snippet: |
    # Global rate limit zones (shared across all server blocks)
    limit_req_zone $binary_remote_addr zone=global_per_ip:50m rate=100r/m;
    limit_req_zone $http_x_api_key zone=api_key:20m rate=1000r/m;

    # Connection limit zones
    limit_conn_zone $binary_remote_addr zone=conn_per_ip:50m;

    # Map for bot detection
    map $http_user_agent $is_bot {
        default 0;
        "~*(?:bot|crawler|spider|scraper)" 1;
    }

    # Map for whitelisted IPs (corporate VPN ranges, monitoring agents)
    geo $is_trusted_ip {
        default 0;
        10.0.0.0/8 1;        # Internal network
        172.16.0.0/12 1;     # VPN range
        192.168.0.0/16 1;    # Private range
    }

  server-snippet: |
    # Deny access to sensitive files
    location ~* \.(env|git|svn|htaccess|htpasswd|conf|bak|orig|save|swp)$ {
        deny all;
        return 404;
    }

    # Block common exploits
    location ~* /(wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|adminer) {
        deny all;
        return 404;
    }
```

## ModSecurity WAF Integration

ModSecurity with the OWASP Core Rule Set (CRS) provides protection against common web application attacks including SQL injection, XSS, and CSRF.

### Enabling ModSecurity in Ingress-NGINX

ModSecurity is included in the ingress-nginx image starting from v0.46.0 but must be enabled:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Enable ModSecurity globally
  enable-modsecurity: "true"
  enable-owasp-modsecurity-crs: "true"
  modsecurity-snippet: |
    SecRuleEngine On
    SecRequestBodyAccess On
    SecRequestBodyLimit 13107200
    SecRequestBodyNoFilesLimit 131072
    SecResponseBodyAccess Off
    SecResponseBodyLimit 524288
    SecPcreMatchLimit 500000
    SecPcreMatchLimitRecursion 500000
    SecRequestBodyLimitAction Reject
    SecAuditLog /var/log/modsec_audit.log
    SecAuditLogParts ABCIJDEFHZ
    SecAuditLogType Serial
    SecStatusEngine Off
```

### Per-Ingress ModSecurity Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service
  namespace: production
  annotations:
    # Enable ModSecurity for this specific ingress
    nginx.ingress.kubernetes.io/enable-modsecurity: "true"
    nginx.ingress.kubernetes.io/enable-owasp-core-rules: "true"

    nginx.ingress.kubernetes.io/modsecurity-snippet: |
      SecRuleEngine On

      # Include OWASP CRS rules
      Include /etc/nginx/owasp-modsecurity-crs/nginx-modsecurity.conf

      # Set paranoia level (1-4; higher = more rules, more false positives)
      SecAction \
        "id:900000,\
        phase:1,\
        nolog,\
        pass,\
        t:none,\
        setvar:tx.paranoia_level=2"

      # Set anomaly scoring thresholds
      SecAction \
        "id:900110,\
        phase:1,\
        nolog,\
        pass,\
        t:none,\
        setvar:tx.inbound_anomaly_score_threshold=10,\
        setvar:tx.outbound_anomaly_score_threshold=4"
```

## OWASP CRS Rule Tuning and False Positive Reduction

Production deployments invariably trigger false positives from the OWASP CRS. Rule tuning is an ongoing operational task.

### Identifying False Positives from ModSecurity Logs

```bash
# Check ModSecurity audit log for blocked requests
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  tail -100 /var/log/modsec_audit.log | grep -E "(BLOCK|WARN|rule_id)"

# Or check nginx error log
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller | \
  grep ModSecurity | head -50

# Parse ModSecurity audit log for blocked rule IDs
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  grep -oP 'id "\K[0-9]+' /var/log/modsec_audit.log | \
  sort | uniq -c | sort -rn | head -20
```

### Creating Rule Exclusions

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/modsecurity-snippet: |
      SecRuleEngine On
      Include /etc/nginx/owasp-modsecurity-crs/nginx-modsecurity.conf

      # ===== Application-Specific Exclusions =====

      # Exclude rule 942440 (SQL injection) for the /api/search endpoint
      # This endpoint legitimately accepts SQL-like syntax for search operators
      SecRuleUpdateTargetById 942440 "!REQUEST_URI:/api/search"

      # Disable XSS rule for rich text editor endpoint (accepts HTML)
      SecRule REQUEST_URI "@beginsWith /api/content/richtext" \
        "id:10001,\
        phase:1,\
        pass,\
        nolog,\
        ctl:ruleRemoveById=941100-941999"

      # Allow specific User-Agent patterns that trigger scanner detection
      SecRuleUpdateTargetById 913100 "!REQUEST_HEADERS:User-Agent"
      SecRuleUpdateTargetById 913101 "!REQUEST_HEADERS:User-Agent"

      # Exclude file upload rule for the upload endpoint
      SecRule REQUEST_URI "@beginsWith /api/upload" \
        "id:10002,\
        phase:1,\
        pass,\
        nolog,\
        ctl:ruleRemoveById=200002"

      # Disable body size limit for batch import endpoint
      SecRule REQUEST_URI "@beginsWith /api/import/batch" \
        "id:10003,\
        phase:1,\
        pass,\
        nolog,\
        ctl:requestBodyAccess=Off"

      # Allow Base64 in specific parameter (legitimate app pattern)
      SecRuleUpdateTargetById 941120 "!ARGS:thumbnail"

      # Whitelist internal API key from security checks
      SecRule REQUEST_HEADERS:X-Internal-Service-Token "@pmFromFile /etc/nginx/internal-tokens.dat" \
        "id:10004,\
        phase:1,\
        pass,\
        nolog,\
        skipAfter:END_MODSEC_CHECKS"

      SecMarker "END_MODSEC_CHECKS"
```

### Global Exclusion Rules for Common Application Frameworks

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  modsecurity-snippet: |
    # Global exclusions for common frameworks

    # Django CSRF token - legitimate Base64 value in POST body
    SecRuleUpdateTargetById 941120 "!ARGS:csrfmiddlewaretoken"
    SecRuleUpdateTargetById 942440 "!ARGS:csrfmiddlewaretoken"

    # React/Next.js hydration data
    SecRuleUpdateTargetById 941100 "!ARGS:__NEXT_DATA__"

    # GraphQL query parameter
    SecRuleUpdateTargetById 942100 "!ARGS:query"
    SecRuleUpdateTargetById 942110 "!ARGS:query"

    # JWT tokens in Authorization header (they contain '.' which triggers rules)
    SecRuleUpdateTargetById 942100 "!REQUEST_HEADERS:Authorization"

    # Health check paths - skip all rules for efficiency
    SecRule REQUEST_URI "@rx ^/(health|healthz|ready|readyz|ping|metrics)$" \
      "id:10100,\
      phase:1,\
      pass,\
      nolog,\
      ctl:ruleEngine=Off"
```

## Rate Limiting

### IP-Based Rate Limiting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-endpoint
  namespace: production
  annotations:
    # Rate limit: 100 requests per minute per IP
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-rpm: "100"

    # Burst allows temporary spikes above the rate
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"

    # Status code for rate-limited requests (429 is standard)
    # Default is 503, override to 429 for proper API behavior
    nginx.ingress.kubernetes.io/limit-req-status-code: "429"

    # Whitelist trusted IPs from rate limiting
    nginx.ingress.kubernetes.io/limit-whitelist: "10.0.0.0/8,172.16.0.0/12"

    # Custom rate limit zone (shared across ingresses)
    nginx.ingress.kubernetes.io/configuration-snippet: |
      limit_req zone=global_per_ip burst=20 nodelay;
      limit_req_status 429;
      limit_conn conn_per_ip 100;
      add_header Retry-After 60 always;
      add_header X-RateLimit-Limit 100 always;
      add_header X-RateLimit-Remaining $limit_req_status always;
```

### Header-Based Rate Limiting

Different rate limits based on API key or authentication header:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  http-snippet: |
    # Rate limit zones based on API key
    # Unauthenticated: 10 req/minute
    # Authenticated (any key): 1000 req/minute
    # Premium tier: 10000 req/minute

    # Map API key to rate limit tier
    map $http_x_api_key $rate_limit_key {
        default                 "$binary_remote_addr";    # No key: IP-based
        "~^[a-zA-Z0-9]{32}$"   "$http_x_api_key";       # Valid key: key-based
    }

    # Separate zones for different tiers
    limit_req_zone $binary_remote_addr zone=unauth:50m rate=10r/m;
    limit_req_zone $http_x_api_key zone=auth_standard:50m rate=1000r/m;
    limit_req_zone $http_x_api_key zone=auth_premium:50m rate=10000r/m;

    # Map to determine premium status (could also check against database via auth_request)
    map $http_x_api_key $is_premium {
        default 0;
        # In production, load from a file or use auth_request
        "~^PREM[a-zA-Z0-9]{28}$" 1;
    }
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-tiered-ratelimit
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Apply appropriate rate limit based on tier
      if ($is_premium = "0") {
          limit_req zone=auth_standard burst=50 nodelay;
      }
      if ($is_premium = "1") {
          limit_req zone=auth_premium burst=500 nodelay;
      }
      limit_req_status 429;
      add_header X-RateLimit-Tier $is_premium always;
```

### Cookie-Based Rate Limiting

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  http-snippet: |
    # Use session cookie as rate limit key for authenticated users
    map $cookie_session_id $rate_limit_session {
        default "$binary_remote_addr";
        "~.+"   "$cookie_session_id";
    }

    limit_req_zone $rate_limit_session zone=session_limit:50m rate=60r/m;
    limit_req_zone $binary_remote_addr zone=anon_limit:50m rate=10r/m;
```

### Advanced Rate Limiting with Lua (via OpenResty)

For extremely fine-grained rate limiting beyond what nginx's native zones support, use the lua-resty-limit-traffic module:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-complex-ratelimit
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Rate limit with sliding window using Redis (requires lua-resty-redis)
      access_by_lua_block {
        local redis = require "resty.redis"
        local red = redis:new()
        red:set_timeouts(100, 100, 100)  -- milliseconds

        local ok, err = red:connect("redis-service", 6379)
        if not ok then
            -- Fail open: allow request if Redis is unavailable
            return
        end

        local key = "ratelimit:" .. ngx.var.remote_addr
        local limit = 100
        local window = 60  -- seconds

        local count, err = red:incr(key)
        if count == 1 then
            red:expire(key, window)
        end

        local ttl = red:ttl(key)
        ngx.header["X-RateLimit-Limit"] = limit
        ngx.header["X-RateLimit-Remaining"] = math.max(0, limit - count)
        ngx.header["X-RateLimit-Reset"] = ngx.time() + ttl

        if count > limit then
            ngx.header["Retry-After"] = ttl
            ngx.status = 429
            ngx.say('{"error":"rate_limit_exceeded","retry_after":' .. ttl .. '}')
            ngx.exit(429)
        end

        red:close()
      }
```

## Upstream Hashing for Session Affinity

### IP Hash Affinity

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: stateful-app
  namespace: production
  annotations:
    # Session affinity by client IP
    nginx.ingress.kubernetes.io/upstream-hash-by: "$binary_remote_addr"
    nginx.ingress.kubernetes.io/upstream-hash-by-subset: "false"
```

### Cookie-Based Session Affinity

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: stateful-app
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/affinity-mode: "balanced"
    nginx.ingress.kubernetes.io/session-cookie-name: "INGRESSCOOKIE"
    nginx.ingress.kubernetes.io/session-cookie-expires: "172800"  # 2 days
    nginx.ingress.kubernetes.io/session-cookie-max-age: "172800"
    nginx.ingress.kubernetes.io/session-cookie-secure: "true"
    nginx.ingress.kubernetes.io/session-cookie-path: "/"
    nginx.ingress.kubernetes.io/session-cookie-samesite: "Strict"
```

### Custom Header-Based Routing

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: header-routing
  namespace: production
  annotations:
    # Route to same upstream based on a custom header
    nginx.ingress.kubernetes.io/upstream-hash-by: "$http_x_user_id"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Fallback to IP if header not present
      if ($http_x_user_id = "") {
          set $upstream_hash_by "$binary_remote_addr";
      }
```

## SSL Passthrough

SSL passthrough forwards TLS connections directly to the backend without termination at the ingress controller. Required for protocols that use SNI-based routing (MySQL, PostgreSQL, custom TCP protocols):

```bash
# Enable SSL passthrough in the controller (must be enabled at startup)
helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --set controller.extraArgs.enable-ssl-passthrough=true
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: database-passthrough
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
    nginx.ingress.kubernetes.io/ssl-passthrough-proxy-protocol: "true"
spec:
  ingressClassName: nginx
  rules:
  - host: db.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: postgresql-service
            port:
              number: 5432
```

Note: SSL passthrough disables the standard Ingress TLS termination and all NGINX-level functionality (rate limiting, WAF, rewriting) for that ingress.

## Authentication with oauth2-proxy

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: protected-app
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/auth-url: "https://auth.example.com/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://auth.example.com/oauth2/start?rd=$escaped_request_uri"
    nginx.ingress.kubernetes.io/auth-response-headers: "X-Auth-Request-User,X-Auth-Request-Email,X-Auth-Request-Groups"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      auth_request_set $user $upstream_http_x_auth_request_user;
      auth_request_set $email $upstream_http_x_auth_request_email;
      proxy_set_header X-Forwarded-User $user;
      proxy_set_header X-Forwarded-Email $email;
```

## Monitoring and Alerting

### Prometheus Metrics for Ingress-NGINX

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ingress-nginx-alerts
  namespace: monitoring
spec:
  groups:
  - name: ingress-nginx
    rules:
    - alert: NginxHighError5xxRate
      expr: |
        sum(rate(nginx_ingress_controller_requests{status=~"5.."}[5m]))
        by (ingress, namespace, service) /
        sum(rate(nginx_ingress_controller_requests[5m]))
        by (ingress, namespace, service) > 0.05
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "High 5xx error rate on {{ $labels.ingress }}"
        description: "Error rate is {{ $value | humanizePercentage }}"

    - alert: NginxHighLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m]))
          by (ingress, namespace, le)
        ) > 2
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High P99 latency on {{ $labels.ingress }}"

    - alert: NginxModSecurityBlocking
      expr: |
        sum(rate(nginx_ingress_controller_requests{status="403"}[5m]))
        by (ingress) > 10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High ModSecurity block rate on {{ $labels.ingress }}"
        description: "ModSecurity blocking {{ $value | humanize }} req/s"

    - alert: NginxRateLimitHigh
      expr: |
        sum(rate(nginx_ingress_controller_requests{status="429"}[5m]))
        by (ingress) > 50
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "High rate limit rejections on {{ $labels.ingress }}"
```

### Key Dashboard Metrics

```promql
# Request rate by status code
sum(rate(nginx_ingress_controller_requests[5m])) by (status)

# P95 latency by ingress
histogram_quantile(0.95,
  sum(rate(nginx_ingress_controller_request_duration_seconds_bucket[5m]))
  by (ingress, le)
)

# Active connections per controller
sum(nginx_ingress_controller_nginx_process_connections{state="active"}) by (controller_pod)

# WAF blocks vs allows ratio
sum(rate(nginx_ingress_controller_requests{status="403"}[5m])) /
sum(rate(nginx_ingress_controller_requests[5m]))
```

## Troubleshooting

### Debugging WAF False Positives

```bash
# Enable ModSecurity in detection-only mode while debugging
# Detection mode logs blocks but does not actually block requests
kubectl patch ingress my-ingress -n production --type=merge -p '{
  "metadata": {
    "annotations": {
      "nginx.ingress.kubernetes.io/modsecurity-snippet": "SecRuleEngine DetectionOnly\nInclude /etc/nginx/owasp-modsecurity-crs/nginx-modsecurity.conf"
    }
  }
}'

# Check ModSecurity audit logs
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  tail -f /var/log/modsec_audit.log | python3 -c "
import sys, json, re
for line in sys.stdin:
    m = re.search(r'--\w+--\n(.*)', line)
    if m:
        try:
            print(json.dumps(json.loads(m.group(1)), indent=2))
        except:
            print(line)
"

# Test specific requests against ModSecurity
curl -v -X POST https://app.example.com/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "SELECT * FROM users WHERE 1=1"}' 2>&1 | \
  grep -E "(HTTP|X-Request-ID|body)"
```

### Debugging Rate Limiting

```bash
# Check if rate limiting is active
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  nginx -T 2>/dev/null | grep "limit_req_zone"

# Test rate limiting manually
for i in $(seq 1 110); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://api.example.com/endpoint)
    echo "Request $i: $STATUS"
    if [ "$STATUS" = "429" ]; then
        echo "Rate limited at request $i"
        break
    fi
done

# Check nginx status for current connections
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  curl -s http://localhost:10246/nginx_status
```

## Summary

Advanced Ingress-NGINX configuration provides a comprehensive security and performance layer for Kubernetes applications:

- ModSecurity CRS with paranoia level 2 provides a good balance of security and false positive rate for most applications; level 3 requires more tuning
- Rate limiting should use multiple zones (per-IP, per-API-key, per-session) with appropriate burst values - overly aggressive limits frustrate legitimate users
- Configuration snippets are powerful but bypass validation; document them thoroughly and test in staging
- OWASP CRS tuning is an ongoing process; start with detection mode, analyze 30 days of traffic patterns, then enable blocking mode with known false positives excluded
- SSL passthrough sacrifices NGINX-layer inspection and should only be used when end-to-end TLS is truly required by the protocol
- Session affinity via cookies is more stable than IP-based hashing for cloud-hosted users behind NAT or shared proxies
- Monitor the 429 rate alongside 5xx and latency - a spike in rate limiting often precedes an attack or indicates a legitimate traffic pattern that needs adjustment
