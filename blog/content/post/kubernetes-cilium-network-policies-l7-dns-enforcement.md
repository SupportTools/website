---
title: "Kubernetes Cilium Network Policies: L7 Policy Enforcement and DNS-Based Rules"
date: 2031-05-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "eBPF", "Network Policy", "L7", "DNS", "Security", "Hubble", "Zero Trust"]
categories:
- Kubernetes
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Cilium's network policy capabilities including L7 HTTP/gRPC enforcement, FQDN-based egress rules, ToEntities for cluster/host/world, policy audit mode for safe rollout, and Hubble for real-time policy visualization and debugging."
more_link: "yes"
url: "/kubernetes-cilium-network-policies-l7-dns-enforcement/"
---

Standard Kubernetes NetworkPolicy provides L3/L4 filtering—IP addresses, ports, and protocols. Cilium extends this to L7, enabling HTTP path-based routing, gRPC method filtering, DNS-based egress rules, and cryptographic identity through mTLS. When combined with Hubble's visibility layer, Cilium provides the observability needed to debug policy issues without service disruption.

<!--more-->

# Kubernetes Cilium Network Policies: L7 Policy Enforcement and DNS-Based Rules

## Section 1: Cilium Policy Architecture

### Policy Enforcement Model

```
Standard NetworkPolicy:
  • L3: Source/destination IP, CIDR
  • L4: TCP/UDP port numbers
  • Limited: No application protocol awareness

CiliumNetworkPolicy:
  • L3: Same as standard + FQDN-based
  • L4: Same as standard
  • L7: HTTP (method, path, headers), Kafka, DNS, gRPC
  • Identity-based: Pod labels, service accounts
  • Cryptographic: mTLS with SPIFFE/SVID
```

### Cilium Identity System

```
Each pod/endpoint gets a numeric security identity based on:
  1. Kubernetes labels
  2. Namespace
  3. Service account

Example:
  Pod: {app: frontend, env: production}
  Cilium identity: 1234

Policy rule: Allow identity 1234 → identity 5678 on port 443
  Enforcement: eBPF program checks identity in packet metadata
```

## Section 2: Standard NetworkPolicy vs CiliumNetworkPolicy

### Standard NetworkPolicy (L3/L4 only)

```yaml
# standard-networkpolicy.yaml - Standard L3/L4 only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-allow-frontend
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 8080
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              name: monitoring
      ports:
        - protocol: TCP
          port: 9090
    - ports:
        - protocol: UDP
          port: 53  # DNS
```

### CiliumNetworkPolicy (Full L7)

```yaml
# cilium-l7-policy.yaml - L7 HTTP enforcement
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-l7-policy
  namespace: production
spec:
  description: "API service: allow frontend GET/POST only"
  endpointSelector:
    matchLabels:
      app: api
  ingress:
    # Allow frontend pods to make specific HTTP calls
    - fromEndpoints:
        - matchLabels:
            app: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              # Only allow GET and POST to /api/v1/* paths
              - method: GET
                path: "^/api/v1/.*"
              - method: POST
                path: "^/api/v1/.*"
                headers:
                  - "Content-Type: application/json"
              # Deny all other HTTP methods (PUT, DELETE, PATCH)

    # Allow monitoring to scrape metrics (no L7 rules = any HTTP allowed)
    - fromEndpoints:
        - matchLabels:
            app: prometheus
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP

  egress:
    # Allow database access
    - toEndpoints:
        - matchLabels:
            app: postgres
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP

    # DNS egress (required for FQDN rules to work)
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
              - matchPattern: "*.yourdomain.com"
              - matchPattern: "*.google.com"

    # External API access via FQDN
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.sendgrid.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

## Section 3: L7 HTTP Policy Rules

### HTTP Rule Specification

```yaml
# http-policy-examples.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: http-rules-example
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend
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
              # Public endpoints - no auth header required
              - method: GET
                path: "^/public/.*"

              # Admin endpoints - require specific header
              - method: GET
                path: "^/admin/.*"
                headers:
                  - "X-Admin-Token: .*"

              # Mutation endpoints
              - method: POST
                path: "^/api/v[12]/resources$"
                headers:
                  - "Content-Type: application/json"

              # Health check endpoint accessible without auth
              - method: GET
                path: "^/healthz$"

              # Block everything else by not including rules for it
              # Any request not matching above rules is DENIED
