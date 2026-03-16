---
title: "Kubernetes Network Policy Enterprise Guide: Zero-Trust Microsegmentation"
date: 2027-06-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Network Policy", "Security", "Zero Trust", "Networking"]
categories:
- Kubernetes
- Security
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Kubernetes NetworkPolicy: default-deny architecture, namespace isolation, ingress/egress rules, CIDR blocks, policy testing, and service mesh integration for zero-trust microsegmentation."
more_link: "yes"
url: "/kubernetes-network-policy-enterprise-guide/"
---

Kubernetes NetworkPolicy is the foundational primitive for enforcing zero-trust microsegmentation within a cluster. Without explicit policies, every pod can reach every other pod across every namespace — a flat network posture that violates the principle of least privilege. This guide covers the full lifecycle of enterprise NetworkPolicy: from default-deny baseline through namespace isolation patterns, ingress and egress rule construction, CIDR-based external access, policy testing workflows, visualization tooling, common operational pitfalls, and integration with service mesh mTLS.

<!--more-->

## Section 1: Understanding the NetworkPolicy Enforcement Model

Kubernetes NetworkPolicy objects are declarative specifications. They do nothing on their own — enforcement is delegated entirely to the CNI plugin. The cluster must run a CNI that supports NetworkPolicy (Calico, Cilium, Antrea, Weave Net, or similar). Flannel in its base form does not enforce NetworkPolicy.

### CNI Compatibility Matrix

| CNI Plugin      | NetworkPolicy Support | L7 Policy | eBPF Dataplane |
|-----------------|----------------------|-----------|----------------|
| Calico          | Full                 | Enterprise | Yes (eBPF mode) |
| Cilium          | Full                 | Yes        | Yes            |
| Antrea          | Full                 | Yes        | Yes            |
| Weave Net       | Full                 | No         | No             |
| Flannel         | No (vanilla)         | No         | No             |
| Canal           | Full (Calico policy) | No         | No             |

Verify CNI support before applying any NetworkPolicy. In a cluster with an unsupported CNI, policies are silently ignored — pods remain fully reachable.

### Policy Scoping Rules

NetworkPolicy operates at the namespace scope. Key behavioral rules:

- A policy applies to pods matched by its `podSelector` within its namespace.
- An empty `podSelector` (`{}`) selects all pods in the namespace.
- If no policy selects a pod, that pod is non-isolated: all ingress and egress is allowed.
- Once any policy selects a pod, the pod becomes isolated for the policy type (Ingress, Egress, or both). All traffic not explicitly allowed by a matching rule is denied.
- Multiple policies selecting the same pod combine additively (union of all allow rules).

This additive model means policies never override each other — they only add permissions. The only way to restrict traffic is to ensure a pod is selected by at least one policy that does not include the traffic you want to block.

## Section 2: Default-Deny Architecture

The recommended enterprise baseline is a default-deny policy applied to every namespace. This ensures newly deployed workloads are isolated by default and must opt-in to connectivity.

### Default-Deny Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Ingress
```

### Default-Deny Egress

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Egress
```

### Combined Default-Deny (Recommended)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

Apply this policy to every namespace as part of namespace provisioning. A GitOps workflow should include this as a mandatory namespace-level resource. Without egress default-deny, pods can still initiate outbound connections to any destination — including data exfiltration paths.

### DNS Egress Allow (Critical)

The most common operational mistake after applying default-deny-egress is forgetting to allow DNS. CoreDNS listens on UDP and TCP port 53 in the `kube-system` namespace. Without this rule, all DNS resolution fails silently, causing application failures that appear unrelated to network policy.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
```

Apply this alongside default-deny-egress in every namespace. This is not optional — it is a prerequisite for any workload that performs name resolution.

## Section 3: Namespace Isolation Patterns

### Isolating Namespaces from Each Other

The following policy allows pods in the `production` namespace to receive ingress only from other pods within the same namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector: {}
```

