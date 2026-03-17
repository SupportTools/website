---
title: "Linkerd 2.x Deep Dive: mTLS Everywhere, Authorization Policies, and Multicluster Mirroring"
date: 2031-08-17T00:00:00-05:00
draft: false
tags: ["Linkerd", "Kubernetes", "Service Mesh", "mTLS", "Zero Trust", "Multicluster", "Security"]
categories: ["Kubernetes", "Security", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Linkerd 2.x covering automatic mTLS enforcement, fine-grained authorization policies, multicluster service mirroring, and production observability patterns."
more_link: "yes"
url: "/linkerd-2x-mtls-authorization-multicluster-enterprise-guide/"
---

Linkerd 2.x has matured into one of the most operationally sound service meshes available for Kubernetes. Unlike heavier alternatives, Linkerd's Rust-based data plane delivers sub-millisecond overhead while providing automatic mutual TLS, deep traffic observability, and fine-grained authorization policies without requiring application code changes. This guide covers a production-grade Linkerd deployment: from initial installation and certificate management through authorization policy enforcement, multicluster service mirroring, and the observability patterns that make the difference between a mesh that provides security theater and one that genuinely hardens your cluster.

<!--more-->

# Linkerd 2.x Deep Dive: mTLS Everywhere, Authorization Policies, and Multicluster Mirroring

## Why Linkerd Over Alternatives

The service mesh landscape has consolidated around a few credible options. Istio remains dominant in complexity-tolerant enterprises, Consul Connect serves HashiCorp shops, but Linkerd occupies a distinct niche: minimal operational overhead, extreme reliability, and a security model that works by default rather than by configuration.

Key architectural advantages for enterprise deployments:

- **Rust data plane proxies** (linkerd2-proxy) consume roughly 10-50ms of additional latency at p99 versus Envoy-based meshes that can add 10-100ms depending on configuration
- **Zero-config mTLS**: every injected pod gets mutual TLS automatically with no certificate management required from operators
- **Policy as first-class CRDs**: `Server`, `ServerAuthorization`, `AuthorizationPolicy`, `MeshTLSAuthentication`, and `NetworkAuthentication` resources provide layered access control
- **Non-invasive injection**: sidecar injection via annotation, no application changes required
- **Stable Helm chart**: predictable upgrade paths with clear deprecation timelines

## Infrastructure Prerequisites

Before installing Linkerd, ensure your cluster meets these requirements:

```bash
# Verify cluster capabilities
linkerd check --pre

# Required: kernel >= 4.4 for iptables-based traffic capture
# Required: CNI compatibility (Calico, Cilium, Flannel all work)
# Required: cert-manager or Vault PKI for production certificate management
```

### Certificate Architecture

Linkerd's trust hierarchy requires three certificate types:

1. **Trust anchor** (root CA): long-lived, stored offline or in Vault
2. **Identity issuer** (intermediate CA): issued by trust anchor, rotated annually
3. **Workload certificates**: issued by the identity issuer, 24-hour TTL by default

For production, never use Linkerd's built-in certificate generation. Use cert-manager with Vault or your internal PKI.

```yaml
# cert-manager Issuer backed by Vault PKI
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: linkerd-trust-anchor-issuer
spec:
  vault:
    path: pki/sign/linkerd-intermediate
    server: https://vault.internal.example.com
    auth:
      kubernetes:
        role: cert-manager-linkerd
        mountPath: /v1/auth/kubernetes
        secretRef:
          name: cert-manager-vault-token
          key: token
---
# Identity issuer certificate - renewed by cert-manager automatically
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: linkerd-identity-issuer
  namespace: linkerd
spec:
  secretName: linkerd-identity-issuer
  duration: 8760h  # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
  issuerRef:
    name: linkerd-trust-anchor-ississuer
    kind: ClusterIssuer
  commonName: identity.linkerd.cluster.local
  dnsNames:
    - identity.linkerd.cluster.local
  isCA: true
  privateKey:
    algorithm: ECDSA
    size: 256
  usages:
    - cert sign
    - crl sign
    - server auth
    - client auth
```

## Installing Linkerd with Helm

```bash
# Add the Linkerd stable Helm repository
helm repo add linkerd https://helm.linkerd.io/stable
helm repo update

# Install the CRDs first (separate chart in Linkerd 2.14+)
helm install linkerd-crds linkerd/linkerd-crds \
  --namespace linkerd \
  --create-namespace

# Extract the trust anchor certificate for Helm values
# In production this comes from your PKI; here we reference the cert-manager secret
TRUST_ANCHOR=$(kubectl get secret linkerd-trust-anchor \
  -n linkerd -o jsonpath='{.data.ca\.crt}' | base64 -d)

# Install the control plane
helm install linkerd-control-plane linkerd/linkerd-control-plane \
  --namespace linkerd \
  --set-file identityTrustAnchorsPEM=<(echo "$TRUST_ANCHOR") \
  --set identity.issuer.scheme=kubernetes.io/tls \
  --values linkerd-values.yaml
```

```yaml
# linkerd-values.yaml - production configuration
controllerLogLevel: info
controllerReplicas: 3

proxy:
  logLevel: warn,linkerd=info
  resources:
    cpu:
      request: 100m
      limit: 1000m
    memory:
      request: 20Mi
      limit: 250Mi
  # Increase default timeout for slow services
  outboundConnectTimeout: 1000ms
  inboundConnectTimeout: 100ms

identity:
  issuer:
    scheme: kubernetes.io/tls
    clockSkewAllowance: 20s
    issuanceLifetime: 24h0m0s

# Enable pod anti-affinity for control plane HA
enablePodAntiAffinity: true

# Prometheus integration
prometheusUrl: http://prometheus-operated.monitoring.svc.cluster.local:9090

# High availability control plane
highAvailability: true

# Disable viz if using external Prometheus
disableHeartBeat: false
```

### Verifying Installation

```bash
# Comprehensive health check
linkerd check

# Expected output (abbreviated):
# kubernetes
# -----------------------
# √ can initialize the client
# √ can query the Kubernetes API
#
# linkerd-config
# -----------------------
# √ control plane Namespace exists
# √ control plane ClusterRoles exist
# √ control plane ClusterRoleBindings exist
#
# linkerd-identity
# -----------------------
# √ certificate config is valid
# √ trust anchors are using supported crypto algorithm
# √ trust anchors are within their validity period
# √ trust anchors are valid for at least 60 days
#
# linkerd-data-plane
# -----------------------
# √ data plane namespace exists
# √ data plane proxies are ready
# √ data plane is up-to-date
```

## Automatic mTLS: How It Works

Understanding Linkerd's mTLS implementation is critical for debugging and policy design.

### The Identity System

When a Pod starts with the Linkerd proxy injected, the proxy:

1. Generates an ephemeral ECDSA P-256 key pair in memory
2. Constructs a SPIFFE SVID in the form `spiffe://<cluster-domain>/ns/<namespace>/sa/<service-account>`
3. Sends a CSR to the Linkerd Identity controller
4. Receives a signed certificate valid for 24 hours
5. Automatically renews before expiry (default: renew at 70% of lifetime)

```bash
# Inspect the SPIFFE identity of a running pod
linkerd diagnostics proxy-metrics -n production deploy/api-gateway | \
  grep identity

# View certificate details for a specific pod
kubectl exec -n production deploy/api-gateway -c linkerd-proxy -- \
  /usr/lib/linkerd/linkerd-await --authority=localhost:4191 \
  -- curl -s localhost:4191/metrics | grep identity_cert
```

### Verifying mTLS Is Active

```bash
# Use linkerd viz to confirm mTLS status between services
linkerd viz stat deployments -n production

# NAME          MESHED   SUCCESS   RPS   LATENCY_P50   LATENCY_P95   LATENCY_P99   TCP_CONN
# api-gateway   3/3      100.00%   42    1ms           4ms           12ms          47
# user-service  2/2      99.98%    38    2ms           6ms           18ms          42

# Check specific connection mTLS status
linkerd viz tap deploy/api-gateway -n production --to deploy/user-service | \
  grep -E "tls=|src=|dst="

# Expected: tls=true for all meshed connections
```

### Namespace-Level Injection

Annotate namespaces for automatic injection rather than individual deployments:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  annotations:
    linkerd.io/inject: enabled
    # Control proxy resource allocation per namespace
    config.linkerd.io/proxy-cpu-request: "100m"
    config.linkerd.io/proxy-cpu-limit: "500m"
    config.linkerd.io/proxy-memory-request: "20Mi"
    config.linkerd.io/proxy-memory-limit: "128Mi"
```

For workloads that cannot be meshed (e.g., host-network pods, system DaemonSets):

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  template:
    metadata:
      annotations:
        linkerd.io/inject: disabled
```

## Authorization Policies

Linkerd's policy system operates at Layer 4 (TCP) and Layer 7 (HTTP). The resource hierarchy:

```
Server (defines a port on a workload)
  └── AuthorizationPolicy (who can reach this Server)
        ├── MeshTLSAuthentication (SPIFFE identity-based)
        └── NetworkAuthentication (CIDR-based, for unmeshed clients)
```

### Defining Servers

A `Server` resource selects a port on a set of pods:

```yaml
apiVersion: policy.linkerd.io/v1beta3
kind: Server
metadata:
  name: api-gateway-http
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-gateway
  port: 8080
  proxyProtocol: HTTP/2
---
apiVersion: policy.linkerd.io/v1beta3
kind: Server
metadata:
  name: user-service-grpc
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: user-service
  port: 9090
  proxyProtocol: gRPC
```

### MeshTLS Authentication

Allow only specific SPIFFE identities to reach a service:

```yaml
# Define which identities are trusted
apiVersion: policy.linkerd.io/v1alpha1
kind: MeshTLSAuthentication
metadata:
  name: api-gateway-clients
  namespace: production
spec:
  identities:
    # Allow the api-gateway service account
    - "*.production.serviceaccount.identity.linkerd.cluster.local"
  identityRefs:
    # Or reference specific service accounts directly
    - kind: ServiceAccount
      name: api-gateway
      namespace: production
    - kind: ServiceAccount
      name: frontend
      namespace: production
---
# Apply the authentication to the user-service Server
apiVersion: policy.linkerd.io/v1alpha1
kind: AuthorizationPolicy
metadata:
  name: user-service-allow-api-gateway
  namespace: production
spec:
  targetRef:
    group: policy.linkerd.io
    kind: Server
    name: user-service-grpc
  requiredAuthenticationRefs:
    - name: api-gateway-clients
      kind: MeshTLSAuthentication
      group: policy.linkerd.io
```

### Network Authentication for Unmeshed Clients

Some clients cannot run the Linkerd proxy (external load balancers, legacy systems):

```yaml
apiVersion: policy.linkerd.io/v1alpha1
kind: NetworkAuthentication
metadata:
  name: internal-network
  namespace: production
spec:
  networks:
    - cidr: 10.0.0.0/8      # Internal RFC 1918
    - cidr: 172.16.0.0/12
    - cidr: 192.168.0.0/16
---
apiVersion: policy.linkerd.io/v1alpha1
kind: AuthorizationPolicy
metadata:
  name: allow-internal-network
  namespace: production
spec:
  targetRef:
    group: policy.linkerd.io
    kind: Server
    name: api-gateway-http
  requiredAuthenticationRefs:
    - name: internal-network
      kind: NetworkAuthentication
      group: policy.linkerd.io
```

### HTTPRoute for Layer 7 Policies

Linkerd supports Gateway API HTTPRoute for fine-grained L7 authorization:

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: HTTPRoute
metadata:
  name: user-service-routes
  namespace: production
spec:
  parentRefs:
    - name: user-service-grpc
      kind: Server
      group: policy.linkerd.io
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1/users
          headers:
            - name: x-internal-request
              value: "true"
      backendRefs:
        - name: user-service
          port: 9090
---
# Authorize only authenticated mesh clients for the admin path
apiVersion: policy.linkerd.io/v1alpha1
kind: AuthorizationPolicy
metadata:
  name: user-service-admin-policy
  namespace: production
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: user-service-routes
  requiredAuthenticationRefs:
    - name: api-gateway-clients
      kind: MeshTLSAuthentication
      group: policy.linkerd.io
```

### Default-Deny Policy

For a zero-trust posture, configure Linkerd to deny all traffic by default and require explicit authorization:

```bash
# Set default policy to deny for a namespace
kubectl annotate namespace production \
  config.linkerd.io/default-inbound-policy=deny
```

Or in Helm values for cluster-wide default:

```yaml
# In linkerd-values.yaml
proxy:
  defaultInboundPolicy: deny
```

With default-deny enabled, you must explicitly create `AuthorizationPolicy` resources for every service-to-service communication path. This is operationally intensive but provides the strongest security posture.

```bash
# Audit policy coverage - find servers without authorization policies
linkerd diagnostics policy-check -n production

# List all servers and their authorization status
kubectl get servers,authorizationpolicies -n production
```

## Traffic Management and Reliability

### Retries and Timeouts

Linkerd's retry and timeout configuration uses `ServiceProfile` CRDs:

```yaml
apiVersion: linkerd.io/v1alpha2
kind: ServiceProfile
metadata:
  name: user-service.production.svc.cluster.local
  namespace: production
spec:
  routes:
    - name: GET /api/v1/users/{id}
      condition:
        method: GET
        pathRegex: /api/v1/users/[^/]*
      responseClasses:
        - condition:
            status:
              min: 500
              max: 599
          isFailure: true
      retryBudget:
        retryRatio: 0.2       # Up to 20% additional requests for retries
        minRetriesPerSecond: 10
        ttl: 10s
      timeout: 25ms
    - name: POST /api/v1/users
      condition:
        method: POST
        pathRegex: /api/v1/users
      # Do NOT retry non-idempotent requests
      isRetryable: false
      timeout: 100ms
```

### Circuit Breaking

Linkerd does not implement circuit breaking directly (this is a deliberate design decision to keep the data plane simple). For circuit breaking, use the `failoverGroup` pattern with multiple backends:

```yaml
apiVersion: linkerd.io/v1alpha2
kind: ServiceProfile
metadata:
  name: payment-service.production.svc.cluster.local
  namespace: production
spec:
  routes:
    - name: POST /charge
      condition:
        method: POST
        pathRegex: /charge
      responseClasses:
        - condition:
            status:
              min: 500
              max: 599
          isFailure: true
        - condition:
            status:
              min: 429
              max: 429
          isFailure: true
      retryBudget:
        retryRatio: 0.1
        minRetriesPerSecond: 5
        ttl: 10s
```

## Multicluster Service Mirroring

Linkerd's multicluster feature uses a gateway-based model where services in one cluster are mirrored as local services in another cluster. Traffic flows through a gateway pod in the target cluster, with mTLS maintained end-to-end.

### Architecture Overview

```
Cluster A (source)                    Cluster B (target)
┌─────────────────────────┐          ┌─────────────────────────┐
│  frontend               │          │  api-service            │
│  └── linkerd-proxy ──── │──mTLS───▶│  └── linkerd-proxy      │
│                         │          │                          │
│  api-service-cluster-b  │          │  linkerd-multicluster    │
│  (mirror service) ──────│──────────│  gateway                 │
└─────────────────────────┘          └─────────────────────────┘
```

### Installing the Multicluster Extension

```bash
# Install on both clusters
helm install linkerd-multicluster linkerd/linkerd-multicluster \
  --namespace linkerd-multicluster \
  --create-namespace \
  --set gateway.enabled=true \
  --set gateway.serviceAnnotations."service\.beta\.kubernetes\.io/aws-load-balancer-type"=nlb

# Verify gateway is ready
linkerd multicluster check
```

### Linking Clusters

```bash
# On cluster-b: generate the link credentials
linkerd multicluster link --cluster-name cluster-b \
  --api-server-address https://cluster-b-api.example.com:6443 \
  > cluster-b-link.yaml

# Review the generated link (contains a service account token and CA cert)
cat cluster-b-link.yaml

# On cluster-a: apply the link
kubectl apply -f cluster-b-link.yaml --context cluster-a

# Verify the link is healthy
linkerd multicluster check --context cluster-a
```

The generated `Link` resource looks like:

```yaml
apiVersion: multicluster.linkerd.io/v1alpha1
kind: Link
metadata:
  name: cluster-b
  namespace: linkerd-multicluster
spec:
  clusterCredentialsSecret: cluster-b-credentials
  gatewayAddress: 203.0.113.42  # The NLB IP of cluster-b's gateway
  gatewayIdentity: linkerd-gateway.linkerd-multicluster.serviceaccount.identity.linkerd.cluster.local
  gatewayPort: 4143
  probeSpec:
    path: /ready
    period: 3s
    port: 4191
  remoteDiscoverySelector:
    matchLabels:
      mirror.linkerd.io/exported: "true"
  targetClusterDomain: cluster.local
  targetClusterLinkerdNamespace: linkerd
  targetClusterName: cluster-b
```

### Exporting Services

On cluster-b, label services for export:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  labels:
    mirror.linkerd.io/exported: "true"
  annotations:
    # Optional: customize the gateway service used for this export
    multicluster.linkerd.io/gateway-name: linkerd-gateway
    multicluster.linkerd.io/gateway-namespace: linkerd-multicluster
spec:
  selector:
    app: api-service
  ports:
    - name: http
      port: 8080
      targetPort: 8080
```

Once labeled, cluster-a will automatically create a mirror service:

```bash
# On cluster-a: verify the mirror service was created
kubectl get services -n production --context cluster-a | grep cluster-b

# NAME                        TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE
# api-service-cluster-b       ClusterIP   10.96.142.88    <none>        8080/TCP   2m
```

### Failover with Traffic Splitting

Use Linkerd's traffic split (SMI) to implement cross-cluster failover:

```yaml
apiVersion: split.smi-spec.io/v1alpha2
kind: TrafficSplit
metadata:
  name: api-service-failover
  namespace: production
spec:
  service: api-service
  backends:
    - service: api-service         # Local cluster-a instance
      weight: 90
    - service: api-service-cluster-b  # Mirror from cluster-b
      weight: 10
```

For active-passive failover, implement health-based switching using an external controller or the Flagger operator.

### Multicluster mTLS Verification

```bash
# Verify mTLS is maintained for cross-cluster traffic
linkerd viz tap deploy/frontend -n production \
  --to service/api-service-cluster-b | grep tls

# Each connection should show: tls=true
# The identity will be the cluster-b service's SPIFFE ID

# Check gateway metrics
linkerd viz stat --namespace linkerd-multicluster \
  deploy/linkerd-gateway
```

## Observability and Metrics

### Linkerd Viz Extension

```bash
# Install the viz extension (connects to your existing Prometheus)
helm install linkerd-viz linkerd/linkerd-viz \
  --namespace linkerd-viz \
  --create-namespace \
  --set prometheus.enabled=false \
  --set prometheusUrl=http://prometheus-operated.monitoring.svc.cluster.local:9090 \
  --set grafana.enabled=false \
  --set grafanaUrl=http://grafana.monitoring.svc.cluster.local:3000
```

### Key Prometheus Metrics

The Linkerd proxy exposes rich metrics at `:4191/metrics`. Critical metrics for alerting:

```yaml
# PrometheusRule for Linkerd SLOs
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: linkerd-slos
  namespace: monitoring
spec:
  groups:
    - name: linkerd.success-rate
      interval: 30s
      rules:
        # Success rate SLO: 99.9% over 5m
        - alert: LinkerdHighErrorRate
          expr: |
            (
              sum(rate(response_total{classification="failure",namespace="production"}[5m]))
              /
              sum(rate(response_total{namespace="production"}[5m]))
            ) > 0.001
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Linkerd error rate exceeds 0.1% in production"
            description: "Error rate is {{ $value | humanizePercentage }} for namespace production"

        # P99 latency SLO: < 100ms
        - alert: LinkerdHighLatency
          expr: |
            histogram_quantile(0.99,
              sum(rate(response_latency_ms_bucket{namespace="production"}[5m]))
              by (le, deployment)
            ) > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Linkerd P99 latency exceeds 100ms"
            description: "P99 latency is {{ $value }}ms for {{ $labels.deployment }}"

        # mTLS coverage: all meshed traffic should be encrypted
        - alert: LinkerdUnencryptedTraffic
          expr: |
            sum(rate(tcp_open_connections{tls="false",namespace="production"}[5m])) > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Unencrypted traffic detected in production namespace"
```

### Grafana Dashboard Integration

Linkerd provides official Grafana dashboards. Import them via ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: linkerd-dashboards
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  linkerd-top-line.json: |
    # Dashboard JSON from https://grafana.com/grafana/dashboards/15474
    # Import dashboard ID 15474 for Linkerd Top Line metrics
```

```bash
# Use linkerd viz dashboard for quick inspection
linkerd viz dashboard &

# Or tap traffic in real-time
linkerd viz tap ns/production --method GET --path /api/v1/users

# Top-line metrics per deployment
linkerd viz top deploy -n production

# Route-level success rates from ServiceProfiles
linkerd viz routes deploy/api-gateway -n production
```

## Upgrade Strategy

Linkerd upgrades require a rolling approach to maintain data plane availability:

```bash
# Step 1: Upgrade the CLI
curl -sL run.linkerd.io/install | sh -s -- --version stable-2.14.x

# Step 2: Check compatibility before upgrading control plane
linkerd upgrade --dry-run | kubectl diff -f -

# Step 3: Upgrade CRDs first
helm upgrade linkerd-crds linkerd/linkerd-crds \
  --namespace linkerd \
  --version 2.14.x

# Step 4: Upgrade control plane
helm upgrade linkerd-control-plane linkerd/linkerd-control-plane \
  --namespace linkerd \
  --version 2.14.x \
  --values linkerd-values.yaml \
  --atomic \
  --timeout 5m

# Step 5: Verify control plane health
linkerd check

# Step 6: Rolling-restart injected workloads to pick up new proxy version
# Do this namespace by namespace to control blast radius
for ns in production staging; do
  kubectl rollout restart deployment -n $ns
  kubectl rollout status deployment -n $ns --timeout=5m
done

# Step 7: Verify data plane is updated
linkerd check --proxy
```

## Troubleshooting Common Issues

### Certificate Rotation Failures

```bash
# Check identity controller logs
kubectl logs -n linkerd deploy/linkerd-identity -c identity

# Verify cert-manager has renewed the issuer certificate
kubectl get certificate -n linkerd linkerd-identity-issuer -o yaml | \
  grep -E "notBefore|notAfter|renewedAt"

# Force certificate renewal if stuck
kubectl annotate certificate linkerd-identity-issuer \
  -n linkerd \
  cert-manager.io/issueAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

### Proxy Injection Not Working

```bash
# Check webhook configuration
kubectl get mutatingwebhookconfigurations linkerd-proxy-injector-webhook-config -o yaml | \
  grep -A5 namespaceSelector

# Verify the namespace annotation
kubectl get namespace production -o jsonpath='{.metadata.annotations}'

# Check injector logs
kubectl logs -n linkerd deploy/linkerd-proxy-injector -c proxy-injector

# Test injection manually
kubectl run test-pod --image=nginx --dry-run=server -o yaml | \
  grep linkerd
```

### Multicluster Connectivity Issues

```bash
# Check gateway health from source cluster
linkerd multicluster gateways --context cluster-a

# CLUSTER    ALIVE   NUM_SVC   LATENCY
# cluster-b  true    5         3ms

# If ALIVE=false, check gateway service external IP
kubectl get svc -n linkerd-multicluster --context cluster-b | grep gateway

# Test direct connectivity to gateway
kubectl run nettest --rm -it --image=nicolaka/netshoot -- \
  curl -v https://<gateway-ip>:4143/ready

# Check link credentials secret
kubectl get secret cluster-b-credentials -n linkerd-multicluster \
  -o jsonpath='{.data.kubeconfig}' | base64 -d | \
  kubectl --kubeconfig /dev/stdin get nodes
```

## Production Hardening Checklist

Before moving Linkerd to production, verify these items:

```bash
#!/bin/bash
# linkerd-production-check.sh

echo "=== Linkerd Production Readiness Check ==="

# 1. Verify HA control plane
echo "Control plane replicas:"
kubectl get deploy -n linkerd -o custom-columns=\
'NAME:.metadata.name,REPLICAS:.spec.replicas,READY:.status.readyReplicas'

# 2. Verify certificate validity periods
echo ""
echo "Certificate validity:"
kubectl get certificate -n linkerd -o custom-columns=\
'NAME:.metadata.name,READY:.status.conditions[0].status,NOT_AFTER:.status.notAfter'

# 3. Check default-deny policy coverage
echo ""
echo "Namespaces without default-deny:"
kubectl get namespaces -o json | jq -r \
  '.items[] | select(.metadata.annotations["config.linkerd.io/default-inbound-policy"] != "deny") | .metadata.name'

# 4. Verify meshed pod percentage
echo ""
echo "Mesh injection coverage:"
kubectl get pods -A -o json | jq -r '
  .items |
  group_by(.metadata.namespace) |
  .[] |
  {
    namespace: .[0].metadata.namespace,
    total: length,
    meshed: [.[] | select(.metadata.annotations["linkerd.io/proxy-version"] != null)] | length
  } |
  "\(.namespace): \(.meshed)/\(.total) meshed"
'

# 5. Verify no unauthorized egress
echo ""
echo "Checking for Server resources without AuthorizationPolicies:"
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
  servers=$(kubectl get servers -n $ns --no-headers 2>/dev/null | wc -l)
  policies=$(kubectl get authorizationpolicies -n $ns --no-headers 2>/dev/null | wc -l)
  if [ "$servers" -gt 0 ] && [ "$policies" -eq 0 ]; then
    echo "  WARNING: $ns has $servers Server(s) but no AuthorizationPolicies"
  fi
done

echo ""
echo "=== Check complete ==="
```

## Conclusion

Linkerd 2.x provides enterprise-grade zero-trust networking with remarkably low operational overhead. The key capabilities covered here — automatic mTLS with SPIFFE identities, fine-grained authorization policies using the Server/AuthorizationPolicy CRD hierarchy, and multicluster service mirroring with end-to-end encryption — give platform teams the building blocks for a security posture that is enforceable, auditable, and observable.

The investment in proper certificate management (using cert-manager with Vault rather than self-signed certs), default-deny authorization policies, and per-route ServiceProfiles pays dividends in incident response: when something breaks, the authorization audit trail and per-route success rate metrics pinpoint the issue immediately rather than requiring packet captures.

For teams adopting Linkerd, start with mesh injection and mTLS visibility in a non-production namespace, build familiarity with `linkerd viz tap` and `linkerd viz stat`, then progressively roll out authorization policies namespace by namespace. The multicluster feature can be added independently once single-cluster operations are stable.