```

### gRPC L7 Policy

```yaml
# grpc-policy.yaml
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
            # gRPC uses HTTP/2 - rules match on :path header
            http:
              # Allow only specific gRPC methods
              - method: POST
                path: "^/user.v1.UserService/GetUser$"
              - method: POST
                path: "^/user.v1.UserService/ListUsers$"
              # Block admin gRPC methods
              # - DeleteUser, UpdateUser, etc. not listed = DENIED

    # Allow internal admin service full access
    - fromEndpoints:
        - matchLabels:
            app: admin-service
            role: admin
      toPorts:
        - ports:
            - port: "50051"
              protocol: TCP
          # No rules = allow all gRPC methods for admin service
```

### Kafka Policy

```yaml
# kafka-policy.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: kafka-consumer-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: order-processor
  egress:
    - toEndpoints:
        - matchLabels:
            app: kafka
      toPorts:
        - ports:
            - port: "9092"
              protocol: TCP
          rules:
            kafka:
              # Only allow consuming from specific topics
              - role: consume
                topic: "orders"
              - role: consume
                topic: "payments"
              # Explicitly deny production to prevent accidental writes
              # (no produce rule = denied)
```

## Section 4: FQDN-Based Egress Policies

### DNS Policy Overview

Cilium's FQDN-based policies work by intercepting DNS responses and creating dynamic IP-based rules based on the resolved addresses.

```
Flow:
1. Pod queries DNS for api.stripe.com
2. Cilium intercepts DNS response (via eBPF)
3. Cilium sees response: api.stripe.com → 34.192.168.5
4. Cilium creates dynamic L3 rule: allow pod → 34.192.168.5:443
5. When IP changes (next DNS TTL), rule is updated automatically
```

### FQDN Policy Examples

```yaml
# fqdn-egress-policy.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: payment-service-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: payment-service
  egress:
    # Exact FQDN match
    - toFQDNs:
        - matchName: "api.stripe.com"
        - matchName: "api.stripe.network"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Wildcard FQDN match
    - toFQDNs:
        - matchPattern: "*.stripe.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Multiple providers
    - toFQDNs:
        - matchName: "api.sendgrid.com"
        - matchName: "smtp.sendgrid.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
        - ports:
            - port: "587"
              protocol: TCP

    # Allow AWS SDK
    - toFQDNs:
        - matchPattern: "*.amazonaws.com"
        - matchPattern: "*.aws.amazon.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # DNS resolution (required for FQDN rules)
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
              - matchPattern: "*"  # Allow resolving any name
```

### DNS-Based Policy for Internal Services

```yaml
# internal-dns-policy.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: internal-services-dns
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: worker
  egress:
    # Allow DNS queries to kube-dns
    - toEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": kube-system
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
            - port: "53"
              protocol: TCP
          rules:
            dns:
              # Only allow resolving internal domains
              - matchPattern: "*.svc.cluster.local"
              - matchPattern: "*.cluster.local"
              - matchName: "kubernetes.default.svc.cluster.local"
              # Allow external resolution for specific services
              - matchPattern: "*.yourdomain.com"

    # Access internal services via DNS name
    - toFQDNs:
        - matchName: "api-service.production.svc.cluster.local"
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
```

## Section 5: ToEntities for Cluster/Host/World

### Entity-Based Policies

Cilium provides pre-defined entities that represent groups of endpoints:

| Entity | Description |
|--------|-------------|
| `cluster` | All pods in the Kubernetes cluster |
| `host` | The node (host network namespace) |
| `remote-node` | Remote Kubernetes nodes |
| `world` | Everything outside the cluster |
| `health` | Cilium health check endpoints |
| `init` | Pods during initialization |
| `kube-apiserver` | Kubernetes API server |
| `unmanaged` | Endpoints not managed by Cilium |
| `all` | Everything |

```yaml
# entity-policies.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: entity-examples
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: internal-service
  ingress:
    # Allow traffic from anywhere in the cluster
    - fromEntities:
        - cluster

    # Allow health checks from the node itself
    - fromEntities:
        - host
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP

  egress:
    # Allow ALL outbound within cluster
    - toEntities:
        - cluster

    # Deny direct access to the world (internet)
    # by not adding toEntities: [world] rule

    # Allow only specific FQDNs to reach external
    - toFQDNs:
        - matchName: "api.yourdomain.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP

    # Allow kube-apiserver communication
    - toEntities:
        - kube-apiserver
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
            - port: "6443"
              protocol: TCP
