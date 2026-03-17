---
title: "Kubernetes Network Policy Deep Dive: Ingress/Egress Rules, Namespace Isolation, and Cilium Network Policies"
date: 2028-07-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Network Policy", "Cilium", "Security", "Zero Trust"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes Network Policies covering ingress and egress rule design, namespace isolation patterns, default-deny architecture, and Cilium's extended network policy capabilities including L7 policies and DNS-based egress control."
more_link: "yes"
url: "/kubernetes-network-policy-deep-dive-guide/"
---

Kubernetes Network Policies are one of the most widely misconfigured security features in production clusters. Most teams either skip them entirely (everything can talk to everything) or implement them incorrectly (partial rules that give false confidence). Understanding Network Policies properly means understanding what they cannot do as well as what they can: they are not firewalls, they don't encrypt traffic, and a policy that selects no pods protects nothing.

This guide covers Network Policy fundamentals without shortcuts, namespace isolation patterns, the common pitfalls that cause outages, and Cilium's extended capabilities that address the limitations of the standard API.

<!--more-->

# Kubernetes Network Policy Deep Dive: Ingress/Egress Rules, Namespace Isolation, and Cilium Network Policies

## Section 1: NetworkPolicy Fundamentals

### How NetworkPolicy Works

A NetworkPolicy is implemented by the CNI plugin (Calico, Cilium, Weave, etc.), NOT by kube-apiserver or kubelet. If your CNI plugin doesn't support NetworkPolicy, creating NetworkPolicy resources has no effect at all - they are stored in etcd but never enforced.

Critical facts:
- **Default behavior**: Without any NetworkPolicy, all traffic between pods is allowed
- **Additive**: Multiple policies apply together (union of all allowed traffic)
- **Selector-based**: Policies apply to pods matching `podSelector`
- **No implicit deny**: A policy only creates allow rules; it doesn't block traffic that isn't mentioned UNLESS the policy explicitly creates a default deny by having a podSelector that matches pods but empty ingress/egress rules

### Checking CNI NetworkPolicy Support

```bash
# Check which CNI is installed
kubectl get pods -n kube-system | grep -iE "calico|cilium|weave|flannel|canal"

# For Cilium
kubectl -n kube-system exec -it ds/cilium -- cilium status | grep "Network Policy"

# For Calico
kubectl get felixconfigurations -o yaml | grep policyDebug

# Verify NetworkPolicy is being enforced (test with a simple policy)
kubectl run test-a --image=nginx -n default --labels=app=test-a
kubectl run test-b --image=nginx -n default --labels=app=test-b

# Without any policy, test-b can reach test-a
kubectl exec test-b -- curl -s --max-time 2 http://test-a

# Apply a policy blocking test-b from test-a
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-test-b
  namespace: default
spec:
  podSelector:
    matchLabels:
      app: test-a
  policyTypes:
  - Ingress
  ingress: []  # Empty = deny all ingress
EOF

# Now test-b should not reach test-a
kubectl exec test-b -- curl -s --max-time 2 http://test-a
# Should timeout or be refused

# Cleanup
kubectl delete networkpolicy deny-test-b
kubectl delete pod test-a test-b
```

## Section 2: Policy Selectors

### Pod Selector

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-policy
  namespace: production
spec:
  # Apply this policy to pods with these labels
  podSelector:
    matchLabels:
      app: api
      tier: backend

  policyTypes:
  - Ingress
  - Egress
```

### Namespace Selector

```yaml
# Allow ingress from pods in namespaces labeled "env=production"
spec:
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          env: production

---
# Combine namespace AND pod selectors (AND logic)
# From pods labeled app=frontend AND in namespaces labeled env=production
spec:
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          env: production
      podSelector:
        matchLabels:
          app: frontend

---
# OR logic: from pods labeled app=frontend OR from any pod in env=production namespace
# (separate entries in the from array = OR)
spec:
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    - namespaceSelector:
        matchLabels:
          env: production
```

**Critical distinction:** When `namespaceSelector` and `podSelector` are in the SAME `from` entry (same list item), it's AND logic. When they are in SEPARATE `from` list items, it's OR logic. This is a frequent source of bugs.

### IP Block Selector

```yaml
# Allow ingress from specific CIDR ranges
spec:
  ingress:
  - from:
    - ipBlock:
        cidr: 10.0.0.0/8      # Internal RFC1918
        except:
        - 10.100.0.0/16        # Exclude this specific subnet
    - ipBlock:
        cidr: 172.16.0.0/12   # Docker default bridge network

