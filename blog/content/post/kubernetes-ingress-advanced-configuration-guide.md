---
title: "Kubernetes Ingress Advanced Configuration: TLS, Rate Limiting, and Auth"
date: 2027-11-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Ingress", "NGINX", "TLS", "Rate Limiting"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into NGINX Ingress Controller annotations, external authentication with oauth2-proxy, rate limiting, TLS termination and passthrough, canary deployments, custom error pages, ModSecurity WAF integration, and cert-manager automation."
more_link: "yes"
url: "/kubernetes-ingress-advanced-configuration-guide/"
---

The NGINX Ingress Controller is the most widely deployed ingress solution for Kubernetes, and most teams use only a small fraction of its capabilities. Beyond basic routing, it supports external authentication delegation, fine-grained rate limiting, TLS passthrough for end-to-end encryption, canary deployments, WAF integration, and extensive customization via ConfigMap and annotations.

This guide covers the full feature set of NGINX Ingress in production configurations, from basic TLS termination through ModSecurity WAF enforcement.

<!--more-->

# Kubernetes Ingress Advanced Configuration: TLS, Rate Limiting, and Auth

## Section 1: NGINX Ingress Controller Installation

Production installations require careful configuration of the controller itself before configuring individual Ingress resources.

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --version 4.10.0 \
  --set controller.replicaCount=3 \
  --set controller.minAvailable=2 \
  --set controller.resources.requests.cpu=100m \
  --set controller.resources.requests.memory=256Mi \
  --set controller.resources.limits.cpu=2000m \
  --set controller.resources.limits.memory=1Gi \
  --set controller.metrics.enabled=true \
  --set controller.metrics.serviceMonitor.enabled=true \
  --set controller.podAntiAffinity.type=hard \
  --set controller.topologySpreadConstraints[0].maxSkew=1 \
  --set controller.topologySpreadConstraints[0].topologyKey="topology.kubernetes.io/zone" \
  --set controller.topologySpreadConstraints[0].whenUnsatisfiable=DoNotSchedule
```

### Global ConfigMap

The ConfigMap at `ingress-nginx/ingress-nginx-controller` applies globally to all Ingress resources:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Security headers
  add-headers: "ingress-nginx/security-headers"
  hide-headers: "Server,X-Powered-By"

  # SSL/TLS configuration
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"
  ssl-prefer-server-ciphers: "true"
  ssl-session-cache: "shared:SSL:10m"
  ssl-session-timeout: "10m"
  ssl-session-tickets: "false"

  # HSTS
  hsts: "true"
  hsts-max-age: "31536000"
  hsts-include-subdomains: "true"
  hsts-preload: "true"

  # Performance
  use-gzip: "true"
  gzip-level: "6"
  gzip-min-length: "1024"
  worker-processes: "auto"
  worker-cpu-affinity: "auto"
  max-worker-connections: "65536"
  upstream-keepalive-connections: "100"
  upstream-keepalive-timeout: "60"
  upstream-keepalive-requests: "1000"

  # Logging
  log-format-upstream: >-
    {"time":"$time_iso8601","remote_addr":"$proxy_protocol_addr",
    "x_forwarded_for":"$proxy_add_x_forwarded_for","request_id":"$req_id",
    "remote_user":"$remote_user","bytes_sent":$bytes_sent,
    "request_time":$request_time,"status":$status,"vhost":"$host",
    "request_proto":"$server_protocol","path":"$uri",
    "request_query":"$args","request_length":$request_length,
    "duration":$request_time,"method":"$request_method",
    "http_referrer":"$http_referer","http_user_agent":"$http_user_agent"}
  access-log-path: "/var/log/nginx/access.log"
  error-log-path: "/var/log/nginx/error.log"

  # Real IP configuration (trust proxy headers from load balancer)
  use-forwarded-headers: "true"
  forwarded-for-header: "X-Forwarded-For"
  compute-full-forwarded-for: "true"
  proxy-real-ip-cidr: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
---
# Security headers ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: security-headers
  namespace: ingress-nginx
data:
  X-Frame-Options: "SAMEORIGIN"
  X-Content-Type-Options: "nosniff"
  X-XSS-Protection: "1; mode=block"
  Referrer-Policy: "strict-origin-when-cross-origin"
  Permissions-Policy: "camera=(), microphone=(), geolocation=()"
  Content-Security-Policy: "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'"
```