The `podSelector: {}` inside the `from` block without a `namespaceSelector` matches pods in the same namespace as the policy. This is a common source of confusion — a `podSelector` in `from` without an accompanying `namespaceSelector` is implicitly scoped to the policy's own namespace.

### Cross-Namespace Communication

To allow pods in `monitoring` namespace to scrape metrics from pods in `production`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring-scrape
  namespace: production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: api
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app.kubernetes.io/name: prometheus
    ports:
    - port: 8080
      protocol: TCP
```

The combination of `namespaceSelector` and `podSelector` in the same `from` entry uses AND logic: the source pod must match both selectors. Placing them in separate `from` entries produces OR logic. This distinction is critical and a frequent source of policy misconfiguration.

### AND vs OR Logic in from/to Rules

```yaml
# AND logic: pod must be in monitoring namespace AND have label app=prometheus
ingress:
- from:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: monitoring
    podSelector:
      matchLabels:
        app: prometheus

# OR logic: pod in monitoring namespace OR pod with label app=prometheus (any namespace)
ingress:
- from:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: monitoring
  - podSelector:
      matchLabels:
        app: prometheus
```

Always use AND logic (combined entries) when restricting cross-namespace access to specific pods within a specific namespace.

### Namespace Label Requirements

`namespaceSelector` relies on namespace labels. Verify namespace labels exist:

```bash
kubectl get namespace production --show-labels
kubectl label namespace production kubernetes.io/metadata.name=production
```

Kubernetes 1.21+ automatically sets `kubernetes.io/metadata.name` on all namespaces. Earlier versions require manual labeling.

## Section 4: Pod Selector Strategies

### Labeling Strategy for NetworkPolicy

Effective NetworkPolicy depends on consistent, meaningful pod labels. Recommended label taxonomy:

```yaml
labels:
  app.kubernetes.io/name: payment-service
  app.kubernetes.io/component: backend
  app.kubernetes.io/part-of: checkout
  app.kubernetes.io/tier: api
  security.company.com/data-classification: pci
```

Avoid using labels that change frequently (like image tags) as policy selectors. Use stable semantic labels.

### Tier-Based Isolation

```yaml
# Allow frontend to reach backend only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend-to-backend
  namespace: production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/tier: backend
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app.kubernetes.io/tier: frontend
    ports:
    - port: 8080
      protocol: TCP
---
# Allow backend to reach database only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-backend-to-database
  namespace: production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/tier: database
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app.kubernetes.io/tier: backend
    ports:
    - port: 5432
      protocol: TCP
```

### Service Account-Based Isolation (Cilium Extension)

Standard Kubernetes NetworkPolicy does not support service account selectors. Cilium's `CiliumNetworkPolicy` extends this:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-sa-based
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  ingress:
  - fromEndpoints:
    - matchLabels:
        io.cilium.k8s.policy.serviceaccount: checkout-backend
```

This enables policy enforcement based on cryptographic workload identity rather than mutable labels.

## Section 5: Ingress and Egress Rule Construction

### Ingress Rule Patterns

Allow ingress from the NGINX ingress controller pods:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-controller
  namespace: production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: api-server
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
    - port: 8443
      protocol: TCP
```

### Egress Rule Patterns

Allow egress to a specific external API:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-external-api-egress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: payment-service
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 203.0.113.0/24
    ports:
    - port: 443
      protocol: TCP
```

### Allow Kubernetes API Server Egress

Pods that interact with the Kubernetes API (operators, admission webhooks, service accounts) need egress to the API server:

```bash
# Find the API server CIDR
kubectl get endpoints kubernetes -n default
```

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-kube-apiserver-egress
  namespace: production
spec:
  podSelector:
    matchLabels:
      needs-api-access: "true"
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 10.96.0.1/32
    ports:
    - port: 443
      protocol: TCP
    - port: 6443
      protocol: TCP
