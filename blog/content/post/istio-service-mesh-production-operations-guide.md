---
title: "Istio Service Mesh Production Operations: Traffic Management, mTLS, and Observability"
date: 2027-06-16T00:00:00-05:00
draft: false
tags: ["Istio", "Service Mesh", "mTLS", "Kubernetes", "Observability", "Traffic Management"]
categories:
- Kubernetes
- Service Mesh
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to operating Istio covering control plane components, sidecar injection, VirtualService and DestinationRule configuration, mTLS PeerAuthentication, AuthorizationPolicy, Envoy tuning, Kiali service topology, canary deployments, and ambient mesh migration."
more_link: "yes"
url: "/istio-service-mesh-production-operations-guide/"
---

Istio is the most feature-complete service mesh available for Kubernetes, but that feature set comes with operational complexity that bites teams unprepared for it. Control plane upgrades, Envoy sidecar resource consumption, mTLS rollout sequencing, and debugging Envoy xDS configuration are all skills that distinguish teams running Istio successfully in production from those fighting it.

This guide covers the complete operational picture: installing and upgrading the Istio control plane, configuring traffic management primitives, enforcing mutual TLS across the mesh, writing AuthorizationPolicy for zero-trust workloads, tuning Envoy sidecar behaviour, using Kiali for topology visibility, running canary deployments, and evaluating the ambient mesh architecture as a sidecar replacement.

<!--more-->

# Istio Service Mesh Production Operations: Traffic Management, mTLS, and Observability

## Section 1: Control Plane Architecture

### Components

Istio's control plane runs as a single binary — `istiod` — which consolidates what was previously three separate services (Pilot, Citadel, Galley):

- **istiod**: Handles all control plane functions:
  - **xDS server**: Pushes Envoy configuration (Listeners, Routes, Clusters, Endpoints) to sidecar proxies via the Envoy xDS API.
  - **CA (Certificate Authority)**: Issues and rotates mTLS certificates for workload identities (SPIFFE SVIDs).
  - **Webhook server**: Handles sidecar injection and validation webhooks.
  - **Config server**: Watches Kubernetes resources (VirtualService, DestinationRule, etc.) and translates them into Envoy xDS config.

The data plane consists of Envoy proxy instances injected as sidecars alongside every application container. These proxies intercept all inbound and outbound traffic using iptables rules inserted during pod initialisation by the `istio-init` init container.

### Installation with istioctl

```bash
# Download istioctl
curl -L https://istio.io/downloadIstio | \
  ISTIO_VERSION=1.23.0 TARGET_ARCH=x86_64 sh -
export PATH=$PATH:$HOME/istio-1.23.0/bin

# Validate prerequisites
istioctl x precheck

# Install with production profile
istioctl install --set profile=default \
  --set values.pilot.traceSampling=1.0 \
  --set values.global.meshID=mesh1 \
  --set values.global.network=network1 \
  --set meshConfig.accessLogFile=/dev/stdout \
  --set meshConfig.accessLogEncoding=JSON \
  --set meshConfig.enablePrometheusMerge=true \
  -y

# Verify
istioctl verify-install
kubectl -n istio-system get pods
```

### Production Profile vs. Default Profile

| Setting | default | production recommendation |
|---------|---------|--------------------------|
| Pilot replicas | 1 | 3 (with PodDisruptionBudget) |
| Pilot CPU request | 500m | 2000m |
| Pilot memory request | 2Gi | 4Gi |
| Tracing sample rate | 1% | 0.1–1% (depends on volume) |
| Access log | disabled | JSON to stdout |
| Metrics merge | enabled | enabled |

Customise via IstioOperator:

```yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: production
  namespace: istio-system
spec:
  profile: default
  components:
    pilot:
      k8s:
        replicaCount: 3
        resources:
          requests:
            cpu: 2000m
            memory: 4Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        hpaSpec:
          minReplicas: 3
          maxReplicas: 5
          metrics:
          - type: Resource
            resource:
              name: cpu
              target:
                type: Utilization
                averageUtilization: 60
  meshConfig:
    accessLogFile: /dev/stdout
    accessLogEncoding: JSON
    accessLogFormat: |
      {
        "timestamp": "%START_TIME%",
        "method": "%REQ(:METHOD)%",
        "path": "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%",
        "protocol": "%PROTOCOL%",
        "response_code": "%RESPONSE_CODE%",
        "response_flags": "%RESPONSE_FLAGS%",
        "duration": "%DURATION%",
        "upstream_host": "%UPSTREAM_HOST%",
        "source_principal": "%DOWNSTREAM_PEER_PRINCIPAL%"
      }
    defaultConfig:
      proxyMetadata:
        ISTIO_META_DNS_CAPTURE: "true"
```

## Section 2: Sidecar Injection

### Namespace-Level Injection

```bash
# Enable automatic sidecar injection for a namespace
kubectl label namespace production istio-injection=enabled

# Verify
kubectl get namespace production --show-labels
```

### Pod-Level Overrides

```yaml
# Disable injection for a specific pod
metadata:
  annotations:
    sidecar.istio.io/inject: "false"

# Force injection on a pod in a non-injected namespace
metadata:
  annotations:
    sidecar.istio.io/inject: "true"
```

### Sidecar Resource Tuning

Envoy sidecars consume resources on every pod. Set appropriate limits:

```yaml
metadata:
  annotations:
    sidecar.istio.io/proxyCPU: "100m"
    sidecar.istio.io/proxyMemory: "128Mi"
    sidecar.istio.io/proxyCPULimit: "2000m"
    sidecar.istio.io/proxyMemoryLimit: "1024Mi"
```

Or configure globally via IstioOperator:

```yaml
meshConfig:
  defaultConfig:
    concurrency: 2    # Envoy worker threads
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 2000m
      memory: 1024Mi
```

### Excluding Ports from Interception

Some applications (metrics exporters, health checks) should bypass Envoy:

```yaml
metadata:
  annotations:
    traffic.sidecar.istio.io/excludeInboundPorts: "9090,8081"
    traffic.sidecar.istio.io/excludeOutboundPorts: "9090"
    traffic.sidecar.istio.io/excludeOutboundIPRanges: "169.254.169.254/32"
```

## Section 3: Traffic Management

### VirtualService

VirtualService defines routing rules applied to traffic matching a host. Rules are evaluated in order; the first match wins.

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: frontend
  namespace: production
spec:
  hosts:
  - frontend.production.svc.cluster.local
  - frontend.example.com           # External hostname
  gateways:
  - production/frontend-gateway    # For external traffic
  - mesh                           # For internal mesh traffic
  http:
  - name: canary-route
    match:
    - headers:
        x-canary:
          exact: "true"
    route:
    - destination:
        host: frontend
        subset: v2
      weight: 100
  - name: stable-route
    route:
    - destination:
        host: frontend
        subset: v1
      weight: 90
    - destination:
        host: frontend
        subset: v2
      weight: 10
    retries:
      attempts: 3
      perTryTimeout: 5s
      retryOn: gateway-error,connect-failure,retriable-4xx
    timeout: 30s
    fault:
      delay:
        percentage:
          value: 0.1    # 0.1% of requests get 500ms delay (chaos testing)
        fixedDelay: 500ms
```

### DestinationRule

DestinationRule defines traffic policies for a destination service: load balancing algorithm, connection pool settings, circuit breaker, and TLS settings. It also defines subsets (versions) used by VirtualService.

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: frontend
  namespace: production
spec:
  host: frontend.production.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      simple: LEAST_CONN
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
        h2UpgradePolicy: UPGRADE
    outlierDetection:
      consecutiveGatewayErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 0
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
```

### Gateway

An Istio Gateway configures an Envoy proxy acting as an ingress (or egress) load balancer at the edge of the mesh:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: frontend-gateway
  namespace: production
