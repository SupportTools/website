---
title: "Kubernetes Istio Authorization Policies: Fine-Grained Access Control in Service Meshes"
date: 2031-02-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Istio", "Service Mesh", "Security", "Authorization", "mTLS", "JWT"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Istio AuthorizationPolicy covering ALLOW/DENY semantics, source principal matching, request-level conditions, JWT claim-based authorization, ambient mesh authorization, and debugging 403 responses."
more_link: "yes"
url: "/kubernetes-istio-authorization-policies-service-mesh-access-control/"
---

Istio's AuthorizationPolicy resource provides fine-grained, identity-aware access control for service-to-service and end-user-to-service communication within a Kubernetes cluster. Understanding the policy evaluation semantics, combining mTLS identity matching with JWT claim inspection, and debugging authorization failures are essential skills for securing production service meshes.

<!--more-->

# Kubernetes Istio Authorization Policies: Fine-Grained Access Control in Service Meshes

## Authorization Policy Overview

Istio's authorization system operates at the Envoy proxy level (sidecar or ambient ztunnel/waypoint). Authorization policies are evaluated for every request, regardless of protocol — HTTP, gRPC, TCP, or raw TCP.

The policy evaluation model is:

1. If any DENY policy matches the request: **DENY**
2. If no ALLOW policies exist in the namespace: **ALLOW** (default permit if no policy)
3. If any ALLOW policies exist: **DENY unless one ALLOW policy matches**

This means: the presence of any ALLOW policy in a namespace implicitly denies everything not explicitly permitted.

```yaml
# The simplest possible policy: deny all traffic to the productpage service
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-all-to-productpage
  namespace: production
spec:
  selector:
    matchLabels:
      app: productpage
  action: DENY
  rules:
    - {}   # Empty rule matches everything
```

```yaml
# Allow-nothing policy: install this to enforce zero-trust in a namespace
# After this, you MUST create ALLOW policies for each required communication path
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-all
  namespace: production
spec:
  {}   # No selector = applies to all workloads in namespace
  # No rules = deny all (when action defaults to ALLOW with no rules, it allows nothing
  # when there are no rules under an ALLOW action)
```

## Section 1: ALLOW and DENY Policy Semantics

### ALLOW Policy — Whitelist Model

```yaml
# Allow only the frontend service to access the backend API service
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-frontend-to-api
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-service
  action: ALLOW
  rules:
    - from:
        - source:
            # Match the service account used by the frontend Pod
            principals:
              - "cluster.local/ns/production/sa/frontend-service-account"
      to:
        - operation:
            # Only allow GET and POST to the /api/* path
            methods: ["GET", "POST"]
            paths: ["/api/*"]
```

### DENY Policy — Blacklist Model

DENY policies are evaluated first and take precedence over ALLOW policies:

```yaml
# Deny all external traffic to the database service
# This cannot be overridden by ALLOW policies
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-external-to-database
  namespace: production
spec:
  selector:
    matchLabels:
      app: postgresql
  action: DENY
  rules:
    - from:
        - source:
            # Deny traffic from outside the production namespace
            notNamespaces:
              - production
```

```yaml
# DENY then ALLOW interaction example:
# Even if an ALLOW policy permits traffic from service-a,
# a DENY policy that matches will override it.

# Policy 1: DENY all DELETE operations
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-delete-operations
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-service
  action: DENY
  rules:
    - to:
        - operation:
            methods: ["DELETE"]
---
# Policy 2: ALLOW frontend service (DELETE would still be denied by Policy 1)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-frontend
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-service
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/frontend"
      to:
        - operation:
            methods: ["GET", "POST", "PUT", "DELETE"]
# Result: frontend can GET/POST/PUT but NOT DELETE (DENY takes precedence)
```

## Section 2: Source Principal Matching

### SPIFFE Identity Principals

In an mTLS-enabled mesh, every workload has a SPIFFE identity in the form:
`cluster.local/ns/<namespace>/sa/<service-account>`

