---
title: "Cilium Network Policies: Advanced L7 Policies and DNS-Based Rules"
date: 2027-10-15T00:00:00-05:00
draft: false
tags: ["Cilium", "Network Policy", "Security", "Kubernetes", "eBPF"]
categories:
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Cilium network policy guide covering CiliumNetworkPolicy and CiliumClusterwideNetworkPolicy, L7 HTTP/gRPC/Kafka enforcement, DNS-based egress with FQDN, host policies, policy audit mode, Hubble visibility, and migration from Kubernetes NetworkPolicy."
more_link: "yes"
url: "/cilium-network-policy-advanced-guide/"
---

Cilium extends Kubernetes network policy beyond basic L3/L4 IP and port filtering to enforce policies at L7 — inspecting HTTP methods and paths, gRPC service names, and Kafka topics. Using eBPF for enforcement at the kernel level, Cilium achieves this without the performance overhead of a sidecar proxy. This guide covers the full spectrum of Cilium network policy capabilities from basic endpoint isolation through advanced L7 enforcement, DNS-based egress control, and production migration strategies.

<!--more-->

# Cilium Network Policies: Advanced L7 Policies and DNS-Based Rules

## Section 1: Cilium Installation and Configuration

### Installation with Helm

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.16.3 \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=auto \
  --set k8sServicePort=443 \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,port-distribution,icmp,httpV2:exemplars=true;labelsContext=source_ip\,source_namespace\,source_workload\,destination_ip\,destination_namespace\,destination_workload\,traffic_direction}" \
  --set prometheus.enabled=true \
  --set operator.prometheus.enabled=true \
  --set envoy.enabled=true \
  --set policyAuditMode=false
```

Verify installation:

```bash
cilium status --wait
cilium connectivity test
```

### CiliumNetworkPolicy vs CiliumClusterwideNetworkPolicy

| Resource | Scope | Use Case |
|----------|-------|----------|
| `CiliumNetworkPolicy` | Namespace-scoped | Application-level policies |
| `CiliumClusterwideNetworkPolicy` | Cluster-scoped | Cluster-wide baseline policies |
| `NetworkPolicy` | Namespace-scoped | Standard Kubernetes compatibility |

Cilium enforces all three simultaneously. A policy that allows traffic takes precedence only within its own scope — a denied connection must be explicitly allowed by all applicable policies.

## Section 2: Basic CiliumNetworkPolicy Structure

### Endpoint Selector Syntax

```yaml
# Allow traffic between pods with matching labels
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: allow-frontend-to-backend
  namespace: production
spec:
  # Applies to pods matching this selector
  endpointSelector:
    matchLabels:
      app: backend
      tier: api

  # Ingress rules: what traffic is allowed IN
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend
            tier: web
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP

  # Egress rules: what traffic is allowed OUT
  egress:
    - toEndpoints:
        - matchLabels:
            app: postgres
            tier: database
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
```

### Namespace Selectors

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: cross-namespace-allow
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  ingress:
    # Allow from any pod in the monitoring namespace
    - fromEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": monitoring
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP

    # Allow from pods in namespaces with specific labels
    - fromEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": ""
          matchExpressions:
            - key: "k8s:io.cilium.k8s.namespace.labels.team"
              operator: In
              values: ["platform", "security"]
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
```

## Section 3: L7 HTTP Policy Enforcement

Cilium's L7 HTTP policies allow and deny traffic based on HTTP method, path, headers, and host.

### HTTP Method and Path Filtering

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: api-http-policy
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
              # Allow GET requests to any /api/v1/ path
              - method: GET
                path: "/api/v1/.*"

              # Allow POST to specific endpoints only
              - method: POST
                path: "/api/v1/orders"

              - method: POST
                path: "/api/v1/users"

              # Allow health check from any source
              - method: GET
                path: "/health"

              # Allow metrics endpoint from monitoring namespace only
              # (combined with separate fromEndpoints rule)
              - method: GET
                path: "/metrics"

    # Monitoring access to metrics — separate rule for different source
    - fromEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": monitoring
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: "/metrics"
```

### Header-Based Policy

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: header-based-access
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: internal-api
  ingress:
    - fromEndpoints:
        - matchLabels:
            role: service-account
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Require specific API version header
              - method: GET
                path: "/v2/.*"
                headers:
                  - "X-API-Version: v2"
              # Block requests without the header (implicit deny)
```

### Blocking Specific Paths

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: block-admin-paths
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: web-server
  ingress:
    - fromEndpoints:
        - {}  # All endpoints
      toPorts:
        - ports:
            - port: "80"
              protocol: TCP
          rules:
            http:
              # Block admin paths from non-admin sources
              # (allow only non-admin paths)
              - method: GET
                path: "/(?!admin).*"
              - method: POST
                path: "/(?!admin).*"
