---
title: "Istio Production Operations: Traffic Management, mTLS, and Observability at Scale"
date: 2027-06-30T00:00:00-05:00
draft: false
tags: ["Istio", "Service Mesh", "Kubernetes", "mTLS", "Traffic Management", "Observability"]
categories:
- Kubernetes
- Service Mesh
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to operating Istio at scale: IstioOperator/Helm installation, STRICT mTLS, AuthorizationPolicy, VirtualService traffic shaping, Envoy proxy tuning, Kiali observability, canary deployments, and upgrade strategies."
more_link: "yes"
url: "/istio-production-operations-guide/"
---

Istio remains the most feature-complete service mesh for Kubernetes, offering automatic mutual TLS, fine-grained authorization, sophisticated traffic management, and deep observability through its Envoy sidecar proxies. However, Istio's operational surface area is substantial, and teams frequently encounter performance issues from under-resourced sidecars, incorrect mTLS modes, or misconfigured VirtualServices that silently break traffic. This guide addresses all of these concerns: how to install Istio correctly for production, how to enforce security with PeerAuthentication and AuthorizationPolicy, how to configure VirtualService and DestinationRule for resilient traffic patterns, how to tune Envoy proxy resources, and how to approach upgrades without service disruption.

<!--more-->

## Istio Architecture Overview

Istio's control plane is composed of a single binary, **istiod**, which consolidates three previously separate components:

- **Pilot**: Watches Kubernetes Services, Endpoints, and Istio CRDs, converts them into Envoy xDS configuration (clusters, listeners, routes, endpoints), and pushes configuration to all Envoy proxies via gRPC streams.
- **Citadel** (now istiod PKI): Issues and rotates X.509 certificates to all workload proxies using SPIFFE-compatible identities. Each pod gets a certificate bound to its Kubernetes service account.
- **Galley** (now integrated): Validates Istio resource configurations before they reach Pilot.

The **data plane** is composed of Envoy proxies injected as sidecars into application pods. Each sidecar intercepts all inbound and outbound traffic via iptables rules that redirect traffic through ports 15001 (outbound) and 15006 (inbound). Envoy handles TLS termination, telemetry collection, load balancing, circuit breaking, retries, and timeout enforcement.

**Istio Ingress Gateway** and **Egress Gateway** are Envoy proxies deployed as standalone pods (not sidecars), acting as the cluster edge for inbound and outbound traffic respectively.

---

## Installation

### IstioOperator-Based Installation (Recommended)

The IstioOperator CRD provides declarative control over Istio's installation configuration and makes upgrades reproducible.

```bash
# Install istioctl
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.23.0 sh -
export PATH="$PWD/istio-1.23.0/bin:$PATH"
```

```yaml
# istio-production.yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: production
  namespace: istio-system
spec:
  profile: default
  hub: docker.io/istio
  tag: 1.23.0

  meshConfig:
    accessLogFile: /dev/stdout
    accessLogEncoding: JSON
    enableTracing: true
    defaultConfig:
      tracing:
        sampling: 100.0          # Reduce to 1.0 in high-traffic production
        zipkin:
          address: jaeger-collector.monitoring:9411
      proxyMetadata:
        ISTIO_META_IDLE_TIMEOUT: "60s"     # Idle connection cleanup
      holdApplicationUntilProxyStarts: true  # Wait for proxy before app starts

    # Default destination rule settings applied mesh-wide
    defaultDestinationRuleExportTo:
      - "."
      - "istio-system"

    outboundTrafficPolicy:
      mode: REGISTRY_ONLY           # Block traffic to unregistered external services

  components:
    pilot:
      k8s:
        replicaCount: 2
        hpaSpec:
          minReplicas: 2
          maxReplicas: 5
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: "2"
            memory: 4Gi
        env:
          - name: PILOT_ENABLE_WORKLOAD_ENTRY_AUTOREGISTRATION
            value: "true"
          - name: PILOT_DEBOUNCE_AFTER
            value: "100ms"
          - name: PILOT_DEBOUNCE_MAX
            value: "10s"

    ingressGateways:
      - name: istio-ingressgateway
        enabled: true
        k8s:
          replicaCount: 3
          hpaSpec:
            minReplicas: 3
            maxReplicas: 10
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 1Gi
          service:
            type: LoadBalancer
            ports:
              - name: http2
                port: 80
                targetPort: 8080
              - name: https
                port: 443
                targetPort: 8443
              - name: tcp
                port: 31400
                targetPort: 31400

    egressGateways:
      - name: istio-egressgateway
        enabled: true
        k8s:
          replicaCount: 2

  values:
    global:
      proxy:
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: "2"
            memory: 1Gi
        logLevel: warning
        componentLogLevel: "misc:error"
        privileged: false
        enableCoreDump: false

      telemetry:
        v2:
          enabled: true
          prometheus:
            enabled: true

    pilot:
      autoscaleEnabled: true
      traceSampling: 1.0
```

