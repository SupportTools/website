---
title: "Kubernetes Linkerd 2.x Production: Control Plane HA, Multicluster Service Mirroring, SMI Traffic Split, and Debug Tools"
date: 2031-12-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Linkerd", "Service Mesh", "mTLS", "Multicluster", "SMI", "Observability"]
categories:
- Kubernetes
- Service Mesh
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linkerd 2.x: deploying a highly available control plane, configuring multicluster service mirroring for cross-cluster communication, implementing SMI TrafficSplit for canary deployments, and using Linkerd's debug tools for production diagnosis."
more_link: "yes"
url: "/kubernetes-linkerd-2x-production-multicluster-smi-debug/"
---

Linkerd's design philosophy — minimal footprint, zero-configuration mTLS, and operational simplicity — makes it the service mesh of choice for teams that want mesh benefits without Istio's operational overhead. But production deployments require careful attention to control plane high availability, certificate rotation, multicluster federation, and the diagnostic tooling available when things go wrong. This guide covers Linkerd 2.x from a production operations perspective, including HA control plane configuration, multicluster service mirroring topology, SMI-based traffic splitting for safe progressive delivery, and the `linkerd diagnostics` and `linkerd viz` tools for production debugging.

<!--more-->

# Kubernetes Linkerd 2.x Production Guide

## Section 1: Linkerd Architecture and Control Plane Components

Linkerd's data plane consists of ultralight Rust-based proxies (`linkerd2-proxy`) injected as sidecar containers. The control plane provides certificate issuance, proxy configuration, and observability.

### Control Plane Components

| Component | Purpose |
|-----------|---------|
| `linkerd-destination` | Service discovery and policy distribution to proxies |
| `linkerd-identity` | mTLS certificate issuance (Linkerd CA) |
| `linkerd-proxy-injector` | Webhook that injects proxy sidecars |
| `linkerd-controller` | API server for the CLI and dashboard |
| `linkerd-viz` (extension) | Prometheus + Grafana + tap dashboard |
| `linkerd-multicluster` (extension) | Cross-cluster service mirroring |
| `linkerd-jaeger` (extension) | Distributed tracing integration |

### Certificate Hierarchy

```
Root CA (external — cert-manager or Vault)
  └── Linkerd Trust Anchor (intermediate CA, 10-year rotation)
        └── Issuer Certificate (short-lived, 1-year, cert-manager rotates)
              └── Workload Certificates (24h, issued by identity component)
```

## Section 2: Installing Linkerd CLI and Pre-Flight Checks

```bash
# Install the Linkerd CLI
curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install | sh

# Or install a specific version
curl --proto '=https' --tlsv1.2 -sSfL \
  https://github.com/linkerd/linkerd2/releases/download/stable-2.15.0/linkerd2-cli-stable-2.15.0-linux-amd64 \
  -o /usr/local/bin/linkerd
chmod +x /usr/local/bin/linkerd

# Verify version
linkerd version --client

# Run pre-installation checks
linkerd check --pre
```

## Section 3: Cert-Manager Integration for Certificate Management

Linkerd's trust anchor (root CA) should be managed externally so it outlives Linkerd's own lifecycle. Use cert-manager with a separate issuer namespace:

### Trust Anchor with cert-manager

```bash
# Install cert-manager
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true \
  --version v1.14.0
```