```

## Section 6: CIDR Blocks for External Access

### Allowing Specific External Ranges

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-corporate-ingress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: admin-portal
  policyTypes:
  - Ingress
  ingress:
  - from:
    - ipBlock:
        cidr: 10.0.0.0/8
    - ipBlock:
        cidr: 172.16.0.0/12
    - ipBlock:
        cidr: 192.168.0.0/16
    ports:
    - port: 8080
      protocol: TCP
```

### Allowing All External Egress Except Private Ranges

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-internet-egress-except-private
  namespace: production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: web-crawler
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8
        - 172.16.0.0/12
        - 192.168.0.0/16
        - 100.64.0.0/10
    ports:
    - port: 80
      protocol: TCP
    - port: 443
      protocol: TCP
```

The `except` field removes subnets from the allowed CIDR range. This prevents pods from reaching internal infrastructure while still permitting internet egress.

### Node CIDR Access

Pods sometimes need to reach node-level services (e.g., node-local DNS, kubelet metrics):

```bash
# Get node CIDR
kubectl get nodes -o jsonpath='{.items[*].spec.podCIDR}'
# Or check cluster CIDR
kubectl cluster-info dump | grep -m 1 cluster-cidr
```

```yaml
egress:
- to:
  - ipBlock:
      cidr: 192.168.0.0/24  # node subnet
  ports:
  - port: 9100  # node-exporter
    protocol: TCP
```

## Section 7: Policy Testing with netcat and kubectl-netpol

### Testing with netcat

Deploy a debug pod to test connectivity:

```bash
# Deploy a test pod in the source namespace
kubectl run netcat-test \
  --image=busybox:1.36 \
  --restart=Never \
  --labels="app.kubernetes.io/name=netcat-test" \
  -n production \
  -- sleep 3600

# Test TCP connectivity to target pod
kubectl exec -n production netcat-test -- \
  nc -zv -w 3 payment-service.production.svc.cluster.local 8080

# Test UDP connectivity (e.g., DNS)
kubectl exec -n production netcat-test -- \
  nc -zu -w 3 kube-dns.kube-system.svc.cluster.local 53

# Test that blocked traffic is actually blocked
kubectl exec -n production netcat-test -- \
  nc -zv -w 3 database.production.svc.cluster.local 5432
# Expected: nc: database.production.svc.cluster.local (10.96.x.x:5432): Connection timed out

# Clean up
kubectl delete pod netcat-test -n production
```

### Using kubectl-netpol Plugin

The `kubectl-netpol` plugin (part of the Kubernetes network policy toolkit) provides policy analysis and simulation:

```bash
# Install kubectl-netpol
kubectl krew install netpol

# List all network policies in a namespace
kubectl netpol -n production list

# Simulate traffic: would a pod with app=frontend reach a pod with app=backend on port 8080?
kubectl netpol -n production simulate \
  --from "pod:app=frontend" \
  --to "pod:app=backend" \
  --port 8080 \
  --protocol TCP

# Generate a report of all allowed traffic paths
kubectl netpol -n production report
```

### Automated Policy Validation Script

```bash
#!/usr/bin/env bash
# network-policy-test.sh — validate NetworkPolicy enforcement

set -euo pipefail

NAMESPACE="${1:-production}"
SOURCE_POD="policy-test-source"
TARGET_SVC="payment-service"
TARGET_PORT="8080"
BLOCKED_SVC="database"
BLOCKED_PORT="5432"

echo "=== Network Policy Validation: ${NAMESPACE} ==="

# Create source pod
kubectl run "${SOURCE_POD}" \
  --image=busybox:1.36 \
  --restart=Never \
  --labels="app.kubernetes.io/name=policy-test" \
  -n "${NAMESPACE}" \
  -- sleep 60

kubectl wait pod/"${SOURCE_POD}" \
  -n "${NAMESPACE}" \
  --for=condition=Ready \
  --timeout=30s

echo ""
echo "--- Test 1: DNS resolution (must succeed) ---"
if kubectl exec -n "${NAMESPACE}" "${SOURCE_POD}" -- \
    nslookup "${TARGET_SVC}.${NAMESPACE}.svc.cluster.local" 2>/dev/null; then
  echo "PASS: DNS resolution works"
