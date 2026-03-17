---
title: "Kubernetes Keycloak Gatekeeper: OIDC Proxy for Legacy Application Authentication"
date: 2031-05-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Keycloak", "OIDC", "Authentication", "Security", "oauth2-proxy", "Service Mesh"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to deploying Keycloak Gatekeeper and oauth2-proxy as OIDC authentication proxies for legacy Kubernetes applications, covering sidecar patterns, authorization policies, token management, and migration strategies."
more_link: "yes"
url: "/kubernetes-keycloak-gatekeeper-oidc-proxy-legacy-auth/"
---

Legacy applications that predate modern authentication standards are a persistent challenge in Kubernetes environments. An app built before OIDC/OAuth2 became ubiquitous has no concept of JWTs, token introspection, or role-based access policies. Rebuilding authentication is expensive and risky. The sidecar proxy pattern — placing an authentication gateway in front of the legacy app — solves this without modifying application code.

Keycloak Gatekeeper (now maintained as louketo-proxy) was the canonical solution for Keycloak-integrated environments. As the project matured and use cases expanded, oauth2-proxy emerged as the more actively maintained, multi-IdP alternative. This guide covers both, with a focus on getting real workloads secured in production.

<!--more-->

# Kubernetes Keycloak Gatekeeper: OIDC Proxy for Legacy Application Authentication

## Section 1: Architecture Overview

The proxy intercepts all HTTP traffic before it reaches the application, validates OIDC tokens, enforces authorization policies, and injects claims as headers that the application can optionally consume:

```
Internet → Ingress → Gatekeeper Sidecar → Legacy App Container
                            │
                    OIDC Discovery
                            │
                       Keycloak
```

In sidecar mode, both containers share the same pod network namespace. The app only listens on localhost, and the proxy listens on the external-facing port. No network policy can bypass the proxy — traffic must flow through it.

### 1.1 Deployment Patterns

**Pattern 1: Sidecar (Recommended)**
- Gatekeeper and app in the same pod
- App listens on `localhost:8080`
- Gatekeeper listens on `0.0.0.0:3000`
- Strongest security posture (app not reachable without proxy)

**Pattern 2: Reverse Proxy Deployment**
- Gatekeeper as a separate Deployment
- App as a separate Deployment
- Gatekeeper proxies to app's ClusterIP service
- Easier to manage independently, but requires network policies to prevent bypass

**Pattern 3: Ingress-Integrated**
- External auth via NGINX `auth_request` or Traefik ForwardAuth
- Gatekeeper runs as a validation service
- Token validated but not proxied (lighter weight)

## Section 2: Keycloak Setup

### 2.1 Create the OIDC Client

In Keycloak admin console:

```bash
# Using Keycloak CLI (kcadm.sh)
# Login to admin
kcadm.sh config credentials \
  --server https://keycloak.example.com \
  --realm master \
  --user admin

# Create realm if needed
kcadm.sh create realms \
  -s realm=myapp \
  -s enabled=true

# Create client
kcadm.sh create clients -r myapp \
  -s clientId=my-legacy-app \
  -s "redirectUris=[\"https://myapp.example.com/oauth/callback\"]" \
  -s "webOrigins=[\"https://myapp.example.com\"]" \
  -s publicClient=false \
  -s protocol=openid-connect \
  -s standardFlowEnabled=true \
  -s directAccessGrantsEnabled=false \
  -s serviceAccountsEnabled=false \
  -s 'attributes={"access.token.lifespan":"900","client.session.idle.timeout":"1800"}'

# Get the client secret
CLIENT_ID=$(kcadm.sh get clients -r myapp -q clientId=my-legacy-app --fields id -c | jq -r '.[0].id')
kcadm.sh get clients/$CLIENT_ID/client-secret -r myapp
```

### 2.2 Create Client Roles