## Section 2: TLS Termination with cert-manager

cert-manager automates TLS certificate lifecycle management using Let's Encrypt or internal PKI.

### cert-manager Installation

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.15.0 \
  --set installCRDs=true \
  --set global.leaderElection.namespace=cert-manager \
  --set prometheus.enabled=true \
  --set prometheus.servicemonitor.enabled=true
```

### ClusterIssuer for Let's Encrypt

```yaml
# Production ClusterIssuer (rate-limited; use staging for testing)
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
    # HTTP-01 challenge via ingress
    - http01:
        ingress:
          ingressClassName: nginx
          ingressTemplate:
            metadata:
              annotations:
                # Ensure challenge route is not rate-limited
                nginx.ingress.kubernetes.io/limit-connections: "0"
                nginx.ingress.kubernetes.io/limit-rpm: "0"
    # DNS-01 challenge via Route53 (for wildcard certs)
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1234567890ABCDEF
          accessKeyIDSecretRef:
            name: route53-credentials
            key: access-key-id
          secretAccessKeySecretRef:
            name: route53-credentials
            key: secret-access-key
      selector:
        dnsZones:
        - "*.example.com"
---
# Staging ClusterIssuer for testing
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-staging-account-key
    solvers:
    - http01:
        ingress:
          ingressClassName: nginx
```

### Ingress with TLS

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    # HTTPS only; redirect HTTP to HTTPS
    nginx.ingress.kubernetes.io/from-to-www-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - api.example.com
    secretName: api-example-com-tls   # cert-manager creates this secret
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

### TLS Passthrough for End-to-End Encryption

TLS passthrough routes SSL connections directly to the backend without NGINX decrypting them. The backend service handles TLS termination.

```yaml
# TLS passthrough ingress (uses SNI routing, not HTTP routing)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: grpc-ingress
  namespace: production
  annotations:
    # Enable passthrough - NGINX forwards raw TCP with SNI routing
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
    # Backend port must be the TLS port on the service
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
spec:
  ingressClassName: nginx
  rules:
  - host: grpc.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: grpc-service
            port:
              number: 443
```

## Section 3: External Authentication with oauth2-proxy

oauth2-proxy sits in front of applications and authenticates users via OIDC providers (Google, GitHub, Azure AD, Okta). NGINX Ingress delegates authentication to it via the `auth-url` annotation.

### oauth2-proxy Deployment

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
        - --oidc-issuer-url=https://login.microsoftonline.com/TENANT_ID/v2.0
        - --email-domain=example.com
        - --upstream=file:///dev/null
        - --http-address=0.0.0.0:4180
        - --cookie-secure=true
        - --cookie-samesite=lax
        - --cookie-refresh=1h
        - --cookie-expire=168h
        - --set-xauthrequest=true
        - --pass-access-token=true
        - --skip-provider-button=true
        - --request-logging=true
        env:
        - name: OAUTH2_PROXY_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: oauth2-proxy-secret
              key: client-id
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
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi
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
  - name: http
    port: 4180
    targetPort: 4180
```

### Protected Ingress Using oauth2-proxy

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: internal-dashboard
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    # Delegate auth to oauth2-proxy
    nginx.ingress.kubernetes.io/auth-url: "https://auth.example.com/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://auth.example.com/oauth2/start?rd=$escaped_request_uri"
    # Pass authenticated user info to backend
    nginx.ingress.kubernetes.io/auth-response-headers: "X-Auth-Request-User,X-Auth-Request-Email,X-Auth-Request-Access-Token"
    # Cache auth responses for 5 minutes
    nginx.ingress.kubernetes.io/auth-cache-key: "$cookie__oauth2_proxy"
    nginx.ingress.kubernetes.io/auth-cache-duration: "200 202 401 5m"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - dashboard.example.com
    secretName: dashboard-example-com-tls
  rules:
  - host: dashboard.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: grafana
            port:
              number: 3000