spec:
  selector:
    istio: ingressgateway
  servers:
  - port:
      number: 443
      name: https
      protocol: HTTPS
    hosts:
    - frontend.example.com
    tls:
      mode: SIMPLE
      credentialName: frontend-tls-cert   # Kubernetes Secret with TLS cert
  - port:
      number: 80
      name: http
      protocol: HTTP
    hosts:
    - frontend.example.com
    tls:
      httpsRedirect: true
```

### ServiceEntry for External Services

Add external services to the mesh registry so Envoy manages the connections:

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
  resolution: DNS
  location: MESH_EXTERNAL
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: stripe-api
  namespace: production
spec:
  hosts:
  - api.stripe.com
  http:
  - timeout: 10s
    retries:
      attempts: 3
      perTryTimeout: 3s
      retryOn: 5xx,reset,connect-failure
    route:
    - destination:
        host: api.stripe.com
        port:
          number: 443
```

## Section 4: Mutual TLS (mTLS)

### PeerAuthentication

PeerAuthentication controls the mTLS mode for a workload. It is the server-side policy — it specifies what the workload accepts:

```yaml
# Strict mTLS for the entire production namespace
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
---
# Mesh-wide strict mTLS (apply to istio-system namespace)
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system
spec:
  mtls:
    mode: STRICT
```

mTLS modes:

| Mode | Behaviour |
|------|-----------|
| `STRICT` | Only mTLS traffic accepted. Plain text rejected. |
| `PERMISSIVE` | Accept both mTLS and plain text. Useful during migration. |
| `DISABLE` | mTLS disabled. Plain text only. |

### Migration from Permissive to Strict

```bash
# Phase 1: Set PERMISSIVE (accept both mTLS and plain text)
kubectl apply -f - <<'EOF'
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: PERMISSIVE
EOF

# Verify traffic is actually using mTLS in Kiali or via:
kubectl -n production exec <pod> -c istio-proxy -- \
  pilot-agent request GET /stats/prometheus | \
  grep "istio_requests_total.*connection_security_policy=\"mutual_tls\""

# Phase 2: Once all services confirmed using mTLS, switch to STRICT
kubectl apply -f - <<'EOF'
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
EOF
```

## Section 5: AuthorizationPolicy

### Zero-Trust Workload Access Control

AuthorizationPolicy is the client-side complement to PeerAuthentication. It defines what principals (service accounts, namespaces) can access a workload:

```yaml
# Deny all by default for production namespace
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: deny-all
  namespace: production
spec:
  {}   # Empty spec with no selector = deny all in namespace
---
# Allow frontend to call backend-api on specific paths
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
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/v1/*"]
        ports: ["8080"]
---
# Allow monitoring namespace to scrape metrics
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-prometheus-scrape
  namespace: production
spec:
  action: ALLOW
  rules:
  - from:
    - source:
        namespaces: ["monitoring"]
    to:
    - operation:
        ports: ["9090", "8080"]
        paths: ["/metrics"]
```

### JWT Authentication

```yaml
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: production
spec:
  selector:
    matchLabels:
      app: backend-api
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"
    audiences:
    - "backend-api"
---
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: require-jwt
  namespace: production
spec:
  selector:
    matchLabels:
      app: backend-api
  action: ALLOW
  rules:
  - from:
    - source:
        requestPrincipals: ["https://auth.example.com/*"]
    when:
    - key: request.auth.claims[groups]
      values: ["admin", "api-user"]
```

## Section 6: Envoy Filter Tuning

### Adjusting Envoy Proxy Behaviour

EnvoyFilter provides low-level access to Envoy's configuration when Istio's higher-level APIs are insufficient:

