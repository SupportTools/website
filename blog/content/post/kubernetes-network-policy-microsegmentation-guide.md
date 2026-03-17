---
title: "Kubernetes Network Policy Microsegmentation: Zero-Trust Workload Isolation"
date: 2027-12-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NetworkPolicy", "Security", "Zero-Trust", "Cilium", "Calico", "Microsegmentation", "Networking"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes network policy microsegmentation: default-deny patterns, ingress/egress rules, namespace selectors, Cilium CiliumNetworkPolicy extensions, policy testing with netshoot, and Calico GlobalNetworkPolicy."
more_link: "yes"
url: "/kubernetes-network-policy-microsegmentation-guide/"
---

By default, every pod in Kubernetes can communicate with every other pod in the cluster. This flat network model is convenient for development but incompatible with zero-trust security principles. Network policies provide the primitive for microsegmentation: declarative rules that restrict which pods can communicate with which other pods, over which ports and protocols. This guide covers the full enterprise implementation from default-deny baseline through advanced Cilium and Calico extensions, including policy testing methodologies and visualization tools.

<!--more-->

# Kubernetes Network Policy Microsegmentation: Zero-Trust Workload Isolation

## Prerequisites: CNI Support

NetworkPolicy requires a CNI plugin that enforces policies. Many CNI plugins ignore NetworkPolicy entirely. Verify enforcement capability before relying on policies:

| CNI Plugin | NetworkPolicy Support | Extensions |
|---|---|---|
| Cilium | Full | CiliumNetworkPolicy, L7 policies |
| Calico | Full | GlobalNetworkPolicy, staged policies |
| Weave | Full | None beyond core spec |
| Flannel | None | Does not enforce policies |
| AWS VPC CNI | Partial | Requires additional controller |

```bash
# Verify CNI plugin
kubectl get pods -n kube-system | grep -E "cilium|calico|flannel|weave"

# Test if policies are enforced by CNI
kubectl apply -f - << 'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: test-deny
  namespace: default
spec:
  podSelector:
    matchLabels:
      test: policy
  policyTypes:
    - Ingress
EOF

# If traffic is still allowed to pods labeled test=policy, CNI does not enforce policies
kubectl delete networkpolicy test-deny
```

## Default-Deny Baseline

The foundation of microsegmentation is a default-deny policy applied to every namespace. This ensures that no implicit allow rules exist; all communication must be explicitly permitted.

### Default-Deny All Ingress and Egress

```yaml
# Apply to every application namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}   # Applies to ALL pods in namespace
  policyTypes:
    - Ingress
    - Egress
  # No ingress or egress rules = deny all
```

This single policy blocks all traffic to and from all pods in the namespace. Apply it immediately after namespace creation, before any workloads are deployed.

### Namespace Bootstrap Script

```bash
#!/bin/bash
# bootstrap-namespace.sh
# Apply default security policies to a new namespace

NAMESPACE="$1"
if [ -z "$NAMESPACE" ]; then
  echo "Usage: $0 <namespace>"
  exit 1
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# Apply default-deny
kubectl apply -f - << EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: $NAMESPACE
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
# Allow DNS resolution (required for nearly every workload)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: $NAMESPACE
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
EOF

echo "Default-deny policies applied to namespace $NAMESPACE"
```

## Ingress Rules

### Allow from Specific Pods

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-ingress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: database
      tier: data
  policyTypes:
    - Ingress
  ingress:
    # Only the api-service pods can reach database
    - from:
        - podSelector:
            matchLabels:
              app: api-service
              tier: backend
      ports:
        - protocol: TCP
          port: 5432
```

### Allow from Specific Namespace

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring-ingress
  namespace: production
spec:
  podSelector:
    matchLabels:
      monitoring: "true"
  policyTypes:
    - Ingress
  ingress:
    # Allow Prometheus scraping from monitoring namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app.kubernetes.io/name: prometheus
      ports:
        - protocol: TCP
          port: 9090
        - protocol: TCP
          port: 8080
```