```

### Ingress from World with Rate Limiting

```yaml
# ingress-from-world.yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: public-api-ingress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: public-api
  ingress:
    # Allow HTTP/HTTPS from world (public internet)
    - fromEntities:
        - world
      toPorts:
        - ports:
            - port: "80"
              protocol: TCP
            - port: "443"
              protocol: TCP
          rules:
            http:
              # Only allow GET requests from world
              - method: GET
                path: "^/api/v1/public/.*"
              - method: GET
                path: "^/healthz$"
              # Block all other methods from world
```

## Section 6: Policy Audit Mode

Audit mode allows you to test policies without enforcing them—essential for safe production rollouts.

### Enabling Audit Mode

```yaml
# audit-mode-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Enable policy audit mode globally
  policy-audit-mode: "true"
  # Log level for audit events
  debug: "false"
  monitor-aggregation: "medium"
```

```bash
# Enable audit mode per-endpoint
kubectl annotate pod my-pod \
  policy.cilium.io/proxy-visibility=+<Ingress/8080/TCP/HTTP>

# Or via Cilium CLI
cilium config set policy-audit-mode true

# Check current audit mode status
kubectl -n kube-system exec ds/cilium -- \
  cilium config | grep audit

# View audit violations (policies that would have been enforced)
kubectl -n kube-system exec ds/cilium -- \
  cilium monitor --type drop
```

### Graduated Policy Rollout Process

```bash
#!/bin/bash
# policy-rollout.sh - Safe policy rollout with audit mode

NAMESPACE="${1:-production}"
POLICY_FILE="${2}"
POLICY_NAME="${3}"
MONITOR_DURATION="${4:-300}"  # 5 minutes of monitoring

if [[ -z "${POLICY_FILE}" || -z "${POLICY_NAME}" ]]; then
    echo "Usage: $0 <namespace> <policy-file> <policy-name> [monitor-seconds]"
    exit 1
fi

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

# Step 1: Apply policy in audit mode first
log "Step 1: Applying policy in annotation-based audit mode..."

# Add audit annotation to the policy
cat "${POLICY_FILE}" | \
    python3 -c "
import sys, yaml
docs = list(yaml.safe_load_all(sys.stdin))
for doc in docs:
    if doc.get('metadata', {}).get('annotations') is None:
        doc['metadata']['annotations'] = {}
    doc['metadata']['annotations']['policy.cilium.io/audit-mode'] = 'true'
print(yaml.dump_all(docs))
" | kubectl apply -f -

log "Policy applied in audit mode. Monitoring for ${MONITOR_DURATION}s..."

# Step 2: Monitor for would-be drops
log "Step 2: Monitoring for policy violations..."
VIOLATIONS_LOG="/tmp/policy-violations-$$.log"

kubectl -n kube-system exec ds/cilium -- \
    cilium monitor --type drop 2>&1 | \
    grep "${POLICY_NAME}" | \
    tee "${VIOLATIONS_LOG}" &
MONITOR_PID=$!

sleep "${MONITOR_DURATION}"
kill ${MONITOR_PID} 2>/dev/null

VIOLATION_COUNT=$(wc -l < "${VIOLATIONS_LOG}")

if [[ ${VIOLATION_COUNT} -gt 0 ]]; then
    log "WARNING: ${VIOLATION_COUNT} policy violations would occur if enforced!"
    log "Review violations in: ${VIOLATIONS_LOG}"
    log ""
    log "Top violations:"
    sort "${VIOLATIONS_LOG}" | uniq -c | sort -rn | head -10
    echo ""
    read -r -p "Continue with enforcement anyway? (yes/no): " CONFIRM
    if [[ "${CONFIRM}" != "yes" ]]; then
        log "Rollout cancelled. Policy remains in audit mode."
        exit 1
    fi
fi

# Step 3: Switch to enforce mode
log "Step 3: Switching policy to enforce mode..."
kubectl apply -f "${POLICY_FILE}"

log "Policy enforcement enabled."
log "Continue monitoring in Hubble:"
log "  hubble observe --namespace ${NAMESPACE} --verdict DROPPED"
```

## Section 7: Hubble for Policy Visualization and Debugging

### Hubble CLI Usage

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -L --remote-name-all \
    https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Enable Hubble relay in Cilium
helm upgrade cilium cilium/cilium \
    --namespace kube-system \
    --reuse-values \
    --set hubble.relay.enabled=true \
    --set hubble.ui.enabled=true

# Port-forward Hubble relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &

# Observe all flows
hubble observe

# Observe drops only (policy violations)
hubble observe --verdict DROPPED

# Observe specific namespace
hubble observe --namespace production

# Observe specific pod
hubble observe --pod production/api-7d9f4b8c-xyz

# Observe specific flow direction
hubble observe --from-pod production/frontend \
               --to-pod production/api

# Follow mode (like tail -f)
hubble observe --follow

# Filter by L7
hubble observe --protocol http

# Show flow with L7 details
hubble observe --protocol http --follow -o json | \
    jq 'select(.flow.l7 != null) | {
      src: .flow.source.labels,
      dst: .flow.destination.labels,
      method: .flow.l7.http.method,
      url: .flow.l7.http.url,
      status: .flow.l7.http.code
    }'
```