```yaml
# Add custom response header via EnvoyFilter
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: add-security-headers
  namespace: production
spec:
  workloadSelector:
    labels:
      app: frontend
  configPatches:
  - applyTo: HTTP_FILTER
    match:
      context: SIDECAR_INBOUND
      listener:
        filterChain:
          filter:
            name: envoy.filters.network.http_connection_manager
    patch:
      operation: MERGE
      value:
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          server_header_transformation: PASS_THROUGH
---
# Increase gRPC max message size
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: grpc-max-message-size
  namespace: production
spec:
  configPatches:
  - applyTo: HTTP_FILTER
    match:
      context: SIDECAR_INBOUND
    patch:
      operation: MERGE
      value:
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          max_request_headers_kb: 96
```

### Circuit Breaker via DestinationRule

The preferred approach for circuit breaking is through DestinationRule outlierDetection rather than EnvoyFilter:

```yaml
trafficPolicy:
  outlierDetection:
    consecutiveGatewayErrors: 5       # Trigger after 5 consecutive 5xx
    consecutive5xxErrors: 5
    interval: 10s                      # Analysis window
    baseEjectionTime: 30s             # Initial ejection duration
    maxEjectionPercent: 100           # Allow full ejection if needed
    minHealthPercent: 0               # Allow ejection even if all unhealthy
```

### Debugging Envoy Configuration

```bash
# Dump the full Envoy xDS config for a pod
kubectl -n production exec <pod> -c istio-proxy -- \
  pilot-agent request GET config_dump | jq .

# Get cluster configuration (upstream services)
kubectl -n production exec <pod> -c istio-proxy -- \
  pilot-agent request GET clusters

# Get listener configuration
kubectl -n production exec <pod> -c istio-proxy -- \
  pilot-agent request GET listeners

# Check Envoy stats for a specific cluster
kubectl -n production exec <pod> -c istio-proxy -- \
  pilot-agent request GET stats | grep "cluster.outbound|8080|backend-api"

# Use istioctl proxy-config for structured output
istioctl proxy-config cluster <pod>.<namespace>
istioctl proxy-config route <pod>.<namespace>
istioctl proxy-config listener <pod>.<namespace>
istioctl proxy-config endpoint <pod>.<namespace>
```

## Section 7: Kiali Service Topology

### Installing Kiali

```bash
# Install Kiali via the Istio addons
kubectl apply -f \
  https://raw.githubusercontent.com/istio/istio/release-1.23/samples/addons/kiali.yaml

# Install Jaeger for tracing
kubectl apply -f \
  https://raw.githubusercontent.com/istio/istio/release-1.23/samples/addons/jaeger.yaml

# Access Kiali
istioctl dashboard kiali
```

### Using Kiali for Observability

Kiali provides a service graph derived from Envoy telemetry. Key features:

- **Traffic graph**: Directed service dependency graph with request rate, error rate, and response time labels.
- **Health indicators**: Green/yellow/red health based on error rate thresholds.
- **mTLS badges**: Visual indication of which service pairs have mTLS active.
- **Configuration validation**: Detects misconfigured VirtualServices, missing DestinationRule subsets, policy conflicts.
- **Traces**: Integrated Jaeger trace drill-down from service graph edges.

### Kiali Validation Warnings

Kiali validates Istio configuration and surfaces issues:

| Warning | Cause | Resolution |
|---------|-------|-----------|
| `KIA0201` | VirtualService subset not found | DestinationRule subset label mismatch |
| `KIA0202` | VirtualService weight sum != 100 | Fix route weight percentages |
| `KIA0301` | AuthorizationPolicy references unknown service | Selector label mismatch |
| `KIA0401` | Gateway selector has no matching ingress | Ingress pod label mismatch |

```bash
# Check Kiali validation via CLI
istioctl analyze --namespace production
```

## Section 8: Canary Deployments with Traffic Shifting

### Progressive Traffic Migration