```yaml
# linkerd-trust-anchor.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: linkerd-trust-anchor-issuer
spec:
  selfSigned: {}
---
# Step 1: Generate the trust anchor certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: linkerd-trust-anchor
  namespace: linkerd
spec:
  isCA: true
  commonName: root.linkerd.cluster.local
  secretName: linkerd-trust-anchor
  subject:
    organizations:
      - cluster.local
      - linkerd
  privateKey:
    algorithm: ECDSA
    size: 256
  duration: 87600h  # 10 years
  renewBefore: 720h # 30 days before expiry
  issuerRef:
    name: linkerd-trust-anchor-issuer
    kind: ClusterIssuer
    group: cert-manager.io
---
# Step 2: Create an issuer using the trust anchor
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: linkerd-trust-anchor
  namespace: linkerd
spec:
  ca:
    secretName: linkerd-trust-anchor
---
# Step 3: Generate the identity issuer certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: linkerd-identity-issuer
  namespace: linkerd
spec:
  isCA: true
  commonName: identity.linkerd.cluster.local
  secretName: linkerd-identity-issuer
  subject:
    organizations:
      - cluster.local
      - linkerd
  privateKey:
    algorithm: ECDSA
    size: 256
  duration: 8760h    # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
  issuerRef:
    name: linkerd-trust-anchor
    kind: Issuer
    group: cert-manager.io
```

```bash
kubectl create namespace linkerd
kubectl apply -f linkerd-trust-anchor.yaml

# Wait for certificates to be issued
kubectl -n linkerd wait certificate/linkerd-trust-anchor \
  --for=condition=Ready --timeout=60s
kubectl -n linkerd wait certificate/linkerd-identity-issuer \
  --for=condition=Ready --timeout=60s
```

## Section 4: High Availability Control Plane Installation

### HA Values Configuration

```yaml
# linkerd-ha-values.yaml
controllerReplicas: 3
controllerLogLevel: info

# Identity component HA
identity:
  issuerClockSkewAllowance: 20s
  issuanceLifetime: 24h0m0s

# Proxy injection
proxyInjector:
  namespaceSelector:
    matchExpressions:
      - key: linkerd.io/inject
        operator: In
        values:
          - enabled
  replicaCount: 3

# Policy controller
policyController:
  logLevel: info
  probeNetworks:
    - 10.0.0.0/8
    - 172.16.0.0/12
    - 192.168.0.0/16

# Proxy defaults
proxy:
  resources:
    cpu:
      request: 100m
      limit: 1000m
    memory:
      request: 20Mi
      limit: 250Mi
  logLevel: warn,linkerd=info
  logFormat: json

# Control plane resource requirements
controllerResources:
  cpu:
    request: 100m
    limit: 1000m
  memory:
    request: 50Mi
    limit: 250Mi

destinationResources:
  cpu:
    request: 100m
    limit: 1000m
  memory:
    request: 50Mi
    limit: 250Mi

identityResources:
  cpu:
    request: 10m
    limit: 1000m
  memory:
    request: 10Mi
    limit: 250Mi

# Pod disruption budgets
podDisruptionBudget:
  maxUnavailable: 1

# Prometheus scraping
enablePodAntiAffinity: true
```

### Installation

```bash
# Extract trust anchor cert for --identity-trust-anchors-file
kubectl -n linkerd get secret linkerd-trust-anchor \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/linkerd-trust-anchor.crt

# Install Linkerd CRDs
helm install linkerd-crds linkerd/linkerd-crds \
  -n linkerd \
  --create-namespace

# Install Linkerd control plane
helm install linkerd-control-plane \
  -n linkerd \
  --set-file identityTrustAnchorsPEM=/tmp/linkerd-trust-anchor.crt \
  --set identity.issuer.scheme=kubernetes.io/tls \
  --values linkerd-ha-values.yaml \
  linkerd/linkerd-control-plane \
  --version 2.15.0 \
  --wait

# Verify installation
linkerd check
```

### Verify HA Configuration

```bash
# Check all control plane pods are running with multiple replicas
kubectl -n linkerd get pods

# Verify proxy injector has 3 replicas
kubectl -n linkerd get deployment linkerd-proxy-injector \
  -o jsonpath='{.spec.replicas}'

# Check PodDisruptionBudgets
kubectl -n linkerd get pdb

# Verify anti-affinity (pods on different nodes)
kubectl -n linkerd get pods -o wide | grep linkerd-destination
```

## Section 5: Injecting Proxies into Workloads

### Namespace-Level Injection

```bash
# Enable auto-injection for a namespace
kubectl annotate namespace production \
  linkerd.io/inject=enabled

# Verify annotation
kubectl get namespace production -o jsonpath='{.metadata.annotations}'

# Restart deployments to inject proxies
kubectl -n production rollout restart deployment
```