# Allow egress to external services (specific IPs)
spec:
  egress:
  - to:
    - ipBlock:
        cidr: 203.0.113.0/24  # External API provider
    ports:
    - protocol: TCP
      port: 443
```

## Section 3: Default Deny Architecture

### Namespace-Level Default Deny

The safest baseline is default deny all traffic, then explicitly allow what is needed:

```yaml
---
# Default deny all ingress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: production
spec:
  podSelector: {}    # Matches ALL pods in namespace
  policyTypes:
  - Ingress
  ingress: []        # No rules = no ingress allowed

---
# Default deny all egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress: []
```

**Critical:** After applying default deny egress, DNS resolution breaks. You MUST add a DNS allow rule:

```yaml
# Allow DNS resolution (required for all services)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: production
spec:
  podSelector: {}    # Apply to all pods
  policyTypes:
  - Egress
  egress:
  # Allow DNS to kube-dns
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
```

### Baseline Allow Rules for Production Namespace

```yaml
---
# Allow Prometheus to scrape all pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-prometheus-scrape
  namespace: production
spec:
  podSelector: {}    # All pods can be scraped
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app: prometheus
    ports:
    - protocol: TCP
      port: 9090
    - protocol: TCP
      port: 8080    # Common metrics port

---
# Allow health checks from kubelet (required for liveness/readiness probes)
# Note: kubelet runs on the node, not in a pod - use ipBlock
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-kubelet-health-checks
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  # Kubelet IP range (node CIDR)
  - from:
    - ipBlock:
        cidr: 10.0.0.0/24    # Node CIDR - adjust for your cluster
    ports:
    - protocol: TCP
      port: 8080
    - protocol: TCP
      port: 8443
    - protocol: TCP
      port: 9090
```

## Section 4: Microservice Communication Patterns

### Three-Tier Application Policies

```yaml
---
# Frontend: accepts ingress from load balancer, egress to API only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      tier: frontend
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # From ingress controller
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8080
  egress:
  # To API tier
  - to:
    - podSelector:
        matchLabels:
          tier: api
    ports:
    - protocol: TCP
      port: 8080
  # DNS
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53

---
# API tier: ingress from frontend, egress to database and cache
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      tier: api
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          tier: frontend
    ports:
    - protocol: TCP
      port: 8080
  egress:
  # To database tier
  - to:
    - podSelector:
        matchLabels:
          tier: database
    ports:
    - protocol: TCP
      port: 5432
  # To cache tier
  - to:
    - podSelector:
        matchLabels:
          tier: cache
    ports:
    - protocol: TCP
      port: 6379
  # DNS
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53

---
# Database tier: ingress from API only, no egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      tier: database
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          tier: api
    ports:
    - protocol: TCP
      port: 5432
  egress:
  # Only DNS - databases don't need external access
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
```

### Cross-Namespace Communication

```yaml
# Namespace labels are required for cross-namespace policies
# Set labels on namespaces you want to reference
kubectl label namespace production kubernetes.io/metadata.name=production
kubectl label namespace staging kubernetes.io/metadata.name=staging
kubectl label namespace monitoring kubernetes.io/metadata.name=monitoring

# Allow API in staging to call API in production (for integration tests)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-staging-ingress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: staging
      podSelector:
        matchLabels:
          app: integration-test
    ports:
    - protocol: TCP
      port: 8080
```

## Section 5: Cilium Network Policies

Cilium extends NetworkPolicy with:
- **Layer 7 policies** (HTTP, gRPC, DNS filtering)
- **FQDN-based egress** (allow by domain name, not IP)
- **Identity-based policies** (SPIFFE/X.509 identities)
- **CiliumNetworkPolicy** for cluster-scoped policies
- **CiliumClusterwideNetworkPolicy** for cluster-wide baseline rules

### Installing Cilium

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.15.0 \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<API_SERVER_IP> \
  --set k8sServicePort=6443 \
  --set policyEnforcementMode=default \  # default | always | never
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --wait
```

### Cilium L7 HTTP Policy

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-l7-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: frontend
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      rules:
        http:
        # Allow only GET /api/v1/* requests
        - method: GET
          path: "/api/v1/.*"
        # Allow POST to specific endpoints only
        - method: POST
          path: "/api/v1/orders"
        - method: POST
          path: "/api/v1/users"
        # Block everything else
