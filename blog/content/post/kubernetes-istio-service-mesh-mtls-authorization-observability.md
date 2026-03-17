---
title: "Kubernetes Istio Service Mesh: mTLS, Authorization Policies, and Observability"
date: 2029-06-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Istio", "Service Mesh", "mTLS", "Security", "Observability", "Envoy"]
categories: ["Kubernetes", "Security", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to securing Kubernetes workloads with Istio's PeerAuthentication, RequestAuthentication, and AuthorizationPolicy resources, combined with the Telemetry API, Envoy access logs, and Kiali visualization."
more_link: "yes"
url: "/kubernetes-istio-service-mesh-mtls-authorization-observability/"
---

Istio remains the most feature-complete service mesh available for Kubernetes, but its breadth of capabilities is also its steepest learning curve. Teams frequently deploy Istio for mTLS and then discover that getting authorization policies, telemetry pipelines, and Kiali dashboards all working together requires careful sequencing. This guide walks through each layer end-to-end: from bootstrapping mutual TLS across a namespace, to fine-grained JWT-based authorization, to shipping structured Envoy access logs into your observability stack.

<!--more-->

# Kubernetes Istio Service Mesh: mTLS, Authorization Policies, and Observability

## Section 1: Istio Architecture and Control Plane Components

Istio's control plane is consolidated into a single binary, `istiod`, which serves three functions: certificate authority (CA), configuration distribution (xDS), and service discovery aggregation. Every sidecar proxy (Envoy) connects to istiod over gRPC and receives:

- **LDS** (Listener Discovery Service): what ports to listen on
- **RDS** (Route Discovery Service): HTTP routing rules
- **CDS** (Cluster Discovery Service): upstream service definitions
- **EDS** (Endpoint Discovery Service): healthy pod IPs per cluster
- **SDS** (Secret Discovery Service): TLS certificates and keys

Understanding this matters when debugging policy failures. A policy applied to the wrong resource kind (e.g., a `VirtualService` instead of an `AuthorizationPolicy`) will silently have no effect.

### Install Istio with Production Profile

```bash
# Download and install istioctl
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.21.0 sh -
export PATH="$PWD/istio-1.21.0/bin:$PATH"

# Verify pre-flight checks
istioctl x precheck

# Install with production profile
istioctl install --set profile=default \
  --set values.pilot.traceSampling=1.0 \
  --set values.global.proxy.resources.requests.cpu=100m \
  --set values.global.proxy.resources.requests.memory=128Mi \
  --set values.global.proxy.resources.limits.cpu=2000m \
  --set values.global.proxy.resources.limits.memory=1024Mi \
  -y

# Verify control plane health
kubectl get pods -n istio-system
istioctl analyze
```

For GitOps workflows, prefer the IstioOperator manifest:

```yaml
# istio-operator.yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: control-plane
  namespace: istio-system
spec:
  profile: default
  meshConfig:
    accessLogFile: /dev/stdout
    accessLogEncoding: JSON
    enableTracing: true
    defaultConfig:
      tracing:
        sampling: 1.0
        zipkin:
          address: jaeger-collector.observability:9411
    outboundTrafficPolicy:
      mode: REGISTRY_ONLY
  components:
    pilot:
      k8s:
        resources:
          requests:
            cpu: 500m
            memory: 2048Mi
          limits:
            cpu: 2000m
            memory: 4096Mi
        hpaSpec:
          minReplicas: 2
          maxReplicas: 5
    ingressGateways:
    - name: istio-ingressgateway
      enabled: true
      k8s:
        hpaSpec:
          minReplicas: 2
          maxReplicas: 10
        service:
          type: LoadBalancer
```

```bash
istioctl install -f istio-operator.yaml -y
```

### Enable Sidecar Injection

Sidecar injection is enabled per-namespace via label:

```bash
# Enable automatic injection for a namespace
kubectl label namespace production istio-injection=enabled

# Verify injection is enabled
kubectl get namespace production --show-labels

# Roll existing deployments to inject sidecars
kubectl rollout restart deployment -n production
```

To verify sidecars are injected:

```bash
kubectl get pods -n production -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.name}{","}{end}{"\n"}{end}'
```

Each pod should show `app-container,istio-proxy` in its container list.

---

## Section 2: PeerAuthentication — Enforcing mTLS

`PeerAuthentication` controls how Envoy handles inbound traffic: whether it accepts plaintext, mTLS only, or both (PERMISSIVE mode). PERMISSIVE is the migration path; STRICT is the production target.

### Namespace-Wide STRICT mTLS

```yaml
# peer-auth-strict.yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
```

```bash
kubectl apply -f peer-auth-strict.yaml

# Verify no plaintext connections succeed
kubectl run curl-test --image=curlimages/curl --rm -it --restart=Never \
  -- curl -v http://myservice.production.svc.cluster.local:8080/health
# Should fail with connection reset
```

### Port-Level mTLS Overrides

Some services expose ports that cannot use mTLS (e.g., a metrics scraper that cannot present a client cert). Override at the port level:

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: myservice-override
  namespace: production
spec:
  selector:
    matchLabels:
      app: myservice
  mtls:
    mode: STRICT
  portLevelMtls:
    9090:
      mode: DISABLE   # Prometheus scrape port
    8443:
      mode: STRICT    # gRPC API port
```

### Checking mTLS Status

```bash
# Show mTLS status between two services
istioctl x describe pod myservice-pod-xyz -n production

# Check effective peer authentication policies
kubectl get peerauthentication -A

# Verify Envoy sees client certs on incoming connections
kubectl exec -n production myservice-pod-xyz -c istio-proxy -- \
  pilot-agent request GET /certs | jq .
```

---

## Section 3: RequestAuthentication — JWT Validation

`RequestAuthentication` tells Envoy how to validate bearer tokens. It does not enforce authorization — it only validates and extracts JWT claims. Use `AuthorizationPolicy` to actually deny requests.

```yaml
# request-auth-jwt.yaml
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-gateway
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"
    audiences:
    - "api.example.com"
    forwardOriginalToken: true
    outputClaimToHeaders:
    - header: x-jwt-sub
      claim: sub
    - header: x-jwt-groups
      claim: groups
```

Key fields:
- `jwksUri`: Envoy fetches this URL to get public keys for signature verification. It is cached and refreshed.
- `forwardOriginalToken`: Pass the raw `Authorization` header upstream so the application can re-validate if needed.
- `outputClaimToHeaders`: Extract claims into request headers, making them available to upstream services without token parsing.

### Multi-Issuer Support

For environments with multiple identity providers:

```yaml
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: multi-issuer-jwt
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-gateway
  jwtRules:
  - issuer: "https://accounts.google.com"
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs"
    audiences:
    - "your-google-client-id.apps.googleusercontent.com"
  - issuer: "https://login.microsoftonline.com/tenant-id/v2.0"
    jwksUri: "https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys"
    audiences:
    - "your-azure-app-id"
  - issuer: "https://auth.internal.example.com"
    jwksUri: "https://auth.internal.example.com/.well-known/jwks.json"
    audiences:
    - "internal-services"
```

A request with a valid token from any of these issuers will have its claims extracted. A request with an invalid token is rejected with 401. A request with no token is passed through (enforcement requires `AuthorizationPolicy`).

---

## Section 4: AuthorizationPolicy — Fine-Grained Access Control

`AuthorizationPolicy` is where you enforce rules. The default deny-all behavior when policies exist is a common source of confusion: if any policy selects a workload, requests not matched by an ALLOW policy are denied.

### Deny All by Default

```yaml
# deny-all.yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: deny-all
  namespace: production
spec:
  {}  # Empty spec = deny all traffic to all workloads in namespace
```

### Allow Specific Sources

```yaml
# allow-frontend-to-backend.yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-frontend-to-backend
  namespace: production
spec:
  selector:
    matchLabels:
      app: backend-api
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        - "cluster.local/ns/production/sa/frontend"
        - "cluster.local/ns/production/sa/admin-tool"
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/*"]
    when:
    - key: request.headers[x-request-id]
      notValues: [""]  # Require correlation ID header
```

### JWT Claim-Based Authorization

```yaml
# allow-admin-jwt.yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-admin-operations
  namespace: production
spec:
  selector:
    matchLabels:
      app: admin-service
  action: ALLOW
  rules:
  - from:
    - source:
        requestPrincipals: ["https://auth.example.com/*"]
    when:
    - key: request.auth.claims[groups]
      values: ["platform-admins", "site-reliability"]
    - key: request.auth.claims[email_verified]
      values: ["true"]
    to:
    - operation:
        methods: ["GET", "POST", "DELETE"]
```

### CUSTOM Action with External Authorization

For complex business logic, delegate to an external authorization service:

```yaml
# Register the external authorizer in mesh config
apiVersion: v1
kind: ConfigMap
metadata:
  name: istio
  namespace: istio-system
data:
  mesh: |
    extensionProviders:
    - name: opa-authorizer
      envoyExtAuthzGrpc:
        service: opa.policy-system.svc.cluster.local
        port: 9191
---
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: opa-custom-auth
  namespace: production
spec:
  selector:
    matchLabels:
      app: sensitive-service
  action: CUSTOM
  provider:
    name: opa-authorizer
  rules:
  - to:
    - operation:
        paths: ["/admin/*", "/config/*"]
```

---

## Section 5: Telemetry API — Metrics and Access Log Configuration

The Telemetry API (v1alpha1, promoted to v1 in Istio 1.20) replaces the legacy `EnvoyFilter`-based approach for configuring metrics and logs. It operates at mesh, namespace, and workload scope.

### Customize Metrics

```yaml
# telemetry-metrics.yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: custom-metrics
  namespace: production
spec:
  selector:
    matchLabels:
      app: payment-service
  metrics:
  - providers:
    - name: prometheus
    overrides:
    - match:
        metric: REQUEST_COUNT
        mode: CLIENT_AND_SERVER
      tagOverrides:
        payment_tier:
          value: "request.headers['x-payment-tier'] | 'unknown'"
        response_code_class:
          value: "response.code / 100 | 0"
    - match:
        metric: REQUEST_DURATION
      disabled: false
    - match:
        metric: REQUEST_BYTES
      disabled: true   # Disable noisy metric
```

### Configure Access Logs

```yaml
# telemetry-access-logs.yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: access-logs
  namespace: production
spec:
  accessLogging:
  - providers:
    - name: envoy
    filter:
      expression: "response.code >= 400 || request.duration > duration('1s')"
```

This filters access logs to only errors and slow requests — dramatically reducing log volume in high-traffic environments.

### Mesh-Wide Telemetry Defaults

Apply at the `istio-system` namespace without a selector to set mesh-wide defaults:

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: mesh-defaults
  namespace: istio-system
spec:
  metrics:
  - providers:
    - name: prometheus
  tracing:
  - providers:
    - name: zipkin
    randomSamplingPercentage: 1.0
    customTags:
      environment:
        literal:
          value: "production"
      version:
        header:
          name: x-app-version
          defaultValue: "unknown"
  accessLogging:
  - providers:
    - name: envoy
```

---

## Section 6: Envoy Access Log Format and Parsing

### Default JSON Access Log Configuration

Istio's `accessLogFile: /dev/stdout` with `accessLogEncoding: JSON` produces structured logs. The default fields are extensive but can be tuned.

To see the raw Envoy access log format:

```bash
kubectl exec -n production myservice-pod -c istio-proxy -- \
  pilot-agent request GET /config_dump | \
  jq '.configs[] | select(.["@type"] | contains("ListenersConfigDump")) | .dynamic_listeners[0].active_state.listener.access_log'
```

### Custom Access Log Format

Define a custom format via EnvoyFilter (use Telemetry API when possible):

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: custom-access-log-format
  namespace: istio-system
spec:
  configPatches:
  - applyTo: NETWORK_FILTER
    match:
      context: ANY
      listener:
        filterChain:
          filter:
            name: envoy.filters.network.http_connection_manager
    patch:
      operation: MERGE
      value:
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          access_log:
          - name: envoy.access_loggers.file
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog
              path: /dev/stdout
              log_format:
                json_format:
                  timestamp: "%START_TIME%"
                  method: "%REQ(:METHOD)%"
                  path: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"
                  protocol: "%PROTOCOL%"
                  response_code: "%RESPONSE_CODE%"
                  response_flags: "%RESPONSE_FLAGS%"
                  bytes_received: "%BYTES_RECEIVED%"
                  bytes_sent: "%BYTES_SENT%"
                  duration_ms: "%DURATION%"
                  upstream_service_time: "%RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)%"
                  x_forwarded_for: "%REQ(X-FORWARDED-FOR)%"
                  user_agent: "%REQ(USER-AGENT)%"
                  request_id: "%REQ(X-REQUEST-ID)%"
                  authority: "%REQ(:AUTHORITY)%"
                  upstream_host: "%UPSTREAM_HOST%"
                  upstream_cluster: "%UPSTREAM_CLUSTER%"
                  upstream_local_address: "%UPSTREAM_LOCAL_ADDRESS%"
                  downstream_remote_address: "%DOWNSTREAM_REMOTE_ADDRESS%"
                  downstream_local_address: "%DOWNSTREAM_LOCAL_ADDRESS%"
                  route_name: "%ROUTE_NAME%"
                  grpc_status: "%GRPC_STATUS%"
                  trace_id: "%REQ(X-B3-TRACEID)%"
                  span_id: "%REQ(X-B3-SPANID)%"
```

### Parsing Access Logs in Loki

With logs shipped to Loki via Promtail, use LogQL to analyze patterns:

```logql
# High error rate by service
sum by (upstream_cluster) (
  rate({namespace="production", container="istio-proxy"}
    | json
    | response_code >= 500
    [5m])
)

# P99 latency estimate (Loki metric query)
quantile_over_time(0.99,
  {namespace="production", container="istio-proxy"}
    | json
    | unwrap duration_ms
    [5m]
) by (upstream_cluster)

# Response flag analysis (circuit breaking, etc.)
{namespace="production", container="istio-proxy"}
  | json
  | response_flags != ""
  | line_format "{{.upstream_cluster}} {{.response_flags}} {{.response_code}}"
```

Common `RESPONSE_FLAGS` values and their meanings:
- `UH`: No healthy upstream
- `UF`: Upstream connection failure
- `UO`: Upstream overflow (circuit breaker)
- `NR`: No route configured
- `RL`: Rate limited
- `UAEX`: Unauthorized external service

---

## Section 7: Kiali — Service Mesh Visualization

Kiali provides real-time topology visualization, health indicators, and configuration validation. It reads from Prometheus metrics and Kubernetes API.

### Install Kiali

```bash
# Install via Istio addons (development)
kubectl apply -f https://raw.githubusercontent.com/istio/istio/release-1.21/samples/addons/kiali.yaml

# Production install via Helm
helm repo add kiali https://kiali.org/helm-charts
helm install kiali-operator kiali/kiali-operator \
  --namespace kiali-operator \
  --create-namespace

# Configure KialiCR
kubectl apply -f - <<'EOF'
apiVersion: kiali.io/v1alpha1
kind: Kiali
metadata:
  name: kiali
  namespace: istio-system
spec:
  auth:
    strategy: "token"
  deployment:
    accessible_namespaces:
    - "production"
    - "staging"
    replicas: 2
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
  external_services:
    prometheus:
      url: "http://prometheus-operated.monitoring:9090"
    grafana:
      enabled: true
      internal_url: "http://grafana.monitoring:3000"
      external_url: "https://grafana.example.com"
    tracing:
      enabled: true
      internal_url: "http://jaeger-query.observability:16685"
      external_url: "https://jaeger.example.com"
  server:
    web_root: "/kiali"
EOF
```

### Kiali Health Configuration

```yaml
# Override health thresholds per namespace
apiVersion: kiali.io/v1alpha1
kind: Kiali
metadata:
  name: kiali
  namespace: istio-system
spec:
  health_config:
    rate:
    - namespace: "production"
      kind: "Deployment"
      name: "payment-service"
      tolerance:
      - code: "5xx"
        failure: 1      # 1% failure = failure (default is 20%)
        degraded: 0.1   # 0.1% failure = degraded
      - code: "4xx"
        failure: 10
        degraded: 5
```

### Accessing Kiali

```bash
# Port-forward for local access
kubectl port-forward svc/kiali 20001:20001 -n istio-system &
open http://localhost:20001/kiali

# Or via Istio ingress gateway
kubectl apply -f - <<'EOF'
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: kiali
  namespace: istio-system
spec:
  hosts:
  - "kiali.example.com"
  gateways:
  - istio-system/main-gateway
  http:
  - route:
    - destination:
        host: kiali
        port:
          number: 20001
EOF
```

---

## Section 8: DestinationRule and Traffic Management

`DestinationRule` configures policies applied to traffic after routing — connection pooling, outlier detection, and TLS settings.

```yaml
# destination-rule-production.yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: payment-service
  namespace: production
spec:
  host: payment-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
        connectTimeout: 30ms
        tcpKeepalive:
          time: 7200s
          interval: 75s
      http:
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
        maxRequestsPerConnection: 10
        maxRetries: 3
        idleTimeout: 90s
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 30
    tls:
      mode: ISTIO_MUTUAL
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
    trafficPolicy:
      connectionPool:
        http:
          http2MaxRequests: 500   # Limit traffic to v2 during canary
```

---

## Section 9: Debugging Policy Issues

### Check Envoy Configuration Dump

```bash
# Full Envoy config dump
kubectl exec -n production myservice-pod -c istio-proxy -- \
  pilot-agent request GET /config_dump > config_dump.json

# Find effective route configuration
cat config_dump.json | jq '.configs[] |
  select(.["@type"] | contains("RoutesConfigDump")) |
  .dynamic_route_configs[].route_config.virtual_hosts[] |
  select(.name | contains("backend-api"))'

# Check authorization policy enforcement
cat config_dump.json | jq '.configs[] |
  select(.["@type"] | contains("ListenersConfigDump")) |
  .dynamic_listeners[].active_state.listener.filter_chains[].filters[] |
  select(.name == "envoy.filters.network.rbac") |
  .typed_config'
```

### istioctl proxy-status and proxy-config

```bash
# Check sync status across all proxies
istioctl proxy-status

# Check specific proxy's active listeners
istioctl proxy-config listener myservice-pod.production

# Check routes
istioctl proxy-config route myservice-pod.production --name 8080

# Check clusters
istioctl proxy-config cluster myservice-pod.production --direction inbound

# Check effective authorization policies
istioctl x authz check myservice-pod.production
```

### Common Policy Failures

**Problem: RBAC filter returning 403 for allowed traffic**

```bash
# Check if the source principal matches what the policy expects
istioctl x describe pod myservice-pod.production
# Look for "PeerAuthentication" and "AuthorizationPolicy" sections

# Verify certificate SANs
kubectl exec -n production myservice-pod -c istio-proxy -- \
  openssl s_client -connect backend-api:8080 -cert /var/run/secrets/istio/cert-chain.pem \
  -key /var/run/secrets/istio/key.pem 2>/dev/null | \
  openssl x509 -noout -text | grep -A2 "Subject Alternative Name"
```

**Problem: JWT validation failing**

```bash
# Decode the JWT without verification to inspect claims
JWT_TOKEN="eyJ..."
echo $JWT_TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq .

# Check if JWKS endpoint is reachable from within the pod
kubectl exec -n production myservice-pod -c istio-proxy -- \
  curl -v https://auth.example.com/.well-known/jwks.json
```

---

## Section 10: Production Checklist

Before promoting an Istio-secured namespace to production, verify:

```bash
#!/bin/bash
# istio-production-check.sh
set -euo pipefail

NAMESPACE=${1:-production}

echo "=== Istio Production Readiness Check ==="
echo "Namespace: $NAMESPACE"

# 1. Check all pods have sidecars injected
echo ""
echo "--- Sidecar Injection Status ---"
TOTAL=$(kubectl get pods -n $NAMESPACE --field-selector=status.phase=Running -o name | wc -l)
WITH_SIDECAR=$(kubectl get pods -n $NAMESPACE -o jsonpath='{range .items[*]}{.spec.containers[*].name}{"\n"}{end}' | grep -c istio-proxy || true)
echo "Total running pods: $TOTAL"
echo "Pods with istio-proxy: $WITH_SIDECAR"

# 2. Check for STRICT mTLS
echo ""
echo "--- PeerAuthentication ---"
kubectl get peerauthentication -n $NAMESPACE -o yaml | grep -E "name:|mode:"

# 3. Check AuthorizationPolicy coverage
echo ""
echo "--- Authorization Policies ---"
kubectl get authorizationpolicy -n $NAMESPACE

# 4. Check for configuration issues
echo ""
echo "--- Istio Config Analysis ---"
istioctl analyze -n $NAMESPACE

# 5. Check proxy sync status
echo ""
echo "--- Proxy Sync Status ---"
istioctl proxy-status | grep $NAMESPACE | grep -v "SYNCED" || echo "All proxies synced"

echo ""
echo "=== Check Complete ==="
```

### Resource Sizing for Production

| Component | Requests | Limits |
|---|---|---|
| istiod (per replica) | 500m CPU, 2Gi | 2000m CPU, 4Gi |
| Envoy sidecar | 100m CPU, 128Mi | 2000m CPU, 1Gi |
| Kiali | 100m CPU, 256Mi | 500m CPU, 512Mi |
| Ingress Gateway | 100m CPU, 128Mi | 2000m CPU, 1Gi |

### Upgrade Strategy

```bash
# Canary upgrade using revision-based install
istioctl install --revision=1-21 -f istio-operator.yaml -y

# Label namespace to use new revision
kubectl label namespace staging istio.io/rev=1-21 --overwrite

# Migrate production gradually
kubectl label namespace production istio.io/rev=1-21 --overwrite
kubectl rollout restart deployment -n production

# Verify no issues, then remove old revision
istioctl x uninstall --revision=1-20
```

Istio's layered security model — PeerAuthentication for transport security, RequestAuthentication for identity verification, and AuthorizationPolicy for access control — provides defense in depth without requiring application code changes. Combined with the Telemetry API for structured observability and Kiali for visualization, you have a complete zero-trust networking foundation for production Kubernetes workloads.