Apply the configuration:

```bash
istioctl install -f istio-production.yaml --verify
```

### Helm Installation (Alternative)

```bash
helm repo add istio https://istio-release.storage.googleapis.com/charts
helm repo update

helm install istio-base istio/base \
  --namespace istio-system \
  --create-namespace \
  --version 1.23.0

helm install istiod istio/istiod \
  --namespace istio-system \
  --version 1.23.0 \
  --values istiod-values.yaml

helm install istio-ingress istio/gateway \
  --namespace istio-ingress \
  --create-namespace \
  --version 1.23.0
```

---

## mTLS: PeerAuthentication

### Enabling STRICT mTLS Mesh-Wide

The safest default is to enable STRICT mTLS across the entire mesh, then use PERMISSIVE mode selectively for services during migration.

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system    # Mesh-wide when in istio-system namespace
spec:
  mtls:
    mode: STRICT
```

### Namespace-Scoped PeerAuthentication

Override mesh-level settings for a specific namespace (e.g., during migration of a legacy service):

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: permissive-migration
  namespace: legacy-services
spec:
  mtls:
    mode: PERMISSIVE       # Accept both plaintext and mTLS during migration
```

### Port-Level mTLS Override

Allow a specific port to remain plaintext while requiring mTLS on all others (useful for health check endpoints that do not support mTLS):

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: health-check-exception
  namespace: production
spec:
  selector:
    matchLabels:
      app: legacy-service
  mtls:
    mode: STRICT
  portLevelMtls:
    "8086":
      mode: DISABLE      # Legacy health check port
```

### Verifying mTLS Status

```bash
# Check mTLS status for all pods in a namespace
istioctl x check-inject -n production

# Verify a specific connection uses mTLS
istioctl x authz check <pod-name> -n production

# Show the current mTLS mode for a service
istioctl proxy-config listener <pod-name>.production \
  | grep -i tls
```

---

## AuthorizationPolicy: L4 and L7 Access Control

### L4 Policy: Source Principal and Namespace

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: backend-access
  namespace: production
spec:
  selector:
    matchLabels:
      app: backend

  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/frontend-service-account"
            namespaces:
              - production
      to:
        - operation:
            ports:
              - "3000"
```

### L7 Policy: HTTP Method and Path

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: api-read-policy
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server

  rules:
    # Read-only clients: GET and HEAD only
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/read-only-client"
      to:
        - operation:
            methods: ["GET", "HEAD"]
            paths: ["/api/v1/*"]

    # Admin clients: full access
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/admin-client"
      to:
        - operation:
            methods: ["GET", "POST", "PUT", "DELETE", "PATCH"]
            paths: ["/api/*"]
```

### Deny Policy (Explicit Deny Overrides Allow)

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: deny-external-access
  namespace: production
spec:
  action: DENY
  rules:
    - from:
        - source:
            notPrincipals:
              - "cluster.local/*"   # Deny anything not from this cluster
      to:
        - operation:
            ports:
              - "3000"
              - "8080"
```

