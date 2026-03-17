---
title: "Kubernetes Network Policies with Cilium: L7 Policies, FQDN Policies, and ToServices"
date: 2030-03-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "Network Policy", "eBPF", "Security", "L7", "FQDN"]
categories: ["Kubernetes", "Networking", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Cilium network policy extensions, HTTP-level policies with method and path matching, DNS-based egress policies, and service-to-service policies with cryptographic identity."
more_link: "yes"
url: "/kubernetes-network-policies-cilium-l7-fqdn-toservices/"
---

Cilium extends Kubernetes network policies far beyond the standard namespace/pod selector model by operating at Layer 7 (application protocol) using eBPF programs rather than iptables rules. This allows security policies that understand HTTP methods and paths, gRPC services, Kafka topics, and DNS names — not just IP addresses and ports. Combined with Cilium's cryptographic identity model (where each workload gets a unique identity derived from its labels), policy enforcement is resilient to IP address reuse and container restarts. This guide covers the complete Cilium policy API for enterprise security teams.

<!--more-->

## Cilium Policy Architecture

Standard Kubernetes NetworkPolicy operates at L3/L4: it allows or denies connections based on pod selectors, namespace selectors, and IP blocks at the TCP/UDP level. Cilium's CiliumNetworkPolicy extends this with:

- **L7 inspection**: HTTP method/path/header matching, gRPC method matching, Kafka topic matching
- **FQDN policies**: Egress rules based on DNS names rather than IP addresses
- **ToServices**: Policies that match against Kubernetes Service objects
- **Identity-based security**: Workload identities derived from labels, cryptographically verified

### Cilium Identity Model

```bash
# View the identity assigned to pods
kubectl exec -n kube-system ds/cilium -- cilium identity list | head -20

# Get the identity of a specific pod
kubectl exec -n kube-system ds/cilium -- \
    cilium endpoint list | grep my-pod-name

# Inspect a specific endpoint's identity labels
kubectl exec -n kube-system ds/cilium -- \
    cilium endpoint get <endpoint-id>

# View the policy that applies to an endpoint
kubectl exec -n kube-system ds/cilium -- \
    cilium policy get | head -50

# Watch policy enforcement in real time
kubectl exec -n kube-system ds/cilium -- \
    cilium monitor --type drop

# View L7 policy decisions (HTTP)
kubectl exec -n kube-system ds/cilium -- \
    cilium monitor --type l7 | head -30
```

## L7 HTTP Policies

L7 HTTP policies inspect HTTP requests and responses, allowing or denying based on method, path, headers, and status codes.

### Basic HTTP Policy

```yaml
# Allow only GET requests to /api/v1/users from the frontend service
# Deny all other HTTP methods and paths
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-http-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
      tier: backend

  ingress:
    # Allow from frontend pods, but only specific HTTP operations
    - fromEndpoints:
        - matchLabels:
            app: frontend
            tier: web
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Read operations on users collection
              - method: GET
                path: /api/v1/users
              - method: GET
                path: ^/api/v1/users/[0-9]+$  # Regex: GET /api/v1/users/123
              # Create a new user
              - method: POST
                path: /api/v1/users
                headers:
                  - Content-Type: application/json
              # Update specific user
              - method: PUT
                path: ^/api/v1/users/[0-9]+$
              # Health check accessible without auth header
              - method: GET
                path: /health

    # Allow from admin service with full access
    - fromEndpoints:
        - matchLabels:
            app: admin-service
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Admin has DELETE access too
              - method: DELETE
                path: ^/api/v1/users/[0-9]+$
              # Admin sees all endpoints
              - method: ".*"
                path: /api/v1/admin/.*

  egress:
    # Allow egress to the database (L4 only for DB connections)
    - toEndpoints:
        - matchLabels:
            app: postgres
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
```

### Advanced HTTP Policies with Headers

```yaml
# Enforce authentication and tenant isolation via headers
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-auth-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server

  ingress:
    - fromEndpoints:
        - matchLabels:
            requires-auth: "true"
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Require Authorization header to be present
              # (value validation done by the application)
              - method: ".*"
                path: /api/.*
                headers:
                  - "Authorization: Bearer .*"
              # Internal health checks don't need auth
              - method: GET
                path: /internal/health

    # Monitoring - only allow specific endpoints
    - fromEndpoints:
        - matchLabels:
            app: prometheus
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: /metrics
```

### gRPC-Level Policies

```yaml
# Allow only specific gRPC methods
apiVersion: cilium.io/v2
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
            app: order-service
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          rules:
            # gRPC uses HTTP/2 under the hood
            # Cilium matches on gRPC service and method paths
            http:
              # Allow specific gRPC methods
              - method: POST
                path: /payment.PaymentService/AuthorizePayment
              - method: POST
                path: /payment.PaymentService/CapturePayment
              # Explicitly deny refund operations from order-service
              # (only billing-service can initiate refunds)

    - fromEndpoints:
        - matchLabels:
            app: billing-service
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          rules:
            http:
              - method: POST
                path: /payment.PaymentService/.*  # Full access
```

## FQDN-Based Egress Policies

FQDN policies allow egress rules based on DNS names, which is essential for controlling access to external SaaS APIs, cloud services, and partner endpoints.

### Basic FQDN Policy

```yaml
# Control external API access by DNS name
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: external-api-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-processor

  egress:
    # Allow Stripe API
    - toFQDNs:
        - matchName: api.stripe.com
        - matchName: files.stripe.com
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow AWS services (S3, SQS, etc.) using pattern matching
    - toFQDNs:
        - matchPattern: "*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow specific GitHub access (e.g., for webhook delivery)
    - toFQDNs:
        - matchName: api.github.com
        - matchName: github.com
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow DNS resolution (required for FQDN policies to work)
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP

    # Deny all other external egress (implicit default deny)
```

### DNS Policy Caching and Preemptive Resolution

Cilium resolves FQDN rules by intercepting DNS responses. Configure the DNS proxy for reliability:

```yaml
# Cilium ConfigMap settings for FQDN policy
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # DNS proxy settings
  dns-proxy-enable-transparent-mode: "true"

  # TTL settings for cached DNS results
  # Minimum TTL to cache FQDN results (seconds)
  # Prevents excessive re-resolution
  tofqdns-min-ttl: "3600"

  # Maximum number of IPs per FQDN to track
  tofqdns-max-ips-per-hostname: "50"

  # Enable pre-caching of common FQDNs
  tofqdns-pre-cache: "true"
```

```bash
# View FQDN policy mappings
kubectl exec -n kube-system ds/cilium -- \
    cilium fqdn cache list

# Sample output:
# FQDN                   IPS                           TTL
# api.stripe.com         54.164.185.35,52.8.120.177   3598
# *.amazonaws.com        [multiple]                    86400

# Clear FQDN cache (force re-resolution)
kubectl exec -n kube-system ds/cilium -- \
    cilium fqdn cache clean

# Monitor DNS interception
kubectl exec -n kube-system ds/cilium -- \
    cilium monitor --type drop --related-to-fqdn api.stripe.com
```

### FQDN Policies for AWS Services

```yaml
# Comprehensive AWS service egress policy
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: aws-services-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      needs-aws: "true"

  egress:
    # S3 in us-east-1
    - toFQDNs:
        - matchPattern: "*.s3.us-east-1.amazonaws.com"
        - matchPattern: "s3.us-east-1.amazonaws.com"
        - matchName: "s3.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # RDS endpoints
    - toFQDNs:
        - matchPattern: "*.rds.amazonaws.com"
      toPorts:
        - ports:
            - port: "5432"  # PostgreSQL
              protocol: TCP
            - port: "3306"  # MySQL
              protocol: TCP

    # SQS
    - toFQDNs:
        - matchPattern: "sqs.*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # SNS
    - toFQDNs:
        - matchPattern: "sns.*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # AWS STS (for IRSA token exchange)
    - toFQDNs:
        - matchName: sts.amazonaws.com
        - matchPattern: "sts.*.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # IMDS (Instance Metadata Service)
    - toCIDR:
        - 169.254.169.254/32
      toPorts:
        - ports:
            - port: "80"
              protocol: TCP

    # Required: Allow DNS
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
```

## ToServices: Kubernetes-Native Service Targeting

`toServices` allows network policies that target Kubernetes Service objects rather than individual pod IPs. This is particularly useful for policies that need to survive Service IP changes or work with ExternalName services.

```yaml
# Allow traffic to a specific Kubernetes service
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-to-payment-service
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: order-processor

  egress:
    # Allow to the payment-service Kubernetes Service object
    - toServices:
        - k8sService:
            serviceName: payment-service
            namespace: payments

    # Allow to services matching a label selector
    - toServices:
        - k8sServiceSelector:
            selector:
              matchLabels:
                tier: database
                environment: production
            namespace: data-stores

    # Allow to services across namespaces
    - toServices:
        - k8sServiceSelector:
            selector:
              matchLabels:
                expose-to-production: "true"
```

### Combining ToServices with L7 Rules

```yaml
# L7 policy targeting a Kubernetes service
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-to-catalog-service
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-gateway

  egress:
    - toServices:
        - k8sService:
            serviceName: catalog-service
            namespace: catalog
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # API gateway can only read from catalog, not write
              - method: GET
                path: /catalog/.*
              - method: GET
                path: /products/.*
```

## Cluster-Wide Policies with CiliumClusterwideNetworkPolicy

For baseline policies that apply across all namespaces:

```yaml
# Default deny all egress except DNS and internal cluster traffic
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: default-deny-external-egress
spec:
  endpointSelector: {}  # Applies to ALL endpoints

  egress:
    # Allow DNS to kube-dns
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP

    # Allow intra-cluster communication (same cluster CIDR)
    # Replace with your actual cluster pod CIDR
    - toCIDR:
        - 10.0.0.0/8

    # Allow access to Kubernetes API server
    - toEntities:
        - kube-apiserver

    # Allow health check probes from kube-proxy and kubelet
    - toEntities:
        - host

---
# Default deny ingress except from within the cluster
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: default-deny-external-ingress
spec:
  endpointSelector: {}

  ingress:
    # Allow from within the cluster
    - fromEntities:
        - cluster

    # Allow from host (for kubelet health checks)
    - fromEntities:
        - host

    # Allow from ingress controllers
    - fromEndpoints:
        - matchLabels:
            app.kubernetes.io/name: ingress-nginx
            k8s:io.kubernetes.pod.namespace: ingress-nginx
```

### Node-Level Policies

```yaml
# CiliumClusterwideNetworkPolicy for node-level traffic
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: allow-node-to-pod-health-checks
spec:
  endpointSelector:
    matchLabels:
      k8s:io.kubernetes.pod.namespace: ".*"  # All namespaces

  ingress:
    # Allow kubelet health check probes from the node
    - fromEntities:
        - host
      toPorts:
        - ports:
            # Common health check ports
            - port: "8080"
              protocol: TCP
            - port: "8443"
              protocol: TCP
            - port: "9090"
              protocol: TCP
```

## Kafka Topic-Level Policies

Cilium can inspect and enforce policies at the Kafka protocol level:

```yaml
# Kafka topic-level access control
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: kafka-order-topic-policy
  namespace: streaming

spec:
  endpointSelector:
    matchLabels:
      app: kafka-broker

  ingress:
    # Order service can only produce to orders topic
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
              # Allow metadata and group coordination
              - apiKey: metadata
              - apiKey: findCoordinator
              - apiKey: joinGroup
              - apiKey: syncGroup
              - apiKey: heartbeat
              - apiKey: leaveGroup

    # Analytics service can consume from multiple topics
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
                topic: orders
              - role: consume
                topic: order-events
              - role: consume
                topic: inventory-events
              - apiKey: metadata
              - apiKey: findCoordinator
              - apiKey: offsetFetch
              - apiKey: offsetCommit
              - apiKey: joinGroup
              - apiKey: syncGroup
              - apiKey: heartbeat
              - apiKey: leaveGroup
              - apiKey: fetch
```

## Policy Debugging and Observability

### Hubble for Network Flow Visibility

```bash
# Install Hubble CLI
export HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name-all \
    https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Enable Hubble relay
helm upgrade cilium cilium/cilium \
    --namespace kube-system \
    --reuse-values \
    --set hubble.relay.enabled=true \
    --set hubble.ui.enabled=true

# Port-forward to Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe all flows in production namespace
hubble observe --namespace production

# Observe dropped flows (policy denials)
hubble observe --verdict DROPPED --namespace production

# Observe flows to specific pod
hubble observe --to-pod production/api-server-xxxxx

# Observe L7 flows
hubble observe --protocol http --namespace production

# Export flows for SIEM
hubble observe --all-namespaces --output json | \
    jq 'select(.verdict == "DROPPED")' | \
    head -100
```

### Policy Testing Before Enforcement

```bash
# Use cilium's policy trace to test a policy before applying it
kubectl exec -n kube-system ds/cilium -- \
    cilium policy trace \
    --src-k8s-pod production/frontend-pod \
    --dst-k8s-pod production/api-server-pod \
    --dport 8080 \
    --http-method GET \
    --http-path /api/v1/users

# Output shows the policy decision and which rules matched:
# Tracing From: [k8s:app=frontend] => To: [k8s:app=api-server] Ports: [8080/TCP]
# * Match for rule #1: ingress rule (action allow)
#   -> GET /api/v1/users ALLOWED

# Test a denied path
kubectl exec -n kube-system ds/cilium -- \
    cilium policy trace \
    --src-k8s-pod production/frontend-pod \
    --dst-k8s-pod production/api-server-pod \
    --dport 8080 \
    --http-method DELETE \
    --http-path /api/v1/users/123

# -> DELETE /api/v1/users/123 DENIED
```

### Monitoring Cilium Policy Metrics

```yaml
# Prometheus alert rules for Cilium policy
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cilium-policy-alerts
  namespace: monitoring
spec:
  groups:
    - name: cilium.policy
      interval: 30s
      rules:
        # High drop rate may indicate misconfigured policy
        - alert: CiliumHighDropRate
          expr: |
            rate(cilium_drop_count_total[5m]) > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High Cilium packet drop rate on {{ $labels.instance }}"
            description: "{{ $value }} drops/sec - may indicate policy misconfiguration"

        # Policy import errors
        - alert: CiliumPolicyImportError
          expr: |
            cilium_policy_import_errors_total > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Cilium policy import errors on {{ $labels.instance }}"

        # Endpoint regeneration errors
        - alert: CiliumEndpointRegenerationError
          expr: |
            cilium_endpoint_regenerations_total{outcome="failure"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cilium endpoint regeneration failures"

        # FQDN resolution failures
        - alert: CiliumFQDNResolutionFailure
          expr: |
            rate(cilium_fqdn_gc_deletions_total[5m]) > 10
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High FQDN cache GC rate - possible DNS resolution issues"
```

## Complete Zero-Trust Policy Example

Putting it all together — a production zero-trust policy set for a three-tier application:

```yaml
# Tier 1: Frontend
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: frontend-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      tier: frontend

  ingress:
    # Only accept traffic from ingress controller
    - fromEndpoints:
        - matchLabels:
            app.kubernetes.io/name: ingress-nginx
            k8s:io.kubernetes.pod.namespace: ingress-nginx
      toPorts:
        - ports:
            - port: "3000"
              protocol: TCP

  egress:
    # Frontend can only call the API tier on specific endpoints
    - toEndpoints:
        - matchLabels:
            tier: api
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: /api/v1/.*
              - method: POST
                path: /api/v1/.*
              - method: PUT
                path: /api/v1/.*

    # DNS
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP

---
# Tier 2: API
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      tier: api

  ingress:
    - fromEndpoints:
        - matchLabels:
            tier: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP

  egress:
    # API can only call database tier
    - toEndpoints:
        - matchLabels:
            tier: database
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # API can call external payment processor
    - toFQDNs:
        - matchName: api.stripe.com
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # DNS
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP

---
# Tier 3: Database
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: database-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      tier: database

  ingress:
    # ONLY accept connections from API tier
    - fromEndpoints:
        - matchLabels:
            tier: api
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

  egress:
    # Database has no egress except DNS
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
            k8s:k8s-app: kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
```

## Key Takeaways

Cilium's eBPF-based policy enforcement provides security capabilities that standard Kubernetes NetworkPolicy cannot match. The key principles for production Cilium policy deployments are:

1. Start with L4 policies matching the standard Kubernetes NetworkPolicy model, then layer L7 policies on top only for services where you need HTTP method/path enforcement — L7 inspection adds CPU overhead that should be justified by the security requirement
2. FQDN policies (`toFQDNs`) must always include a DNS egress rule to kube-dns, or the FQDN resolution that drives the policy will fail silently
3. Use `cilium policy trace` to validate policies before applying them — it simulates the policy decision without actually blocking traffic, avoiding production incidents from misconfigured rules
4. Deploy Hubble and configure it to export dropped flows to your SIEM — L7 denials are invisible to traditional network monitoring tools and critical for both debugging and audit trails
5. `CiliumClusterwideNetworkPolicy` with a default-deny stance and explicit allowances is more secure than namespace-level policies alone, because it prevents cross-namespace attacks that exploit missing namespace isolation
6. Kafka topic-level policies (`rules.kafka`) are particularly valuable in shared Kafka clusters where you cannot rely on separate Kafka ACLs being correctly configured — Cilium enforces the policy at the network level regardless of Kafka ACL configuration
7. FQDN pattern matching (`matchPattern: "*.amazonaws.com"`) is more maintainable than CIDR-based rules for cloud provider APIs because IP ranges change frequently without notice, but DNS names are stable
8. Monitor `cilium_drop_count_total` with Prometheus alerts — a sudden increase often indicates a new service dependency that needs a policy exception or a potential attack that the policy is successfully blocking
