---
title: "Kubernetes Cilium Network Policy: Endpoint Selectors, DNS Policy, CIDR Rules, and L7 HTTP Policies"
date: 2032-04-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "Network Policy", "eBPF", "Security", "CNI", "Zero Trust"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Cilium network policy capabilities including endpoint-based policies, DNS FQDN policies, CIDR egress rules, and L7 HTTP policies using eBPF for production zero-trust network enforcement."
more_link: "yes"
url: "/kubernetes-cilium-network-policy-endpoint-selectors-dns-cidr-l7-http/"
---

Cilium extends Kubernetes network policy with eBPF-powered enforcement that provides identity-based access control, DNS-aware egress filtering, and Layer 7 HTTP/gRPC policy enforcement. These capabilities enable true zero-trust networking for containerized workloads without performance penalties inherent to sidecar-based approaches.

<!--more-->

## Cilium vs Standard Kubernetes NetworkPolicy

| Feature | Kubernetes NetworkPolicy | CiliumNetworkPolicy |
|---|---|---|
| Identity basis | IP + port | Workload identity (labels) |
| L7 policies | No | HTTP, gRPC, Kafka, DNS |
| DNS-aware egress | No | Yes (FQDN rules) |
| Node selector | No | Yes |
| Service account | No | Yes |
| CIDR ranges | Yes | Yes (extended) |
| Port ranges | No | Yes |
| Observability | None built-in | Hubble (eBPF-based) |
| Performance | iptables/ipset | eBPF (kernel bypass) |

---

## Cilium Network Policy Fundamentals

### CiliumNetworkPolicy Structure

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: policy-name
  namespace: target-namespace
spec:
  # Endpoint selector - which pods this policy applies TO
  endpointSelector:
    matchLabels:
      app: my-app
      tier: backend

  # Ingress rules - control incoming traffic
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend

  # Egress rules - control outgoing traffic
  egress:
    - toEndpoints:
        - matchLabels:
            app: database
```

### Endpoint Selectors vs Entity Selectors

Cilium provides special entity selectors for well-known targets:

```yaml
# Entity selectors for system entities
egress:
  # Allow egress to kube-dns
  - toEntities:
      - "kube-apiserver"     # Kubernetes API server
  - toEntities:
      - "cluster"            # All pods/services in the cluster
  - toEntities:
      - "host"               # The node itself
  - toEntities:
      - "world"              # External internet
  - toEntities:
      - "health"             # Cilium health check endpoints
  - toEntities:
      - "remote-node"        # Other nodes in the cluster
```

---

## Endpoint Selector Policies

### Strict Ingress Policy

Deny all ingress by default, allow only from specific workloads:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: backend-ingress-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend-api
      environment: production
  ingress:
    # Allow from frontend pods in same namespace
    - fromEndpoints:
        - matchLabels:
            app: frontend
            environment: production
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP

    # Allow from monitoring (any namespace via CIDR is NOT supported;
    # use fromEndpoints with namespaceSelector)
    - fromEndpoints:
        - matchLabels:
            app.kubernetes.io/name: prometheus
        - matchLabels:
            app.kubernetes.io/name: grafana-agent
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP

    # Allow health checks from kubelet/node
    - fromEntities:
        - "host"
      toPorts:
        - ports:
            - port: "8081"
              protocol: TCP
```

### Cross-Namespace Policies

Cilium supports cross-namespace policies with namespace selectors:

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: shared-service-cross-namespace
  namespace: shared-services
spec:
  endpointSelector:
    matchLabels:
      app: auth-service
  ingress:
    # Allow from any namespace with the "team.company.com/environment=production" label
    - fromEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": "production-apps"
      toPorts:
        - ports:
            - port: "3000"
              protocol: TCP

    # Allow from multiple specific namespaces
    - fromEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": "api-gateway"
    - fromEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": "mobile-backend"
      toPorts:
        - ports:
            - port: "3000"
              protocol: TCP
```

### Service Account-Based Policy

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: service-account-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payments-service
  ingress:
    # Only allow pods with specific service account identity
    - fromEndpoints:
        - matchLabels:
            "k8s:io.cilium.k8s.policy.serviceaccount": "checkout-service-account"
      toPorts:
        - ports:
            - port: "8443"
              protocol: TCP
```

---

## L7 HTTP Policies

Cilium can enforce HTTP-specific rules at Layer 7 without a sidecar proxy:

### HTTP Method and Path Rules

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: api-l7-policy
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
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Allow GET requests to /users and its sub-paths
              - method: "GET"
                path: "^/users(/.*)?$"
              # Allow POST to create users
              - method: "POST"
                path: "^/users$"
              # Allow PATCH for updates
              - method: "PATCH"
                path: "^/users/[0-9]+$"
              # Allow DELETE only for admin
              - method: "DELETE"
                path: "^/users/[0-9]+$"
                headers:
                  - "X-Admin-Token: exists"
    # Admin service has broader access
    - fromEndpoints:
        - matchLabels:
            app: admin-service
            security.company.com/admin: "true"
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Allow all methods (no method restriction = all methods allowed)
              - path: ".*"