### Default Deny Policy

```yaml
# Deny all traffic not explicitly allowed
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: default-deny
  namespace: production
spec:
  {}   # Empty spec = deny all traffic to all workloads in namespace
```

---

## Traffic Management: VirtualService and DestinationRule

### VirtualService: Retries, Timeouts, and Circuit Breaking

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: payment-service
  namespace: production
spec:
  hosts:
    - payment-service
  http:
    - name: payment-route
      match:
        - uri:
            prefix: /api/v1/payment
      timeout: 30s
      retries:
        attempts: 3
        perTryTimeout: 10s
        retryOn: >-
          5xx,reset,connect-failure,retriable-4xx,
          retriable-status-codes
        retryRemoteStatuses: "503,429"
      route:
        - destination:
            host: payment-service
            port:
              number: 8080
```

### VirtualService: Fault Injection for Testing

Fault injection enables chaos engineering at the application layer without requiring code changes:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: inventory-fault-injection
  namespace: staging
spec:
  hosts:
    - inventory-service
  http:
    - match:
        - headers:
            x-test-fault:
              exact: delay
      fault:
        delay:
          percentage:
            value: 100.0
          fixedDelay: 5s
      route:
        - destination:
            host: inventory-service
            port:
              number: 8080

    - match:
        - headers:
            x-test-fault:
              exact: abort
      fault:
        abort:
          percentage:
            value: 100.0
          httpStatus: 503
      route:
        - destination:
            host: inventory-service

    # Default: no fault injection
    - route:
        - destination:
            host: inventory-service
```

### VirtualService: Header-Based Routing for Canary

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: checkout-canary
  namespace: production
spec:
  hosts:
    - checkout-service
  http:
    # Route users with canary header to v2
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: checkout-service
            subset: v2
          weight: 100

    # Route 10% of production traffic to v2
    - route:
        - destination:
            host: checkout-service
            subset: v1
          weight: 90
        - destination:
            host: checkout-service
            subset: v2
          weight: 10
```

### DestinationRule: Outlier Detection and Connection Pool

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: checkout-destination
  namespace: production
spec:
  host: checkout-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
        connectTimeout: 5s
        tcpKeepalive:
          time: 7200s
          interval: 75s
          probes: 10
      http:
        h2UpgradePolicy: UPGRADE    # Upgrade to HTTP/2 when possible
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
        maxRequestsPerConnection: 100
        maxRetries: 3
        idleTimeout: 90s

    outlierDetection:
      consecutive5xxErrors: 5
      consecutiveGatewayErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 30
      splitExternalLocalOriginErrors: true
      consecutiveLocalOriginFailures: 5

    loadBalancer:
      consistentHash:
        httpCookie:
          name: session-id
          ttl: 3600s

  subsets:
    - name: v1
      labels:
        version: v1
      trafficPolicy:
        loadBalancer:
          simple: ROUND_ROBIN

    - name: v2
      labels:
        version: v2
      trafficPolicy:
        loadBalancer:
          simple: LEAST_CONN
```

### ServiceEntry: Registering External Services

When `outboundTrafficPolicy: REGISTRY_ONLY` is set, all external traffic is blocked unless a ServiceEntry exists:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: stripe-api
  namespace: production
spec:
  hosts:
    - api.stripe.com
  ports:
    - number: 443
      name: https
      protocol: HTTPS
  location: MESH_EXTERNAL
  resolution: DNS
  exportTo:
    - production    # Only visible from the production namespace
```

### Egress Gateway for External Traffic

Route all external traffic through a dedicated Egress Gateway for auditing and firewall control:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: istio-egressgateway
  namespace: istio-system
spec:
  selector:
    istio: egressgateway
  servers:
    - port:
        number: 443
        name: tls-stripe
        protocol: TLS
      hosts:
        - api.stripe.com
      tls:
        mode: PASSTHROUGH

---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: stripe-egress
  namespace: production
spec:
  hosts:
    - api.stripe.com
  gateways:
    - mesh
    - istio-system/istio-egressgateway
  tls:
    - match:
        - gateways:
            - mesh
          port: 443
          sniHosts:
            - api.stripe.com
      route:
        - destination:
            host: istio-egressgateway.istio-system.svc.cluster.local
            port:
              number: 443
    - match:
        - gateways:
            - istio-system/istio-egressgateway
          port: 443
          sniHosts:
            - api.stripe.com
      route:
        - destination:
            host: api.stripe.com
            port:
              number: 443
```