```

### Cilium gRPC Policy

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: grpc-service-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: user-service
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: api-gateway
    toPorts:
    - ports:
      - port: "50051"
        protocol: TCP
      rules:
        # Allow only specific gRPC methods
        grpc:
        - servicePrefix: "/myorg.v1.UserService/"
          # Allow all methods in the UserService
        - servicePrefix: "/grpc.health.v1.Health/"
          # Allow health checks
```

### FQDN-Based Egress (DNS Filtering)

This is one of the most powerful Cilium features - allowing egress to external services by domain name instead of IP address:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: egress-external-apis
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  egress:
  # Allow DNS
  - toEndpoints:
    - matchLabels:
        "k8s:io.kubernetes.pod.namespace": kube-system
        "k8s:k8s-app": kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: UDP
      rules:
        dns:
        - matchPattern: "*.stripe.com"
        - matchPattern: "*.amazonaws.com"

  # Allow HTTPS to Stripe
  - toFQDNs:
    - matchPattern: "*.stripe.com"
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP

  # Allow HTTPS to AWS services
  - toFQDNs:
    - matchPattern: "*.amazonaws.com"
    - matchName: "s3.us-east-1.amazonaws.com"
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
```

### CiliumClusterwideNetworkPolicy for Baseline Rules

```yaml
# Apply cluster-wide baseline rules (no namespace required)
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: baseline-allow-dns
spec:
  endpointSelector: {}  # Applies to all endpoints
  egress:
  # Allow all endpoints to use DNS
  - toEndpoints:
    - matchLabels:
        "k8s:io.kubernetes.pod.namespace": kube-system
        "k8s:k8s-app": kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: UDP
      - port: "53"
        protocol: TCP

---
# Allow all pods to be reached by Prometheus
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: allow-prometheus
spec:
  endpointSelector: {}
  ingress:
  - fromEndpoints:
    - matchLabels:
        "k8s:io.kubernetes.pod.namespace": monitoring
        "k8s:app": prometheus
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      - port: "9090"
        protocol: TCP
      - port: "9091"
        protocol: TCP
```

### Cilium Network Policy Enforcement Mode

```bash
# Check current enforcement mode
cilium config view | grep PolicyEnforcement

# Enable default-deny for a namespace via annotation
kubectl annotate namespace production \
  "network-policy.cilium.io/default-enforcement"="always"

# Check policy enforcement per endpoint
cilium endpoint list

# Verify a specific endpoint's policies
cilium endpoint get <endpoint-id>
```

## Section 6: Hubble Observability

Cilium includes Hubble for network flow visibility, which is invaluable for debugging Network Policy issues.

### Hubble CLI Usage

```bash
# Install hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --fail --remote-name-all https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/hubble

# Port-forward Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe flows
hubble observe --namespace production

# Observe dropped flows (policy violations)
hubble observe --namespace production --verdict DROPPED

# Watch traffic to a specific pod
hubble observe --to-pod production/api-deployment-abc123

# Filter by source and destination
hubble observe \
  --from-pod production/frontend-abc123 \
  --to-pod production/api-xyz789

# Show flows in JSON format for analysis
hubble observe --namespace production -o json | jq '.
  | select(.verdict == "DROPPED")
  | {src: .source.labels, dst: .destination.labels, policy: .drop_reason_desc}'
```

### Debugging Network Policy Issues

```bash
#!/bin/bash
# debug-network-policy.sh
# Diagnose why a connection is being blocked

SOURCE_POD="${1}"
DEST_POD="${2}"
NAMESPACE="${3:-default}"
DEST_PORT="${4:-8080}"

echo "=== Network Policy Debug ==="
echo "Source: ${SOURCE_POD}"
echo "Destination: ${DEST_POD}"
echo "Namespace: ${NAMESPACE}"
echo ""

# Test connectivity
echo "--- Connectivity Test ---"
kubectl exec -n ${NAMESPACE} ${SOURCE_POD} -- \
  nc -zv $(kubectl get pod ${DEST_POD} -n ${NAMESPACE} -o jsonpath='{.status.podIP}') ${DEST_PORT} \
  2>&1 || echo "Connection FAILED"

# Show policies that apply to destination pod
echo ""
echo "--- Policies on Destination Pod ---"
DEST_LABELS=$(kubectl get pod ${DEST_POD} -n ${NAMESPACE} -o json | \
  jq -r '.metadata.labels | to_entries[] | "\(.key)=\(.value)"')