```bash
# Create roles for authorization
kcadm.sh create clients/$CLIENT_ID/roles -r myapp -s name=admin -s description="Admin users"
kcadm.sh create clients/$CLIENT_ID/roles -r myapp -s name=editor -s description="Editor users"
kcadm.sh create clients/$CLIENT_ID/roles -r myapp -s name=viewer -s description="Read-only users"

# Create groups for team-based access
kcadm.sh create groups -r myapp -s name=platform-team
kcadm.sh create groups -r myapp -s name=app-team
```

## Section 3: Louketo-Proxy (Keycloak Gatekeeper) Deployment

### 3.1 Sidecar Deployment

```yaml
# deployment-with-gatekeeper.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-app
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: legacy-app
  template:
    metadata:
      labels:
        app: legacy-app
    spec:
      volumes:
        - name: gatekeeper-config
          configMap:
            name: gatekeeper-config
        - name: gatekeeper-secrets
          secret:
            secretName: gatekeeper-secrets
      containers:
        # The legacy application - only listens on localhost
        - name: app
          image: registry.corp.example.com/legacy-app:v2.3.1
          ports:
            - containerPort: 8080
              protocol: TCP
          env:
            - name: LISTEN_ADDR
              value: "127.0.0.1:8080"
            # Inject Keycloak user info via headers
            - name: REMOTE_USER_HEADER
              value: "X-Auth-Username"
            - name: REMOTE_EMAIL_HEADER
              value: "X-Auth-Email"
            - name: REMOTE_ROLES_HEADER
              value: "X-Auth-Roles"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi

        # Keycloak Gatekeeper sidecar
        - name: gatekeeper
          image: quay.io/louketo/louketo-proxy:1.0.0
          imagePullPolicy: IfNotPresent
          args:
            - --config=/etc/gatekeeper/config.yaml
          ports:
            - containerPort: 3000
              name: http
              protocol: TCP
            - containerPort: 9090
              name: metrics
              protocol: TCP
          volumeMounts:
            - name: gatekeeper-config
              mountPath: /etc/gatekeeper
            - name: gatekeeper-secrets
              mountPath: /etc/gatekeeper-secrets
          livenessProbe:
            httpGet:
              path: /oauth/health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /oauth/health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 32Mi
            limits:
              cpu: 200m
              memory: 128Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
            capabilities:
              drop: ["ALL"]
---
apiVersion: v1
kind: Service
metadata:
  name: legacy-app
  namespace: production
spec:
  selector:
    app: legacy-app
  ports:
    - name: http
      port: 80
      targetPort: 3000  # Routes to gatekeeper, not the app directly
```

### 3.2 Gatekeeper Configuration

```yaml
# configmap-gatekeeper.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gatekeeper-config
  namespace: production
data:
  config.yaml: |
    # Keycloak OIDC discovery URL
    discovery-url: https://keycloak.example.com/realms/myapp

    # Client credentials (referenced from secret via env vars)
    client-id: my-legacy-app
    client-secret: $(GATEKEEPER_CLIENT_SECRET)

    # Where gatekeeper listens
    listen: 0.0.0.0:3000

    # Where to proxy authenticated requests
    upstream-url: http://127.0.0.1:8080

    # Redirect URI (must match Keycloak client config)
    redirection-url: https://myapp.example.com

    # Enable mutual TLS for upstream
    upstream-keepalives: true
    upstream-timeout: 10s
    upstream-response-header-timeout: 10s
    upstream-tls-handshake-timeout: 10s

    # Session security (generate a unique encryption key per deployment)
    encryption-key: $(GATEKEEPER_ENCRYPTION_KEY)

    # Cookie settings
    cookie-domain: example.com
    cookie-access-name: kc_access
    cookie-refresh-name: kc_state
    same-site-cookie: Strict
    http-only-cookie: true
    secure-cookie: true

    # Token settings
    access-token-duration: 15m
    enable-refresh-tokens: true

    # Security headers
    add-headers:
      X-Frame-Options: DENY
      X-Content-Type-Options: nosniff
      X-XSS-Protection: "1; mode=block"
      Strict-Transport-Security: "max-age=31536000; includeSubDomains"
      Content-Security-Policy: "default-src 'self'"

    # Headers to forward to upstream
    enable-token-header: false  # Don't forward raw token
    enable-authorization-header: true
    enable-authorization-cookies: false

    # Custom claim headers
    headers:
      X-Auth-Username: preferred_username
      X-Auth-Email: email
      X-Auth-Roles: "realm_access.roles"

    # Authorization resources
    resources:
      # Allow health check without authentication
      - uri: /health
        white-listed: true
      - uri: /metrics
        white-listed: true

      # Require authentication for all other paths
      - uri: /*
        roles:
          - "my-legacy-app:viewer"
          - "my-legacy-app:editor"
          - "my-legacy-app:admin"

      # Restrict admin paths to admin role
      - uri: /admin/*
        roles:
          - "my-legacy-app:admin"

      # API endpoints require editor or admin
      - uri: /api/v1/write*
        methods:
          - POST
          - PUT
          - DELETE
        roles:
          - "my-legacy-app:editor"
          - "my-legacy-app:admin"

    # CORS configuration
    cors-origins:
      - https://myapp.example.com
    cors-methods:
      - GET
      - POST
      - PUT
      - DELETE
      - OPTIONS
    cors-headers:
      - Content-Type
      - Authorization
    cors-credentials: false

    # Scopes to request
    scopes:
      - openid
      - profile
      - email

    # Enable metrics endpoint
    enable-metrics: true
    metrics-listen: 0.0.0.0:9090

    # Logging
    log-format: json
    verbose: false
    enable-logging: true
    enable-json-logging: true
    log-request: true
```