```bash
# Step 1: Deploy v2 alongside v1 (0% traffic initially)
kubectl apply -f deployment-v2.yaml

# Step 2: Create DestinationRule with subsets
cat <<'EOF' | kubectl apply -f -
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: frontend
  namespace: production
spec:
  host: frontend
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
EOF

# Step 3: Route 5% to v2
cat <<'EOF' | kubectl apply -f -
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: frontend
  namespace: production
spec:
  hosts:
  - frontend
  http:
  - route:
    - destination:
        host: frontend
        subset: v1
      weight: 95
    - destination:
        host: frontend
        subset: v2
      weight: 5
EOF

# Step 4: Monitor error rate for v2 via Prometheus
# Alert if error rate for v2 subset exceeds threshold

# Step 5: Shift to 25% → 50% → 75% → 100%
# Final: remove v1 deployment
```

### Header-Based Canary for Testing

```yaml
http:
- match:
  - headers:
      x-version:
        exact: "v2"
  route:
  - destination:
      host: frontend
      subset: v2
- route:
  - destination:
      host: frontend
      subset: v1
```

### Automated Canary with Argo Rollouts + Istio

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: frontend
  namespace: production
spec:
  replicas: 10
  strategy:
    canary:
      canaryService: frontend-canary
      stableService: frontend-stable
      trafficRouting:
        istio:
          virtualService:
            name: frontend-vsvc
            routes:
            - primary
          destinationRule:
            name: frontend-destrule
            canarySubsetName: canary
            stableSubsetName: stable
      steps:
      - setWeight: 5
      - pause: {duration: 5m}
      - analysis:
          templates:
          - templateName: success-rate
      - setWeight: 25
      - pause: {duration: 10m}
      - setWeight: 50
      - pause: {duration: 10m}
      - setWeight: 100
```

## Section 9: Ambient Mesh Migration

### What is Ambient Mesh

Ambient mesh (introduced as stable in Istio 1.22) replaces per-pod Envoy sidecars with a two-layer architecture:

- **ztunnel**: A per-node DaemonSet written in Rust that handles L4 mTLS and telemetry using WireGuard-style encrypted tunnels (HBONE protocol).
- **waypoint proxy**: A per-namespace or per-service Envoy deployment that handles L7 features (HTTP routing, JWT auth, AuthorizationPolicy with L7 conditions).

Benefits:
- No sidecar injection — no pod restart required to join mesh.
- Significantly lower CPU and memory overhead per workload.
- Simpler upgrade path — no per-pod restarts during Istio upgrades.

### Enabling Ambient Mode

```bash
# Install Istio with ambient profile
istioctl install --set profile=ambient \
  --set values.cni.ambient.enabled=true \
  -y

# Add workloads to ambient mesh by labelling the namespace
kubectl label namespace production istio.io/dataplane-mode=ambient

# Verify ztunnel is running
kubectl -n istio-system get pods -l app=ztunnel

# Verify workloads are enrolled
kubectl get pods -n production -o jsonpath=\
  '{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.ambient\.istio\.io/redirection}{"\n"}{end}'
```

### Deploying a Waypoint for L7 Features

```bash
# Create a namespace-scoped waypoint
istioctl waypoint apply --namespace production

# Or a service-scoped waypoint
istioctl waypoint apply \
  --name frontend-waypoint \
  --namespace production \
  --for service

# Associate the waypoint with a service
kubectl label service frontend \
  istio.io/use-waypoint=frontend-waypoint \
  -n production
```

### Sidecar to Ambient Migration Path

```bash
# Step 1: Ensure Istio 1.22+ is installed
# Step 2: Install CNI and ztunnel DaemonSet
# Step 3: Label namespace for ambient (non-disruptive — works alongside sidecars)
kubectl label namespace production istio.io/dataplane-mode=ambient

# Step 4: Remove injection label from namespace (sidecars will stay until pod restart)
kubectl label namespace production istio-injection-

# Step 5: Rolling restart to remove sidecars
kubectl -n production rollout restart deployment

# Step 6: Verify no sidecar containers in pods
kubectl -n production get pods -o jsonpath=\
  '{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.name}{" "}{end}{"\n"}{end}'