### Workload-Level Injection (Selective)

```yaml
# deployment-with-linkerd.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: production
spec:
  replicas: 3
  template:
    metadata:
      annotations:
        linkerd.io/inject: enabled
        # Proxy resource overrides for this workload
        config.linkerd.io/proxy-cpu-request: "200m"
        config.linkerd.io/proxy-memory-request: "32Mi"
        # Skip proxy for specific ports
        config.linkerd.io/skip-outbound-ports: "3306"
        config.linkerd.io/skip-inbound-ports: ""
        # Enable access logging
        config.linkerd.io/access-log: apache
    spec:
      containers:
        - name: orders-api
          image: your-registry/orders-api:v2.5.0
          ports:
            - containerPort: 8080
```

### Opt-Out Injection

```yaml
# For pods that should NOT have proxies (e.g., node-level DaemonSets)
metadata:
  annotations:
    linkerd.io/inject: disabled
```

## Section 6: Installing and Configuring the Viz Extension

```bash
# Install linkerd-viz
helm install linkerd-viz \
  -n linkerd-viz \
  --create-namespace \
  linkerd/linkerd-viz \
  --version 2.15.0 \
  --set dashboard.replicas=2 \
  --set prometheus.enabled=false \  # Use your existing Prometheus
  --set prometheusUrl="http://prometheus-operated.monitoring.svc.cluster.local:9090" \
  --wait

# Verify
linkerd viz check

# Access the dashboard
linkerd viz dashboard
# Or port-forward manually:
kubectl -n linkerd-viz port-forward svc/web 8084:8084 &
```

### ServiceMonitor for Existing Prometheus

```yaml
# linkerd-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: linkerd-controller
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    matchNames:
      - linkerd
      - linkerd-viz
  selector:
    matchLabels:
      linkerd.io/control-plane-component: controller
  endpoints:
    - port: admin-http
      path: /metrics
      interval: 15s
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: linkerd-proxy
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    any: true
  selector:
    matchLabels:
      linkerd.io/proxy-deployment: ""
  endpoints:
    - port: linkerd-admin
      path: /metrics
      interval: 15s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_label_linkerd_io_proxy_deployment]
          targetLabel: deployment
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
```

## Section 7: Multicluster Service Mirroring

Linkerd's multicluster extension creates a gateway-based service mirroring architecture. Services in a "target" cluster are mirrored as local services in the "source" cluster, with mTLS enforced end-to-end through the gateways.

### Topology

```
Source Cluster                    Target Cluster
┌─────────────────────┐          ┌─────────────────────┐
│  Pod A              │          │  payments-api (svc)  │
│  (calls payments)   │──mTLS──▶│  Gateway             │
│                     │          │  linkerd-gateway     │
│  payments-api       │          └─────────────────────┘
│  (mirror service)   │
└─────────────────────┘
```

### Installing Multicluster Extension on Both Clusters

```bash
# Install on both clusters
for CONTEXT in prod-us-east-1 prod-us-west-2; do
    helm install linkerd-multicluster \
      -n linkerd-multicluster \
      --create-namespace \
      --kube-context "${CONTEXT}" \
      linkerd/linkerd-multicluster \
      --version 2.15.0 \
      --wait

    echo "Installed multicluster on ${CONTEXT}"
done
```

### Linking Clusters

```bash
# Generate credentials from the target cluster (prod-us-west-2)
linkerd --context=prod-us-west-2 multicluster link \
  --cluster-name prod-us-west-2 \
  --gateway-addresses "gateway.linkerd-multicluster.svc.cluster.local" \
  > /tmp/link-credentials.yaml

# Apply the credentials to the source cluster (prod-us-east-1)
kubectl --context=prod-us-east-1 apply -f /tmp/link-credentials.yaml

# Verify the link
linkerd --context=prod-us-east-1 multicluster check
linkerd --context=prod-us-east-1 multicluster gateways
```