```

## Section 4: Rate Limiting

NGINX Ingress provides two rate limiting mechanisms: connection rate limiting and request rate limiting using nginx's leaky bucket algorithm.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress-rate-limited
  namespace: production
  annotations:
    # Connections per IP
    nginx.ingress.kubernetes.io/limit-connections: "20"

    # Requests per minute per IP (leaky bucket)
    nginx.ingress.kubernetes.io/limit-rpm: "300"

    # Requests per second per IP
    nginx.ingress.kubernetes.io/limit-rps: "10"

    # Burst above the rate limit (up to 50 requests burst before dropping)
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"

    # Return 429 Too Many Requests (not the default 503)
    nginx.ingress.kubernetes.io/limit-response-status-code: "429"

    # Whitelist internal IPs from rate limiting
    nginx.ingress.kubernetes.io/limit-whitelist: "10.0.0.0/8,172.16.0.0/12"
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

### Global Rate Limiting with NGINX ConfigMap

For more sophisticated rate limiting using shared state across NGINX replicas, use the global rate limiting with Redis backend:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Global rate limiting config using nginx_http_limit_req_module
  limit-req-zone-variable: "$binary_remote_addr"
  limit-req-status-code: "429"

  # Custom nginx configuration snippet for per-zone limits
  http-snippet: |
    # Per-IP rate limiting zone: 10MB storage, 100r/s rate
    limit_req_zone $binary_remote_addr zone=ip_rate:10m rate=100r/s;
    # Per-key rate limiting using API key header
    limit_req_zone $http_x_api_key zone=key_rate:10m rate=1000r/s;
    # Per-user rate limiting using auth header
    limit_req_zone $http_authorization zone=user_rate:10m rate=500r/s;
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-with-custom-rate-limit
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Use the per-key rate limit zone for API key-authenticated requests
      limit_req zone=key_rate burst=20 nodelay;
      # Fallback to per-IP if no API key
      limit_req zone=ip_rate burst=10;
      limit_req_log_level warn;
      limit_req_status 429;

      # Add rate limit headers to response
      add_header X-RateLimit-Limit "1000" always;
      add_header X-RateLimit-Remaining "$upstream_http_x_ratelimit_remaining" always;
spec:
  ingressClassName: nginx
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
```

## Section 5: Canary Deployments via Ingress

NGINX Ingress supports canary deployments by splitting traffic between a primary ingress and a canary ingress based on headers, cookies, or weight.

```yaml
# Primary ingress (stable version)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: checkout-stable
  namespace: production
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - checkout.example.com
    secretName: checkout-tls
  rules:
  - host: checkout.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: checkout-service-v1
            port:
              number: 8080
---
# Canary ingress (new version receives 10% of traffic)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: checkout-canary
  namespace: production
  annotations:
    # Mark this as a canary ingress
    nginx.ingress.kubernetes.io/canary: "true"
    # Send 10% of traffic to canary
    nginx.ingress.kubernetes.io/canary-weight: "10"
    # Optionally route specific users via cookie
    nginx.ingress.kubernetes.io/canary-by-cookie: "canary_user"
    # Or route via header
    nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
    nginx.ingress.kubernetes.io/canary-by-header-value: "true"
spec:
  ingressClassName: nginx
  rules:
  - host: checkout.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: checkout-service-v2
            port:
              number: 8080
```

Monitor canary traffic split:

```bash
# Watch request distribution
kubectl exec -n ingress-nginx deploy/ingress-nginx-controller -- \
    nginx -T | grep -A5 "canary"

# Check canary error rates via Prometheus
kubectl port-forward -n monitoring svc/prometheus 9090:9090 &
curl -s 'http://localhost:9090/api/v1/query?query=
    rate(nginx_ingress_controller_requests{
        ingress="checkout-canary",
        status=~"5.."
    }[5m])
'
```

## Section 6: Custom Error Pages

Custom error pages improve user experience when backends are unavailable. NGINX Ingress supports a default backend that serves custom error responses.

```yaml
# Custom error pages as a deployment
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
          mountPath: /usr/share/nginx/html
        - name: nginx-config
          mountPath: /etc/nginx/conf.d
      volumes:
      - name: error-pages
        configMap:
          name: custom-error-pages
      - name: nginx-config
        configMap:
          name: error-pages-nginx-config
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
    <head><title>Page Not Found</title></head>
    <body>
    <h1>404 - Page Not Found</h1>
    <p>The requested resource could not be found.</p>
    <p>Request ID: <span id="reqid"></span></p>
    <script>
      document.getElementById('reqid').textContent =
        document.querySelector('meta[name="request-id"]')?.content || 'unknown';
    </script>
    </body>
    </html>
  503.html: |
    <!DOCTYPE html>
    <html>
    <head><title>Service Unavailable</title></head>
    <body>
    <h1>503 - Service Temporarily Unavailable</h1>
    <p>We are experiencing technical difficulties. Please try again shortly.</p>
    <p>Status: <a href="https://status.example.com">status.example.com</a></p>
    </body>
    </html>
```

