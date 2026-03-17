---
title: "Kubernetes NetworkPolicy Deep Dive: Ingress, Egress, and FQDN Policies"
date: 2029-06-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NetworkPolicy", "Cilium", "Security", "Network", "Zero Trust", "FQDN"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes NetworkPolicy covering policy selectors, namespace selectors, ipBlock rules, Cilium FQDN policies, policy visualization tools, and default-deny patterns for production zero-trust network security."
more_link: "yes"
url: "/kubernetes-networkpolicy-deep-dive-ingress-egress-fqdn/"
---

Kubernetes NetworkPolicy is the primary mechanism for implementing zero-trust network security within a cluster. Without NetworkPolicy, every pod can communicate with every other pod in the cluster by default — a flat network with no isolation. This guide covers the full NetworkPolicy API from basic pod selectors through namespace-scoped policies, IP block rules, and Cilium's FQDN policy extension for controlling egress to external services. Each pattern includes production-ready policy manifests and visualization strategies.

<!--more-->

# Kubernetes NetworkPolicy Deep Dive: Ingress, Egress, and FQDN Policies

## Understanding the Default NetworkPolicy Behavior

Kubernetes does not restrict pod-to-pod communication by default. The default state for any pod that has no NetworkPolicy selecting it is:

- **Ingress**: allow all traffic from all sources
- **Egress**: allow all traffic to all destinations

This default-allow posture is appropriate for development but dangerous in production. The first step in any production cluster is establishing default-deny policies.

### Important: Network Plugin Requirement

NetworkPolicy objects are only enforced if your CNI plugin supports them. Common CNI plugins and their NetworkPolicy support:

| CNI Plugin | Standard NetworkPolicy | FQDN Policy | L7 Policy |
|---|---|---|---|
| Cilium | Yes | Yes (CiliumNetworkPolicy) | Yes |
| Calico | Yes | Yes (GlobalNetworkPolicy) | Yes (with Envoy) |
| Weave Net | Yes | No | No |
| Flannel | No | No | No |
| AWS VPC CNI | Yes (via Calico) | No | No |
| Azure CNI | Yes | No | No |

If your CNI does not support NetworkPolicy, all policy objects are silently ignored.

## The NetworkPolicy API Structure

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: example-policy
  namespace: production    # Policies are namespaced
spec:
  # podSelector: which pods this policy applies TO
  # Empty selector {} = applies to ALL pods in the namespace
  podSelector:
    matchLabels:
      app: api-service
      tier: backend

  # policyTypes: which traffic directions are controlled
  # If Ingress is listed, non-matching ingress is DENIED
  # If Egress is listed, non-matching egress is DENIED
  policyTypes:
    - Ingress
    - Egress

  ingress:
    - from:
        # Multiple entries in 'from' are OR'd together
        # Multiple conditions within a single entry are AND'd
        - podSelector:
            matchLabels:
              app: frontend
          namespaceSelector:
            matchLabels:
              environment: production
        - podSelector:
            matchLabels:
              role: monitoring
      ports:
        - protocol: TCP
          port: 8080
        - protocol: TCP
          port: 8443

  egress:
    - to:
        - podSelector:
            matchLabels:
              app: database
      ports:
        - protocol: TCP
          port: 5432
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
```

## Default-Deny Patterns

Establishing default-deny is the foundation of a zero-trust network posture.

### Default-Deny All Ingress for a Namespace

```yaml
# Denies ALL ingress to ALL pods in the namespace.
# Any pod that needs ingress must have a separate allow policy.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: production
spec:
  podSelector: {}      # Applies to all pods
  policyTypes:
    - Ingress
  # No ingress rules = deny all ingress
```

### Default-Deny All Egress for a Namespace

```yaml
# Denies ALL egress from ALL pods in the namespace.
# Note: this blocks DNS! You must explicitly allow UDP/53 to kube-dns.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Egress
  # No egress rules = deny all egress
```

### Allow DNS Egress (Required with Default-Deny)

```yaml
# Always add this alongside default-deny-egress
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

### Combined Default-Deny (Both Directions)

```yaml
# Apply this to every namespace as part of your baseline security posture
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
---
# Then allow DNS for all pods in this namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: production
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
```

## Pod and Namespace Selectors

Understanding selector semantics is critical to writing correct policies.

### AND vs OR Semantics

```yaml
# IMPORTANT: Selector semantics inside 'from'/'to' arrays
ingress:
  - from:
    # Entry 1 AND Entry 2 must BOTH be true
    # This means: pod must match BOTH selectors simultaneously
    - podSelector:
        matchLabels:
          role: frontend
      namespaceSelector:
        matchLabels:
          environment: production
```

vs.