```

## Section 10: Prometheus Monitoring and Alerting

### Key Istio Metrics

```yaml
groups:
- name: istio.rules
  rules:
  - record: istio:request_total:rate5m
    expr: |
      sum(rate(istio_requests_total[5m])) by (
        destination_service, response_code, source_workload)

  - record: istio:error_rate:rate5m
    expr: |
      sum(rate(istio_requests_total{response_code=~"5.."}[5m])) by (
        destination_service)
      /
      sum(rate(istio_requests_total[5m])) by (destination_service)

  - alert: IstioHighErrorRate
    expr: istio:error_rate:rate5m > 0.05
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "High error rate on {{ $labels.destination_service }}: {{ $value | humanizePercentage }}"

  - alert: IstioHighLatencyP99
    expr: |
      histogram_quantile(0.99,
        sum(rate(istio_request_duration_milliseconds_bucket[5m]))
        by (destination_service, le)
      ) > 5000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "P99 latency on {{ $labels.destination_service }} is {{ $value }}ms"

  - alert: IstiodXDSPushErrors
    expr: rate(pilot_xds_push_errors[5m]) > 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "istiod is failing to push xDS updates"

  - alert: IstioCertExpiryShort
    expr: citadel_server_cert_chain_expiry_timestamp - time() < 86400 * 7
    for: 1h
    labels:
      severity: critical
    annotations:
      summary: "Istio workload certificate expires in less than 7 days"
```

## Section 11: Production Hardening Checklist

```
Istio Production Checklist
============================

Control Plane
[ ] istiod replicas >= 3 with PodDisruptionBudget
[ ] istiod HPA configured (CPU target 60%)
[ ] istiod resource limits set appropriately
[ ] Revision-based upgrade strategy (canary istiod)
[ ] istioctl analyze run in CI/CD pipeline

Sidecar Injection
[ ] Namespace injection labels audited
[ ] Per-pod resource annotations set for high-density nodes
[ ] Health check ports excluded from interception
[ ] AWS metadata endpoint (169.254.169.254) excluded

mTLS
[ ] PeerAuthentication STRICT in all production namespaces
[ ] Mesh-wide default PeerAuthentication in istio-system
[ ] mTLS validation in Kiali confirmed before enabling STRICT
[ ] Certificate rotation interval < 24h (default: 1h, acceptable)

Authorization
[ ] AuthorizationPolicy deny-all baseline applied
[ ] Each service has explicit ALLOW rules
[ ] Prometheus scrape ports explicitly allowed
[ ] JWT RequestAuthentication validated for external APIs

Traffic Management
[ ] DestinationRule connectionPool limits set per service
[ ] outlierDetection configured for all critical services
[ ] Retry budget defined (attempts, perTryTimeout, retryOn)
[ ] Timeout set on all VirtualServices (no infinite wait)

Observability
[ ] Access log in JSON format to stdout
[ ] Kiali deployed and ServiceMonitor active
[ ] Prometheus alerts for error rate, latency, xDS errors
[ ] Jaeger or Zipkin traces sampled appropriately
[ ] istiod dashboard in Grafana reviewed quarterly

Ambient Migration (if applicable)
[ ] ztunnel DaemonSet running on all nodes
[ ] Waypoint proxy deployed for L7-dependent namespaces
[ ] Sidecar removal validated in staging before production
```

## Summary

Istio delivers a comprehensive service mesh capability set — mTLS between all workloads, fine-grained L7 authorisation, sophisticated traffic shaping, and deep Envoy telemetry — but realising that value in production requires disciplined configuration management and operational investment.

The shift from PERMISSIVE to STRICT mTLS, building AuthorizationPolicy from a deny-all baseline, using Kiali to validate configuration before applying it to production, and sizing istiod appropriately for the cluster are the practices that separate reliable Istio deployments from ones that generate incidents.

Ambient mesh represents a genuine architectural improvement: removing per-pod sidecars eliminates the largest operational friction point (pod restarts on injection changes, per-pod resource overhead) while preserving the security and observability properties that make Istio valuable. Teams should evaluate ambient mode for new deployments and plan migration paths for existing sidecar deployments.