---

## Envoy Proxy Sidecar Tuning

### Resource Requests and Limits

The default Envoy sidecar resource requests are intentionally low for compatibility. Production deployments require tuning based on actual traffic volume:

```yaml
# In IstioOperator:
values:
  global:
    proxy:
      resources:
        requests:
          cpu: 100m       # Increase to 250m+ for high-throughput services
          memory: 128Mi
        limits:
          cpu: "2"
          memory: 1Gi     # Keep limit high; OOM kills the sidecar, not the app
```

Per-pod annotation override:

```yaml
apiVersion: v1
kind: Pod
metadata:
  annotations:
    sidecar.istio.io/proxyCPU: "500m"
    sidecar.istio.io/proxyMemory: "512Mi"
    sidecar.istio.io/proxyCPULimit: "2000m"
    sidecar.istio.io/proxyMemoryLimit: "2048Mi"
```

### Proxy Log Level

```yaml
# Reduce log verbosity in production
metadata:
  annotations:
    sidecar.istio.io/logLevel: "warning"
    sidecar.istio.io/componentLogLevel: "misc:error,main:warning"
```

Dynamically adjust log level without restart:

```bash
istioctl proxy-config log <pod-name>.production --level debug
```

### Concurrency Tuning

Envoy uses a fixed number of worker threads. The default (0 = auto, uses all CPUs) can cause excessive CPU usage on large nodes. Set a reasonable maximum:

```yaml
metadata:
  annotations:
    sidecar.istio.io/proxyConcurrency: "2"
```

### Envoy Access Log Configuration

```yaml
# meshConfig in IstioOperator
meshConfig:
  accessLogFile: /dev/stdout
  accessLogEncoding: JSON
  accessLogFormat: |
    {
      "start_time": "%START_TIME%",
      "method": "%REQ(:METHOD)%",
      "path": "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%",
      "protocol": "%PROTOCOL%",
      "response_code": "%RESPONSE_CODE%",
      "response_flags": "%RESPONSE_FLAGS%",
      "duration": "%DURATION%",
      "upstream_host": "%UPSTREAM_HOST%",
      "upstream_cluster": "%UPSTREAM_CLUSTER%",
      "upstream_service_time": "%RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)%",
      "x_forwarded_for": "%REQ(X-FORWARDED-FOR)%",
      "request_id": "%REQ(X-REQUEST-ID)%",
      "authority": "%REQ(:AUTHORITY)%",
      "trace_id": "%REQ(X-B3-TRACEID)%"
    }
```

---

## Kiali Integration

Kiali provides a service topology graph, traffic health indicators, and configuration validation for Istio resources.

```bash
helm repo add kiali https://kiali.org/helm-charts
helm install kiali-operator kiali/kiali-operator \
  --namespace kiali-operator \
  --create-namespace

kubectl apply -f - <<'EOF'
apiVersion: kiali.io/v1alpha1
kind: Kiali
metadata:
  name: kiali
  namespace: istio-system
spec:
  version: v1.89
  auth:
    strategy: anonymous    # Use 'openid' for production with SSO
  external_services:
    prometheus:
      url: http://prometheus-operated.monitoring:9090
    tracing:
      enabled: true
      in_cluster_url: http://jaeger-query.monitoring:16686
      use_grpc: false
    grafana:
      enabled: true
      in_cluster_url: http://grafana.monitoring:3000
  deployment:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
EOF
```

---

## Distributed Tracing with Jaeger

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: jaeger-config
  namespace: monitoring
