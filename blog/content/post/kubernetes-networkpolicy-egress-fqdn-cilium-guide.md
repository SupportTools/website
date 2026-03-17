---
title: "Kubernetes NetworkPolicy Advanced: Egress Control, FQDN Policies with Cilium, and Zero-Trust Microsegmentation"
date: 2028-09-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NetworkPolicy", "Cilium", "Egress", "Zero-Trust", "Security"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement zero-trust microsegmentation in Kubernetes using advanced NetworkPolicy egress rules, Cilium FQDN-based policies, L7 HTTP/gRPC policy enforcement, and policy auditing automation."
more_link: "yes"
url: "/kubernetes-networkpolicy-egress-fqdn-cilium-guide/"
---

Default Kubernetes NetworkPolicy is L3/L4 only and cannot express domain-name-based egress rules. A pod blocked from arbitrary internet access but needing to reach `api.stripe.com` requires either an IP allowlist (brittle, changes) or a smarter CNI. Cilium's CiliumNetworkPolicy extends standard NetworkPolicy with FQDN filtering, L7 HTTP/gRPC inspection, and port-range rules. This guide builds a complete zero-trust network model from scratch.

<!--more-->

# Kubernetes NetworkPolicy Advanced: Egress Control, FQDN Policies with Cilium, and Zero-Trust Microsegmentation

## Section 1: Zero-Trust Network Model for Kubernetes

In a zero-trust model, every pod starts with no network access and policies explicitly grant what is needed. The default-deny posture:

```
Default state:
  Pod A → Pod B:     DENIED
  Pod A → Internet:  DENIED
  Internet → Pod A:  DENIED

Explicit grants:
  frontend → backend:8080     ALLOWED
  backend  → postgres:5432    ALLOWED
  backend  → api.stripe.com:443 ALLOWED (FQDN)
  ingress-nginx → frontend:80  ALLOWED
```

## Section 2: Installing Cilium with Hubble Observability

```bash
# Install Cilium CLI
curl -L --fail --remote-name-all \
  https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz
tar xzvf cilium-linux-amd64.tar.gz -C /usr/local/bin

# Install Cilium in a KinD cluster
kind create cluster --config=kind-config.yaml

cilium install \
  --version 1.15.5 \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=kind-control-plane \
  --set k8sServicePort=6443

# Verify
cilium status --wait
cilium connectivity test
```

```yaml
# kind-config.yaml — disable default CNI for Cilium
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
networking:
  disableDefaultCNI: true
  podSubnet: "10.0.0.0/16"
  serviceSubnet: "10.96.0.0/12"
```

## Section 3: Namespace-Level Default Deny

Apply default-deny before any workloads are deployed:

```yaml
# netpol-default-deny-all.yaml
# Block ALL ingress and egress for every pod in the namespace.
# Apply this first, then explicitly allow what is needed.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}   # matches ALL pods in namespace
  policyTypes:
    - Ingress
    - Egress
  # No ingress or egress rules = deny all
---
# Allow DNS egress — required for all pods to resolve names
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
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
```

## Section 4: Service-to-Service Policies

```yaml
# netpol-frontend.yaml
# Frontend: accept ingress from ingress-nginx, send egress to backend only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: frontend
      tier: web
  policyTypes:
    - Ingress
    - Egress
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
  egress:
    # Backend API
    - to:
        - podSelector:
            matchLabels:
              app: backend
              tier: api
      ports:
        - port: 8080
          protocol: TCP
    # DNS (inherited from allow-dns-egress but explicit here for clarity)
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
---
# netpol-backend.yaml
# Backend: accept from frontend, send to database and external APIs
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: backend
      tier: api
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - port: 8080
          protocol: TCP
    # Allow prometheus scraping from monitoring namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app: prometheus
      ports:
        - port: 9090
          protocol: TCP
  egress:
    # PostgreSQL
    - to:
        - podSelector:
            matchLabels:
              app: postgres
      ports:
        - port: 5432
          protocol: TCP
    # Redis cache
    - to:
        - podSelector:
            matchLabels:
              app: redis
      ports:
        - port: 6379
          protocol: TCP
    # DNS
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
---
# netpol-database.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: postgres-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: postgres
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: backend
      ports:
        - port: 5432
          protocol: TCP
  egress:
    # PostgreSQL replication (if using HA)
    - to:
        - podSelector:
            matchLabels:
              app: postgres
      ports:
        - port: 5432
          protocol: TCP
```