```

## Section 4: gRPC Policy Enforcement

Cilium can enforce gRPC policies at the service method level.

### gRPC Service Method Control

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: grpc-service-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: order-service
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: checkout-service
      toPorts:
        - ports:
            - port: "9000"
              protocol: TCP
          rules:
            # gRPC rules are defined as L7 protocol
            l7proto: grpc
            l7:
              # Allow only specific service methods
              - rule: "path: /order.OrderService/CreateOrder"
              - rule: "path: /order.OrderService/GetOrder"
              - rule: "path: /order.OrderService/ListOrders"
              # Deny CancelOrder from checkout-service (requires different source)

    - fromEndpoints:
        - matchLabels:
            app: admin-service
      toPorts:
        - ports:
            - port: "9000"
              protocol: TCP
          rules:
            l7proto: grpc
            l7:
              # Admin service can also cancel orders
              - rule: "path: /order.OrderService/CancelOrder"
              - rule: "path: /order.OrderService/CreateOrder"
              - rule: "path: /order.OrderService/GetOrder"
```

## Section 5: Kafka Topic-Level Policies

Cilium enforces Kafka policies at the topic and operation level, preventing unauthorized topic access without needing Kafka ACLs.

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: kafka-topic-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: kafka
  ingress:
    # Order service can produce to orders topic
    - fromEndpoints:
        - matchLabels:
            app: order-service
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: produce
                topic: orders
              - role: produce
                topic: order-events

    # Notification service can consume from orders topic
    - fromEndpoints:
        - matchLabels:
            app: notification-service
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: consume
                topic: orders
              - role: consume
                topic: order-events

    # Analytics service can consume from any topic but not produce
    - fromEndpoints:
        - matchLabels:
            app: analytics-service
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: consume
                topic: ".*"  # Regex: all topics

    # Kafka admin tools
    - fromEndpoints:
        - matchLabels:
            role: kafka-admin
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
```

## Section 6: DNS-Based Egress Policies with FQDN

FQDN-based egress policies allow pods to reach external services by hostname, without hardcoding IP addresses that change over time.

### Basic FQDN Egress Policy

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: api-server-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  egress:
    # Allow DNS resolution
    - toEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP

    # Allow access to AWS APIs by FQDN
    - toFQDNs:
        - matchPattern: "*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow access to specific external services
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "hooks.stripe.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow access to internal services in other namespaces
    - toEndpoints:
        - matchLabels:
            app: postgres
            "k8s:io.kubernetes.pod.namespace": databases
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # Allow access to Kubernetes API server
    - toEntities:
        - kube-apiserver
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

### FQDN Policy with Regex Matching

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: controlled-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: data-processor
  egress:
    # DNS resolution must be allowed first
    - toEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP

    # Allow AWS S3 in specific regions
    - toFQDNs:
        - matchPattern: "s3.us-east-1.amazonaws.com"
        - matchPattern: "*.s3.us-east-1.amazonaws.com"
        - matchPattern: "s3.us-west-2.amazonaws.com"
        - matchPattern: "*.s3.us-west-2.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow company's CDN using regex
    - toFQDNs:
        - matchPattern: "cdn[0-9]+.support.tools"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Deny all other egress (implicit with a policy present)
```

### DNS Proxy Configuration

Cilium intercepts DNS responses to learn IP addresses associated with FQDNs and programs eBPF rules dynamically:

```bash
# Verify DNS proxy is active
cilium endpoint list | grep -E "ID|POLICY"

# Check FQDN cache
kubectl -n kube-system exec -it ds/cilium -- cilium fqdn cache list

# Inspect DNS policy maps
kubectl -n kube-system exec -it ds/cilium -- cilium map list
```

## Section 7: toServices for Cluster Services