```yaml
ingress:
  - from:
    # Two SEPARATE entries: Entry 1 OR Entry 2
    # Source can be from role=frontend (any namespace)
    # OR from the production namespace (any pod)
    - podSelector:
        matchLabels:
          role: frontend
    - namespaceSelector:
        matchLabels:
          environment: production
```

This distinction is the most common source of NetworkPolicy misconfiguration.

### Cross-Namespace Communication

```yaml
# Allow the 'monitoring' namespace to scrape metrics from all pods in 'production'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-prometheus-scrape
  namespace: production
spec:
  podSelector: {}    # All pods in production
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
          port: 8080
        - protocol: TCP
          port: 2112
```

### Service Account Based Selectors (Cilium Extension)

Standard NetworkPolicy does not support service account selectors, but Cilium does:

```yaml
# CiliumNetworkPolicy with service account selector
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-service-account
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: database
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.cilium.k8s.policy.serviceaccount: api-service-sa
            io.kubernetes.pod.namespace: production
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
```

## IP Block Rules

Use `ipBlock` to control traffic to/from external IP ranges.

### Restricting Egress to Known IP Ranges

```yaml
# Allow egress only to the internal corporate network + specific SaaS endpoints
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict-external-egress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: payment-service
  policyTypes:
    - Egress
  egress:
    # Allow DNS
    - ports:
        - protocol: UDP
          port: 53
    # Allow internal Kubernetes pod/service CIDR
    - to:
        - ipBlock:
            cidr: 10.0.0.0/8
    # Allow specific external payment processor IP range
    - to:
        - ipBlock:
            cidr: 203.0.113.0/24
      ports:
        - protocol: TCP
          port: 443
    # Allow external notification service but exclude a specific subnet
    - to:
        - ipBlock:
            cidr: 198.51.100.0/24
            except:
              - 198.51.100.128/25  # Exclude this subnet
      ports:
        - protocol: TCP
          port: 443
```

### Restricting Ingress from External IP Ranges

```yaml
# Only allow ingress from the corporate IP range and the load balancer subnet
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict-external-ingress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: admin-portal
  policyTypes:
    - Ingress
  ingress:
    # Corporate office IP range
    - from:
        - ipBlock:
            cidr: 192.0.2.0/24
    # AWS ALB subnet range
    - from:
        - ipBlock:
            cidr: 10.0.100.0/24
      ports:
        - protocol: TCP
          port: 8080
```

## Complete Microservice Policy Example

A real-world three-tier application (frontend, API, database) with full policy isolation:

```yaml
---
# Default deny for the entire namespace
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
  name: allow-dns
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
# Frontend: accept ingress from load balancer, egress to API only
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
        - ipBlock:
            cidr: 10.0.100.0/24  # ALB subnet
      ports:
        - protocol: TCP
          port: 3000
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - protocol: TCP
          port: 3000
  egress:
    - to:
        - podSelector:
            matchLabels:
              tier: api
      ports:
        - protocol: TCP
          port: 8080
---
# API: accept from frontend, egress to database and Redis
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-policy
  namespace: ecommerce
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
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app: prometheus
      ports:
        - protocol: TCP
          port: 2112  # metrics
  egress:
    - to:
        - podSelector:
            matchLabels:
              tier: database
      ports:
        - protocol: TCP
          port: 5432
    - to:
        - podSelector:
            matchLabels:
              app: redis
      ports:
        - protocol: TCP
          port: 6379
---
# Database: only accept from API
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
              tier: api
      ports:
        - protocol: TCP
          port: 5432
    # Allow backup operator
    - from:
        - podSelector:
            matchLabels:
              app: backup-operator
      ports:
        - protocol: TCP
          port: 5432
  egress:
    # Database replication to standby (same namespace)
    - to:
        - podSelector:
            matchLabels:
              tier: database
      ports:
        - protocol: TCP
          port: 5432
```

## Cilium FQDN Policies

The standard Kubernetes NetworkPolicy API only supports IP-based rules, not domain names. For controlling egress to external services where IP addresses change (SaaS APIs, managed databases), Cilium provides `CiliumNetworkPolicy` with FQDN selectors.

FQDN policies work by intercepting DNS responses and building an IP set from the resolved addresses. When a pod makes a DNS query for `api.stripe.com`, Cilium captures the response, records the IPs, and enforces the FQDN policy against those IPs.

### Basic FQDN Egress Policy

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-external-apis
  namespace: payment
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  egress:
    # Allow DNS resolution for FQDN policies to work
    - toEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"

    # Allow egress to Stripe API
    - toFQDNs:
        - matchName: "api.stripe.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow wildcard for SendGrid subdomains
    - toFQDNs:
        - matchPattern: "*.sendgrid.net"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow AWS services (pattern-based)
    - toFQDNs:
        - matchPattern: "*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