## Section 5: Cilium FQDN Egress Policies

Standard NetworkPolicy uses IP CIDRs. Cilium's `CiliumNetworkPolicy` adds FQDN-based egress:

```yaml
# cilium-fqdn-policy.yaml
# Allow backend pods to reach Stripe and SendGrid APIs by domain name.
# Cilium resolves the FQDN and dynamically updates the underlying iptables/eBPF rules.
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: backend-external-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend
  egress:
    # Payment processing
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "hooks.stripe.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Email service
    - toFQDNs:
        - matchName: "api.sendgrid.com"
        - matchPattern: "*.sendgrid.net"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # AWS S3 (wildcard matching)
    - toFQDNs:
        - matchPattern: "*.s3.amazonaws.com"
        - matchPattern: "s3.*.amazonaws.com"
        - matchName: "s3.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Internal service mesh traffic to kube-apiserver
    - toEntities:
        - kube-apiserver
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Metrics push to external Prometheus remote write
    - toFQDNs:
        - matchName: "prometheus.myorg.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
---
# Block all other external egress from backend pods
# (the default-deny-all NetworkPolicy above already does this,
#  but this CiliumNetworkPolicy provides an explicit audit trail)
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: backend-deny-other-external
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend
  egressDeny:
    - toEntities:
        - world   # Everything outside the cluster
```

## Section 6: L7 HTTP and gRPC Policy Enforcement

Cilium can inspect HTTP requests and enforce policies based on method and path:

```yaml
# cilium-l7-policy.yaml
# Only allow the frontend to call specific backend API endpoints.
# Blocks all other HTTP methods/paths even on the allowed port.
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: backend-l7-ingress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend
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
              # Allow GET on any /api/v1/* path
              - method: "GET"
                path: "/api/v1/.*"
              # Allow POST only on specific endpoints
              - method: "POST"
                path: "/api/v1/orders"
              - method: "POST"
                path: "/api/v1/users"
              # Allow health check
              - method: "GET"
                path: "/health"
              # Block everything else (implicit deny)
---
# gRPC service-level policy
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: grpc-payment-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: backend
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
          rules:
            # gRPC service/method filtering
            http:
              - method: "POST"
                path: "/payment.PaymentService/.*"
              - method: "POST"
                path: "/grpc.health.v1.Health/Check"
```

## Section 7: Cross-Namespace Policies

```yaml
# Allow monitoring namespace to scrape all namespaces
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-prometheus-scrape
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              monitoring: "true"
          podSelector:
            matchLabels:
              app: prometheus
      ports:
        - port: 9090
          protocol: TCP
        - port: 8080
          protocol: TCP
---
# Allow cert-manager to communicate with ACME servers and Vault
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: cert-manager-egress
  namespace: cert-manager
spec:
  endpointSelector:
    matchLabels:
      app: cert-manager
  egress:
    - toFQDNs:
        - matchName: "acme-v02.api.letsencrypt.org"
        - matchName: "vault.production.svc.cluster.local"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
            - port: "8200"
              protocol: TCP
    - toEntities:
        - kube-apiserver
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

## Section 8: Cilium Hubble — Network Flow Observability

Hubble provides real-time visibility into policy decisions:

```bash
# Install Hubble CLI
curl -L --fail --remote-name-all \
  https://github.com/cilium/hubble/releases/latest/download/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz -C /usr/local/bin

# Port-forward Hubble relay
cilium hubble port-forward &

# Observe all traffic in production namespace
hubble observe --namespace production --follow

# Observe dropped packets (policy violations)
hubble observe --namespace production --verdict DROPPED --follow

# Filter by source pod
hubble observe --pod production/backend-7d5c9 --follow

# Check flows between specific pods
hubble observe \
  --from-pod production/frontend-abc123 \
  --to-pod production/backend-def456 \
  --follow