`toServices` selects Kubernetes Services rather than individual pods, ensuring the policy remains valid as pod IPs change.

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: service-based-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  egress:
    # Reference a Kubernetes Service by selector
    - toServices:
        - k8sService:
            serviceName: postgres-primary
            namespace: databases
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # Reference a service in any namespace matching labels
    - toServices:
        - k8sServiceSelector:
            selector:
              matchLabels:
                role: metrics-endpoint
            namespace: ""  # Empty = any namespace
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
```

## Section 8: Host Policies for Node-Level Control

`CiliumClusterwideNetworkPolicy` with host selectors controls traffic at the node level.

### Restricting Node Access

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: host-firewall-policy
spec:
  # nodeSelector targets the host network namespace
  nodeSelector:
    matchLabels:
      node-role.kubernetes.io/worker: ""
  ingress:
    # Allow SSH from specific management CIDR
    - fromCIDR:
        - 10.0.0.0/24
      toPorts:
        - ports:
            - port: "22"
              protocol: TCP

    # Allow Kubernetes API communication
    - fromEntities:
        - kube-apiserver
      toPorts:
        - ports:
            - port: "10250"
              protocol: TCP
            - port: "10255"
              protocol: TCP

    # Allow inter-node VXLAN/Geneve for pod networking
    - fromEntities:
        - cluster
      toPorts:
        - ports:
            - port: "8472"
              protocol: UDP
            - port: "4240"
              protocol: TCP

    # Allow health checks from Cilium agents
    - fromEntities:
        - health
  egress:
    # Allow all cluster-internal traffic
    - toEntities:
        - cluster

    # Allow DNS
    - toEntities:
        - cluster
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP

    # Allow access to AWS metadata service
    - toCIDR:
        - 169.254.169.254/32
      toPorts:
        - ports:
            - port: "80"
              protocol: TCP

    # Allow HTTPS to AWS APIs
    - toFQDNs:
        - matchPattern: "*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

## Section 9: Policy Audit Mode vs Enforcement Mode

Audit mode logs policy violations without enforcing them, enabling safe migration from no-policy to strict-policy environments.

### Enabling Audit Mode for a Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # Audit mode: log violations, do not block
    policy-audit.cilium.io: enabled
```

Or per-endpoint:

```bash
# Enable audit mode for specific pods
kubectl -n production annotate pod api-server-6d9b47b9c-xk2jv \
  policy.cilium.io/proxy-visibility=<Egress/53/UDP/DNS>,<Egress/443/TCP/HTTP>
```

### Analyzing Policy Violations with Hubble

```bash
# Install Hubble CLI
export HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --fail --remote-name-all \
  "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzvf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/

# Port-forward Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe all flows (drop + allowed)
hubble observe --all-namespaces --follow

# Observe only dropped flows
hubble observe --all-namespaces --verdict DROPPED --follow

# Observe flows for a specific pod
hubble observe \
  --pod production/api-server-6d9b47b9c-xk2jv \
  --follow

# Generate a policy from observed flows
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --output json | \
  cilium policy export --namespace production
```

### Transition from Audit to Enforcement

```bash
# Step 1: Enable policy logging for namespace
kubectl -n production annotate namespace production \
  policy.cilium.io/enforcement=audit

# Step 2: Review Hubble flows for 48+ hours
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --from=2h \
  | jq '{source: .source.namespace + "/" + .source.pod_name,
         destination: .destination.namespace + "/" + .destination.pod_name,
         port: .l4.TCP.destination_port}' \
  | sort -u

# Step 3: Create policies that allow all observed legitimate traffic

# Step 4: Switch to enforcement mode
kubectl -n production annotate namespace production \
  policy.cilium.io/enforcement=default \
  --overwrite

# Step 5: Monitor for drops
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --follow
```

## Section 10: Hubble for Network Flow Visibility

Hubble provides deep visibility into Cilium network flows, enabling real-time observability and retrospective analysis.

### Hubble Service Map

```bash
# Access Hubble UI
kubectl port-forward -n kube-system svc/hubble-ui 12000:80

# Or use the Hubble CLI for terminal-based analysis
# Show connections between specific services
hubble observe \
  --namespace production \
  --to-label app=postgres \
  --follow \
  --output json | jq '{
    time: .time,
    source: .source.namespace + "/" + .source.pod_name,
    traffic_direction: .traffic_direction,
    verdict: .verdict,
    summary: .summary
  }'
```

### Hubble Metrics for Prometheus

Hubble exposes flow metrics that can drive alerting:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cilium-network-policy-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: cilium-policy
      rules:
        - alert: CiliumHighDropRate
          expr: |
            sum(rate(hubble_drop_total[5m])) by (namespace, reason) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High Cilium drop rate in {{ $labels.namespace }}"
            description: "Reason: {{ $labels.reason }}, rate: {{ $value }}/s"

        - alert: CiliumPolicyDropsProduction
          expr: |
            sum(rate(hubble_drop_total{namespace="production", reason="POLICY_DENIED"}[5m])) > 5
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Policy denying traffic in production namespace"
            description: "{{ $value }} drops/s due to policy denial in production"

        - alert: CiliumAgentUnhealthy
          expr: up{job="cilium-agent"} == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Cilium agent is down on {{ $labels.instance }}"