Configure the controller to use custom error pages:

```yaml
# Update ingress-nginx-controller ConfigMap
data:
  custom-http-errors: "404,503,502,500"
  # The default backend handles these codes
```

## Section 7: ModSecurity WAF Integration

NGINX Ingress bundles ModSecurity v3 with the OWASP Core Rule Set (CRS). Enable it for workloads requiring WAF protection.

```yaml
# Enable ModSecurity globally in ingress-nginx ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Enable ModSecurity WAF
  enable-modsecurity: "true"
  enable-owasp-modsecurity-crs: "true"

  # ModSecurity in detection mode initially (log but don't block)
  modsecurity-snippet: |
    SecRuleEngine DetectionOnly
    SecRequestBodyAccess On
    SecResponseBodyAccess Off
    SecAuditEngine RelevantOnly
    SecAuditLog /var/log/modsecurity/audit.log
    SecAuditLogType Serial
    # Tune CRS paranoia level (1-4; higher = more false positives)
    SecAction "id:900000,phase:1,pass,t:none,setvar:tx.paranoia_level=1"
    # Set maximum request body size
    SecRequestBodyLimit 13107200
    SecRequestBodyNoFilesLimit 131072
    # Disable score-based blocking (use DetectionOnly until tuned)
    SecAction "id:900990,phase:1,pass,t:none,setvar:tx.enforce_bodyproc_urlencoded=1"
```

Enable blocking mode per-ingress after tuning:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payment-api-protected
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/enable-modsecurity: "true"
    nginx.ingress.kubernetes.io/enable-owasp-core-rules: "true"
    nginx.ingress.kubernetes.io/modsecurity-snippet: |
      # Enable blocking mode for this specific ingress
      SecRuleEngine On
      # Custom rule to block suspicious requests
      SecRule REQUEST_HEADERS:User-Agent "@pmf /etc/nginx/modsec/bad_bots.txt" \
        "id:1001,phase:1,deny,status:403,log,msg:'Bad bot detected'"
      # Whitelist known false positive rule IDs for this application
      SecRuleRemoveById 942440 942450
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - payments.example.com
    secretName: payments-tls
  rules:
  - host: payments.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: payment-service
            port:
              number: 8080
```

### Tuning WAF False Positives

```bash
# View ModSecurity audit log
kubectl exec -n ingress-nginx deploy/ingress-nginx-controller -- \
    tail -100 /var/log/modsecurity/audit.log | \
    jq 'select(.transaction.messages != null) |
        .transaction.messages[] |
        {id: .details.ruleId, message: .message, uri: .request.uri}'

# Find most triggered rules (candidates for whitelist)
kubectl exec -n ingress-nginx deploy/ingress-nginx-controller -- \
    grep -o 'id "[0-9]*"' /var/log/modsecurity/audit.log | \
    sort | uniq -c | sort -rn | head -20

# Test a specific rule against a request
kubectl exec -n ingress-nginx deploy/ingress-nginx-controller -- \
    modsec-rules-check --rule-id=942440 --uri="/api/v1/search?q=test"
