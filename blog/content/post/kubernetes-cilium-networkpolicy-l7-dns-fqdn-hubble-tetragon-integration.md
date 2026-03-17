---
title: "Kubernetes Cilium NetworkPolicy: L7 DNS Policy, FQDN-Based Rules, Hubble Flow Visualization, and Tetragon Integration"
date: 2031-11-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "NetworkPolicy", "eBPF", "Hubble", "Tetragon", "Security", "Service Mesh"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to advanced Cilium NetworkPolicy including L7 HTTP and DNS policy enforcement, FQDN-based egress rules, Hubble network flow visualization for policy debugging, and Tetragon runtime security integration."
more_link: "yes"
url: "/kubernetes-cilium-networkpolicy-l7-dns-fqdn-hubble-tetragon-integration/"
---

Cilium's eBPF-based networking extends Kubernetes NetworkPolicy to Layer 7, enabling HTTP method and path-level access control, DNS-aware FQDN egress policies, and Kafka topic-level isolation — capabilities that standard NetworkPolicy cannot provide. Combined with Hubble's network flow observability and Tetragon's runtime security enforcement, Cilium provides a complete zero-trust networking stack. This guide covers each capability with production-ready configurations.

<!--more-->

# Kubernetes Cilium NetworkPolicy: L7 DNS Policy, FQDN-Based Rules, Hubble Flow Visualization, and Tetragon Integration

## Cilium Architecture Refresher

Cilium uses eBPF programs loaded into the Linux kernel to implement networking, policy enforcement, and observability without iptables. Key components:

- **Cilium Agent** (`cilium-agent`): runs on each node, manages eBPF programs
- **Cilium Operator**: manages cluster-wide state (CiliumNode, CiliumIdentity, IPAM)
- **Hubble**: network observability layer built into Cilium
- **Hubble Relay**: aggregates flow data across nodes for cluster-wide visibility
- **Tetragon**: runtime security enforcement via eBPF (separate but Cilium-native)

## Section 1: Installation

### 1.1 Cilium with Hubble and Tetragon

```bash
# Install Cilium with Hubble and Tetragon enabled
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,port-distribution,icmp,http}" \
  --set tetragon.enabled=true \
  --set tetragon.export.hubble.enabled=true \
  --set l7Proxy=true \
  --set dns.proxy.transparentMode=true \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=192.168.1.100 \
  --set k8sServicePort=6443

# Verify installation
cilium status --wait
cilium connectivity test

# Install Cilium CLI
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --remote-name-all \
  "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz"
tar xzf cilium-linux-amd64.tar.gz
mv cilium /usr/local/bin/
```

## Section 2: Standard and Extended NetworkPolicy

### 2.1 Cilium NetworkPolicy (CiliumNetworkPolicy CRD)

Cilium extends Kubernetes NetworkPolicy with `CiliumNetworkPolicy` (CNP) and `CiliumClusterwideNetworkPolicy` (CCNP):

```yaml
# cilium-np-default-deny.yaml
# Apply cluster-wide default deny as a baseline
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: default-deny-all
spec:
  description: "Default deny all traffic; allow only explicitly permitted flows"
  endpointSelector:
    matchLabels:
      policy-enforcement: enabled

  # Deny all ingress
  ingress:
    - {}   # Empty rule = deny all

  # Deny all egress
  egress:
    - {}   # Empty rule = deny all
```

```yaml
# cilium-np-allow-kube-dns.yaml
# Allow all pods to query kube-dns — required for all workloads
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: allow-kube-dns
spec:
  description: "Allow all pods to query kube-dns"
  endpointSelector: {}   # Applies to all pods

  egress:
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            dns:
              - matchPattern: "*"   # Allow any DNS query
```

### 2.2 Label-Based L4 Policy