### Hubble Observe for Debugging

```bash
# Debug: why is connection being dropped?
hubble observe \
    --from-pod production/frontend \
    --to-pod production/api \
    --verdict DROPPED \
    --output json | \
    jq '{
      "drop_reason": .flow.drop_reason,
      "src_identity": .flow.source.identity,
      "dst_identity": .flow.destination.identity,
      "dst_port": .flow.l4.TCP.destination_port,
      "policy_match": .flow.policy_match_type
    }'

# Check which policies are applied to a pod
kubectl -n kube-system exec ds/cilium -- \
    cilium endpoint list | grep -A3 "production-api"

# Get policy details for an endpoint
ENDPOINT_ID=12345  # Get from endpoint list
kubectl -n kube-system exec ds/cilium -- \
    cilium endpoint get ${ENDPOINT_ID}

# Check policy enforcement state
kubectl -n kube-system exec ds/cilium -- \
    cilium endpoint list --output json | \
    jq '.[] | select(.labels.orchestration.k8s.labels["app"] == "api") | {
      id: .id,
      policy_enabled: .status.policy.spec.ingress.enforcing,
      identity: .status.identity
    }'

# Get all identities and their labels
kubectl -n kube-system exec ds/cilium -- \
    cilium identity list

# Map identity to policy
kubectl -n kube-system exec ds/cilium -- \
    cilium policy get
```

### Hubble UI Setup

```yaml
# hubble-ui-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hubble-ui
  namespace: kube-system
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: hubble-basic-auth
    nginx.ingress.kubernetes.io/auth-realm: "Hubble UI - Authentication Required"
spec:
  ingressClassName: nginx
  rules:
    - host: hubble.internal.yourdomain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: hubble-ui
                port:
                  number: 80
```

## Section 8: Complete Zero-Trust Policy for Microservices

### Production-Ready Policy Set

```yaml
# zero-trust-baseline.yaml
# Default deny-all policy for a namespace
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  # Match ALL pods in namespace
  endpointSelector: {}
  # Deny all ingress by default (empty ingress rules = deny all)
  ingress:
    - {}  # This syntax creates deny-all with Cilium
  egress:
    - {}  # Deny all egress
---
# Allow DNS for all pods (required baseline)
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-dns
  namespace: production
spec:
  endpointSelector: {}
  egress:
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
          rules:
            dns:
              - matchPattern: "*"
---
# Frontend service policy
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: frontend-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: frontend
  ingress:
    # Accept traffic from the world (via ingress controller)
    - fromEntities:
        - world
      toPorts:
        - ports:
            - port: "3000"
              protocol: TCP
    # Accept health checks from the node
    - fromEntities:
        - host
      toPorts:
        - ports:
            - port: "3000"
              protocol: TCP
  egress:
    # DNS (covered by allow-dns policy above)
    # API service
    - toEndpoints:
        - matchLabels:
            app: api
            namespace: production
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: "^/api/.*"
              - method: POST
                path: "^/api/.*"
              - method: PUT
                path: "^/api/.*"
              - method: DELETE
                path: "^/api/.*"
---
# API service policy
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: api-policy
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
    - fromEndpoints:
        - matchLabels:
            app: monitoring
      toPorts:
        - ports:
            - port: "9090"
              protocol: TCP
  egress:
    # Database
    - toEndpoints:
        - matchLabels:
            app: postgres
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
    # Redis cache
    - toEndpoints:
        - matchLabels:
            app: redis
      toPorts:
        - ports:
            - port: "6379"
              protocol: TCP
    # External payment provider
    - toFQDNs:
        - matchName: "api.stripe.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
    # DNS
    - toEndpoints:
        - matchLabels:
            "k8s:io.kubernetes.pod.namespace": kube-system
            "k8s:k8s-app": kube-dns
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
```

## Section 9: Policy Testing and Validation

### Testing Policies with Cilium CLI