else
  echo "FAIL: DNS resolution failed — check allow-dns-egress policy"
fi

echo ""
echo "--- Test 2: Allowed connection to ${TARGET_SVC}:${TARGET_PORT} ---"
if kubectl exec -n "${NAMESPACE}" "${SOURCE_POD}" -- \
    nc -zv -w 3 "${TARGET_SVC}.${NAMESPACE}.svc.cluster.local" "${TARGET_PORT}" 2>&1 | grep -q "open\|succeeded"; then
  echo "PASS: Connection to ${TARGET_SVC}:${TARGET_PORT} succeeded as expected"
else
  echo "FAIL: Expected connection to ${TARGET_SVC}:${TARGET_PORT} was blocked"
fi

echo ""
echo "--- Test 3: Blocked connection to ${BLOCKED_SVC}:${BLOCKED_PORT} ---"
if kubectl exec -n "${NAMESPACE}" "${SOURCE_POD}" -- \
    nc -zv -w 3 "${BLOCKED_SVC}.${NAMESPACE}.svc.cluster.local" "${BLOCKED_PORT}" 2>&1 | grep -q "open\|succeeded"; then
  echo "FAIL: Connection to ${BLOCKED_SVC}:${BLOCKED_PORT} succeeded but should be blocked"
else
  echo "PASS: Connection to ${BLOCKED_SVC}:${BLOCKED_PORT} was blocked as expected"
fi

# Cleanup
kubectl delete pod "${SOURCE_POD}" -n "${NAMESPACE}" --ignore-not-found
echo ""
echo "=== Validation complete ==="
```

## Section 8: Policy Visualization Tools

### Calico Enterprise Policy Board

Calico Enterprise provides a graphical policy editor and traffic visualization dashboard. It shows:

- Which policies are active per namespace
- Live traffic flows with allow/deny decisions
- Policy recommendation engine based on observed traffic
- Compliance reports mapping policies to regulatory frameworks

```bash
# Install Calico Enterprise (requires license)
kubectl apply -f https://downloads.tigera.io/ee/v3.18/manifests/tigera-operator.yaml

# Apply Calico Enterprise installation
kubectl apply -f - <<EOF
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  variant: TigeraSecureEnterprise
  imagePullSecrets:
  - name: tigera-pull-secret
EOF
```

### Cilium Hubble UI

Cilium's Hubble provides a real-time network flow observability UI:

```bash
# Enable Hubble
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true

# Port-forward to access the UI
kubectl port-forward -n kube-system svc/hubble-ui 12000:80

# Use Hubble CLI to observe flows
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --last 100
```

### Network Policy Editor (Cilium)

The open-source Cilium Network Policy Editor (editor.networkpolicy.io) allows visual policy construction without a cluster:

```bash
# Export existing policies for visual review
kubectl get networkpolicy -n production -o yaml | \
  python3 -c "
import sys, json, yaml
docs = list(yaml.safe_load_all(sys.stdin))
for doc in docs:
    print(json.dumps(doc, indent=2))
"
```

### np-viewer Tool

```bash
# Install np-viewer
go install github.com/sysdiglabs/kube-policy-advisor@latest

# Generate policy advisor report
kube-policy-advisor inspect --namespace production
```

## Section 9: Common Pitfalls and Operational Issues

### Pitfall 1: DNS Port 53 Forgetting Both Protocols

DNS uses both UDP and TCP port 53. Defining only UDP blocks large DNS responses that fall back to TCP:

```yaml
# WRONG: Only UDP — large DNS responses will fail
egress:
- ports:
  - port: 53
    protocol: UDP

# CORRECT: Both UDP and TCP
egress:
- ports:
  - port: 53
    protocol: UDP
  - port: 53
    protocol: TCP