```yaml
# secret-gatekeeper.yaml
apiVersion: v1
kind: Secret
metadata:
  name: gatekeeper-secrets
  namespace: production
type: Opaque
stringData:
  client-secret: "<keycloak-client-secret>"
  encryption-key: "<32-byte-random-hex-key>"
---
# Inject secrets as environment variables
apiVersion: v1
kind: ConfigMap
metadata:
  name: gatekeeper-env
  namespace: production
data:
  # Reference secrets in the container spec
  GATEKEEPER_CLIENT_SECRET:
    valueFrom:
      secretKeyRef:
        name: gatekeeper-secrets
        key: client-secret
```

Actually, for secret injection into the config file, use environment variable expansion in the container spec:

```yaml
# In the gatekeeper container spec:
env:
  - name: GATEKEEPER_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: gatekeeper-secrets
        key: client-secret
  - name: GATEKEEPER_ENCRYPTION_KEY
    valueFrom:
      secretKeyRef:
        name: gatekeeper-secrets
        key: encryption-key
```

### 3.3 Group-Based Authorization

```yaml
# Group-based access control in gatekeeper config
resources:
  - uri: /admin/*
    groups:
      - platform-team

  - uri: /reports/*
    groups:
      - platform-team
      - reporting-team

  # Combine group AND role requirements
  - uri: /sensitive/*
    groups:
      - platform-team
    roles:
      - "my-legacy-app:admin"
    require-any-role: false  # Must satisfy BOTH group AND role
```

### 3.4 Token Refresh and Session Management

```yaml
# Advanced token configuration
enable-refresh-tokens: true
# How often to check if refresh is needed
refresh-token-interval: 30s
# How close to expiry before refreshing
enable-login-handler: true

# Logout configuration
enable-logout-redirect: true
# Redirect to Keycloak's logout endpoint
logout-redirect: https://keycloak.example.com/realms/myapp/protocol/openid-connect/logout?post_logout_redirect_uri=https://myapp.example.com

# Session store - use Redis for multi-replica deployments
store-url: redis://redis:6379/0
```

## Section 4: oauth2-proxy — The Modern Alternative

oauth2-proxy is more actively maintained, supports multiple identity providers (Keycloak, Google, GitHub, Azure AD), and has better Kubernetes integration. It is the recommended choice for new deployments.

### 4.1 oauth2-proxy Configuration for Keycloak