### Exporting Services for Mirroring

In the target cluster, annotate services to make them visible to the mirror controller:

```yaml
# payments-service-target.yaml (applied to prod-us-west-2)
apiVersion: v1
kind: Service
metadata:
  name: payments-api
  namespace: production
  labels:
    mirror.linkerd.io/exported: "true"   # This service will be mirrored
  annotations:
    mirror.linkerd.io/gateway-name: linkerd-gateway
    mirror.linkerd.io/gateway-ns: linkerd-multicluster
spec:
  selector:
    app: payments-api
  ports:
    - name: http
      port: 8080
      targetPort: 8080
```

After annotation, the mirror controller in the source cluster creates:

```
payments-api-prod-us-west-2.production.svc.cluster.local
```

Clients in the source cluster call this mirrored service as if it were local.

### Testing Multicluster Connectivity

```bash
# Check mirrored services in source cluster
kubectl --context=prod-us-east-1 -n production get services | grep "west-2"

# Send test traffic
kubectl --context=prod-us-east-1 -n production run test-pod \
  --image=curlimages/curl:8.5.0 \
  --rm -it \
  --restart=Never \
  -- curl -s http://payments-api-prod-us-west-2:8080/health

# Check service mirror controller logs
kubectl --context=prod-us-east-1 -n linkerd-multicluster \
  logs deploy/linkerd-service-mirror-prod-us-west-2 --tail=30

# Measure cross-cluster latency
linkerd --context=prod-us-east-1 viz stat \
  --namespace production \
  deploy/orders-api
```

## Section 8: SMI Traffic Split for Canary Deployments

Linkerd implements the Service Mesh Interface (SMI) TrafficSplit spec, enabling percentage-based traffic routing between service versions.

### Installing SMI CRDs

```bash
# SMI CRDs are included with Linkerd SMI extension
helm install linkerd-smi \
  -n linkerd-smi \
  --create-namespace \
  linkerd/linkerd-smi \
  --version 1.0.0 \
  --wait
```

### Canary Deployment with TrafficSplit

```yaml
# canary-traffic-split.yaml

# Stable version (v1)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api-v1
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payments-api
      version: v1
  template:
    metadata:
      labels:
        app: payments-api
        version: v1
      annotations:
        linkerd.io/inject: enabled
    spec:
      containers:
        - name: payments-api
          image: your-registry/payments-api:v1.8.0
          ports:
            - containerPort: 8080
---
# Canary version (v2)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api-v2
  namespace: production
spec:
  replicas: 1
  selector:
    matchLabels:
      app: payments-api
      version: v2
  template:
    metadata:
      labels:
        app: payments-api
        version: v2
      annotations:
        linkerd.io/inject: enabled
    spec:
      containers:
        - name: payments-api
          image: your-registry/payments-api:v2.0.0
          ports:
            - containerPort: 8080
---
# Apex service (what clients call)
apiVersion: v1
kind: Service
metadata:
  name: payments-api
  namespace: production
spec:
  selector:
    app: payments-api  # No version selector — TrafficSplit controls distribution
  ports:
    - port: 8080
---
# v1 backend service
apiVersion: v1
kind: Service
metadata:
  name: payments-api-v1
  namespace: production
spec:
  selector:
    app: payments-api
    version: v1
  ports:
    - port: 8080
---
# v2 backend service
apiVersion: v1
kind: Service
metadata:
  name: payments-api-v2
  namespace: production
spec:
  selector:
    app: payments-api
    version: v2
  ports:
    - port: 8080
---
# TrafficSplit: 95% to v1, 5% to v2
apiVersion: split.smi-spec.io/v1alpha1
kind: TrafficSplit
metadata:
  name: payments-api-canary
  namespace: production
spec:
  service: payments-api
  backends:
    - service: payments-api-v1
      weight: 950m   # 95% (milli-weight, 1000m = 100%)
    - service: payments-api-v2
      weight: 50m    # 5%
```

### Progressive Traffic Migration Script