```

## Section 11: Migrating from Kubernetes NetworkPolicy to Cilium

Cilium fully implements the Kubernetes NetworkPolicy API, so existing NetworkPolicy resources continue to function without modification. Migration focuses on replacing and enhancing policies.

### Migration Assessment

```bash
# Export all existing NetworkPolicies
kubectl get networkpolicies --all-namespaces -o yaml > existing-network-policies.yaml

# Check which policies have no Cilium equivalent
kubectl get ciliumnetworkpolicies --all-namespaces

# Validate Cilium is enforcing the standard NetworkPolicies
cilium policy get --all-namespaces | grep -A5 "kubernetes.io/NetworkPolicy"
```

### Converting NetworkPolicy to CiliumNetworkPolicy

Kubernetes NetworkPolicy:

```yaml
# Original Kubernetes NetworkPolicy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: backend
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 8080
```

Equivalent CiliumNetworkPolicy with L7 enhancement:

```yaml
# Enhanced CiliumNetworkPolicy replacing the NetworkPolicy above
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: allow-frontend-enhanced
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
              # Add L7 enforcement: only allow specific API paths
              - method: GET
                path: "/api/.*"
              - method: POST
                path: "/api/.*"
              # Deny other methods (DELETE, PATCH) from frontend
```

### Incremental Policy Migration

```bash
#!/bin/bash
# migrate-network-policies.sh

NAMESPACE=$1

echo "=== Migrating NetworkPolicies in namespace: ${NAMESPACE} ==="

# Get all NetworkPolicies
NP_LIST=$(kubectl -n "${NAMESPACE}" get networkpolicies -o name)

for NP in ${NP_LIST}; do
  NP_NAME=$(echo "${NP}" | cut -d/ -f2)
  echo ""
  echo "Processing: ${NP_NAME}"

  # Export the NetworkPolicy
  kubectl -n "${NAMESPACE}" get networkpolicy "${NP_NAME}" -o yaml

  # Check if a CiliumNetworkPolicy already exists with the same name
  if kubectl -n "${NAMESPACE}" get ciliumnetworkpolicy "${NP_NAME}" &>/dev/null; then
    echo "  CiliumNetworkPolicy already exists for ${NP_NAME}"
    echo "  Safe to delete NetworkPolicy: kubectl -n ${NAMESPACE} delete networkpolicy ${NP_NAME}"
  else
    echo "  No CiliumNetworkPolicy found. Create one before deleting the NetworkPolicy."
  fi
done
```

## Section 12: Zero-Trust Network Architecture with Cilium

### Default Deny Baseline Policy

```yaml
# CiliumClusterwideNetworkPolicy: default deny for all namespaces
# except explicitly exempt system namespaces
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: default-deny-all
spec:
  endpointSelector:
    matchExpressions:
      # Apply to all endpoints NOT in system namespaces
      - key: "k8s:io.kubernetes.pod.namespace"
        operator: NotIn
        values:
          - kube-system
          - cilium-system
          - monitoring
          - cert-manager
  ingress:
    # Allow nothing by default (endpoints must explicitly allow ingress)
    - fromEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": kube-system
            k8s-app: kube-dns
  egress:
    # Allow DNS resolution to kube-dns
    - toEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": kube-system
            k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP
    # Allow access to Kubernetes API server
    - toEntities:
        - kube-apiserver
```

With this baseline, each application namespace must explicitly allow all required traffic. This models a zero-trust network where no traffic is permitted by default and all allowed paths are explicitly declared.

### Validating the Policy Model

```bash
# Test policy enforcement: try to connect to a service without a policy
kubectl -n production run policy-test \
  --image=curlimages/curl:latest \
  --restart=Never \
  --rm \
  -it \
  -- curl -s --connect-timeout 5 http://postgres.databases.svc.cluster.local:5432
# Expected: connection timeout (policy denied)

# Test allowed path works
kubectl -n production run allowed-test \
  --image=curlimages/curl:latest \
  --restart=Never \
  --rm \
  -it \
  -- curl -s http://api-server.production.svc.cluster.local:8080/health
# Expected: {"status":"ok"}

# Generate policy enforcement summary
kubectl -n kube-system exec ds/cilium -- \
  cilium policy get --all-namespaces | grep -c "selector"
echo " policies active"
```

The combination of L7 HTTP/gRPC/Kafka enforcement, FQDN-based egress control, and Hubble visibility makes Cilium the most capable network security layer available in the Kubernetes ecosystem. Teams migrating from vanilla NetworkPolicy to CiliumNetworkPolicy can incrementally adopt L7 policies while maintaining full compatibility with existing configurations throughout the migration.