kubectl get networkpolicies -n ${NAMESPACE} -o json | jq -r --arg labels "${DEST_LABELS}" '
  .items[] |
  {
    name: .metadata.name,
    podSelector: .spec.podSelector,
    policyTypes: .spec.policyTypes
  }
'

# Show policies that apply to source pod
echo ""
echo "--- Policies on Source Pod ---"
SOURCE_LABELS=$(kubectl get pod ${SOURCE_POD} -n ${NAMESPACE} -o json | \
  jq -r '.metadata.labels | to_entries[] | "\(.key)=\(.value)"')

echo "Source pod labels: ${SOURCE_LABELS}"

# Check Cilium policy if available
if command -v cilium &>/dev/null; then
    echo ""
    echo "--- Cilium Policy Status ---"
    DEST_EP=$(cilium endpoint list -o json | \
      jq -r --arg pod "${DEST_POD}" \
      '.[] | select(.status["external-identifiers"]["pod-name"] | contains($pod)) | .id')

    if [ -n "${DEST_EP}" ]; then
        echo "Destination endpoint ID: ${DEST_EP}"
        cilium endpoint get ${DEST_EP} | grep -A 20 "policy"
    fi
fi
```

## Section 7: Common Pitfalls and Fixes

### Pitfall 1: Empty podSelector Doesn't Mean "All Pods"

```yaml
# This policy applies to ALL pods in the namespace (empty selector = match all)
spec:
  podSelector: {}    # Matches everything

# This policy applies to NO pods (no label named "app" = matches nothing)
spec:
  podSelector:
    matchLabels:
      app: ""    # This is valid YAML but likely not intended
```

### Pitfall 2: Forgetting policyTypes

```yaml
# This policy has egress rules but no policyTypes for egress
# egress rules are IGNORED without policyTypes: [Egress]
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
  - Ingress    # Only ingress is enforced!
  ingress: []
  egress:      # These rules are NOT enforced without policyTypes: [Egress]
  - to:
    - podSelector:
        matchLabels:
          app: database
```

### Pitfall 3: Node Local Traffic Not Blocked

NetworkPolicy applies to pod-to-pod traffic, not node-level traffic. Processes running on the node itself (kubelet, node agents) can bypass pod-level NetworkPolicy.

### Pitfall 4: Service IP vs Pod IP

NetworkPolicy applies to pod IP addresses, not Service ClusterIP addresses. A policy allowing traffic to `podSelector: matchLabels: app=backend` allows traffic to the pod IPs, which is how kube-proxy routes traffic from Services anyway. This works correctly for most cases.

### Pitfall 5: StatefulSet Pod Communication

```yaml
# StatefulSet pods need to communicate with each other (e.g., for Kafka, Cassandra)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kafka-internal-communication
  namespace: databases
spec:
  podSelector:
    matchLabels:
      app: kafka
  policyTypes:
  - Ingress
  ingress:
  # Allow Kafka pods to communicate with each other
  - from:
    - podSelector:
        matchLabels:
          app: kafka
    ports:
    - protocol: TCP
      port: 9092   # Client port
    - protocol: TCP
      port: 9093   # Inter-broker
    - protocol: TCP
      port: 2181   # ZooKeeper
```

### Pitfall 6: Ingress Controller Access

```yaml
# Common mistake: blocking ingress controller from reaching pods
# The ingress controller pods need to reach your application pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-controller
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
      podSelector:
        matchLabels:
          app.kubernetes.io/name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8080
```

## Section 8: Testing Network Policies

### Automated Policy Testing

```bash
#!/bin/bash
# test-network-policies.sh
# Run a series of connectivity tests to validate policies

NAMESPACE="${1:-production}"
PASS=0
FAIL=0

test_connection() {
    local desc="$1"
    local from_pod="$2"
    local to_ip="$3"
    local port="$4"
    local expected="$5"  # "allowed" or "blocked"

    result=$(kubectl exec -n ${NAMESPACE} ${from_pod} -- \
        nc -zv ${to_ip} ${port} --wait=2 2>&1)

    if [ "${expected}" = "allowed" ]; then
        if echo "${result}" | grep -q "succeeded\|open"; then
            echo "[PASS] ${desc}: connection allowed (expected)"
            PASS=$((PASS + 1))
        else
            echo "[FAIL] ${desc}: connection blocked (expected allowed)"
            FAIL=$((FAIL + 1))
        fi
    else
        if echo "${result}" | grep -q "refused\|timed out"; then
            echo "[PASS] ${desc}: connection blocked (expected)"
            PASS=$((PASS + 1))
        else
            echo "[FAIL] ${desc}: connection allowed (expected blocked)"
            FAIL=$((FAIL + 1))
        fi
    fi
}