```bash
#!/usr/bin/env bash
# canary-promote.sh — Progressively shift traffic to v2
set -euo pipefail

NAMESPACE="production"
TRAFFICSPLIT="payments-api-canary"
V1_SERVICE="payments-api-v1"
V2_SERVICE="payments-api-v2"

# Traffic stages: [v2_weight_millicents]
STAGES=(50 100 200 300 500 750 900 950 1000)

for v2_weight in "${STAGES[@]}"; do
    v1_weight=$(( 1000 - v2_weight ))

    echo "Setting traffic: v1=${v1_weight}m, v2=${v2_weight}m"

    kubectl -n "${NAMESPACE}" patch trafficsplit "${TRAFFICSPLIT}" \
      --type=json \
      -p "[
        {\"op\": \"replace\", \"path\": \"/spec/backends/0/weight\", \"value\": \"${v1_weight}m\"},
        {\"op\": \"replace\", \"path\": \"/spec/backends/1/weight\", \"value\": \"${v2_weight}m\"}
      ]"

    echo "Waiting 2 minutes and checking metrics..."
    sleep 120

    # Check error rate for v2
    V2_ERROR_RATE=$(linkerd viz stat \
      --namespace "${NAMESPACE}" \
      svc/"${V2_SERVICE}" \
      -o json 2>/dev/null | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
rows = data.get('rows', [])
if rows:
    success_rate = float(rows[0].get('successRate', '1.0').rstrip('%')) / 100
    print(1 - success_rate)
else:
    print(0)
" 2>/dev/null || echo "0")

    echo "v2 error rate: ${V2_ERROR_RATE}"

    # Abort if error rate > 1%
    if python3 -c "import sys; sys.exit(0 if float('${V2_ERROR_RATE}') < 0.01 else 1)" 2>/dev/null; then
        echo "Error rate acceptable, continuing..."
    else
        echo "ERROR: v2 error rate (${V2_ERROR_RATE}) exceeds 1%. Rolling back!"
        kubectl -n "${NAMESPACE}" patch trafficsplit "${TRAFFICSPLIT}" \
          --type=json \
          -p '[
            {"op": "replace", "path": "/spec/backends/0/weight", "value": "1000m"},
            {"op": "replace", "path": "/spec/backends/1/weight", "value": "0m"}
          ]'
        exit 1
    fi
done

echo "Canary promotion complete. v2 is now handling 100% of traffic."

# Scale down v1 after successful promotion
kubectl -n "${NAMESPACE}" scale deployment/payments-api-v1 --replicas=0
```

## Section 9: Debug Tools

### linkerd tap — Request-Level Observability

```bash
# Watch live traffic to a deployment
linkerd viz tap deployment/orders-api -n production

# Filter to specific paths
linkerd viz tap deployment/orders-api -n production \
  --path /api/orders \
  --method POST

# Filter to specific response codes
linkerd viz tap deployment/orders-api -n production \
  --to service/payments-api \
  | grep "rsp.http-status=5"

# JSON output for programmatic analysis
linkerd viz tap deployment/orders-api -n production -o json | \
  python3 -c "
import sys, json
for line in sys.stdin:
    event = json.loads(line)
    rsp = event.get('responseInit', {})
    if rsp.get('httpStatus', 200) >= 500:
        req = event.get('requestInit', {})
        print(f'ERROR: {req.get(\"method\")} {req.get(\"path\")} -> {rsp.get(\"httpStatus\")}')
"
```

### linkerd viz stat — Golden Signals

```bash
# P50/P95/P99 latency + success rate + RPS for a deployment
linkerd viz stat deployment -n production

# Stat for specific service
linkerd viz stat deploy/orders-api -n production \
  --from deploy/frontend

# Watch in real-time
watch -n 5 linkerd viz stat deploy/payments-api -n production

# Route-level stats (requires ServiceProfiles)
linkerd viz routes deploy/orders-api -n production
linkerd viz routes deploy/orders-api -n production --to svc/payments-api
```

### linkerd viz edges — mTLS Connection Graph