```yaml
# Match specific service accounts
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: api-access-policy
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-service
  action: ALLOW
  rules:
    # Allow frontend-v1 and frontend-v2 service accounts
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/frontend-v1"
              - "cluster.local/ns/production/sa/frontend-v2"

    # Allow any service account in the monitoring namespace
    - from:
        - source:
            namespaces:
              - monitoring
            principals:
              - "cluster.local/ns/monitoring/sa/prometheus"
              - "cluster.local/ns/monitoring/sa/jaeger-collector"

    # Allow any service in the same namespace with a specific label
    # (labels are not directly matchable via principal — use service account instead)
    - from:
        - source:
            namespaces:
              - production
```

### Wildcard and Negation in Principals

```yaml
# Use wildcards and negation in principal matching
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: cross-namespace-policy
  namespace: production
spec:
  selector:
    matchLabels:
      app: shared-service
  action: ALLOW
  rules:
    - from:
        - source:
            # Match any principal from any namespace (wildcard)
            principals:
              - "*"
            # But exclude the untrusted namespace
            notNamespaces:
              - untrusted-namespace

    # Alternative: explicitly allow only certain namespaces
    - from:
        - source:
            # Prefix match: allow any service account from production/* namespaces
            principals:
              - "cluster.local/ns/production/*"
              - "cluster.local/ns/staging/*"
```

### Cluster-Level Principal Matching

```yaml
# For multi-cluster setups with trust domain federation
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: multi-cluster-access
  namespace: production
spec:
  selector:
    matchLabels:
      app: global-service
  action: ALLOW
  rules:
    - from:
        - source:
            # Allow from peer cluster's trust domain
            principals:
              - "cluster-east.example.com/ns/production/sa/frontend"
              - "cluster-west.example.com/ns/production/sa/frontend"
```

## Section 3: Request-Level Conditions

### HTTP Method and Path Matching

```yaml
# Fine-grained request control for a REST API
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: rest-api-access-control
  namespace: production
spec:
  selector:
    matchLabels:
      app: product-catalog
  action: ALLOW
  rules:
    # Read-only access for catalog-reader service accounts
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/catalog-reader"
      to:
        - operation:
            methods: ["GET", "HEAD"]
            paths: ["/api/v1/products*", "/api/v1/categories*"]

    # Read-write access for catalog-writer service accounts
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/catalog-writer"
      to:
        - operation:
            methods: ["GET", "POST", "PUT", "PATCH"]
            paths: ["/api/v1/products*", "/api/v1/categories*"]
            # Note: DELETE is not included — implicitly denied

    # Admin access (full CRUD including DELETE)
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/catalog-admin"
      to:
        - operation:
            methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
            paths: ["/api/v1/*", "/admin/*"]
```

### Request Header Matching

```yaml
# Match based on HTTP request headers
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: header-based-access
  namespace: production
spec:
  selector:
    matchLabels:
      app: feature-service
  action: ALLOW
  rules:
    # Allow requests with specific API version header
    - from:
        - source:
            namespaces: ["production"]
      to:
        - operation:
            methods: ["GET", "POST"]
      when:
        - key: request.headers[x-api-version]
          values: ["v2", "v3"]

    # Allow requests from specific internal service (identified by header)
    - from:
        - source:
            principals: ["cluster.local/ns/production/sa/gateway"]
      to:
        - operation:
            paths: ["/internal/*"]
      when:
        - key: request.headers[x-internal-caller]
          values: ["true"]
```

### Destination Port Matching

```yaml
# Restrict access based on destination port (for multi-port services)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: port-based-access
  namespace: production
spec:
  selector:
    matchLabels:
      app: multi-port-service
  action: ALLOW
  rules:
    # HTTP API traffic: port 8080
    - from:
        - source:
            namespaces: ["production"]
      to:
        - operation:
            ports: ["8080"]

    # Internal gRPC: port 9090, only from specific service
    - from:
        - source:
            principals: ["cluster.local/ns/production/sa/grpc-client"]
      to:
        - operation:
            ports: ["9090"]

    # Admin interface: port 9091, only from ops namespace
    - from:
        - source:
            namespaces: ["ops"]
      to:
        - operation:
            ports: ["9091"]
```