```yaml
# configmap-oauth2-proxy.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: oauth2-proxy-config
  namespace: production
data:
  oauth2_proxy.cfg: |
    # Provider configuration
    provider = "oidc"
    provider_display_name = "Keycloak"
    oidc_issuer_url = "https://keycloak.example.com/realms/myapp"

    # Client configuration
    client_id = "my-legacy-app"
    # client_secret set via OAUTH2_PROXY_CLIENT_SECRET env var

    # Where to listen
    http_address = "0.0.0.0:4180"

    # Upstream application
    upstreams = ["http://127.0.0.1:8080"]

    # Cookie configuration
    cookie_name = "_oauth2_proxy"
    cookie_secret = ""  # Set via OAUTH2_PROXY_COOKIE_SECRET env var
    cookie_domains = [".example.com"]
    cookie_expire = "168h"    # 7 days
    cookie_refresh = "1h"     # Refresh token every hour
    cookie_httponly = true
    cookie_secure = true
    cookie_samesite = "lax"

    # Redirect URL
    redirect_url = "https://myapp.example.com/oauth2/callback"

    # Email/domain allowlist (or use allowed_groups for group-based auth)
    # email_domains = ["example.com"]  # Restrict by email domain

    # Group-based access control
    allowed_groups = ["/platform-team", "/app-team"]
    oidc_groups_claim = "groups"

    # Inject user info headers
    set_xauthrequest = true
    set_authorization_header = false

    # Custom headers to upstream
    pass_user_headers = true
    pass_access_token = false  # Don't pass raw JWT to app

    # Skip authentication for health endpoints
    skip_auth_routes = [
      "GET=^/health",
      "GET=^/metrics",
      "GET=^/favicon.ico"
    ]

    # Logging
    request_logging = true
    auth_logging = true
    standard_logging = true

    # Session storage (cookie-based by default, Redis for multi-pod)
    session_store_type = "redis"
    redis_connection_url = "redis://redis:6379/1"

    # Metrics
    metrics_address = "0.0.0.0:9090"

    # Scope
    scope = "openid email profile groups"

    # OIDC extra audiences
    oidc_extra_audiences = ["account"]

    # Prompt user to select account
    prompt = ""

    # Skip provider button (go directly to IdP)
    skip_provider_button = true
```

### 4.2 oauth2-proxy Deployment

```yaml
# deployment-oauth2-proxy-sidecar.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: legacy-app
  template:
    metadata:
      labels:
        app: legacy-app
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      volumes:
        - name: proxy-config
          configMap:
            name: oauth2-proxy-config
      containers:
        - name: app
          image: registry.corp.example.com/legacy-app:v2.3.1
          ports:
            - containerPort: 8080
          env:
            - name: LISTEN_ADDR
              value: "127.0.0.1:8080"
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi

        - name: oauth2-proxy
          image: quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
          args:
            - --config=/etc/oauth2-proxy/oauth2_proxy.cfg
            - --alpha-config=/etc/oauth2-proxy/alpha_config.yaml
          ports:
            - containerPort: 4180
              name: http
            - containerPort: 9090
              name: metrics
          volumeMounts:
            - name: proxy-config
              mountPath: /etc/oauth2-proxy
          env:
            - name: OAUTH2_PROXY_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: oauth2-proxy-secrets
                  key: client-secret
            - name: OAUTH2_PROXY_COOKIE_SECRET
              valueFrom:
                secretKeyRef:
                  name: oauth2-proxy-secrets
                  key: cookie-secret
          livenessProbe:
            httpGet:
              path: /ping
              port: 4180
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /ready
              port: 4180
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 25m
              memory: 32Mi
            limits:
              cpu: 100m
              memory: 128Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 2000
            capabilities:
              drop: ["ALL"]
---
apiVersion: v1
kind: Secret
metadata:
  name: oauth2-proxy-secrets
  namespace: production
type: Opaque
stringData:
  client-secret: "<keycloak-client-secret>"
  # Generate with: python3 -c 'import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())'
  cookie-secret: "<32-byte-base64-encoded-secret>"
```

### 4.3 Alpha Config for Fine-Grained Authorization

