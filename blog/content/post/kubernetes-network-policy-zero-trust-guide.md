---
title: "Kubernetes Network Policies: Implementing Zero-Trust Microsegmentation"
date: 2027-04-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Network Policy", "Zero Trust", "Security", "Microsegmentation"]
categories: ["Kubernetes", "Security", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes Network Policies for zero-trust microsegmentation, covering default-deny patterns, namespace isolation, pod selector rules, egress to external services, Cilium NetworkPolicy extensions, policy testing with netpol-visualizer, and automated policy generation with Hubble."
more_link: "yes"
url: "/kubernetes-network-policy-zero-trust-guide/"
---

By default, every pod in a Kubernetes cluster can reach every other pod across all namespaces and can initiate outbound connections to any IP address. This flat network model is convenient during early development but is incompatible with zero-trust security principles and most compliance frameworks. Kubernetes Network Policies provide the primitive for microsegmentation, but their interaction with CNI plugins, DNS, and stateful connection tracking has surprised many production teams. This guide covers the full implementation path: from understanding prerequisites, through building layered default-deny policies, to operating Cilium L7 policies and automated policy generation with Hubble.

<!--more-->

## Prerequisites: CNI Enforcement

### Not All CNIs Enforce Network Policies

The Kubernetes Network Policy API is purely declarative. The API server stores NetworkPolicy objects, but the enforcement is entirely the CNI plugin's responsibility. If a NetworkPolicy exists in a cluster whose CNI does not support enforcement, the policies are silently ignored — every pod remains fully reachable.

CNIs that enforce NetworkPolicy:

| CNI | NetworkPolicy support | CiliumNetworkPolicy | Notes |
|---|---|---|---|
| Cilium | Full | Yes (L3/L4/L7) | Recommended for full zero-trust |
| Calico | Full | No (uses its own CRDs) | Strong production option |
| Weave Net | Full | No | Less common in 2025+ clusters |
| Flannel | None | No | No enforcement; must add Calico for policy |
| AWS VPC CNI | Partial (needs NetworkPolicy addon) | No | Enable `--enable-network-policy` in EKS |

```bash
# Verify CNI can enforce NetworkPolicy by checking for a known enforcement pod
# Cilium example
kubectl get pods -n kube-system -l k8s-app=cilium

# Calico example
kubectl get pods -n kube-system -l k8s-app=calico-node

# Quick enforcement test: create a deny-all, verify blocked
kubectl run test-source --image=registry.support.tools/tools/nettools:1.0.0 \
  --restart=Never -- sleep 3600
kubectl run test-target --image=registry.support.tools/tools/nettools:1.0.0 \
  --restart=Never --labels=app=target -- sleep 3600

# Apply deny-all to target's namespace
kubectl apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-test
  namespace: default
spec:
  podSelector:
    matchLabels:
      app: target
  policyTypes:
  - Ingress
EOF

# Test from source to target — should be blocked
kubectl exec test-source -- nc -zv test-target-ip 80
# If blocked: CNI is enforcing. If open: CNI is not enforcing.
kubectl delete networkpolicy deny-all-test
kubectl delete pod test-source test-target
```

## Default-Deny Foundation Policies

### Why Default-Deny Must Come First

Individual allow policies only work correctly when combined with a default-deny baseline. Without it, the absence of a NetworkPolicy for a pod means unrestricted access. The Kubernetes model is additive: each NetworkPolicy that matches a pod adds permissions, and a pod with no matching policies has no restrictions.

The default-deny pattern requires two separate policies for complete coverage: one for ingress and one for egress.

### Default-Deny Ingress

```yaml
# default-deny-ingress.yaml
# Blocks all inbound traffic to every pod in the namespace.
# Must be combined with explicit allow policies for required traffic.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: payments-api
  annotations:
    policy.support.tools/description: "Zero-trust baseline: deny all ingress"
    policy.support.tools/owner: "platform-security-team"
spec:
  podSelector: {}          # Empty selector matches ALL pods in namespace
  policyTypes:
  - Ingress
  # No ingress rules = deny all ingress
```

### Default-Deny Egress

```yaml
# default-deny-egress.yaml
# Blocks all outbound traffic from every pod in the namespace.
# DNS egress must be explicitly re-allowed or all service discovery breaks.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: payments-api
  annotations:
    policy.support.tools/description: "Zero-trust baseline: deny all egress"
    policy.support.tools/owner: "platform-security-team"
spec:
  podSelector: {}
  policyTypes:
  - Egress
  # No egress rules = deny all egress
```

### Allowing DNS (Critical First Step)

After applying default-deny-egress, DNS resolution breaks because pods can no longer reach kube-dns on port 53. This must be restored immediately:

```yaml
# allow-dns-egress.yaml
# Allows all pods in the namespace to reach kube-dns.
# Without this policy, DNS lookups fail and all service-name based
# connections stop working, breaking most application functionality.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: payments-api
spec:
  podSelector: {}    # Apply to all pods in namespace
  policyTypes:
  - Egress
  egress:
  - ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
    # Allow DNS to kube-dns in kube-system namespace
    to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
```

### Applying the Baseline

```bash
#!/bin/bash
# apply-zero-trust-baseline.sh — Apply default-deny + DNS allow to a namespace
# Run this before deploying any workloads to a new namespace
set -euo pipefail

NAMESPACE="${1:?Namespace required}"

echo "Applying zero-trust baseline to namespace: ${NAMESPACE}"

kubectl apply -n "${NAMESPACE}" -f default-deny-ingress.yaml
kubectl apply -n "${NAMESPACE}" -f default-deny-egress.yaml
kubectl apply -n "${NAMESPACE}" -f allow-dns-egress.yaml

echo "Baseline applied. All traffic is now blocked except DNS egress."
echo "Apply workload-specific allow policies before deploying pods."
```

## Namespace Isolation

### Isolating Environments

A common pattern is to ensure that dev, staging, and production namespaces cannot communicate with each other even when they run workloads with the same labels.

```yaml
# namespace-isolation-policy.yaml
# Prevents ingress from namespaces in different environments.
# Pods in 'production' environment namespaces can only receive ingress
# from other 'production' environment namespaces.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: namespace-isolation
  namespace: payments-api
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          environment: production   # Only allow from namespaces labeled environment=production
```

```bash
# Label namespaces with their environment
kubectl label namespace payments-api environment=production
kubectl label namespace payments-staging environment=staging
kubectl label namespace payments-dev environment=development

# Verify labels
kubectl get namespace -L environment
```

### Allowing Monitoring Namespace Ingress

Prometheus scrapers need to reach application pods on metrics ports. Without an explicit allow, the default-deny blocks metrics collection:

```yaml
# allow-monitoring-ingress.yaml
# Allows Prometheus in the monitoring namespace to scrape metrics.
# Scoped to the metrics port only, not general application traffic.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring-ingress
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/part-of: payments-platform   # Only scraped pods
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
    - port: 9090    # Metrics port
      protocol: TCP
```

## Pod-to-Pod Rules

### Label-Based Allow Policies

Well-structured pod labels are the foundation of effective NetworkPolicy. Adopt a consistent labeling scheme before writing policies:

```yaml
# Recommended label scheme for NetworkPolicy targeting
# app: logical application name (payments-api, payments-worker)
# component: tier within the application (frontend, backend, database, cache)
# app.kubernetes.io/part-of: application group (payments-platform)
```

### Frontend to Backend Allow

```yaml
# frontend-to-backend.yaml
# Allows the frontend pods to reach the backend API on port 8080.
# The backend accepts ingress from frontend only.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-allow-from-frontend
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      component: backend           # This policy applies to backend pods
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          component: frontend      # Only from frontend pods
    ports:
    - port: 8080
      protocol: TCP
```

```yaml
# backend-egress-allowed.yaml
# Allows backend pods to initiate connections to the database and cache.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-allow-egress-to-deps
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      component: backend
  policyTypes:
  - Egress
  egress:
  - to:
    - podSelector:
        matchLabels:
          component: database
    ports:
    - port: 5432      # PostgreSQL
      protocol: TCP
  - to:
    - podSelector:
        matchLabels:
          component: cache
    ports:
    - port: 6379      # Redis
      protocol: TCP
```

## Multi-Tier Application Pattern

### Complete Three-Tier Policy Set

The following complete example implements a payments platform with frontend, backend, database, and cache tiers. All tiers start from the default-deny baseline and have explicit allow policies.

```yaml
# payments-platform-netpol.yaml — Complete zero-trust policy set
# Tier 1: Frontend — accepts HTTP from ingress controller, sends to backend
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-ingress-from-ingress-controller
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      component: frontend
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
    - port: 8080
      protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-egress-to-backend
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      component: frontend
  policyTypes:
  - Egress
  egress:
  - to:
    - podSelector:
        matchLabels:
          component: backend
    ports:
    - port: 8080
      protocol: TCP
---
# Tier 2: Backend — accepts from frontend, sends to database and cache
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-ingress-from-frontend
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      component: backend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          component: frontend
    ports:
    - port: 8080
      protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-egress-to-database-and-cache
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      component: backend
  policyTypes:
  - Egress
  egress:
  - to:
    - podSelector:
        matchLabels:
          component: database
    ports:
    - port: 5432
      protocol: TCP
  - to:
    - podSelector:
        matchLabels:
          component: cache
    ports:
    - port: 6379
      protocol: TCP
---
# Tier 3: Database — accepts only from backend
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-ingress-from-backend-only
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      component: database
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          component: backend
    ports:
    - port: 5432
      protocol: TCP
---
# Cache — accepts only from backend
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cache-ingress-from-backend-only
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      component: cache
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          component: backend
    ports:
    - port: 6379
      protocol: TCP
```

## Egress to External Services

### Allowing Egress to External CIDR Ranges

Some workloads must reach external APIs (payment processors, identity providers). Use `ipBlock` to allow egress to specific CIDR ranges:

```yaml
# allow-external-payment-processor.yaml
# Allows the backend to reach the payment processor API.
# CIDR range should be obtained from the processor's published IP list.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-egress-to-payment-processor
  namespace: payments-api
spec:
  podSelector:
    matchLabels:
      component: backend
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 203.0.113.0/24      # Payment processor published IP range (RFC 5737 example)
        except:
        - 203.0.113.255/32        # Exclude broadcast if needed
    ports:
    - port: 443
      protocol: TCP
```

### Blocking Cloud Metadata API

A critical egress rule in cloud-hosted clusters is explicitly blocking access to the instance metadata API, which credential theft attacks target:

```yaml
# block-metadata-api.yaml
# Prevents all pods from accessing the cloud instance metadata API.
# This blocks credential theft via SSRF attacks targeting 169.254.169.254.
# Note: This uses ipBlock at the namespace level, but with Cilium
# CiliumClusterwideNetworkPolicy is more appropriate for cluster-wide enforcement.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: block-cloud-metadata-api
  namespace: payments-api
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 169.254.169.254/32   # AWS/GCP/Azure metadata API
        - 169.254.170.2/32     # AWS ECS metadata endpoint
```

## Cilium Extended Network Policies

### CiliumNetworkPolicy for L7 Rules

Cilium's `CiliumNetworkPolicy` CRD extends standard Network Policies with Layer 7 awareness, allowing policies based on HTTP methods, paths, gRPC service names, and Kafka topics.

```yaml
# cilium-l7-http-policy.yaml
# Restricts the backend to only accept POST requests to /api/v1/payments
# and GET requests to /api/v1/health. All other paths and methods are denied.
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: backend-http-l7-policy
  namespace: payments-api
spec:
  endpointSelector:
    matchLabels:
      component: backend
  ingress:
  - fromEndpoints:
    - matchLabels:
        component: frontend
    toPorts:
    - ports:
      - port: "8080"
        protocol: TCP
      rules:
        http:
        - method: POST
          path: ^/api/v1/payments$
        - method: GET
          path: ^/api/v1/health$
        - method: GET
          path: ^/metrics$         # For Prometheus scraping
```

### CiliumClusterwideNetworkPolicy

`CiliumClusterwideNetworkPolicy` applies to all pods across the entire cluster, making it appropriate for baseline security rules that should not be bypassable at the namespace level:

```yaml
# cilium-clusterwide-policy.yaml
# Cluster-wide policy: block metadata API access for all pods regardless of namespace.
# Applied cluster-wide so namespace admins cannot accidentally allow it.
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: block-metadata-api-cluster-wide
spec:
  endpointSelector: {}   # Match all endpoints
  egressDeny:
  - toCIDRSet:
    - cidr: 169.254.169.254/32
  - toCIDRSet:
    - cidr: 169.254.170.2/32
```

### Cilium DNS-Based Egress Policy

Standard Kubernetes NetworkPolicy uses CIDR blocks for egress to external services, requiring operators to maintain IP lists. Cilium allows DNS-name-based egress policies:

```yaml
# cilium-dns-egress.yaml
# Allow backend egress to external services by DNS name, not IP.
# Cilium resolves the names and dynamically updates allowed IPs.
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: backend-egress-by-fqdn
  namespace: payments-api
spec:
  endpointSelector:
    matchLabels:
      component: backend
  egress:
  - toFQDNs:
    - matchName: "api.stripe.com"          # Payment processor API
    - matchName: "oauth2.googleapis.com"   # Identity provider
    - matchPattern: "*.amazonaws.com"      # AWS service endpoints
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
```

## Policy Visualization

### Installing network-policy-viewer

```bash
# Install netpol-viewer (works with standard Kubernetes NetworkPolicy)
# Source: https://github.com/runoncloud/kubectl-np-viewer
kubectl krew install np-viewer

# Show all policies affecting a specific pod
kubectl np-viewer pod -n payments-api -l component=backend

# Show ingress rules for all pods in namespace
kubectl np-viewer namespace payments-api

# Export as dot graph format for Graphviz rendering
kubectl np-viewer namespace payments-api --output dot > payments-api-netpol.dot
dot -Tsvg payments-api-netpol.dot -o payments-api-netpol.svg
```

### Cilium Hubble UI for Live Policy Visibility

```bash
# Enable Hubble in existing Cilium installation
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true

# Port-forward to Hubble UI
kubectl port-forward -n kube-system svc/hubble-ui 12000:80

# Hubble CLI — observe live flows
cilium hubble observe \
  --namespace payments-api \
  --type drop \
  --follow

# Observe drops to a specific destination
cilium hubble observe \
  --namespace payments-api \
  --to-pod payments-api/database-0 \
  --verdict DROPPED
```

## Automated Policy Generation from Hubble

### Using Hubble to Generate Policies

Running workloads in audit mode (no NetworkPolicy) while capturing Hubble flows allows automated generation of NetworkPolicy manifests that precisely match observed traffic:

```bash
# Generate NetworkPolicy from observed Hubble flows
# Requires cilium-cli 0.15+

# Step 1: Observe flows for a namespace for a representative period
cilium hubble observe \
  --namespace payments-api \
  --output json \
  --last 10000 > observed-flows.json

# Step 2: Use Hubble's network policy generation feature
# (available via cilium-cli)
cilium policy generate \
  --namespace payments-api \
  --flows observed-flows.json \
  --output payments-api-generated-netpol.yaml

# Step 3: Review the generated policies
cat payments-api-generated-netpol.yaml

# Step 4: Apply in warn mode first (using label on namespace)
kubectl apply -f payments-api-generated-netpol.yaml --dry-run=server
```

### Manual Flow Analysis for Policy Building

```bash
# Find all unique source/destination pairs in a namespace (last 24h of flows)
cilium hubble observe \
  --namespace payments-api \
  --since 24h \
  --output json | \
  jq -r '[.source.namespace, .source.labels["k8s:app"],
          .destination.namespace, .destination.labels["k8s:app"],
          .destination_port] | @tsv' | \
  sort -u

# Find all DROPPED flows (what policies are blocking)
cilium hubble observe \
  --namespace payments-api \
  --verdict DROPPED \
  --since 1h \
  --output json | \
  jq -r '[.time, .source.labels["k8s:app"],
          .destination.labels["k8s:app"],
          .destination_port,
          .drop_reason] | @tsv'
```

## Policy Testing Approaches

### Automated Connectivity Testing

```bash
#!/bin/bash
# test-network-policy.sh — Validate expected connectivity after policy changes
# Each test function runs a connection attempt and reports pass/fail
set -euo pipefail

NAMESPACE="payments-api"

run_test() {
  local description="${1}"
  local source_pod="${2}"
  local target_host="${3}"
  local target_port="${4}"
  local expected="${5}"  # allowed or blocked

  echo -n "Test: ${description} ... "
  if kubectl exec -n "${NAMESPACE}" "${source_pod}" -- \
     nc -zv -w3 "${target_host}" "${target_port}" >/dev/null 2>&1; then
    result="allowed"
  else
    result="blocked"
  fi

  if [[ "${result}" == "${expected}" ]]; then
    echo "PASS (${result})"
  else
    echo "FAIL (expected ${expected}, got ${result})"
    exit 1
  fi
}

# Deploy test pods if not present
kubectl run frontend-test \
  --image=registry.support.tools/tools/nettools:1.0.0 \
  -n "${NAMESPACE}" \
  --labels="component=frontend" \
  --restart=Never -- sleep 3600

kubectl run attacker-test \
  --image=registry.support.tools/tools/nettools:1.0.0 \
  -n "${NAMESPACE}" \
  --labels="component=attacker" \
  --restart=Never -- sleep 3600

# Wait for pods
kubectl wait pod -n "${NAMESPACE}" \
  -l component=frontend \
  --for=condition=Ready --timeout=60s

BACKEND_IP=$(kubectl get pod -n "${NAMESPACE}" \
  -l component=backend -o jsonpath='{.items[0].status.podIP}')
DB_IP=$(kubectl get pod -n "${NAMESPACE}" \
  -l component=database -o jsonpath='{.items[0].status.podIP}')

# Run connectivity tests
run_test "Frontend can reach backend on 8080"  frontend-test "${BACKEND_IP}" 8080 allowed
run_test "Frontend cannot reach database"      frontend-test "${DB_IP}"      5432 blocked
run_test "Attacker cannot reach backend"       attacker-test "${BACKEND_IP}" 8080 blocked
run_test "Attacker cannot reach database"      attacker-test "${DB_IP}"      5432 blocked

echo "All tests passed."
kubectl delete pod frontend-test attacker-test -n "${NAMESPACE}"
```

## Common Mistakes

### Forgetting DNS Egress

The most common mistake when deploying default-deny policies is forgetting to add DNS egress. Symptoms: pods start successfully but cannot connect to any service by name; `nslookup kubernetes.default` times out; application logs show connection refused to service names.

```bash
# Quick diagnosis: test DNS from within an affected pod
kubectl exec -n payments-api failing-pod -- nslookup kubernetes.default

# If this fails, apply the DNS egress policy
kubectl apply -f allow-dns-egress.yaml -n payments-api
```

### AND vs OR Semantics in podSelector + namespaceSelector

A subtle but critical NetworkPolicy gotcha: when both `podSelector` and `namespaceSelector` are in the same `from` entry, they are ANDed (both must match). When they are in separate `from` entries, they are ORed (either can match).

```yaml
# WRONG — this matches pods labeled app=api that are ALSO in namespaces labeled team=payments
# Most operators write this intending OR semantics but get AND
ingress:
- from:
  - podSelector:
      matchLabels:
        app: api
    namespaceSelector:          # NOTE: same list item, no leading "-"
      matchLabels:
        team: payments

# CORRECT — this matches ANY pod labeled app=api, OR any pod in namespaces labeled team=payments
# Two separate list entries produce OR semantics
ingress:
- from:
  - podSelector:
      matchLabels:
        app: api
  - namespaceSelector:          # NOTE: separate list item, leading "-"
      matchLabels:
        team: payments
```

### Stateful Connection Tracking

Kubernetes Network Policies are stateful at the TCP level. An allowed egress connection's return traffic is automatically permitted without needing an explicit ingress allow rule for the response. However, this only applies to connection-level tracking. Operators sometimes add redundant ingress rules for response traffic, which adds noise without effect.

```yaml
# UNNECESSARY — return traffic for TCP connections is automatically allowed
# Do not add ingress rules just to permit response packets
# This policy is redundant:
ingress:
- from:
  - podSelector:
      matchLabels:
        component: database
  ports:
  - port: 8080   # This is NOT needed to allow DB response traffic to backend
```

### Missing Policies for Ephemeral Debug Pods

kubectl exec and kubectl port-forward traffic uses the apiserver, not pod-to-pod networking, so it is not subject to NetworkPolicy. However, debug pods launched with `kubectl debug` or `kubectl run` that actively make connections from within the pod ARE subject to NetworkPolicy.

```yaml
# add-debug-access-temporarily.yaml
# Temporary policy for debugging — REMOVE after investigation
# Includes an annotation tracking when it should be removed
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: temp-debug-access
  namespace: payments-api
  annotations:
    policy.support.tools/temporary: "true"
    policy.support.tools/expires: "2025-03-20"
    policy.support.tools/ticket: "INC-4821"
spec:
  podSelector:
    matchLabels:
      component: backend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          debug-session: "true"    # Only allow debug pods with this label
    ports:
    - port: 8080
      protocol: TCP
```

## Operating at Scale

### GitOps-Managed Policies

```yaml
# kustomization.yaml — Manage all namespace NetworkPolicies via Kustomize
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: payments-api
resources:
  # Baseline policies (apply to every namespace)
  - ../../../base/network-policies/default-deny-ingress.yaml
  - ../../../base/network-policies/default-deny-egress.yaml
  - ../../../base/network-policies/allow-dns-egress.yaml
  - ../../../base/network-policies/allow-monitoring-ingress.yaml
  # Application-specific policies
  - frontend-to-backend.yaml
  - backend-to-database.yaml
  - backend-to-cache.yaml
  - backend-to-external-apis.yaml
```

### Policy Inventory Report

```bash
#!/bin/bash
# netpol-inventory.sh — Generate a human-readable inventory of all NetworkPolicies
set -euo pipefail

echo "=== Network Policy Inventory ==="
echo "Generated: $(date)"
echo ""

kubectl get networkpolicy --all-namespaces \
  -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,POD_SELECTOR:.spec.podSelector,POLICY_TYPES:.spec.policyTypes' \
  | column -t

echo ""
echo "=== Namespaces without any NetworkPolicy ==="
all_namespaces=$(kubectl get namespace -o jsonpath='{.items[*].metadata.name}')
for ns in ${all_namespaces}; do
  count=$(kubectl get networkpolicy -n "${ns}" --no-headers 2>/dev/null | wc -l)
  if [[ "${count}" -eq 0 ]]; then
    echo "  WARNING: ${ns} has no NetworkPolicies (flat network)"
  fi
done
```

## Summary

Implementing zero-trust microsegmentation with Kubernetes Network Policies requires a consistent approach:

1. Verify CNI enforcement capability before investing in policies — silently unenforced policies create false security.
2. Apply default-deny ingress and egress to every namespace, immediately followed by DNS egress allow.
3. Build allow policies incrementally: ingress controller → frontend → backend → database, one explicit rule at a time.
4. Use Cilium CiliumNetworkPolicy for L7 rules where HTTP method/path restrictions are needed.
5. Block cloud metadata API access cluster-wide with CiliumClusterwideNetworkPolicy.
6. Generate initial policies from Hubble flow observations to capture all traffic patterns accurately.
7. Automate connectivity testing in CI to catch policy regressions before they reach production.
8. Understand AND vs OR semantics in `from` entries — this single mistake causes more policy incidents than any other.