Note: when both `namespaceSelector` and `podSelector` appear under the same `from` entry (not as separate entries), they are ANDed: the traffic must come from pods matching BOTH selectors.

### Allow from Multiple Sources

```yaml
# The following uses separate entries (OR logic)
ingress:
  - from:
      - podSelector:
          matchLabels:
            app: frontend
      - podSelector:
          matchLabels:
            app: admin-panel
    ports:
      - port: 8080
```

## Egress Rules

### Allow Egress to Specific Services

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-service-egress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-service
  policyTypes:
    - Egress
  egress:
    # Allow DNS
    - ports:
        - protocol: UDP
          port: 53
    # Allow to database namespace
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: data
          podSelector:
            matchLabels:
              app: postgres
      ports:
        - protocol: TCP
          port: 5432
    # Allow to Redis cache
    - to:
        - podSelector:
            matchLabels:
              app: redis
      ports:
        - protocol: TCP
          port: 6379
    # Allow to external APIs (by IP range)
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
      ports:
        - protocol: TCP
          port: 443
```

### Restricting Egress to Known CIDR Ranges

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-service-egress
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: payment-processor
  policyTypes:
    - Egress
  egress:
    - ports:
        - protocol: UDP
          port: 53
    # Only allow to specific payment gateway CIDR
    - to:
        - ipBlock:
            cidr: 203.0.113.0/24   # Payment gateway IPs
      ports:
        - protocol: TCP
          port: 443
    # Internal services
    - to:
        - namespaceSelector:
            matchLabels:
              team: payments
      ports:
        - protocol: TCP
          port: 8080
```

## Namespace Selector Patterns

### Cross-Namespace Communication Pattern

```yaml
# In namespace: frontend
# Policy: frontend pods can call backend in api namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-to-api-egress
  namespace: frontend
spec:
  podSelector:
    matchLabels:
      app: frontend
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: api
          podSelector:
            matchLabels:
              app: api-service
      ports:
        - protocol: TCP
          port: 8080
---
# In namespace: api
# Policy: only accept ingress from frontend namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-from-frontend-ingress
  namespace: api
spec:
  podSelector:
    matchLabels:
      app: api-service
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: frontend
          podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 8080
```

## Gateway and Ingress Controller Allow Rules

Ingress controllers must be allowed to reach backend pods:

```yaml
# Allow nginx-ingress to reach all pods in namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-controller
  namespace: production
spec:
  podSelector: {}   # Applies to all pods
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
```

## Complete Namespace Policy Set

A complete policy set for a typical three-tier application:

```yaml
---
# Default deny
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: ecommerce
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
# Allow DNS for all pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: ecommerce
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
---
# Frontend: accept from ingress controller, call backend
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-policy
  namespace: ecommerce
spec:
  podSelector:
    matchLabels:
      tier: frontend
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
  egress:
    - to:
        - podSelector:
            matchLabels:
              tier: backend
      ports:
        - port: 8080
    - ports:
        - protocol: UDP
          port: 53
---
# Backend: accept from frontend, call database
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-policy
  namespace: ecommerce
spec:
  podSelector:
    matchLabels:
      tier: backend
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              tier: frontend
      ports:
        - port: 8080
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app.kubernetes.io/name: prometheus
      ports:
        - port: 9090
  egress:
    - to:
        - podSelector:
            matchLabels:
              tier: database
      ports:
        - port: 5432
    - to:
        - podSelector:
            matchLabels:
              tier: cache
      ports:
        - port: 6379
    - ports:
        - protocol: UDP
          port: 53
---
# Database: accept only from backend
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-policy
  namespace: ecommerce
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
              tier: backend
      ports:
        - port: 5432
  egress:
    - ports:
        - protocol: UDP
          port: 53
```

## Cilium CiliumNetworkPolicy

Cilium extends NetworkPolicy with L7 policies, FQDN-based egress, and security identity-based rules.