```

### HTTP Header-Based Policies

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: header-based-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: internal-api
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: client-service
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Require X-Tenant-ID header for multi-tenant API
              - method: "GET"
                path: "/api/v1/.*"
                headers:
                  - "X-Tenant-ID: [a-zA-Z0-9-]+"
              # Allow health endpoint without tenant header
              - method: "GET"
                path: "/health"
              - method: "GET"
                path: "/ready"
```

### gRPC Policies

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: grpc-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: grpc-service
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: grpc-client
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          rules:
            # gRPC uses HTTP/2; Cilium maps gRPC services to HTTP/2 paths
            http:
              # Allow specific gRPC service methods
              - method: "POST"
                path: "/com.example.UserService/GetUser"
              - method: "POST"
                path: "/com.example.UserService/ListUsers"
              # Allow health check endpoint
              - method: "POST"
                path: "/grpc.health.v1.Health/Check"
```

---

## DNS FQDN Egress Policies

DNS-aware egress is one of Cilium's most powerful features. Traditional CNIs must use CIDR rules for egress, but IP addresses for cloud services change constantly. Cilium intercepts DNS queries and creates dynamic CIDR rules matching the resolved IPs.

### Basic FQDN Rules

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
    # Allow DNS resolution (required for FQDN rules to work)
    - toEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": "kube-system"
            "k8s:app.kubernetes.io/name": "coredns"
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP

    # Allow HTTPS to specific AWS services by hostname
    - toFQDNs:
        - matchName: "s3.amazonaws.com"
        - matchName: "s3.us-east-1.amazonaws.com"
        - matchName: "sts.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow access to internal services by domain
    - toFQDNs:
        - matchName: "redis.internal.company.com"
        - matchName: "postgres.internal.company.com"
      toPorts:
        - ports:
            - port: "6379"
              protocol: TCP
            - port: "5432"
              protocol: TCP
```

### Wildcard FQDN Rules

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: wildcard-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: ml-inference
  egress:
    # DNS
    - toEntities:
        - "kube-apiserver"
    - toEndpoints:
        - matchLabels:
            "k8s:app": "coredns"
            "k8s:io.kubernetes.pod.namespace": "kube-system"
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP

    # Allow all subdomains of internal company domain
    - toFQDNs:
        - matchPattern: "*.internal.company.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
            - port: "80"
              protocol: TCP

    # Allow all AWS regional S3 endpoints
    - toFQDNs:
        - matchPattern: "*.s3.*.amazonaws.com"
        - matchPattern: "*.s3.amazonaws.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow HuggingFace for model downloads
    - toFQDNs:
        - matchName: "huggingface.co"
        - matchPattern: "*.huggingface.co"
        - matchName: "cdn-lfs-us-1.huggingface.co"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

### DNS Policy for External Databases (RDS)

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: rds-egress-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api-server
  egress:
    # DNS must be allowed for FQDN resolution
    - toEndpoints:
        - matchLabels:
            "k8s:app.kubernetes.io/name": "coredns"
            "k8s:io.kubernetes.pod.namespace": "kube-system"
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP

    # Allow PostgreSQL connection to RDS endpoint
    # Cilium resolves the FQDN and creates dynamic CIDR rules
    - toFQDNs:
        - matchName: "production-db.cluster-xyz.us-east-1.rds.amazonaws.com"
        # Also allow the reader endpoint
        - matchName: "production-db.cluster-ro-xyz.us-east-1.rds.amazonaws.com"
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # Allow RDS Proxy if used
    - toFQDNs:
        - matchPattern: "*.proxy-*.us-east-1.rds.amazonaws.com"
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
```

---

## CIDR-Based Policies

### Egress to External CIDR Ranges

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: cidr-egress-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: network-scanner
  egress:
    # Allow HTTPS to specific CIDR ranges
    - toCIDR:
        - "10.0.0.0/8"       # Internal corporate network
        - "172.16.0.0/12"    # RFC 1918
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
            - port: "80"
              protocol: TCP

    # Allow to specific AWS CIDR (example: VPC CIDR)
    - toCIDR:
        - "10.100.0.0/16"    # Production VPC
      toPorts:
        - ports:
            - port: "8443"
              protocol: TCP

    # Allow ICMP ping to RFC 1918 ranges
    - toCIDR:
        - "10.0.0.0/8"
        - "172.16.0.0/12"
        - "192.168.0.0/16"
      icmps:
        - fields:
            - type: 8  # Echo request
              family: IPv4
```