## Section 4: JWT Claim-Based Authorization

### Configuring RequestAuthentication

Before JWT-based authorization policies can work, the JWT must be validated. `RequestAuthentication` handles JWT validation:

```yaml
# RequestAuthentication: validate JWTs from the auth provider
apiVersion: security.istio.io/v1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-gateway
  jwtRules:
    - issuer: "https://auth.example.com"
      jwksUri: "https://auth.example.com/.well-known/jwks.json"
      # Cache JWKS for 24 hours
      jwksFetchIntervalDays: 1
      # Forward the JWT to upstream services (for use in authorization)
      forwardOriginalToken: true
      # Audience validation
      audiences:
        - "api.example.com"
      # Location of the JWT (default is Authorization header)
      fromHeaders:
        - name: Authorization
          prefix: "Bearer "
      fromParams:
        - "token"
```

### AuthorizationPolicy with JWT Claims

```yaml
# Authorize based on JWT claims
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: jwt-claim-authorization
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-gateway
  action: ALLOW
  rules:
    # Admin users: full access
    - when:
        - key: request.auth.claims[role]
          values: ["admin"]

    # Regular users: read access only
    - to:
        - operation:
            methods: ["GET"]
      when:
        - key: request.auth.claims[role]
          values: ["user", "viewer"]

    # Service accounts: allow with either JWT or mTLS principal
    - from:
        - source:
            principals: ["cluster.local/ns/production/sa/service-worker"]
      to:
        - operation:
            paths: ["/internal/*"]

    # Premium users: access to premium endpoints
    - to:
        - operation:
            paths: ["/api/premium/*"]
      when:
        - key: request.auth.claims[tier]
          values: ["premium", "enterprise"]
        # Also require the JWT is not expired (Istio handles this, but the claim check is explicit)
        - key: request.auth.claims[email_verified]
          values: ["true"]
```

### Complex JWT Claim Matching

```yaml
# Multiple claim conditions with AND/OR semantics
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: complex-jwt-policy
  namespace: production
spec:
  selector:
    matchLabels:
      app: data-service
  action: ALLOW
  rules:
    # Rule 1: Data analysts with READ_DATA permission
    # Both conditions must be true (AND within a single rule)
    - when:
        - key: request.auth.claims[department]
          values: ["data-engineering", "analytics"]
        - key: request.auth.claims[permissions]
          values: ["READ_DATA"]
      to:
        - operation:
            methods: ["GET"]
            paths: ["/api/data/*"]

    # Rule 2: ETL service account with write access
    # (separate rule = OR logic with Rule 1)
    - from:
        - source:
            principals: ["cluster.local/ns/production/sa/etl-service"]
      when:
        - key: request.auth.claims[scope]
          values: ["data:write"]
      to:
        - operation:
            methods: ["POST", "PUT"]
            paths: ["/api/data/*"]

    # Rule 3: Tenant isolation — users can only access their tenant's data
    - to:
        - operation:
            paths: ["/api/tenant/*"]
      when:
        - key: request.auth.claims[tenant_id]
          # This doesn't support dynamic matching to path params in the same rule
          # For tenant isolation, use external authorization (OPA/custom ext-authz)
          notValues: [""]  # Require tenant_id claim to be present and non-empty
```

## Section 5: Namespace-Wide and Mesh-Wide Policies

### Namespace-Wide Zero-Trust Baseline

```yaml
# Apply to all workloads in the production namespace
# Step 1: Install a deny-all baseline
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-all
  namespace: production
spec: {}
---
# Step 2: Allow intra-namespace traffic for services in the same namespace
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-same-namespace
  namespace: production
spec:
  action: ALLOW
  rules:
    - from:
        - source:
            namespaces: ["production"]
---
# Step 3: Allow health check probes from kubelet
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-health-checks
  namespace: production
spec:
  action: ALLOW
  rules:
    - to:
        - operation:
            paths: ["/healthz", "/readyz", "/livez"]
            methods: ["GET"]
```