oauth2-proxy v7+ supports alpha configuration for advanced routing:

```yaml
# configmap-alpha-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: oauth2-proxy-alpha-config
  namespace: production
data:
  alpha_config.yaml: |
    server:
      BindAddress: "0.0.0.0:4180"
      MetricsBindAddress: "0.0.0.0:9090"
      SecureBindAddress: ""

    upstreamConfig:
      upstreams:
        - id: legacy-app
          path: /
          uri: http://127.0.0.1:8080
          flushInterval: 1s
          passHostHeader: true

    injectRequestHeaders:
      - name: X-Auth-Request-User
        values:
          - claim: preferred_username
      - name: X-Auth-Request-Email
        values:
          - claim: email
      - name: X-Auth-Request-Groups
        values:
          - claim: groups
      - name: X-Auth-Request-Roles
        values:
          - claim: realm_access.roles

    injectResponseHeaders:
      - name: X-Auth-Request-User
        values:
          - claim: preferred_username

    authRoutes:
      # Skip auth for health check
      - path: /health
        allowedGroups: []  # Empty = allow all (no auth required)

      # Admin paths restricted to platform-team
      - path: /admin/
        allowedGroups:
          - /platform-team

      # API write operations restricted to app-team or platform-team
      - path: /api/
        allowedGroups:
          - /app-team
          - /platform-team
```

## Section 5: Ingress Integration

### 5.1 NGINX Ingress External Auth

For a reverse proxy pattern where oauth2-proxy validates tokens but runs separately:

```yaml
# ingress-with-oauth2-proxy.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: legacy-app
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/auth-url: "https://$host/oauth2/auth"
    nginx.ingress.kubernetes.io/auth-signin: "https://$host/oauth2/start?rd=$escaped_request_uri"
    nginx.ingress.kubernetes.io/auth-response-headers: >-
      X-Auth-Request-User,
      X-Auth-Request-Email,
      X-Auth-Request-Groups
    nginx.ingress.kubernetes.io/auth-snippet: |
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - myapp.example.com
      secretName: myapp-tls-cert
  rules:
    - host: myapp.example.com
      http:
        paths:
          - path: /oauth2
            pathType: Prefix
            backend:
              service:
                name: oauth2-proxy
                port:
                  number: 4180
          - path: /
            pathType: Prefix
            backend:
              service:
                name: legacy-app
                port:
                  number: 80
---
# Separate Deployment for oauth2-proxy in reverse proxy mode
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oauth2-proxy
  namespace: production
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
            - --config=/etc/oauth2-proxy/oauth2_proxy.cfg
            - --upstream=http://legacy-app.production.svc.cluster.local
          # ... rest of config
```

### 5.2 Traefik ForwardAuth Middleware

```yaml
# traefik-forwardauth-middleware.yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: oauth2-proxy-auth
  namespace: production
spec:
  forwardAuth:
    address: http://oauth2-proxy.production.svc.cluster.local:4180/oauth2/auth
    trustForwardHeader: true
    authResponseHeaders:
      - X-Auth-Request-User
      - X-Auth-Request-Email
      - X-Auth-Request-Groups
      - X-Auth-Request-Access-Token
    authRequestHeaders:
      - Accept
      - X-Forwarded-Host
      - X-Forwarded-URI
      - X-Forwarded-For
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: legacy-app
  namespace: production
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: production-oauth2-proxy-auth@kubernetescrd
```

## Section 6: Logout Handling

### 6.1 Complete Logout Flow

```yaml
# In oauth2-proxy config
# oauth2-proxy handles logout at /oauth2/sign_out
# Also clear Keycloak session for true SSO logout

# In your app, redirect logout to:
# https://myapp.example.com/oauth2/sign_out?rd=https://keycloak.example.com/realms/myapp/protocol/openid-connect/logout?post_logout_redirect_uri=https://myapp.example.com

# oauth2-proxy config for logout
# whitelist_domains needed for redirect
whitelist_domains = [
  ".example.com",
  "keycloak.example.com"
]
```