### CIDR Exclusion Rules

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: cidr-with-exclusions
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: internet-facing-service
  egress:
    # Allow internet egress but exclude specific ranges
    - toCIDRSet:
        - cidr: "0.0.0.0/0"
          except:
            - "10.0.0.0/8"
            - "172.16.0.0/12"
            - "192.168.0.0/16"
            - "169.254.0.0/16"  # Link-local
            - "100.64.0.0/10"   # Carrier-grade NAT
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

---

## Complete Zero-Trust Example

### Multi-Tier Application Policy

```yaml
# Deny all by default - enforced by Cilium's default-deny mode
# Enable with: cilium config set policy-enforcement=always
---
# Frontend tier - only accepts external ingress + communicates with backend
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: frontend-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      tier: frontend
  ingress:
    # Allow external load balancer health checks
    - fromEntities:
        - "world"
        - "cluster"
      toPorts:
        - ports:
            - port: "80"
              protocol: TCP
            - port: "443"
              protocol: TCP
    # Allow Prometheus scraping
    - fromEndpoints:
        - matchLabels:
            app.kubernetes.io/name: prometheus
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
  egress:
    # DNS
    - toEndpoints:
        - matchLabels:
            "k8s:app.kubernetes.io/name": "coredns"
            "k8s:io.kubernetes.pod.namespace": "kube-system"
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
    # Backend API
    - toEndpoints:
        - matchLabels:
            tier: backend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/api/.*"
              - method: "POST"
                path: "/api/.*"
              - method: "PUT"
                path: "/api/.*"
              - method: "DELETE"
                path: "/api/.*"
---
# Backend tier - only from frontend, communicates with data tier
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: backend-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      tier: backend
  ingress:
    - fromEndpoints:
        - matchLabels:
            tier: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
    - fromEndpoints:
        - matchLabels:
            app.kubernetes.io/name: prometheus
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
    # Health checks from kubelet
    - fromEntities:
        - "host"
      toPorts:
        - ports:
            - port: "8081"
              protocol: TCP
  egress:
    # DNS
    - toEndpoints:
        - matchLabels:
            "k8s:app.kubernetes.io/name": "coredns"
            "k8s:io.kubernetes.pod.namespace": "kube-system"
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
    # Cache tier
    - toEndpoints:
        - matchLabels:
            tier: cache
      toPorts:
        - ports:
            - port: "6379"
              protocol: TCP
    # Database tier (read-write)
    - toEndpoints:
        - matchLabels:
            tier: database
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
    # External payment provider
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "hooks.stripe.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
---
# Database tier - only from backend and migration jobs
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: database-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      tier: database
  ingress:
    - fromEndpoints:
        - matchLabels:
            tier: backend
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
    # Allow migration jobs from specific service account
    - fromEndpoints:
        - matchLabels:
            "k8s:io.cilium.k8s.policy.serviceaccount": "migration-runner"
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
    # Backup agent
    - fromEndpoints:
        - matchLabels:
            app: backup-agent
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
  egress:
    # Database pods only need DNS and replication traffic
    - toEndpoints:
        - matchLabels:
            "k8s:app.kubernetes.io/name": "coredns"
            "k8s:io.kubernetes.pod.namespace": "kube-system"
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
    # PostgreSQL streaming replication between replicas
    - toEndpoints:
        - matchLabels:
            tier: database
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
```

---

## Observability with Hubble

### Hubble CLI for Policy Debugging

```bash
# Install Hubble CLI
cilium hubble enable

# View live traffic flows
hubble observe --follow

# Filter by namespace
hubble observe --namespace production --follow

# View dropped traffic (policy violations)
hubble observe --verdict DROPPED --follow

# View traffic to/from a specific pod
hubble observe \
  --from-pod production/api-server-abc123 \
  --follow

# Get policy drop statistics
hubble observe \
  --verdict DROPPED \
  --namespace production \
  --output json | \
  jq '.flow | {
    source: .source.pod_name,
    dest: .destination.pod_name,
    dest_port: .l4.TCP.destination_port,
    drop_reason: .drop_reason_desc
  }'

# Check which traffic is being dropped by a specific policy
hubble observe \
  --verdict DROPPED \
  --namespace production \
  --type l3-l4 \
  --output json | \
  jq 'select(.flow.drop_reason_desc == "POLICY_DENIED")'
```

### Hubble UI for Visual Policy Analysis

```bash
# Enable Hubble UI
cilium hubble enable --ui

# Port-forward to access Hubble UI
kubectl port-forward -n kube-system svc/hubble-ui 12000:80

# Access at http://localhost:12000
```

### Cilium Policy Audit Mode

Before enforcing a new policy, run it in audit mode to see what would be dropped:

```bash
# Enable audit mode for all policies in a namespace
kubectl annotate namespace production \
  "policy.cilium.io/audit-mode=true"

# View audit events (allowed by audit mode but would be dropped by enforce)
hubble observe \
  --verdict AUDIT \
  --namespace production \
  --follow

# Check policy enforcement per endpoint
cilium endpoint list
cilium endpoint get <endpoint-id>

# View which policies apply to an endpoint
cilium endpoint get <endpoint-id> | jq '.status.policy'
```

---

## Policy Testing and Validation

### Automated Policy Testing

```bash
#!/usr/bin/env bash
# test-network-policies.sh - Validate Cilium network policies

set -euo pipefail

NAMESPACE="${1:-production}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Test connectivity between two pods
test_connectivity() {
  local from_pod="${1}"
  local to_host="${2}"
  local to_port="${3}"
  local expected="${4}" # "allow" or "deny"
  local description="${5}"

  log "Testing: ${description}"

  if kubectl exec -n "${NAMESPACE}" "${from_pod}" -- \
    timeout 3 nc -z -w 3 "${to_host}" "${to_port}" &>/dev/null; then
    result="allow"
  else
    result="deny"
  fi

  if [[ "${result}" == "${expected}" ]]; then
    log "PASS: ${description} (${expected})"
  else
    log "FAIL: ${description} - expected ${expected}, got ${result}"
    FAILED=1
  fi
}

FAILED=0

FRONTEND_POD=$(kubectl get pods -n "${NAMESPACE}" -l tier=frontend -o jsonpath='{.items[0].metadata.name}')
BACKEND_POD=$(kubectl get pods -n "${NAMESPACE}" -l tier=backend -o jsonpath='{.items[0].metadata.name}')
DB_POD=$(kubectl get pods -n "${NAMESPACE}" -l tier=database -o jsonpath='{.items[0].metadata.name}')

BACKEND_SVC="backend.${NAMESPACE}.svc.cluster.local"
DB_SVC="database.${NAMESPACE}.svc.cluster.local"

# Expected allowed connections
test_connectivity "${FRONTEND_POD}" "${BACKEND_SVC}" 8080 "allow" "frontend -> backend:8080"

# Expected denied connections
test_connectivity "${FRONTEND_POD}" "${DB_SVC}" 5432 "deny" "frontend -> database:5432 (should be denied)"

# Backend -> Database
test_connectivity "${BACKEND_POD}" "${DB_SVC}" 5432 "allow" "backend -> database:5432"

# Cross-tier lateral movement (should be denied)
test_connectivity "${FRONTEND_POD}" "${BACKEND_SVC}" 9090 "deny" "frontend -> backend metrics (should be denied)"

if [[ "${FAILED}" -eq 1 ]]; then
  log "SOME TESTS FAILED"
  exit 1
else
  log "ALL TESTS PASSED"
fi
```

### Cilium Network Policy Linting

```bash
# Validate policy YAML with cilium CLI
cilium policy validate frontend-policy.yaml

# Get policy coverage for a namespace
cilium policy get --namespace production

# See effective policies for a specific pod
kubectl get cep -n production <pod-name> -o yaml

# Check if policy has syntax errors
kubectl apply --dry-run=server -f cilium-policies/
```

---

## Advanced: Policy with Node Selector

```yaml
# Apply policy to pods on specific node types (e.g., GPU nodes)
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: gpu-workload-policy
  namespace: ml-training
spec:
  nodeSelector:
    matchLabels:
      node.kubernetes.io/instance-type: "p3.16xlarge"
  ingress:
    - fromEntities:
        - "cluster"
      toPorts:
        - ports:
            - port: "29500"  # PyTorch DDP port range start
              protocol: TCP
            - port: "29501"
              protocol: TCP
            - port: "29502"
              protocol: TCP
```

---

## Performance Tuning

### Cilium Configuration for High-Throughput Policies

```yaml
# cilium-config ConfigMap adjustments
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Enable BPF masquerading for better performance
  enable-bpf-masquerade: "true"

  # Use eBPF host routing (bypasses iptables entirely)
  enable-host-routing: "true"

  # Disable Hubble in high-performance production (saves CPU)
  # Enable when debugging
  enable-hubble: "true"
  hubble-metrics: "drop,tcp,flow,port-distribution,icmp,http"

  # Policy enforcement - "default" = deny on explicit deny rules
  # "always" = full default-deny
  policy-enforcement: "default"

  # Increase map sizes for large clusters (>1000 pods)
  bpf-policy-map-max: "16384"
  bpf-lru-map-max: "65536"

  # Tunnel mode vs native routing
  tunnel: "disabled"   # Use native routing for better performance
  native-routing-cidr: "10.0.0.0/8"
```

Cilium's eBPF-native approach to network policy enforcement eliminates the performance penalties of userspace proxies and iptables rules, making it the preferred choice for high-throughput production workloads that also require sophisticated Layer 7 visibility.