# Output as JSON for parsing
hubble observe --namespace production --output json | \
  jq 'select(.verdict == "DROPPED") | {src: .source.pod_name, dst: .destination.pod_name, reason: .drop_reason_desc}'
```

## Section 9: Policy Auditing and Testing Automation

```bash
#!/bin/bash
# netpol-audit.sh — verify network policies are correctly enforcing isolation

NAMESPACE="production"

echo "=== Network Policy Audit: $NAMESPACE ==="

# List all NetworkPolicies
echo -e "\n--- NetworkPolicies ---"
kubectl get networkpolicy -n "$NAMESPACE" -o wide

# List all CiliumNetworkPolicies
echo -e "\n--- CiliumNetworkPolicies ---"
kubectl get cnp -n "$NAMESPACE" -o wide

# Check for pods without any matching policy (potential gaps)
echo -e "\n--- Pods with NO ingress policy ---"
kubectl get pods -n "$NAMESPACE" -o json | jq -r '.items[] | .metadata.name' | while read pod; do
    labels=$(kubectl get pod "$pod" -n "$NAMESPACE" -o json | jq -r '.metadata.labels | to_entries | map("\(.key)=\(.value)") | join(",")')
    # Check if any NetworkPolicy selects this pod
    matches=$(kubectl get networkpolicy -n "$NAMESPACE" -o json | \
        jq --arg labels "$labels" '
            .items[] | select(.spec.policyTypes[] == "Ingress") |
            # Simple check — in production use a proper policy simulator
            .metadata.name
        ' 2>/dev/null)
    if [ -z "$matches" ]; then
        echo "  WARNING: Pod $pod has no ingress NetworkPolicy"
    fi
done

# Test connectivity using ephemeral debug pods
echo -e "\n--- Connectivity Tests ---"

# Test: frontend -> backend (should be ALLOWED)
echo -n "frontend -> backend:8080: "
kubectl run test-frontend --image=curlimages/curl:8.7.1 \
  --labels="app=frontend,tier=web" \
  --restart=Never --rm -it \
  -n "$NAMESPACE" \
  -- curl -s --connect-timeout 3 http://backend:8080/health 2>/dev/null \
  && echo "ALLOWED" || echo "DENIED"

# Test: frontend -> postgres (should be DENIED)
echo -n "frontend -> postgres:5432: "
kubectl run test-frontend-pg --image=curlimages/curl:8.7.1 \
  --labels="app=frontend,tier=web" \
  --restart=Never --rm -it \
  -n "$NAMESPACE" \
  -- curl -s --connect-timeout 3 postgres:5432 2>/dev/null \
  && echo "ALLOWED (UNEXPECTED)" || echo "DENIED (expected)"

# Test: backend -> external internet without FQDN policy (should be DENIED)
echo -n "backend -> google.com:443 (no FQDN policy): "
kubectl run test-backend-ext --image=curlimages/curl:8.7.1 \
  --labels="app=backend,tier=api" \
  --restart=Never --rm -it \
  -n "$NAMESPACE" \
  -- curl -s --connect-timeout 3 https://google.com 2>/dev/null \
  && echo "ALLOWED (UNEXPECTED)" || echo "DENIED (expected)"

# Test: backend -> stripe (should be ALLOWED via FQDN policy)
echo -n "backend -> api.stripe.com:443: "
kubectl run test-backend-stripe --image=curlimages/curl:8.7.1 \
  --labels="app=backend,tier=api" \
  --restart=Never --rm -it \
  -n "$NAMESPACE" \
  -- curl -s --connect-timeout 5 https://api.stripe.com 2>/dev/null \
  && echo "ALLOWED (expected)" || echo "DENIED (UNEXPECTED)"
```

## Section 10: Network Policy as Code — CI/CD Integration

```yaml
# .github/workflows/netpol-validate.yaml
name: Validate Network Policies

on:
  pull_request:
    paths:
      - 'k8s/netpol/**'
      - 'k8s/cilium/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install tools
        run: |
          # Install cyclonus (network policy simulator)
          curl -L https://github.com/mattfenwick/cyclonus/releases/latest/download/cyclonus_linux_amd64 \
            -o /usr/local/bin/cyclonus && chmod +x /usr/local/bin/cyclonus

          # Install kubectl
          curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
          chmod +x kubectl && mv kubectl /usr/local/bin/

      - name: Lint NetworkPolicies
        run: |
          for f in k8s/netpol/*.yaml; do
            echo "Linting $f..."
            kubectl apply --dry-run=client -f "$f" 2>&1 | grep -v "configured\|created\|unchanged"
          done

      - name: Simulate policy with cyclonus
        run: |
          cyclonus analyze \
            --namespaces production,staging,monitoring \
            --policy-path k8s/netpol/ \
            --format table > policy-analysis.txt
          cat policy-analysis.txt

      - name: Check for unexpected open paths
        run: |
          # Fail if any pod in production can reach the internet without explicit FQDN policy
          grep -q "production.*world.*ALLOWED" policy-analysis.txt && \
            echo "ERROR: Unexpected internet access found" && exit 1 || echo "Internet isolation verified"

      - name: Upload policy analysis
        uses: actions/upload-artifact@v4
        with:
          name: policy-analysis
          path: policy-analysis.txt
```

## Section 11: Complete Policy Template for a New Microservice

```yaml
# templates/microservice-netpol.yaml
# Replace MY_APP, MY_NAMESPACE, UPSTREAM_APP, DOWNSTREAM_SERVICE
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: MY_APP-network-policy
  namespace: MY_NAMESPACE
  labels:
    app: MY_APP
    managed-by: platform-team
spec:
  podSelector:
    matchLabels:
      app: MY_APP
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Accept traffic from upstream services
    - from:
        - podSelector:
            matchLabels:
              app: UPSTREAM_APP
      ports:
        - port: 8080
          protocol: TCP
    # Accept Prometheus scrape from monitoring namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app: prometheus
      ports:
        - port: 9090
          protocol: TCP
  egress:
    # Downstream service
    - to:
        - podSelector:
            matchLabels:
              app: DOWNSTREAM_SERVICE
      ports:
        - port: 5432
          protocol: TCP
    # DNS
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
---
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: MY_APP-fqdn-egress
  namespace: MY_NAMESPACE
spec:
  endpointSelector:
    matchLabels:
      app: MY_APP
  egress:
    # Add FQDN rules as needed
    # - toFQDNs:
    #     - matchName: "api.external-service.com"
    #   toPorts:
    #     - ports:
    #         - port: "443"
    #           protocol: TCP
```

## Section 12: Troubleshooting Network Policy Issues

```bash
# Check if a pod matches any NetworkPolicy
kubectl get networkpolicy -n production -o json | \
  jq --argjson podlabels '{"app":"backend","tier":"api"}' '
    .items[] | {
      name: .metadata.name,
      selects_pod: (.spec.podSelector.matchLabels | to_entries | all(. as $e | $podlabels[$e.key] == $e.value))
    }
  '

# Use Cilium's endpoint view for detailed policy info
kubectl exec -n kube-system ds/cilium -- \
  cilium endpoint list

kubectl exec -n kube-system ds/cilium -- \
  cilium endpoint get -l "k8s:app=backend"

# Check identity and policy verdict
kubectl exec -n kube-system ds/cilium -- \
  cilium policy trace \
    --src-k8s-pod production/frontend-abc123 \
    --dst-k8s-pod production/backend-def456 \
    --dport 8080/TCP

# Monitor drops in real time with eBPF
kubectl exec -n kube-system ds/cilium -- \
  cilium monitor --type drop

# Check Cilium FQDN cache
kubectl exec -n kube-system ds/cilium -- \
  cilium fqdn cache list

# Force FQDN cache refresh
kubectl exec -n kube-system ds/cilium -- \
  cilium fqdn cache clean
```

Zero-trust network segmentation with Kubernetes NetworkPolicy and Cilium provides defense-in-depth at the network layer. Combined with Hubble's observability and automated policy testing in CI/CD pipelines, you can enforce least-privilege network access across thousands of pods without sacrificing developer velocity.