```

### Pitfall 2: Missing NodeLocal DNSCache Port

Clusters using NodeLocal DNSCache use a different IP (169.254.20.10) and port 53. If node-local DNS is enabled:

```yaml
egress:
- to:
  - ipBlock:
      cidr: 169.254.20.10/32
  ports:
  - port: 53
    protocol: UDP
  - port: 53
    protocol: TCP
```

Verify whether node-local DNS is enabled:

```bash
kubectl get daemonset node-local-dns -n kube-system
```

### Pitfall 3: Stateful Connection Tracking

Kubernetes NetworkPolicy is stateful for TCP and UDP. Return traffic from allowed connections is automatically permitted. There is no need to define egress rules to allow responses to allowed ingress. However, for UDP flows, some CNIs implement stateful tracking imperfectly — test explicitly.

### Pitfall 4: Policy Not Selecting Pods Due to Label Changes

If pod labels change after deployment (e.g., via a rolling update that adds/removes labels), policies may stop matching. Use stable labels that are not updated during deployments.

```bash
# Check which pods a policy selects
kubectl get pods -n production -l app.kubernetes.io/name=payment-service
kubectl get networkpolicy allow-payment-ingress -n production -o yaml | grep -A5 podSelector
```

### Pitfall 5: Namespace Without Labels

`namespaceSelector` rules silently fail if the target namespace lacks the expected label:

```bash
# Audit all namespaces for missing metadata labels
kubectl get namespaces -o json | \
  jq -r '.items[] | select(.metadata.labels["kubernetes.io/metadata.name"] == null) | .metadata.name'

# Add missing labels
kubectl label namespace <ns-name> kubernetes.io/metadata.name=<ns-name>
```

### Pitfall 6: Admission Webhooks Blocked

Admission webhooks (ValidatingAdmissionWebhook, MutatingAdmissionWebhook) are called from the API server to webhook pods. If the webhook pods are in a namespace with default-deny-ingress, webhook calls will be blocked, causing all resource creation to fail with a timeout.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-webhook-ingress
  namespace: webhook-namespace
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: admission-webhook
  policyTypes:
  - Ingress
  ingress:
  - from:
    - ipBlock:
        cidr: 0.0.0.0/0  # API server IP is not always predictable
    ports:
    - port: 8443
      protocol: TCP
```

For clusters where the API server IP is known and stable, restrict the CIDR accordingly.

### Pitfall 7: Readiness and Liveness Probe Blocking

kubelet executes health probes from the node, not from within the cluster network. Probes originate from the node IP. If egress or ingress policies block node traffic, pods will fail readiness/liveness checks and be killed.

```yaml
# Allow ingress from node CIDR for health probes
ingress:
- from:
  - ipBlock:
      cidr: 192.168.0.0/24  # Replace with actual node CIDR
  ports:
  - port: 8080
    protocol: TCP
```

## Section 10: Combining NetworkPolicy with Service Mesh

### Layered Defense with Istio

Kubernetes NetworkPolicy operates at L3/L4 (IP and port). Istio adds L7 policy enforcement (HTTP method, path, headers). Both should be used together for defense in depth.

NetworkPolicy ensures mTLS is the only accepted traffic type. Istio enforces which services can call which endpoints.

```yaml
# NetworkPolicy: only allow traffic from the Istio sidecar proxy port
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-istio-only
  namespace: production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: payment-service
  policyTypes:
  - Ingress
  ingress:
  - ports:
    - port: 15006   # Istio inbound capture port
      protocol: TCP
    - port: 15008   # Istio HBONE tunnel
      protocol: TCP
```

### Istio AuthorizationPolicy for L7

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: payment-service-authz
  namespace: production
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: payment-service
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        - cluster.local/ns/production/sa/checkout-backend
    to:
    - operation:
        methods: ["POST"]
        paths: ["/api/v1/charge", "/api/v1/refund"]
```

### PeerAuthentication for mTLS Enforcement

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
```