# Deploy test pods
kubectl run nettest-frontend --image=nicolaka/netshoot -n ${NAMESPACE} \
  --labels=app=frontend,tier=frontend \
  --command -- sleep 3600

kubectl run nettest-api --image=nicolaka/netshoot -n ${NAMESPACE} \
  --labels=app=api,tier=api \
  --command -- sleep 3600

kubectl run nettest-db --image=nicolaka/netshoot -n ${NAMESPACE} \
  --labels=app=postgres,tier=database \
  --command -- sleep 3600

# Wait for pods to be ready
kubectl wait pod -n ${NAMESPACE} -l app=frontend --for=condition=Ready --timeout=60s
kubectl wait pod -n ${NAMESPACE} -l app=api --for=condition=Ready --timeout=60s

API_IP=$(kubectl get pod nettest-api -n ${NAMESPACE} -o jsonpath='{.status.podIP}')
DB_IP=$(kubectl get pod nettest-db -n ${NAMESPACE} -o jsonpath='{.status.podIP}')

# Run tests
test_connection "frontend -> api (should be allowed)" \
    nettest-frontend ${API_IP} 8080 "allowed"

test_connection "frontend -> database (should be blocked)" \
    nettest-frontend ${DB_IP} 5432 "blocked"

test_connection "api -> database (should be allowed)" \
    nettest-api ${DB_IP} 5432 "allowed"

# Cleanup
kubectl delete pod nettest-frontend nettest-api nettest-db -n ${NAMESPACE}

echo ""
echo "=== Results: PASS=${PASS}, FAIL=${FAIL} ==="
[ ${FAIL} -eq 0 ] && exit 0 || exit 1
```

## Section 9: Network Policy as Code

### Kustomize-Based Policy Management

```yaml
# base/network-policies/kustomization.yaml
resources:
- default-deny-ingress.yaml
- default-deny-egress.yaml
- allow-dns.yaml
- allow-prometheus.yaml

---
# overlays/production/kustomization.yaml
bases:
- ../../base/network-policies

resources:
- api-policy.yaml
- database-policy.yaml
- frontend-policy.yaml

patchesStrategicMerge:
- restrict-external-egress.yaml
```

### GitOps Workflow for Policies

```yaml
# ArgoCD Application for network policies
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: network-policies
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/myorg/kubernetes-config
    targetRevision: main
    path: network-policies
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true    # Remove policies not in git
      selfHeal: true # Re-apply if manually changed
    syncOptions:
    - RespectIgnoreDifferences=true
    - ApplyOutOfSyncOnly=true
```

## Section 10: Key Takeaways

**Fundamentals:**
- NetworkPolicy requires a CNI plugin that supports enforcement (Calico, Cilium, Weave - NOT Flannel by default)
- Without any NetworkPolicy, all pod-to-pod traffic is permitted
- NetworkPolicy rules are additive (union of all matching policies)
- `policyTypes: [Ingress, Egress]` must be explicitly listed to enforce egress rules

**Default Deny Architecture:**
- Start with `default-deny-ingress` and `default-deny-egress` for each namespace
- Immediately add `allow-dns-egress` after applying default deny - DNS will break otherwise
- Apply `allow-prometheus-scrape` to allow metrics collection
- Apply kubelet health check allow rules before deploying health-checked workloads

**Common Bugs:**
- `namespaceSelector` + `podSelector` in same list item = AND logic (very restrictive)
- `namespaceSelector` and `podSelector` in separate list items = OR logic (more permissive)
- Omitting `policyTypes: [Egress]` causes egress rules to be silently ignored

**Cilium Extensions:**
- L7 HTTP/gRPC policies enforce at the method level, not just TCP port
- FQDN-based egress policies (`toFQDNs`) allow egress control by domain name
- `CiliumClusterwideNetworkPolicy` applies cluster-wide baselines without namespace scoping
- Hubble provides flow visibility for debugging dropped connections

**Testing:**
- Always test policies before production deployment using dedicated test pods
- Use `hubble observe --verdict DROPPED` to identify dropped connections in Cilium
- Include network policy tests in CI/CD to catch regression before deployment
- Label all namespaces with `kubernetes.io/metadata.name` for reliable cross-namespace policies