### DNS Policy with Visibility

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: dns-visibility-and-fqdn
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: microservice
  egress:
    # DNS with request logging for visibility
    - toEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            # Log all DNS queries — critical for FQDN policy debugging
            dns:
              - matchPattern: "*"

    # Allow Kubernetes internal services
    - toEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: production

    # Allow specific external FQDNs with L7 HTTP rules
    - toFQDNs:
        - matchName: "api.github.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "^/repos/my-org/.*"
```

### Calico FQDN GlobalNetworkPolicy (Alternative)

```yaml
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: allow-external-apis
spec:
  selector: app == 'payment-service'
  types:
    - Egress
  egress:
    # Allow DNS
    - action: Allow
      protocol: UDP
      destination:
        ports: [53]

    # Allow egress to specific domains
    - action: Allow
      protocol: TCP
      destination:
        domains:
          - "api.stripe.com"
          - "*.stripe.com"
        ports: [443]

    # Allow S3
    - action: Allow
      protocol: TCP
      destination:
        domains:
          - "*.s3.amazonaws.com"
          - "s3.amazonaws.com"
        ports: [443]
```

## Policy Visualization Tools

Debugging NetworkPolicy requires understanding what traffic is allowed or denied. Several tools help visualize and validate policies.

### Cilium Policy Viewer

```bash
# View effective policies for a pod
cilium endpoint list
cilium endpoint get <endpoint-id>

# Check if specific traffic would be allowed
cilium policy get

# Trace a packet between two endpoints
cilium monitor --type policy-verdict

# Real-time policy drop monitoring
cilium monitor --type drop

# Check FQDN DNS proxy state
cilium fqdn cache list
cilium fqdn names
```

### Network Policy Simulator (np-viewer)

```bash
# Install netpol tool for policy analysis
kubectl apply -f https://raw.githubusercontent.com/np-guard/netpol-analyzer/main/deployment.yaml

# Analyze all policies in a namespace
kubectl netpol-analyzer analyze -n production

# Check connectivity between two specific pods
kubectl netpol-analyzer check \
  --src-ns production --src-pod api-service-xxx \
  --dst-ns production --dst-pod database-xxx \
  --port 5432 --protocol TCP
```

### Kube-netpol-analyzer

```bash
# Generate connectivity matrix from policies
npx @np-guard/netpol-analyzer analyze \
  --dirpath ./kubernetes/policies \
  --output dot > policy-graph.dot

dot -Tsvg policy-graph.dot > policy-graph.svg
```

### Quick Policy Verification with kubectl

```bash
# Find all policies selecting a specific pod
NAMESPACE="production"
POD="api-service-7d8f9b-xyz"
LABELS=$(kubectl get pod -n $NAMESPACE $POD -o jsonpath='{.metadata.labels}')
echo "Pod labels: $LABELS"

# List all NetworkPolicies in the namespace
kubectl get networkpolicies -n $NAMESPACE -o yaml | \
  kubectl neat

# Test connectivity from one pod to another
kubectl exec -n production api-service-7d8f9b-xyz -- \
  curl -v --connect-timeout 3 http://database-service:5432

# Check if a pod has any policies applied
kubectl describe pod api-service-7d8f9b-xyz -n production | grep -A 5 "Annotations"

# Use netshoot for network debugging
kubectl run netshoot --image=nicolaka/netshoot -it --rm -- \
  curl -v --connect-timeout 3 http://target-service.namespace.svc.cluster.local:8080
```

## Common NetworkPolicy Patterns

### Allow Same-Namespace Traffic

```yaml
# Allow all pods in the same namespace to communicate
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: staging
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector: {}  # Any pod in this namespace
```

### Allow Health Check from Node

```yaml
# Required for kubelet health probes when default-deny is active
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-node-health-probes
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - ipBlock:
            # Node CIDR — adjust for your cluster
            cidr: 10.0.0.0/16
      ports:
        - protocol: TCP
          port: 8080
        - protocol: TCP
          port: 8443
        - protocol: TCP
          port: 9090
```

### Ingress Controller Allow

```yaml
# Allow the nginx-ingress controller to reach all services
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-controller
  namespace: production
spec:
  podSelector: {}
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

### Namespace Isolation with Selective Cross-Namespace Allow

```yaml
# Apply to all namespaces — deny cross-namespace by default
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-cross-namespace
  namespace: tenant-a
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    # Only allow from the same namespace
    - from:
        - podSelector: {}
---
# Then explicitly allow monitoring to cross the boundary
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring-ingress
  namespace: tenant-a
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              purpose: monitoring
      ports:
        - protocol: TCP
          port: 9090
```

## Automating Policy Lifecycle with Helm