```yaml
# cilium-np-payment-service.yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: payment-service-policy
  namespace: payments
spec:
  description: "Payment service network policy"
  endpointSelector:
    matchLabels:
      app: payment-service

  ingress:
    # Allow API gateway to call payment service on port 8080
    - fromEndpoints:
        - matchLabels:
            app: api-gateway
            k8s:io.kubernetes.pod.namespace: production
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP

    # Allow internal health checks from kube-apiserver
    - fromEntities:
        - kube-apiserver
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP

  egress:
    # Allow calling the database service
    - toEndpoints:
        - matchLabels:
            app: postgres
            k8s:io.kubernetes.pod.namespace: payments
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # Allow calling the audit logging service
    - toEndpoints:
        - matchLabels:
            app: audit-log
      toPorts:
        - ports:
            - port: "9200"
              protocol: TCP
```

## Section 3: L7 HTTP Policy

### 3.1 HTTP Method and Path Enforcement

```yaml
# cilium-np-api-l7.yaml
# Enforce specific HTTP methods and paths between services
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: api-service-l7-policy
  namespace: production
spec:
  description: "L7 HTTP policy for API service ingress"
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
              # Allow only specific methods and paths
              - method: "GET"
                path: "^/api/v2/users(/[a-zA-Z0-9_-]+)?$"

              - method: "POST"
                path: "^/api/v2/users$"
                headers:
                  - "Content-Type: application/json"

              - method: "PUT"
                path: "^/api/v2/users/[a-zA-Z0-9_-]+$"

              # Health check endpoint accessible without auth header
              - method: "GET"
                path: "^/health(/live|/ready)?$"

    # Internal services can access all endpoints
    - fromEndpoints:
        - matchLabels:
            role: internal-service
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
```

### 3.2 L7 gRPC Policy

```yaml
# cilium-np-grpc-policy.yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: grpc-service-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: grpc-user-service

  ingress:
    - fromEndpoints:
        - matchLabels:
            app: grpc-client
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          rules:
            http:
              # gRPC is HTTP/2; Cilium can filter by path = /package.Service/Method
              - method: "POST"
                path: "^/api.user.v2.UserService/GetUser$"

              - method: "POST"
                path: "^/api.user.v2.UserService/ListUsers$"

              # Block admin methods from regular clients
              # (AdminService methods not listed here = denied)
```

### 3.3 Kafka Topic-Level Policy

```yaml
# cilium-np-kafka-policy.yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: kafka-topic-policy
  namespace: data
spec:
  endpointSelector:
    matchLabels:
      app: kafka

  ingress:
    # Producer: payment-service can only produce to payments.transactions
    - fromEndpoints:
        - matchLabels:
            app: payment-service
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: "produce"
                topic: "payments.transactions"

              - role: "produce"
                topic: "payments.events"

    # Consumer: fraud-detector can only consume from payments.transactions
    - fromEndpoints:
        - matchLabels:
            app: fraud-detector
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: "consume"
                topic: "payments.transactions"

    # Analytics can consume everything with payments. prefix
    - fromEndpoints:
        - matchLabels:
            app: analytics-service
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              - role: "consume"
                topic: "payments.*"
```

## Section 4: DNS Policy and FQDN-Based Egress

### 4.1 How FQDN Policy Works

Standard Kubernetes NetworkPolicy cannot filter by DNS name because IP addresses are not known at policy creation time and change dynamically. Cilium's DNS proxy intercepts DNS responses and programs eBPF maps with the resolved IPs, enabling `toFQDNs` rules that track DNS TTL and update automatically.

```yaml
# cilium-np-fqdn-egress.yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: external-api-egress
  namespace: production
spec:
  description: "Allow egress only to approved external APIs"
  endpointSelector:
    matchLabels:
      app: data-enrichment-service

  egress:
    # Allow HTTPS to specific external APIs by hostname
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.twilio.com"
        - matchName: "hooks.slack.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Wildcard domain match for a vendor's CDN
    - toFQDNs:
        - matchPattern: "*.cloudflare.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow S3 buckets
    - toFQDNs:
        - matchPattern: "*.s3.amazonaws.com"
        - matchPattern: "*.s3.us-east-1.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Block everything else at the DNS level
    # (default deny handles this, but explicit DNS policy adds audit trail)
```

### 4.2 DNS Policy for Internal Services