### Mesh-Wide Policy in istio-system

```yaml
# Policy in istio-system applies to all namespaces in the mesh
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: mesh-wide-deny-sensitive-headers
  namespace: istio-system
spec:
  action: DENY
  rules:
    # Deny requests that try to inject internal headers from outside the mesh
    - from:
        - source:
            notPrincipals: ["*"]  # No valid mTLS certificate = external request
      to:
        - operation:
            # Block external requests that include internal routing headers
            headers:
              - name: x-internal-caller
                exact: "true"
```

## Section 6: Ambient Mesh Authorization

### Authorization in Ambient Mode

Ambient mesh replaces sidecars with a node-level ztunnel for L4 mTLS and optional waypoint proxies for L7 policies. Authorization policies work differently:

```yaml
# L4 authorization via ztunnel (no waypoint needed)
# This policy is enforced at the ztunnel level for all traffic
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: l4-tcp-allow
  namespace: production
spec:
  targetRefs:
    - kind: Service
      group: ""
      name: database-service
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/api-service"
      to:
        - operation:
            ports: ["5432"]
```

```yaml
# L7 authorization requires a waypoint proxy
# First, create the waypoint
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-waypoint
  namespace: production
  labels:
    istio.io/waypoint-for: service
spec:
  gatewayClassName: istio-waypoint
  listeners:
    - name: mesh
      port: 15008
      protocol: HBONE
---
# Configure the service to use the waypoint
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  labels:
    # This label routes traffic through the waypoint for L7 inspection
    istio.io/use-waypoint: production-waypoint
spec:
  selector:
    app: api-service
  ports:
    - port: 8080
---
# L7 AuthorizationPolicy now works for this service
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: api-service-l7-policy
  namespace: production
spec:
  targetRefs:
    - kind: Service
      group: ""
      name: api-service
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/frontend"
      to:
        - operation:
            methods: ["GET", "POST"]
            paths: ["/api/*"]
```

## Section 7: Debugging 403 Authorization Failures

### Enabling Authorization Logging

```bash
# Enable debug logging for a specific pod's Envoy proxy
kubectl exec -n production deployment/api-service -- \
    curl -X POST "http://localhost:15000/logging?rbac=debug"

# View the authorization logs
kubectl logs -n production deployment/api-service -c istio-proxy | grep "RBAC"
```

### Using istioctl analyze

```bash
# Analyze authorization policies for issues
istioctl analyze -n production --all-namespaces

# Check if there are any conflicting or overly broad policies
istioctl analyze -f ./authorization-policies.yaml

# Example output:
# Warning [IST0001] (AuthorizationPolicy deny-all production)
# No matching workloads for this resource.
```

### The istioctl authz check Command

```bash
# Check what policies apply to a specific pod
istioctl authz check <pod-name> -n production

# Simulate an authorization decision
istioctl authz check <pod-name> -n production \
    --header "x-forwarded-for: 10.0.0.1" \
    --method GET \
    --path /api/products

# Check policies for a service-to-service request
istioctl authz check \
    --sourceWorkload production/frontend-deployment \
    --destWorkload production/api-service \
    --method POST \
    --path /api/v1/orders
```

### Understanding Envoy RBAC Filter Logs

```bash
# Get detailed RBAC decision logs
kubectl logs -n production pod/api-service-7d6c5f9d4b-xk9p2 -c istio-proxy 2>&1 | \
    grep -i "rbac\|authz" | tail -50

# Example log line for a denied request:
# [2031-02-18T10:00:00.000Z] "POST /api/v1/orders HTTP/1.1" 403 UAEX
# - "-" 0 19 1 1 "-" "frontend/1.0" "abc123" "api-service:8080" "-"
#
# UAEX = Unauthorized Access Extension (denied by RBAC filter)

# Enable access logging to see all decisions
kubectl exec -n production deployment/api-service -- \
    curl -X POST "http://localhost:15000/logging?connection=trace"
```