### 6.2 Session Invalidation

```bash
# Revoke tokens in Keycloak when needed (e.g., security incident)
# Get admin token
ADMIN_TOKEN=$(curl -s -X POST \
  https://keycloak.example.com/realms/master/protocol/openid-connect/token \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=<admin-password>" \
  | jq -r '.access_token')

# List sessions for a user
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://keycloak.example.com/admin/realms/myapp/users?username=compromised-user" | jq '.[0].id'

USER_ID="<user-id>"

# Delete all sessions for the user
curl -s -X DELETE \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://keycloak.example.com/admin/realms/myapp/users/$USER_ID/sessions"

# Revoke all tokens for the client
curl -s -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://keycloak.example.com/admin/realms/myapp/clients/<client-uuid>/push-revocation"
```

## Section 7: Monitoring and Observability

### 7.1 oauth2-proxy Metrics

oauth2-proxy exposes Prometheus metrics at `/metrics`:

```yaml
# prometheus-service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: oauth2-proxy
  namespace: production
spec:
  selector:
    matchLabels:
      app: legacy-app
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
```

Key metrics to alert on:

```yaml
# prometheus-rules-oauth2-proxy.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: oauth2-proxy-alerts
  namespace: production
spec:
  groups:
    - name: oauth2-proxy
      rules:
        - alert: OAuth2ProxyHighErrorRate
          expr: |
            rate(oauth2_proxy_requests_total{status=~"5.."}[5m]) /
            rate(oauth2_proxy_requests_total[5m]) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "oauth2-proxy error rate above 5%"

        - alert: OAuth2ProxyAuthFailureSpike
          expr: |
            rate(oauth2_proxy_requests_total{status="401"}[5m]) > 10
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High authentication failure rate - possible brute force"

        - alert: OAuth2ProxyDown
          expr: up{job="oauth2-proxy"} == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "oauth2-proxy is down - application authentication broken"
```

## Section 8: Migrating from Gatekeeper to oauth2-proxy

### 8.1 Migration Strategy

The migration can be done with zero downtime using a canary approach:

1. Deploy oauth2-proxy alongside existing Gatekeeper
2. Route 5% of traffic to oauth2-proxy pod
3. Monitor error rates
4. Gradually increase to 100%
5. Remove Gatekeeper

### 8.2 Configuration Mapping

| Gatekeeper Config | oauth2-proxy Equivalent |
|---|---|
| `client-id` | `client_id` |
| `client-secret` | `client_secret` (env var) |
| `discovery-url` | `oidc_issuer_url` |
| `upstream-url` | `upstreams` |
| `redirection-url` | `redirect_url` |
| `encryption-key` | `cookie_secret` |
| `resources[].uri` with `roles` | `allowed_groups` + custom logic |
| `headers` claim mapping | `injectRequestHeaders` (alpha config) |
| `white-listed: true` | `skip_auth_routes` |
| `cors-origins` | Built-in CORS handling |

### 8.3 Key Differences to Plan For

```bash
# Gatekeeper supports role-based path restrictions natively
# oauth2-proxy uses group-based access

# In Keycloak, map roles to groups for migration:
kcadm.sh update groups/$GROUP_ID/role-mappings/clients/$CLIENT_ID -r myapp \
  -b '[{"id":"<role-id>","name":"admin"}]'

# oauth2-proxy uses /oauth2/* path prefix (Gatekeeper used /oauth/)
# Update your redirect URIs in Keycloak:
kcadm.sh update clients/$CLIENT_ID -r myapp \
  -s 'redirectUris=["https://myapp.example.com/oauth2/callback"]'

# Cookie names change - users will need to re-authenticate
# Plan maintenance window or use --cookie-expire=0 to force immediate re-auth
```

The sidecar proxy pattern provides transparent authentication for legacy applications without requiring any code changes. Whether you use Keycloak Gatekeeper for existing Keycloak integrations or oauth2-proxy for its broader IdP support, the architectural approach is the same: intercept, validate, authorize, and forward with enriched headers.