### L7 HTTP Policy

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-l7-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-service
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
              # Only allow GET and POST to specific paths
              - method: GET
                path: "^/api/v1/products"
              - method: POST
                path: "^/api/v1/orders"
              - method: GET
                path: "^/health"
```

### FQDN-Based Egress

Cilium allows egress policies based on DNS names instead of IP addresses:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: external-api-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  egress:
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.paypal.com"
        - matchPattern: "*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
    # Allow DNS
    - toEndpoints:
        - matchLabels:
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
```

### CiliumClusterwideNetworkPolicy

For cluster-wide policies applying to all namespaces:

```yaml
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: node-to-pod-communication
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux
  ingress:
    - fromNodes:
        - matchLabels:
            kubernetes.io/os: linux
```

## Calico GlobalNetworkPolicy

Calico provides `GlobalNetworkPolicy` for cluster-scoped policies and `NetworkPolicy` for namespace-scoped policies. Calico also supports staged policies for testing without enforcement.

### Staged Policy for Safe Testing

```yaml
# Stage a policy before enforcing it
apiVersion: projectcalico.org/v3
kind: StagedGlobalNetworkPolicy
metadata:
  name: staged-default-deny
spec:
  order: 1000
  selector: all()
  types:
    - Ingress
    - Egress
```

A staged policy logs what would be blocked without actually blocking traffic. This enables safe testing of policy changes.

```bash
# After staging, monitor what would be blocked
kubectl logs -n calico-system -l k8s-app=calico-node --tail=100 \
  | grep "staged-default-deny"

# Convert staged to enforced after validation
kubectl apply -f - << 'EOF'
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: enforced-default-deny
spec:
  order: 1000
  selector: all()
  types:
    - Ingress
    - Egress
EOF
```

### Calico Host Endpoints

Protect Kubernetes node traffic with host endpoint policies:

```yaml
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: protect-node-ports
spec:
  selector: has(kubernetes.io/hostname)
  order: 100
  types:
    - Ingress
  ingress:
    # Allow kubelet healthz
    - action: Allow
      protocol: TCP
      destination:
        ports: [10248, 10250]
      source:
        nets: ["10.0.0.0/8"]
    # Allow NodePort services range
    - action: Allow
      protocol: TCP
      destination:
        ports: [30000:32767]
    # Deny everything else to host
    - action: Deny
```

## Policy Testing with netshoot

`netshoot` is a debug container with networking tools for testing connectivity:

```bash
# Test connectivity between namespaces
kubectl run netshoot --image=nicolaka/netshoot -it --rm \
  --namespace=production \
  --overrides='{"spec":{"containers":[{"name":"netshoot","image":"nicolaka/netshoot","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' \
  -- bash

# Inside netshoot: test TCP connectivity
nc -zv database-service.production.svc.cluster.local 5432
# Expected: Connection to database-service 5432 port [tcp/postgresql] succeeded!

# Test that blocked traffic is actually blocked
nc -zv blocked-service.other-namespace.svc.cluster.local 8080 -w 3
# Expected: nc: connect to ... failed: Connection timed out

# Test DNS resolution
nslookup api-service.production.svc.cluster.local
dig api-service.production.svc.cluster.local
```

### Automated Policy Testing Script