data:
  config.yaml: |
    sampling:
      default_strategy:
        type: probabilistic
        param: 0.01   # 1% of traces in production
      service_strategies:
        - service: checkout-service
          type: probabilistic
          param: 0.1   # Sample 10% of checkout traces
        - service: payment-service
          type: probabilistic
          param: 1.0   # Sample 100% of payment traces
```

Configure Istio to send traces to Jaeger:

```yaml
meshConfig:
  enableTracing: true
  defaultConfig:
    tracing:
      sampling: 1.0          # 1% global sampling rate
      zipkin:
        address: "jaeger-collector.monitoring.svc.cluster.local:9411"
```

---

## Canary Deployment with Weight-Based Routing

A complete canary deployment workflow with progressive traffic shifting:

```bash
# Step 1: Deploy v2 of the service
kubectl apply -f checkout-v2-deployment.yaml

# Step 2: Create DestinationRule with v1 and v2 subsets
kubectl apply -f checkout-destination-rule.yaml

# Step 3: Start with 5% traffic to v2
kubectl apply -f - <<'EOF'
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: checkout-canary
  namespace: production
spec:
  hosts:
    - checkout-service
  http:
    - route:
        - destination:
            host: checkout-service
            subset: v1
          weight: 95
        - destination:
            host: checkout-service
            subset: v2
          weight: 5
EOF

# Step 4: Monitor error rates for both versions
# In Prometheus:
# sum(rate(istio_requests_total{destination_workload="checkout-v2",
#   response_code=~"5.."}[5m])) /
# sum(rate(istio_requests_total{destination_workload="checkout-v2"}[5m]))

# Step 5: Progress to 50%
kubectl patch virtualservice checkout-canary \
  --type merge \
  -p '{"spec":{"http":[{"route":[
    {"destination":{"host":"checkout-service","subset":"v1"},"weight":50},
    {"destination":{"host":"checkout-service","subset":"v2"},"weight":50}
  ]}]}}'

# Step 6: Full cutover to v2
kubectl patch virtualservice checkout-canary \
  --type merge \
  -p '{"spec":{"http":[{"route":[
    {"destination":{"host":"checkout-service","subset":"v2"},"weight":100}
  ]}]}}'
```

---

## Istio Upgrade Strategies

### In-Place Upgrade (Minor Version)

For minor version upgrades within the same major version (e.g., 1.22.x to 1.23.x):

```bash
# Download new istioctl version
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.23.0 sh -

# Verify upgrade path
istioctl upgrade --dry-run

# Perform the upgrade
istioctl upgrade -f istio-production.yaml

# Verify control plane
istioctl verify-install

# Restart workloads to upgrade sidecar versions
kubectl rollout restart deployment -n production
kubectl rollout restart deployment -n staging
```

### Canary Upgrade (Major Version or Zero-Downtime)

The canary upgrade pattern runs two Istio control planes simultaneously, allowing gradual migration of workloads:

```bash
# Install new Istio version with a revision tag
istioctl install \
  --set revision=1-23 \
  -f istio-production.yaml

# Verify new control plane is running
kubectl get pods -n istio-system -l istio.io/rev=1-23

# Create revision tag pointing to new version
istioctl tag set prod-stable --revision 1-23 --overwrite

# Migrate a single namespace to the new revision
kubectl label namespace staging \
  istio.io/rev=1-23 \
  istio-injection-     # Remove old label

# Restart pods in staging to inject new sidecar
kubectl rollout restart deployment -n staging

# Verify staging is using the new proxy version
istioctl proxy-status -n staging

# After validating staging, migrate production
kubectl label namespace production \
  istio.io/rev=1-23 \
  istio-injection-
kubectl rollout restart deployment -n production