```yaml
# cilium-np-internal-dns.yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: internal-service-dns-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend-service

  egress:
    # Allow access to internal services by Kubernetes DNS name
    - toFQDNs:
        - matchName: "postgres-primary.payments.svc.cluster.local"
        - matchName: "redis.cache.svc.cluster.local"
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
            - port: "6379"
              protocol: TCP

    # Allow DNS resolution (required for FQDN policy to work)
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            dns:
              - matchPattern: "*.cluster.local"
              - matchPattern: "*.svc.cluster.local"
              # Block non-cluster DNS lookups from this service
              # (services that don't need internet access)
```

### 4.3 DNS Visibility and Debugging

```bash
# Check DNS proxy status
cilium status | grep -i dns

# View DNS requests being proxied
hubble observe --namespace production \
  --protocol dns \
  --follow

# Check cached FQDN -> IP mappings
cilium fqdn cache list

# Verify DNS policy is applied
cilium policy get | grep -A10 "toFQDNs"

# Test DNS resolution through the proxy
kubectl exec -n production deploy/backend-service -- \
  nslookup api.stripe.com

# Check if a DNS name is allowed
cilium policy selectors
```

## Section 5: Hubble Flow Visualization

### 5.1 Hubble CLI Usage

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -LO "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz"
tar xzf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Configure Hubble CLI
hubble config set server localhost:4245

# Stream flows in real time
hubble observe --follow

# Filter flows by namespace
hubble observe --namespace payments --follow

# Filter dropped flows only (policy violations)
hubble observe --verdict DROPPED --follow

# Filter L7 HTTP flows
hubble observe --protocol http --follow | head -50

# Filter flows for a specific pod
hubble observe --pod production/payment-service-abc123 --follow

# Count flows between two services
hubble observe \
  --from-pod production/frontend \
  --to-pod production/api-service \
  --last 1000 | wc -l
```

### 5.2 Policy Debugging Workflow

```bash
# Step 1: Deploy an application and observe flows before applying policy
hubble observe --namespace production --follow > /tmp/flows-before-policy.log &
OBSERVE_PID=$!

# Generate some traffic
kubectl exec -n production deploy/frontend -- \
  curl -s http://api-service:8080/api/v2/users > /dev/null

sleep 5
kill "$OBSERVE_PID"

# Step 2: Apply the policy
kubectl apply -f cilium-np-api-l7.yaml

# Step 3: Observe flows after policy — look for DROPPED flows
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --last 100 \
  --output json | jq '
  .flow |
  {
    source: .source.pod_name,
    destination: .destination.pod_name,
    l7: .l7,
    reason: .drop_reason_desc
  }'

# Step 4: Use Hubble UI for visual flow graph
kubectl port-forward -n kube-system svc/hubble-ui 12000:80
# Open http://localhost:12000
```

### 5.3 Flow Recording for Audit

```bash
# Record flows to a file for compliance audit
hubble observe \
  --namespace production \
  --output json \
  --last 10000 \
  > /var/log/network-flows/flows-$(date +%Y%m%d).jsonl