```bash
#!/bin/bash
# test-policies.sh - Validate Cilium network policies

NAMESPACE="${1:-production}"

echo "=== Cilium Policy Validation ==="

# 1. Check that Cilium is healthy
echo "1. Cilium daemon health:"
kubectl -n kube-system exec ds/cilium -- cilium status
echo ""

# 2. Verify policies are loaded
echo "2. Loaded policies:"
kubectl -n kube-system exec ds/cilium -- cilium policy get | wc -l
echo "policies loaded"
echo ""

# 3. Check endpoint policy enforcement
echo "3. Endpoint policy enforcement status:"
kubectl -n kube-system exec ds/cilium -- \
    cilium endpoint list --output json | \
    jq -r '.[] | "\(.id)\t\(.labels | to_entries[] | select(.key|test("k8s:app")) | .value)\t\(.status.policy.spec.ingress.enforcing)"' | \
    column -t
echo ""

# 4. Simulate policy check
echo "4. Policy simulation (frontend → api on port 8080):"
FRONTEND_ID=$(kubectl -n ${NAMESPACE} get pod -l app=frontend \
    -o jsonpath='{.items[0].metadata.uid}')
API_ID=$(kubectl -n ${NAMESPACE} get pod -l app=api \
    -o jsonpath='{.items[0].metadata.uid}')

kubectl -n kube-system exec ds/cilium -- \
    cilium debuginfo 2>/dev/null | \
    grep -A5 "Policy state"

# 5. Live connectivity test
echo ""
echo "5. Live connectivity tests:"

# Frontend to API (should succeed)
echo -n "  frontend → api:8080: "
kubectl -n ${NAMESPACE} exec deploy/frontend -- \
    curl -s -o /dev/null -w "%{http_code}" \
    http://api.${NAMESPACE}.svc.cluster.local:8080/healthz --max-time 5 \
    2>/dev/null && echo "OK" || echo "FAILED"

# Frontend to database (should fail)
echo -n "  frontend → postgres:5432: "
kubectl -n ${NAMESPACE} exec deploy/frontend -- \
    timeout 3 bash -c "echo > /dev/tcp/postgres.${NAMESPACE}.svc.cluster.local/5432" \
    2>/dev/null && echo "ALLOWED (UNEXPECTED)" || echo "BLOCKED (EXPECTED)"

# API to external (should succeed via FQDN rule)
echo -n "  api → api.stripe.com:443: "
kubectl -n ${NAMESPACE} exec deploy/api -- \
    curl -s -o /dev/null -w "%{http_code}" \
    https://api.stripe.com --max-time 5 \
    2>/dev/null && echo "OK" || echo "FAILED"

# API to untrusted external (should fail - not in FQDN policy)
echo -n "  api → evil.com:443: "
kubectl -n ${NAMESPACE} exec deploy/api -- \
    curl -s -o /dev/null -w "%{http_code}" \
    https://evil.com --max-time 3 \
    2>/dev/null && echo "ALLOWED (UNEXPECTED)" || echo "BLOCKED (EXPECTED)"
```

## Section 10: Monitoring Policy Violations with Prometheus

```yaml
# cilium-alerts.yaml
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
        - alert: CiliumPolicyDropHigh
          expr: >
            rate(cilium_drop_count_total[5m]) > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High Cilium policy drop rate"
            description: "Cilium is dropping >100 packets/s. Reason: {{ $labels.reason }}. May indicate misconfigured policy or attack."

        - alert: CiliumEndpointNotReady
          expr: cilium_endpoint_state{state!="ready"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cilium endpoint not in ready state"
            description: "Endpoint {{ $labels.endpoint }} is in state {{ $labels.state }}."

        - alert: CiliumPolicyChangeHigh
          expr: rate(cilium_policy_change_total[5m]) > 10
          for: 2m
          labels:
            severity: info
          annotations:
            summary: "High Cilium policy change rate"
            description: "Cilium is applying >10 policy changes/s. May indicate operator issues or too-frequent policy updates."

        - alert: CiliumDNSRequestDropped
          expr: rate(cilium_forward_count_total{reason="forwardDenied"}[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cilium DNS requests being dropped"
            description: "DNS requests are being blocked by FQDN policy. Services may be unable to resolve external names."
```

Cilium's L7 policy capabilities transform Kubernetes network security from port-level filtering to application-aware enforcement. The combination of HTTP method/path filtering, FQDN-based egress, and Hubble's visibility layer provides the security depth and observability needed for zero-trust microservice architectures. Policy audit mode is the key operational tool that makes rolling out these policies safely in production environments practical.