```bash
# Show all mTLS connections for a namespace
linkerd viz edges deployment -n production

# Check if a specific connection is mTLS
linkerd viz edges pod/orders-api-xyz -n production

# Expected output shows "√ mTLS" for encrypted connections
# and "✗" for cleartext
```

### ServiceProfiles for Route-Level Metrics

```yaml
# orders-api-serviceprofile.yaml
apiVersion: linkerd.io/v1alpha2
kind: ServiceProfile
metadata:
  name: orders-api.production.svc.cluster.local
  namespace: production
spec:
  routes:
    - name: GET /api/orders/{id}
      condition:
        method: GET
        pathRegex: /api/orders/[^/]+
      isRetryable: true
      timeout: 25s
    - name: POST /api/orders
      condition:
        method: POST
        pathRegex: /api/orders
      isRetryable: false  # Non-idempotent
      timeout: 30s
    - name: GET /api/orders
      condition:
        method: GET
        pathRegex: /api/orders
      isRetryable: true
      timeout: 10s
  retryBudget:
    retryRatio: 0.2      # Up to 20% of requests can be retries
    minRetriesPerSecond: 10
    ttl: 10s
```

```bash
kubectl -n production apply -f orders-api-serviceprofile.yaml

# Now route-level metrics are available
linkerd viz routes deploy/orders-api -n production
```

### linkerd diagnostics — Internal Diagnostics

```bash
# Get the proxy configuration for a specific pod
linkerd diagnostics proxy-metrics \
  --namespace production \
  pod/orders-api-abc123-def456 | head -50

# Check control plane connection for a pod
linkerd diagnostics endpoints \
  --namespace production \
  orders-api.production.svc.cluster.local:8080

# Validate injection for a manifest
cat deployment.yaml | linkerd inject --dry-run | linkerd validate

# Check for injection issues
linkerd check --namespace production

# Get the outbound proxy configuration (Envoy/linkerd2-proxy xDS)
linkerd diagnostics proxy-metrics \
  --namespace production \
  --proxy pod/payments-api-xyz | grep "outbound"
```

### Debugging mTLS Issues

```bash
# Check certificate validity for a pod
pod="orders-api-abc123-def456"
ns="production"

# Get the proxy container's cert details
kubectl -n "${ns}" exec "${pod}" -c linkerd-proxy -- \
  /usr/lib/linkerd/linkerd2-proxy-identity dump-certs 2>/dev/null | \
  openssl x509 -text -noout 2>/dev/null | \
  grep -E "Subject:|Not Before:|Not After:|Issuer:"

# Check identity component cert issuance
linkerd viz tap deployment/linkerd-identity -n linkerd \
  --method POST --path /io.linkerd.proxy.identity.Identity/Certify 2>/dev/null | head -20

# Verify trust anchor fingerprint
linkerd identity -n production pod/orders-api-abc123-def456 2>/dev/null | \
  openssl x509 -fingerprint -noout

# Check for certificate rotation events
kubectl -n linkerd events --field-selector reason=CertificateRotated
```

## Section 10: Production Alerting and Runbooks

### Prometheus Alerts for Linkerd