# Once all namespaces are migrated, remove the old control plane
istioctl uninstall --revision 1-22
```

---

## Common Production Issues and Resolutions

### Issue: "upstream connect error or disconnect/reset before headers"

**Cause**: Service pod is rejecting connections before Envoy can establish the upstream connection. Common triggers: application crash loop, resource exhaustion, or misconfigured readiness probe.

**Resolution**:
```bash
# Check upstream cluster health
istioctl proxy-config cluster <pod-name>.production \
  | grep <service-name>

# Check outlier detection ejection status
istioctl proxy-config cluster <pod-name>.production \
  --fqdn <service-name>.production.svc.cluster.local \
  -o json \
  | jq '.[].outlierDetection'

# Check if hosts are ejected
kubectl exec <pod-name> -n production -c istio-proxy -- \
  curl -s localhost:15000/clusters \
  | grep -A 5 "ejected"
```

### Issue: 503 Responses with RBAC or uRBAC flags

**Cause**: AuthorizationPolicy is denying the request. Response flags `RBAC` or `uRBAC` in access logs indicate policy denial.

**Resolution**:
```bash
# Check which AuthorizationPolicy is denying
istioctl x authz check <pod-name> -n production

# Temporarily enable debug logging on the proxy
istioctl proxy-config log <pod-name>.production \
  --level rbac:debug

# View RBAC debug logs
kubectl logs <pod-name> -n production -c istio-proxy \
  | grep rbac
```

### Issue: High Latency from Envoy

**Cause**: Envoy is CPU-starved, causing delay in handling proxy threads.

**Resolution**:
```bash
# Check proxy CPU utilization
kubectl top pod -n production --containers \
  | grep istio-proxy

# View Envoy internal stats
kubectl exec <pod-name> -n production -c istio-proxy -- \
  curl -s localhost:15000/stats \
  | grep -E "(pending|overflow|cx_overflow)"

# Increase proxy CPU limit per pod
kubectl annotate pod <pod-name> -n production \
  sidecar.istio.io/proxyCPU=500m \
  sidecar.istio.io/proxyCPULimit=2000m
```

### Issue: Sidecar Injection Not Working

```bash
# Verify namespace label
kubectl get namespace production \
  --show-labels | grep istio-injection

# Check mutating webhook configuration
kubectl get mutatingwebhookconfigurations \
  -l app=sidecar-injector -o yaml

# Verify pod is not annotated to skip injection
kubectl get pod <pod-name> -n production \
  -o jsonpath='{.metadata.annotations.sidecar\.istio\.io/inject}'

# Manually verify injection config
istioctl x check-inject <pod-name> -n production
```

---

## Observability Metrics Reference

Key Istio metrics for production dashboards:

| Metric | Description | Alert Threshold |
|---|---|---|
| `istio_requests_total` | Total requests with labels for source, destination, response code | Error rate > 1% |
| `istio_request_duration_milliseconds` | Request latency histogram | P99 > SLO threshold |
| `istio_tcp_connections_opened_total` | TCP connections opened | Sudden spikes |
| `istio_tcp_connections_closed_total` | TCP connections closed | Compare with opened |
| `pilot_xds_push_time` | Time for istiod to push config to proxies | P99 > 2s indicates scale pressure |
| `pilot_xds_pushes` | Config push count by type | Frequent FULL pushes indicate instability |
| `envoy_cluster_upstream_cx_overflow` | Connection pool overflow (circuit breaker) | Any value > 0 |
| `envoy_cluster_upstream_rq_pending_overflow` | Pending request overflow | Any value > 0 |

---

## Summary

Istio's production operations require attention across three dimensions: security hardening (STRICT mTLS + AuthorizationPolicy default deny), traffic resilience (timeouts + retries + outlier detection in DestinationRule + VirtualService), and observability (Kiali for topology, Jaeger for tracing, Prometheus for metrics). Envoy sidecar resources are frequently under-provisioned in default deployments and must be tuned for actual traffic profiles. The canary upgrade pattern is the safest path for major version upgrades, allowing workload-by-workload migration with rollback capability. With proper configuration, Istio provides a comprehensive security and observability layer that removes the need for application-level mTLS code, retry logic, and telemetry instrumentation.