```bash
#!/bin/bash
# test-network-policies.sh
# Test a set of expected allow/deny connectivity rules

set -euo pipefail

NAMESPACE="${1:-production}"
PASS=0
FAIL=0

test_connectivity() {
  local source_ns="$1"
  local source_pod="$2"
  local target="$3"
  local port="$4"
  local expected="$5"  # "allow" or "deny"

  result=$(kubectl exec -n "$source_ns" "$source_pod" -- \
    nc -zv -w 3 "$target" "$port" 2>&1 || true)

  if echo "$result" | grep -q "succeeded"; then
    actual="allow"
  else
    actual="deny"
  fi

  if [ "$actual" = "$expected" ]; then
    echo "PASS: $source_ns/$source_pod -> $target:$port ($expected)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $source_ns/$source_pod -> $target:$port (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

# Create test pods
kubectl run test-frontend --image=nicolaka/netshoot -n frontend \
  --labels="app=frontend,tier=frontend" \
  --command -- sleep 3600 --dry-run=client -o yaml | kubectl apply -f -

kubectl run test-backend --image=nicolaka/netshoot -n "$NAMESPACE" \
  --labels="app=api-service,tier=backend" \
  --command -- sleep 3600 --dry-run=client -o yaml | kubectl apply -f -

kubectl wait --for=condition=Ready pod/test-frontend -n frontend --timeout=30s
kubectl wait --for=condition=Ready pod/test-backend -n "$NAMESPACE" --timeout=30s

# Test expected allows
test_connectivity "frontend" "test-frontend" \
  "api-service.$NAMESPACE.svc.cluster.local" "8080" "allow"

# Test expected denies
test_connectivity "frontend" "test-frontend" \
  "database.$NAMESPACE.svc.cluster.local" "5432" "deny"

# Cleanup
kubectl delete pod test-frontend -n frontend --ignore-not-found
kubectl delete pod test-backend -n "$NAMESPACE" --ignore-not-found

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
```

## Policy Visualization Tools

### Using Hubble (Cilium's Observability Layer)

```bash
# Install Hubble CLI
curl -L --fail --remote-name-all \
  https://github.com/cilium/hubble/releases/download/v0.13.0/hubble-linux-amd64.tar.gz \
  && tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Enable Hubble UI
helm upgrade cilium cilium/cilium --reuse-values \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  -n kube-system

# Forward Hubble UI
kubectl port-forward svc/hubble-ui -n kube-system 12000:80 &
# Open http://localhost:12000

# Observe traffic flows
hubble observe --namespace production --follow \
  --type drop,forward

# Observe dropped traffic specifically
hubble observe --namespace production \
  --verdict DROPPED \
  --output json | jq '{
    src: .source.namespace + "/" + .source.pod_name,
    dst: .destination.namespace + "/" + .destination.pod_name,
    reason: .drop_reason_desc
  }'
```

### Calico Flow Logs

```bash
# Enable Calico flow logs
kubectl patch felixconfiguration default \
  -p '{"spec":{"flowLogsEnabled":true}}'

# Query flow logs for denied traffic
kubectl logs -n calico-system -l k8s-app=calico-node \
  | grep "\"action\":\"deny\""
```

## Policy Auditing

```bash
#!/bin/bash
# audit-network-policies.sh
# Identify namespaces without default-deny policies

echo "=== Namespaces Without Default-Deny Policy ==="
for NS in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  # Check if default-deny-all policy exists
  HAS_DENY=$(kubectl get networkpolicy default-deny-all -n "$NS" \
    --ignore-not-found -o name 2>/dev/null)

  if [ -z "$HAS_DENY" ]; then
    echo "  MISSING: $NS"
  fi
done

echo ""
echo "=== Network Policies by Namespace ==="
kubectl get networkpolicy -A -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,POD-SELECTOR:.spec.podSelector,POLICY-TYPES:.spec.policyTypes'
```

## Summary

Kubernetes NetworkPolicy microsegmentation implements zero-trust networking at the workload level. The implementation progression is: apply default-deny to all namespaces, add DNS egress allowance (required for every workload), then add specific ingress and egress rules per workload type.

The critical operational principles: always include a DNS egress allowance before applying default-deny to avoid breaking DNS resolution; test policies with netshoot before declaring them production-ready; use staged policies (Calico) or warn-mode rules to observe impact before enforcement. Cilium's L7 HTTP policies and FQDN-based egress extend the base NetworkPolicy spec significantly, enabling path-level and domain-level controls that base NetworkPolicy cannot express.

Policy observability via Hubble (Cilium) or flow logs (Calico) is essential for both troubleshooting connectivity issues and auditing unexpected traffic patterns. Without observability, debugging NetworkPolicy violations requires trial and error. With Hubble observing live traffic and logging drops with source/destination identity, diagnosing a connectivity issue is a matter of querying the flow log.