With `STRICT` mTLS, all inter-service communication is encrypted and authenticated. Combined with NetworkPolicy's L4 restrictions, this creates a defense-in-depth architecture where both network-layer and application-layer controls are enforced independently.

### Cilium L7 Policy

Cilium can enforce L7 policy without a service mesh:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-http-get-only
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
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
        - method: GET
          path: "/api/v1/.*"
```

## Section 11: Enterprise Policy Management Patterns

### GitOps-Driven Policy Deployment

Store all NetworkPolicies in Git and deploy via ArgoCD or Flux:

```yaml
# apps/network-policies/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- default-deny-all.yaml
- allow-dns-egress.yaml
- allow-same-namespace.yaml
- allow-monitoring-scrape.yaml
- allow-ingress-controller.yaml
```

```yaml
# ArgoCD Application for network policies
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: network-policies-production
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://git.company.internal/platform/k8s-policies
    targetRevision: main
    path: apps/network-policies/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### Policy Templating with Helm

```yaml
# templates/network-policy-tier.yaml
{{- range .Values.tiers }}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-{{ .name }}-ingress
  namespace: {{ $.Release.Namespace }}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/tier: {{ .name }}
  policyTypes:
  - Ingress
  ingress:
  {{- range .allowFrom }}
  - from:
    - podSelector:
        matchLabels:
          app.kubernetes.io/tier: {{ . }}
    ports:
    {{- range $.Values.ports }}
    - port: {{ .port }}
      protocol: {{ .protocol }}
    {{- end }}
  {{- end }}
{{- end }}
```

### Audit and Compliance Reporting

```bash
#!/usr/bin/env bash
# network-policy-audit.sh — report namespaces without default-deny

echo "=== Namespaces without default-deny-all NetworkPolicy ==="
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  has_deny=$(kubectl get networkpolicy -n "${ns}" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | \
    tr ' ' '\n' | grep -c "default-deny" || true)
  if [ "${has_deny}" -eq 0 ]; then
    echo "MISSING: ${ns}"
  fi
done

echo ""
echo "=== Namespaces missing DNS egress allow policy ==="
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  has_dns=$(kubectl get networkpolicy -n "${ns}" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | \
    tr ' ' '\n' | grep -c "dns" || true)
  if [ "${has_dns}" -eq 0 ]; then
    echo "MISSING: ${ns}"
  fi
done
```

## Section 12: Performance and Scale Considerations

### Policy Rule Count Impact

Each NetworkPolicy rule translates into iptables/eBPF rules at the kernel level. Very large policy sets can affect connection setup latency:

- Calico with iptables: each rule adds ~1 microsecond of lookup overhead per connection
- Calico with eBPF: O(1) policy lookup via BPF hash maps — scales to thousands of policies
- Cilium: eBPF native, minimal overhead at scale

For clusters with 1000+ policies, consider switching to an eBPF-based CNI.

### Policy Reconciliation

The CNI controller must reconcile NetworkPolicy changes. High churn (frequent policy updates) can increase CPU usage on nodes. Batch policy changes and use progressive rollout.

```bash
# Monitor Calico Felix reconciliation metrics
kubectl exec -n kube-system daemonset/calico-node -- \
  curl -s http://localhost:9091/metrics | \
  grep felix_calc_graph_update_time
```

### Namespace Count and Selector Performance

`namespaceSelector` rules are evaluated against all namespaces in the cluster. In clusters with hundreds of namespaces, broad namespace selectors degrade performance. Prefer specific label matches over wildcard patterns.

---

Kubernetes NetworkPolicy is not optional in production environments handling sensitive workloads. The default-allow posture of a cluster without policies exposes every service to lateral movement attacks from any compromised pod. Implementing default-deny as the baseline, then systematically allowing required traffic paths, reduces the blast radius of any compromise to a single namespace or tier. Combined with service mesh L7 enforcement and continuous policy auditing via GitOps, this architecture satisfies zero-trust requirements for PCI, HIPAA, and SOC 2 compliance frameworks.