Managing policies as Helm chart resources ensures consistency across namespaces:

```yaml
# templates/networkpolicies.yaml
{{- if .Values.networkPolicy.enabled }}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "myapp.fullname" . }}-default-deny
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "myapp.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "myapp.selectorLabels" . | nindent 6 }}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "myapp.fullname" . }}-allow-ingress
  namespace: {{ .Release.Namespace }}
spec:
  podSelector:
    matchLabels:
      {{- include "myapp.selectorLabels" . | nindent 6 }}
  policyTypes:
    - Ingress
  ingress:
    {{- range .Values.networkPolicy.ingress }}
    - from:
        {{- if .namespaceSelector }}
        - namespaceSelector:
            matchLabels:
              {{- toYaml .namespaceSelector | nindent 14 }}
          {{- if .podSelector }}
          podSelector:
            matchLabels:
              {{- toYaml .podSelector | nindent 14 }}
          {{- end }}
        {{- else if .podSelector }}
        - podSelector:
            matchLabels:
              {{- toYaml .podSelector | nindent 14 }}
        {{- end }}
      ports:
        {{- range .ports }}
        - protocol: {{ .protocol | default "TCP" }}
          port: {{ .port }}
        {{- end }}
    {{- end }}
{{- end }}
```

## Testing NetworkPolicy with Automated Validation

```bash
#!/bin/bash
# netpol-test.sh — validate network connectivity matches policy intent

PASS=0
FAIL=0

check_connectivity() {
  local src_ns=$1
  local src_pod=$2
  local dst=$3
  local port=$4
  local expected=$5  # "allow" or "deny"
  local description=$6

  result=$(kubectl exec -n "$src_ns" "$src_pod" -- \
    curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout 3 \
    "http://${dst}:${port}/healthz" 2>/dev/null)

  if [ "$expected" = "allow" ] && [ "$result" != "000" ]; then
    echo "PASS: $description (got $result)"
    ((PASS++))
  elif [ "$expected" = "deny" ] && [ "$result" = "000" ]; then
    echo "PASS: $description (correctly blocked)"
    ((PASS++))
  else
    echo "FAIL: $description (expected $expected, got $result)"
    ((FAIL++))
  fi
}

# Test: frontend can reach API
check_connectivity "production" "frontend-xxx" "api-service.production" "8080" "allow" \
  "Frontend -> API (should be allowed)"

# Test: frontend cannot reach database directly
check_connectivity "production" "frontend-xxx" "database-service.production" "5432" "deny" \
  "Frontend -> Database (should be denied)"

# Test: API can reach database
check_connectivity "production" "api-service-xxx" "database-service.production" "5432" "allow" \
  "API -> Database (should be allowed)"

# Test: external pod cannot reach database
check_connectivity "default" "test-pod" "database-service.production" "5432" "deny" \
  "External -> Database (should be denied)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $FAIL
```

## NetworkPolicy Audit with OPA Gatekeeper

Enforce NetworkPolicy existence with OPA Gatekeeper:

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireNetworkPolicy
metadata:
  name: require-network-policy
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Namespace"]
    excludedNamespaces:
      - kube-system
      - kube-public
      - cert-manager
---
# ConstraintTemplate
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequirenetworkpolicy
spec:
  crd:
    spec:
      names:
        kind: K8sRequireNetworkPolicy
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequirenetworkpolicy

        violation[{"msg": msg}] {
          input.review.kind.kind == "Namespace"
          ns := input.review.object.metadata.name
          not namespace_has_default_deny[ns]
          msg := sprintf("Namespace %v does not have a default-deny NetworkPolicy", [ns])
        }

        namespace_has_default_deny[ns] {
          some policy
          policy := data.inventory.namespace[ns]["networking.k8s.io/v1"]["NetworkPolicy"][_]
          policy.spec.podSelector == {}
          "Ingress" == policy.spec.policyTypes[_]
          "Egress" == policy.spec.policyTypes[_]
          count(policy.spec.ingress) == 0
          count(policy.spec.egress) == 0
        }
```

## Summary

Kubernetes NetworkPolicy provides the API surface for zero-trust network segmentation within a cluster, but its effectiveness depends entirely on the CNI plugin enforcing it. The fundamental pattern is default-deny-all followed by explicit allow policies for each required communication path. The common pitfalls are selector AND/OR confusion, forgetting DNS egress allow, and not testing policy effectiveness with actual traffic probes. For external egress control, Cilium's FQDN policies extend the standard API to support domain-based rules — essential for controlling access to SaaS APIs and managed cloud services where IP addresses are not stable. Pair your policies with automated validation tests and OPA Gatekeeper constraints to ensure policies remain in place and new namespaces are not deployed in a default-allow state.