```

## Section 8: Upstream Configuration

Advanced upstream configuration optimizes connection handling between NGINX and backend services.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress-optimized
  namespace: production
  annotations:
    # HTTP/2 to backend (requires TLS to backend)
    nginx.ingress.kubernetes.io/backend-protocol: "GRPC"

    # Connection timeouts
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"

    # Body size limits
    nginx.ingress.kubernetes.io/proxy-body-size: "100m"

    # Buffer settings
    nginx.ingress.kubernetes.io/proxy-buffer-size: "16k"
    nginx.ingress.kubernetes.io/proxy-buffers-number: "4"

    # Keep-alive to backend
    nginx.ingress.kubernetes.io/upstream-keepalive-connections: "50"
    nginx.ingress.kubernetes.io/upstream-keepalive-timeout: "60"

    # Retry on certain conditions (GET requests only)
    nginx.ingress.kubernetes.io/proxy-next-upstream: "error timeout http_503"
    nginx.ingress.kubernetes.io/proxy-next-upstream-timeout: "5"
    nginx.ingress.kubernetes.io/proxy-next-upstream-tries: "3"

    # Session affinity for stateful applications
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/affinity-mode: "persistent"
    nginx.ingress.kubernetes.io/session-cookie-name: "SERVERID"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "172800"
    nginx.ingress.kubernetes.io/session-cookie-path: "/"
    nginx.ingress.kubernetes.io/session-cookie-secure: "true"
    nginx.ingress.kubernetes.io/session-cookie-samesite: "Lax"
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

## Section 9: NGINX Ingress Monitoring

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
    - alert: NginxIngressHighError5xxRate
      expr: |
        sum(rate(nginx_ingress_controller_requests{
          status=~"5..",
          ingress!=""
        }[5m])) by (ingress, namespace)
        /
        sum(rate(nginx_ingress_controller_requests{
          ingress!=""
        }[5m])) by (ingress, namespace)
        > 0.05
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High 5xx rate on ingress {{ $labels.ingress }}"
        description: "Ingress {{ $labels.namespace }}/{{ $labels.ingress }} has {{ $value | humanizePercentage }} error rate."

    - alert: NginxIngressHighLatency
      expr: |
        histogram_quantile(0.99,
          sum(rate(nginx_ingress_controller_request_duration_seconds_bucket{
            ingress!=""
          }[5m])) by (ingress, namespace, le)
        ) > 2
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High p99 latency on ingress {{ $labels.ingress }}"
        description: "P99 latency for {{ $labels.namespace }}/{{ $labels.ingress }} is {{ $value | humanizeDuration }}."

    - alert: NginxIngressConfigError
      expr: nginx_ingress_controller_config_last_reload_successful == 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "NGINX Ingress configuration reload failed"
        description: "NGINX Ingress controller configuration has not reloaded successfully. Check controller logs."
```

## Section 10: Multi-Tenancy with IngressClass

For clusters serving multiple teams, separate IngressClass resources provide isolation:

```yaml
# Separate IngressClass for internal services
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: nginx-internal
  annotations:
    ingressclass.kubernetes.io/is-default-class: "false"
spec:
  controller: k8s.io/ingress-nginx
  parameters:
    apiGroup: k8s.nginx.org
    kind: IngressClassParameters
    name: nginx-internal-params
---
apiVersion: k8s.nginx.org/v1alpha1
kind: IngressClassParameters
metadata:
  name: nginx-internal-params
  namespace: ingress-nginx
spec:
  # Internal ingress binds to a separate LoadBalancer (private IP)
  ingressClassByName: true
  loadBalancerIP: "10.0.1.100"
---
# Separate controller Deployment for internal ingress
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingress-nginx-internal
  namespace: ingress-nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
      app.kubernetes.io/component: controller
      app.kubernetes.io/instance: internal
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ingress-nginx
        app.kubernetes.io/component: controller
        app.kubernetes.io/instance: internal
    spec:
      containers:
      - name: controller
        image: registry.k8s.io/ingress-nginx/controller:v1.10.0
        args:
        - /nginx-ingress-controller
        - --controller-class=k8s.io/ingress-nginx
        - --ingress-class=nginx-internal
        - --configmap=ingress-nginx/ingress-nginx-internal
        - --election-id=ingress-nginx-internal
        - --watch-namespace=internal
```

## Summary

NGINX Ingress Controller production configuration extends far beyond basic routing:

**Global ConfigMap** controls security headers, TLS cipher suites, logging format, and connection pooling for all ingresses. Set strong cipher suites, enable HSTS, configure real IP handling for your load balancer topology.

**cert-manager** automates TLS certificate lifecycle with Let's Encrypt or internal CA. Use DNS-01 challenge for wildcard certificates. Set up both staging and production ClusterIssuers.

**oauth2-proxy** provides OIDC authentication delegation for internal services without modifying applications. The `auth-url` annotation makes any service require authentication with a single annotation.

**Rate limiting** with `limit-rpm` and `limit-rps` annotations provides per-IP protection. Whitelist internal IPs and load balancer ranges. Return 429 instead of 503 so clients can retry appropriately.

**Canary deployments** split traffic by weight, cookie, or header. Use weight-based splitting for gradual rollouts and cookie-based splitting for opt-in testing.

**ModSecurity WAF** starts in DetectionOnly mode. Tune false positives using audit logs before switching to blocking mode. Apply blocking mode per-ingress rather than globally.

**Monitoring** with PrometheusRule alerts on 5xx rates, p99 latency, and configuration reload failures catches issues before users report them.