### Debugging Tool: Authorization Policy Test

```bash
#!/bin/bash
# test-authz.sh - Test authorization policies interactively

NAMESPACE="${1:-production}"
SOURCE_SA="${2:-frontend}"
DEST_SERVICE="${3:-api-service}"
METHOD="${4:-GET}"
PATH="${5:-/api/v1/products}"

echo "=== Authorization Test ==="
echo "Namespace:    $NAMESPACE"
echo "Source SA:    $SOURCE_SA"
echo "Destination:  $DEST_SERVICE"
echo "Method:       $METHOD"
echo "Path:         $PATH"
echo ""

# Find a pod for the source service account
SOURCE_POD=$(kubectl get pods -n "${NAMESPACE}" \
    -l "app=${SOURCE_SA}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

if [ -z "${SOURCE_POD}" ]; then
    echo "ERROR: No pod found for service ${SOURCE_SA} in namespace ${NAMESPACE}"
    exit 1
fi

echo "Testing from pod: ${SOURCE_POD}"

# Find the destination service's cluster IP
DEST_IP=$(kubectl get service "${DEST_SERVICE}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.clusterIP}')
DEST_PORT=$(kubectl get service "${DEST_SERVICE}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.ports[0].port}')

echo "Destination IP:Port: ${DEST_IP}:${DEST_PORT}"
echo ""

# Make the test request
echo "Making request..."
kubectl exec -n "${NAMESPACE}" "${SOURCE_POD}" -- \
    curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" \
    -X "${METHOD}" \
    "http://${DEST_IP}:${DEST_PORT}${PATH}"

echo ""
echo "=== Applicable AuthorizationPolicies ==="
kubectl get authorizationpolicies -n "${NAMESPACE}" \
    -o custom-columns="NAME:.metadata.name,ACTION:.spec.action,SELECTOR:.spec.selector"
```

### Common Debugging Scenarios

```bash
# Scenario 1: Service gets 403 despite having an ALLOW policy

# Check if the PeerAuthentication (mTLS mode) is configured correctly
kubectl get peerauthentication -n production
kubectl get peerauthentication -n istio-system

# If PeerAuthentication requires STRICT mTLS, clients without sidecars get 403
# Solution: ensure all pods in the source namespace have Istio sidecars
kubectl get pods -n production -o custom-columns="NAME:.metadata.name,SIDECARS:.spec.containers[*].name"

# Scenario 2: JWT validation fails (claims are empty)

# Check that RequestAuthentication is applied to the correct workload
kubectl get requestauthentication -n production -o yaml

# Verify the JWKS URI is accessible from the Istio control plane
kubectl exec -n istio-system deployment/istiod -- \
    curl -s "https://auth.example.com/.well-known/jwks.json" | jq .

# Scenario 3: Policy applies to wrong workload

# List all policies and their selectors
kubectl get authorizationpolicies -A \
    -o custom-columns="NAMESPACE:.metadata.namespace,NAME:.metadata.name,SELECTOR:.spec.selector.matchLabels"

# Verify the workload labels match the policy selector
kubectl get pods -n production --show-labels | grep "app=api-service"

# Scenario 4: DENY policy blocking expected traffic

# List all DENY policies that might affect the service
kubectl get authorizationpolicies -A \
    -o jsonpath='{range .items[?(@.spec.action=="DENY")]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'
```

## Section 8: Production AuthorizationPolicy Patterns

### Complete Microservices Example