```yaml
# linkerd-alert-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: linkerd-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: linkerd.control_plane
      rules:
        - alert: LinkerdControlPlaneDown
          expr: |
            sum(up{job=~"linkerd-.*"}) by (job) == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Linkerd control plane component {{ $labels.job }} is down"
            description: "No instances of {{ $labels.job }} are reachable."

        - alert: LinkerdIdentityCertExpiryImminent
          expr: |
            min(
              certmanager_certificate_expiration_timestamp_seconds{
                namespace="linkerd",
                name="linkerd-identity-issuer"
              }
            ) - time() < 172800
          for: 1h
          labels:
            severity: critical
          annotations:
            summary: "Linkerd identity issuer certificate expires in < 48 hours"
            description: "The Linkerd identity issuer certificate will expire in {{ $value | humanizeDuration }}."

        - alert: LinkerdHighErrorRate
          expr: |
            sum(
              rate(response_total{
                namespace!="linkerd",
                namespace!="linkerd-viz",
                classification="failure"
              }[5m])
            ) by (namespace, deployment)
            /
            sum(
              rate(response_total{
                namespace!="linkerd",
                namespace!="linkerd-viz"
              }[5m])
            ) by (namespace, deployment)
            > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High Linkerd error rate for {{ $labels.namespace }}/{{ $labels.deployment }}"
            description: "Error rate is {{ $value | humanizePercentage }} for {{ $labels.deployment }}."

        - alert: LinkerdHighP99Latency
          expr: |
            histogram_quantile(0.99,
              sum(
                rate(response_latency_ms_bucket{
                  namespace!="linkerd",
                  direction="inbound"
                }[5m])
              ) by (namespace, deployment, le)
            ) > 1000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High P99 latency for {{ $labels.namespace }}/{{ $labels.deployment }}"
            description: "P99 inbound latency is {{ $value }}ms."

        - alert: LinkerdMulticlusterGatewayDown
          expr: |
            probe_success{job="linkerd-multicluster-probe"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Linkerd multicluster gateway probe failing"
            description: "Cross-cluster traffic may be impacted."
```

### Operational Runbook: Control Plane Recovery

```bash
#!/usr/bin/env bash
# linkerd-recover.sh — Recover from a Linkerd control plane incident

echo "=== Linkerd Control Plane Recovery Runbook ==="

# Step 1: Check overall health
echo "1. Running health checks..."
linkerd check 2>&1 | tail -20

# Step 2: Check certificate status
echo "2. Certificate status..."
kubectl -n linkerd get certificates -o wide

# Step 3: Check control plane pod status
echo "3. Control plane pods..."
kubectl -n linkerd get pods -o wide

# Step 4: Check for pending CSRs
echo "4. Certificate signing requests..."
kubectl get csr | grep -i linkerd | head -20

# Step 5: Force certificate renewal if near expiry
echo "5. Checking cert-manager certificates..."
kubectl -n linkerd get certificate linkerd-identity-issuer \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}'

# Step 6: Restart control plane if needed
echo "6. To restart control plane components (if required):"
echo "   kubectl -n linkerd rollout restart deployment"

# Step 7: Check data plane proxy health
echo "7. Data plane proxies..."
kubectl get pods -A -o json | python3 -c "
import sys, json
pods = json.load(sys.stdin)
uninjected = []
for item in pods['items']:
    ns = item['metadata']['namespace']
    name = item['metadata']['name']
    ann = item['metadata'].get('annotations', {})
    if (ns not in ['kube-system', 'linkerd', 'linkerd-viz', 'linkerd-multicluster']
        and ann.get('linkerd.io/inject') == 'enabled'):
        containers = [c['name'] for c in item['spec']['containers']]
        if 'linkerd-proxy' not in containers:
            uninjected.append(f'{ns}/{name}')
for p in uninjected[:10]:
    print(f'NOT INJECTED: {p}')
"
```

### Automating Certificate Rotation Alerts with cert-manager

```yaml
# cert-rotation-alert.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: linkerd-cert-rotation
  namespace: monitoring
spec:
  groups:
    - name: cert.rotation
      rules:
        - alert: LinkerdTrustAnchorExpirySoon
          expr: |
            certmanager_certificate_expiration_timestamp_seconds{
              namespace="linkerd",
              name="linkerd-trust-anchor"
            } - time() < 7776000  # 90 days
          labels:
            severity: warning
          annotations:
            summary: "Linkerd trust anchor expires in < 90 days"
            description: "Plan trust anchor rotation. Current expiry: {{ $value | humanizeTimestamp }}."
```

Linkerd's operational model rewards careful certificate management and progressive delivery disciplines. The combination of zero-config mTLS, lightweight proxies, SMI-based traffic splitting, and comprehensive `linkerd viz` diagnostics makes it the production-grade service mesh for teams who need observability and security without Istio's configuration surface area.