# Parse flow log for dropped connections
jq -r '
  select(.flow.verdict == "DROPPED") |
  [
    .flow.time,
    .flow.source.pod_name // "external",
    .flow.destination.pod_name // (.flow.destination.service.name // "external"),
    .flow.drop_reason_desc,
    (.flow.l7.http.url // "")
  ] | @tsv
' /var/log/network-flows/flows-$(date +%Y%m%d).jsonl
```

### 5.4 Hubble Metrics for Prometheus

```yaml
# hubble-metrics-service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: hubble-metrics
  namespace: monitoring
  labels:
    prometheus: production
spec:
  selector:
    matchLabels:
      k8s-app: hubble
  namespaceSelector:
    matchNames:
      - kube-system
  endpoints:
    - port: hubble-metrics
      path: /metrics
      interval: 30s
```

```yaml
# prometheusrule-hubble-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hubble-policy-alerts
  namespace: monitoring
spec:
  groups:
    - name: cilium.policy
      rules:
        - alert: HighPolicyDropRate
          expr: |
            rate(hubble_drop_total[5m]) > 100
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High policy drop rate detected"
            description: "{{ $value | humanize }} drops/s in the last 5 minutes for reason={{ $labels.reason }}"

        - alert: PolicyDropsFromExternalSource
          expr: |
            rate(hubble_drop_total{
              source_label!~"k8s-app=.*|app=.*"
            }[5m]) > 10
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "External source generating policy drops"
            description: "Potential port scan or unauthorized access attempt detected."
```

## Section 6: Tetragon Runtime Security

### 6.1 Tetragon Architecture

Tetragon enforces security policies at the kernel level using eBPF programs attached to kernel functions via kprobes. Unlike admission controllers, Tetragon enforcement happens in the kernel and cannot be bypassed by a compromised container runtime.

### 6.2 TracingPolicy for File System Monitoring

```yaml
# tetragon-policy-file-access.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: monitor-sensitive-file-access
spec:
  kprobes:
    - call: "security_file_open"
      syscall: false
      return: false
      args:
        - index: 0
          type: "file"
      selectors:
        # Monitor access to sensitive files
        - matchArgs:
            - index: 0
              operator: "Prefix"
              values:
                - "/etc/shadow"
                - "/etc/passwd"
                - "/etc/ssl/private"
                - "/var/run/secrets/kubernetes.io"
          matchActions:
            - action: Sigkill    # Kill process accessing secrets
              argError: 0
        - matchBinaries:
            - operator: "NotIn"
              values:
                - "/usr/bin/cat"     # Allowed binaries for these files
                - "/usr/bin/grep"
          matchArgs:
            - index: 0
              operator: "Prefix"
              values:
                - "/etc/shadow"
          matchActions:
            - action: Sigkill
```

### 6.3 TracingPolicy for Network Enforcement

```yaml
# tetragon-policy-network.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: restrict-outbound-connections
spec:
  kprobes:
    - call: "tcp_connect"
      syscall: false
      return: false
      args:
        - index: 0
          type: "sock"
      selectors:
        # Block connections to known bad IP ranges
        - matchArgs:
            - index: 0
              operator: "NotIn"
              values:
                - "10.0.0.0/8"      # Internal
                - "172.16.0.0/12"   # Internal
                - "192.168.0.0/16"  # Internal
          matchBinaries:
            - operator: "NotIn"
              values:
                - "/usr/bin/curl"   # curl is allowed to connect externally
                - "/usr/bin/wget"
          matchActions:
            - action: Sigkill
```

### 6.4 TracingPolicy for Privilege Escalation Detection

```yaml
# tetragon-policy-privilege-escalation.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: detect-privilege-escalation
spec:
  kprobes:
    # Detect setuid/setgid/setcap calls from non-privileged processes
    - call: "sys_setuid"
      syscall: true
      args:
        - index: 0
          type: "int"
      selectors:
        - matchCapabilities:
            - type: Effective
              operator: "NotIn"
              isNamespaceCapability: false
              values:
                - "CAP_SETUID"
          matchActions:
            - action: Sigkill

    # Detect capabilities being acquired
    - call: "cap_capable"
      syscall: false
      return: true
      args:
        - index: 2
          type: "capability"
      selectors:
        - matchReturnArgs:
            - index: 0
              operator: "Equal"
              values:
                - "0"   # Success = capability acquired
          matchCapabilities:
            - type: Permitted
              operator: "NotIn"
              values:
                - "CAP_NET_ADMIN"
                - "CAP_SYS_ADMIN"
          matchActions:
            - action: Post   # Log but don't kill
```

### 6.5 Viewing Tetragon Events

```bash
# Stream Tetragon events in real time
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
  tetra getevents -o compact --follow

# Filter by event type
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
  tetra getevents \
    --event-types PROCESS_EXEC,PROCESS_KPROBE \
    -o json \
    --follow | jq '.'

# Filter by namespace
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
  tetra getevents \
    --namespace production \
    -o compact \
    --follow

# Export events to Hubble
kubectl logs -n kube-system ds/tetragon -c tetragon | \
  grep '"type":"PROCESS_KPROBE"' | head -10
```

## Section 7: Network Policy Best Practices

### 7.1 Policy Validation Workflow

```bash
#!/usr/bin/env bash
# validate-cilium-policy.sh
# Validates Cilium policies before applying

set -euo pipefail

POLICY_DIR="${1:-./policies}"
NAMESPACE="${2:-production}"

# Validate policy syntax
find "$POLICY_DIR" -name "*.yaml" | while read -r file; do
    echo -n "Validating $file ... "
    kubectl apply --dry-run=client -f "$file" -n "$NAMESPACE" && echo "OK" || echo "FAILED"
done

# Check for overly permissive policies
echo ""
echo "Checking for overly permissive policies..."
grep -l "endpointSelector: {}" "$POLICY_DIR"/*.yaml | while read -r file; do
    echo "WARNING: $file uses empty endpointSelector (applies to all pods)"
done

# Simulate policy with test endpoints
echo ""
echo "Running policy simulation..."
kubectl exec -n kube-system ds/cilium -- \
    cilium policy verify \
    --src-identity 12345 \
    --dst-identity 67890 \
    --dport 8080 \
    --protocol TCP 2>/dev/null || \
    echo "Policy verify not available; check cilium version"
```

### 7.2 CiliumNetworkPolicy Testing

```yaml
# cilium-np-test.yaml
# Test that the policy allows expected traffic and blocks unexpected traffic
apiVersion: cilium.io/v1alpha1
kind: CiliumNetworkPolicyTest
metadata:
  name: payment-service-policy-test
  namespace: payments
spec:
  policy:
    name: payment-service-policy
    namespace: payments

  scenarios:
    - description: "API gateway can call payment service"
      when:
        from:
          labels:
            app: api-gateway
            io.kubernetes.pod.namespace: production
        to:
          labels:
            app: payment-service
          port: 8080
          protocol: TCP
      expect: allow

    - description: "Random pod cannot call payment service"
      when:
        from:
          labels:
            app: random-pod
        to:
          labels:
            app: payment-service
          port: 8080
          protocol: TCP
      expect: deny
```

## Section 8: Complete Production Setup

### 8.1 Namespace Baseline Policy

```yaml
# cilium-np-namespace-baseline.yaml
# Apply this to every namespace as a baseline
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: namespace-baseline
spec:
  description: "Baseline policy: allow intra-namespace, deny cross-namespace ingress"
  endpointSelector: {}  # All pods in this namespace

  ingress:
    # Allow from same namespace
    - fromEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: payments  # Set to actual namespace

    # Allow from monitoring namespace (Prometheus scraping)
    - fromEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: monitoring
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP

  egress:
    # Allow to same namespace
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: payments

    # Allow DNS to kube-system
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: ANY
          rules:
            dns:
              - matchPattern: "*"
```

## Summary

Cilium provides a comprehensive network security stack that surpasses standard Kubernetes NetworkPolicy in every dimension:

1. **L7 HTTP policy** enables per-method and per-path access control between services. Use this for APIs with mixed sensitivity endpoints (read-only vs. write paths) that need to be accessible from different consumers.

2. **Kafka topic policy** provides message-level isolation without needing a separate API gateway in front of the broker. Producers and consumers are limited to specific topics.

3. **FQDN-based egress** is the practical way to implement egress firewalling for cloud-native workloads that call external services by hostname. Always combine with DNS policy to prevent DNS rebinding attacks.

4. **Hubble flow visualization** transforms network policy debugging from guesswork (checking iptables rules, adding `tcpdump` sidecars) into observable, queryable network flow streams.

5. **Tetragon runtime security** enforces policies at the kernel level, making it resistant to container escape attacks. TracingPolicy objects for sensitive file access, privilege escalation, and unexpected outbound connections should be part of the default policy set for any production namespace.

6. **Policy-as-code**: Store all CiliumNetworkPolicy, CiliumClusterwideNetworkPolicy, and TracingPolicy objects in Git with automated validation in CI. A policy regression that opens an unexpected egress path should fail the pipeline before reaching the cluster.