```yaml
# production-authz-policies.yaml
# Complete authorization policy set for a 3-tier application

---
# ===== Frontend tier =====

# Ingress gateway can access the frontend
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-ingress-to-frontend
  namespace: production
spec:
  selector:
    matchLabels:
      app: frontend
      tier: presentation
  action: ALLOW
  rules:
    - from:
        - source:
            namespaces: ["istio-ingress"]
      to:
        - operation:
            methods: ["GET", "POST"]
            paths: ["/*"]
    # Health checks from kubelet (unauthenticated)
    - to:
        - operation:
            methods: ["GET"]
            paths: ["/health", "/ready"]

---
# ===== API tier =====

# Frontend can call API
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-frontend-to-api
  namespace: production
spec:
  selector:
    matchLabels:
      app: api
      tier: business
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/frontend"
      to:
        - operation:
            methods: ["GET", "POST", "PUT", "PATCH"]
            paths: ["/api/v1/*"]

    # Prometheus can scrape metrics
    - from:
        - source:
            principals:
              - "cluster.local/ns/monitoring/sa/prometheus"
      to:
        - operation:
            methods: ["GET"]
            paths: ["/metrics"]

---
# ===== Database tier =====

# Only the API tier can access the database
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-api-to-database
  namespace: production
spec:
  selector:
    matchLabels:
      app: postgresql
      tier: data
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/production/sa/api"
      to:
        - operation:
            ports: ["5432"]

---
# ===== Cross-cutting: allow monitoring from the monitoring namespace =====

apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-monitoring-scrape
  namespace: production
spec:
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/monitoring/sa/prometheus"
              - "cluster.local/ns/monitoring/sa/jaeger-collector"
      to:
        - operation:
            methods: ["GET"]
            paths: ["/metrics", "/actuator/prometheus"]
            ports: ["9090", "15020"]
```

### Using Conditions for Tenant Isolation

```yaml
# Tenant isolation using request headers (set by API gateway after JWT validation)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: tenant-isolation-policy
  namespace: production
spec:
  selector:
    matchLabels:
      app: multi-tenant-service
  action: ALLOW
  rules:
    # Service-to-service traffic: authenticated via mTLS, no tenant header needed
    - from:
        - source:
            namespaces: ["production"]
            principals: ["cluster.local/ns/production/sa/internal-*"]
      to:
        - operation:
            paths: ["/internal/*"]

    # End-user traffic: must have tenant header set by API gateway
    - from:
        - source:
            principals: ["cluster.local/ns/production/sa/api-gateway"]
      to:
        - operation:
            methods: ["GET", "POST", "PUT", "DELETE"]
      when:
        # Tenant header must be present (set by gateway from JWT claim)
        - key: request.headers[x-tenant-id]
          notValues: [""]
```

## Section 9: AuthorizationPolicy Best Practices

```bash
# 1. Start with deny-all and add explicit ALLOW policies

# 2. Use namespace-level policies for broad defaults
# and workload-level policies for specific overrides

# 3. Always test policies before applying to production
istioctl analyze -f ./new-policy.yaml

# 4. Monitor policy changes with audit logging
kubectl get events -n production --field-selector reason=PolicyViolation

# 5. Use kiali for visual policy verification
kubectl port-forward svc/kiali -n istio-system 20001:20001
# Open http://localhost:20001 and navigate to Graph -> Security

# 6. Verify policies are actually being enforced (not in audit mode)
kubectl get authorizationpolicies -n production \
    -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.action}{"\n"}{end}'

# 7. Document every policy with annotations
kubectl annotate authorizationpolicy allow-frontend-to-api \
    -n production \
    "policy.example.com/owner=platform-team" \
    "policy.example.com/last-reviewed=2031-02-18" \
    "policy.example.com/ticket=INFRA-1234"
```

## Conclusion

Istio's AuthorizationPolicy provides a flexible, identity-aware access control layer that operates at the data plane level with minimal performance overhead. The key to effective policy management is understanding the DENY-before-ALLOW evaluation order, using the deny-all + explicit-allow pattern for new namespaces, combining mTLS source principal matching with JWT claim inspection for layered security, and maintaining a robust debugging workflow for diagnosing 403 responses. In ambient mesh mode, L7 policies require waypoint proxies, which adds a deployment step but maintains the same policy semantics. With these patterns in place, your service mesh authorization model is both secure and maintainable as the number of services and teams grows.
