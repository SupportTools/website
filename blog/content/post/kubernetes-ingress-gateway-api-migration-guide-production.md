---
title: "Kubernetes Ingress to Gateway API Migration: Practical Guide with Nginx, Traefik, and Contour"
date: 2028-06-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "Ingress", "Nginx", "Traefik", "Migration"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to migrating from Kubernetes Ingress to Gateway API, covering HTTPRoute translation, implementation-specific configurations for Nginx, Traefik, and Contour, and zero-downtime migration strategies."
more_link: "yes"
url: "/kubernetes-ingress-gateway-api-migration-guide-production/"
---

The Kubernetes Gateway API reached GA in 1.0 in October 2023, and 1.2 in late 2024. If your team is still writing `networking.k8s.io/v1` Ingress resources, you are not missing anything critical today, but you are accumulating migration debt. The Gateway API solves real problems that Ingress never addressed: multi-tenancy with delegation, cross-namespace routing, traffic splitting at the API level, and a consistent extension model across ingress controllers.

This guide covers the concrete migration path: what maps to what, which Ingress annotations become HTTPRoute filters, and the specific implementation details for Nginx Ingress Controller, Traefik, and Contour.

<!--more-->

# Kubernetes Ingress to Gateway API Migration: Practical Guide with Nginx, Traefik, and Contour

## Section 1: Gateway API Architecture

### Core Resource Hierarchy

The Gateway API introduces three primary resources with a clear ownership model:

```
GatewayClass (cluster-scoped, owned by infrastructure team)
    └── Gateway (namespace-scoped, owned by platform team)
            └── HTTPRoute/TCPRoute/TLSRoute/GRPCRoute (namespace-scoped, owned by app teams)
```

This separation solves the Ingress multi-tenancy problem: previously, all routing was in a single `networking.k8s.io/v1/Ingress` resource, requiring either cluster admin access or a complex RBAC setup. With Gateway API, app teams own their HTTPRoutes and attach them to Gateways without needing to touch the Gateway configuration.

### Installing Gateway API CRDs

```bash
# Install standard channel CRDs (GA resources)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# Or install experimental channel (includes GRPCRoute, TCPRoute, etc.)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/experimental-install.yaml

# Verify CRDs
kubectl get crd | grep gateway.networking.k8s.io
# Expected:
# gatewayclasses.gateway.networking.k8s.io
# gateways.gateway.networking.k8s.io
# httproutes.gateway.networking.k8s.io
# referencegrants.gateway.networking.k8s.io
# grpcroutes.gateway.networking.k8s.io
```

## Section 2: Ingress to HTTPRoute Mapping

### Basic Routing

A simple Ingress resource:

```yaml
# BEFORE: Ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: api-backend
            port:
              number: 8080
      - path: /admin
        pathType: Exact
        backend:
          service:
            name: admin-backend
            port:
              number: 8080
  tls:
  - hosts:
    - api.example.com
    secretName: api-tls
```

Equivalent Gateway API resources:

```yaml
# AFTER: GatewayClass (cluster-scoped, created once by infra team)
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx
spec:
  controllerName: k8s.io/ingress-nginx
  description: "Nginx Ingress Controller Gateway"

---
# Gateway (namespace-scoped, managed by platform team)
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: main-gateway
  namespace: ingress-nginx
spec:
  gatewayClassName: nginx
  listeners:
  - name: http
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: All  # Allow routes from any namespace
  - name: https
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - name: api-tls
        namespace: production
    allowedRoutes:
      namespaces:
        from: All

---
# HTTPRoute (namespace-scoped, managed by app team)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: my-app
  namespace: production
spec:
  parentRefs:
  - name: main-gateway
    namespace: ingress-nginx
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /
    backendRefs:
    - name: api-backend
      port: 8080
      weight: 100
  - matches:
    - path:
        type: Exact
        value: /admin
    backendRefs:
    - name: admin-backend
      port: 8080
```

### Cross-Namespace Reference with ReferenceGrant

The Gateway API uses ReferenceGrant to explicitly authorize cross-namespace references. This prevents namespace tenants from referencing resources in namespaces they don't own:

```yaml
# Allow the ingress-nginx namespace to reference TLS secrets in production
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-gateway-tls
  namespace: production  # The namespace being accessed
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: Gateway
    namespace: ingress-nginx  # The namespace making the reference
  to:
  - group: ""
    kind: Secret
    name: api-tls  # Optional: restrict to specific resource name
```

## Section 3: Common Ingress Annotation Translations

### NGINX Ingress Annotations to HTTPRoute Filters

```yaml
# Annotation: nginx.ingress.kubernetes.io/rewrite-target: /$1
# With capture group regex: ^/api/(.*)$
# BEFORE:
annotations:
  nginx.ingress.kubernetes.io/rewrite-target: /$1
  nginx.ingress.kubernetes.io/use-regex: "true"
spec:
  rules:
  - http:
      paths:
      - path: /api/(.*)
        pathType: ImplementationSpecific

# AFTER: HTTPRoute URLRewrite filter
rules:
- matches:
  - path:
      type: PathPrefix
      value: /api
  filters:
  - type: URLRewrite
    urlRewrite:
      path:
        type: ReplacePrefixMatch
        replacePrefixMatch: /  # Strip /api prefix
  backendRefs:
  - name: api-backend
    port: 8080
```

```yaml
# Annotation: nginx.ingress.kubernetes.io/ssl-redirect: "true"
# BEFORE:
annotations:
  nginx.ingress.kubernetes.io/ssl-redirect: "true"

# AFTER: HTTPRoute redirect filter for HTTP -> HTTPS
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-redirect
  namespace: production
spec:
  parentRefs:
  - name: main-gateway
    namespace: ingress-nginx
    sectionName: http
  hostnames:
  - "api.example.com"
  rules:
  - filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
```

```yaml
# Annotation: nginx.ingress.kubernetes.io/add-headers
# BEFORE:
annotations:
  nginx.ingress.kubernetes.io/add-headers: "ingress-nginx/my-custom-headers"
# (with ConfigMap my-custom-headers containing: X-Custom-Header: "value")

# AFTER: HTTPRoute response headers filter
rules:
- matches:
  - path:
      type: PathPrefix
      value: /
  filters:
  - type: ResponseHeaderModifier
    responseHeaderModifier:
      add:
      - name: X-Custom-Header
        value: "value"
      - name: Strict-Transport-Security
        value: "max-age=31536000; includeSubDomains"
  backendRefs:
  - name: my-service
    port: 8080
```

```yaml
# Annotation: nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
# BEFORE:
annotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "60"

# AFTER: HTTPRoute timeout (requires implementation support)
rules:
- matches:
  - path:
      type: PathPrefix
      value: /
  timeouts:
    request: 60s
    backendRequest: 55s
  backendRefs:
  - name: my-service
    port: 8080
```

### Traffic Splitting (Canary Deployments)

```yaml
# BEFORE: Nginx Ingress canary annotations (limited)
# nginx.ingress.kubernetes.io/canary: "true"
# nginx.ingress.kubernetes.io/canary-weight: "20"

# AFTER: HTTPRoute with weighted backends (much cleaner)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: canary-deployment
  namespace: production
spec:
  parentRefs:
  - name: main-gateway
    namespace: ingress-nginx
    sectionName: https
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: api-stable
      port: 8080
      weight: 80    # 80% of traffic
    - name: api-canary
      port: 8080
      weight: 20    # 20% of traffic
```

```yaml
# Header-based canary routing
rules:
- matches:
  - path:
      type: PathPrefix
      value: /
    headers:
    - name: X-Canary
      value: "true"
  backendRefs:
  - name: api-canary
    port: 8080
- matches:
  - path:
      type: PathPrefix
      value: /
  backendRefs:
  - name: api-stable
    port: 8080
```

## Section 4: Nginx Ingress Controller Gateway API Implementation

### Installing Nginx with Gateway API Support

```bash
# Using Helm
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.config.enable-opentelemetry="true" \
  --set controller.replicaCount=3 \
  --set controller.gatewayAPI.enabled=true \
  --version 4.9.0
```

### Nginx Gateway Fabric (Separate Project)

For full Gateway API support, Nginx has a dedicated implementation called "Nginx Gateway Fabric":

```bash
# Install Nginx Gateway Fabric
kubectl apply -f https://github.com/nginxinc/nginx-gateway-fabric/releases/download/v1.3.0/crds.yaml
kubectl apply -f https://github.com/nginxinc/nginx-gateway-fabric/releases/download/v1.3.0/nginx-gateway.yaml

# Verify
kubectl get pods -n nginx-gateway
kubectl get gatewayclass nginx
```

```yaml
# GatewayClass for Nginx Gateway Fabric
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx
spec:
  controllerName: gateway.nginx.org/nginx-gateway-controller

---
# Gateway
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gw
  namespace: nginx-gateway
spec:
  gatewayClassName: nginx
  listeners:
  - name: http
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: "true"
  - name: https
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - name: wildcard-tls
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            gateway-access: "true"
```

### NginxProxy Policy (Implementation-Specific Extension)

```yaml
# Nginx-specific extension for upstream configuration
apiVersion: gateway.nginx.org/v1alpha1
kind: NginxProxy
metadata:
  name: production-proxy
  namespace: nginx-gateway
spec:
  telemetry:
    exporter:
      endpoint: otel-collector:4317
  ipFamily: dual
  disableHTTP2: false
  rewriteClientIP:
    mode: ProxyProtocol
    trustedAddresses:
    - type: CIDR
      value: 10.0.0.0/8

---
# Attach NginxProxy to Gateway
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gw
  namespace: nginx-gateway
  annotations:
    gateway.nginx.org/proxy: production-proxy
spec:
  # ...
```

## Section 5: Traefik Gateway API Implementation

### Installing Traefik with Gateway API

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update

helm install traefik traefik/traefik \
  --namespace traefik \
  --create-namespace \
  --set experimental.kubernetesGateway.enabled=true \
  --set providers.kubernetesGateway.enabled=true \
  --set ingressClass.enabled=true \
  --set ingressClass.isDefaultClass=false \
  --version 26.0.0
```

### Traefik GatewayClass and Gateway

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: traefik
spec:
  controllerName: traefik.io/gateway-controller

---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: traefik-gw
  namespace: traefik
spec:
  gatewayClassName: traefik
  listeners:
  - name: web
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: All
  - name: websecure
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: wildcard-tls
        namespace: traefik
    allowedRoutes:
      namespaces:
        from: All
```

### Traefik Middleware (Implementation Extension)

Traefik's middleware system integrates with Gateway API via annotations or its CRDs:

```yaml
# Traefik Middleware (implementation-specific)
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: strip-prefix
  namespace: production
spec:
  stripPrefix:
    prefixes:
    - /api

---
# Rate limiting middleware
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: rate-limit
  namespace: production
spec:
  rateLimit:
    average: 100
    period: 1s
    burst: 50

---
# Attach middleware via HTTPRoute annotation (Traefik-specific)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
  annotations:
    # Traefik-specific: reference middleware
    traefik.io/router.middlewares: production-strip-prefix@kubernetescrd,production-rate-limit@kubernetescrd
spec:
  parentRefs:
  - name: traefik-gw
    namespace: traefik
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api
  # Note: Traefik middleware applied via annotation, not HTTPRoute filter
    backendRefs:
    - name: api-backend
      port: 8080
```

## Section 6: Contour Gateway API Implementation

### Installing Contour with Gateway API

```bash
# Install Contour with Gateway API provisioner
kubectl apply -f https://projectcontour.io/quickstart/contour.yaml

# Or using Helm
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install contour bitnami/contour \
  --namespace projectcontour \
  --create-namespace \
  --set contour.enabled=true \
  --set envoy.enabled=true
```

### Contour GatewayClass with Provisioner

```yaml
# ContourDeployment parameters for dynamic provisioning
apiVersion: projectcontour.io/v1alpha1
kind: ContourDeployment
metadata:
  name: contour-gateway-provisioner
  namespace: projectcontour
spec:
  runtimeSettings:
    enableExternalNameService: false
  envoy:
    workloadType: DaemonSet
    networkPublishing:
      type: LoadBalancerService
      loadBalancer:
        scope: External
        providerParameters:
          type: AWS
          aws:
            type: NLB

---
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: contour
spec:
  controllerName: projectcontour.io/gateway-controller
  parametersRef:
    kind: ContourDeployment
    group: projectcontour.io
    name: contour-gateway-provisioner
    namespace: projectcontour

---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: contour-gw
  namespace: projectcontour
spec:
  gatewayClassName: contour
  listeners:
  - name: https
    protocol: HTTPS
    port: 443
    tls:
      mode: Terminate
      certificateRefs:
      - name: wildcard-tls
    allowedRoutes:
      namespaces:
        from: All
```

### Contour-Specific Extensions

```yaml
# HTTPProxy (Contour's native CRD) vs HTTPRoute comparison
# HTTPRoute (standard):
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: my-route
  namespace: production
spec:
  parentRefs:
  - name: contour-gw
    namespace: projectcontour
  hostnames:
  - "app.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
  # Contour supports ExtensionRef for Contour-specific policies
    filters:
    - type: ExtensionRef
      extensionRef:
        group: projectcontour.io
        kind: HTTPRequestRedirectPolicy
        name: force-https
    backendRefs:
    - name: my-service
      port: 8080

---
# Contour HTTPProxy (native, more feature-rich but non-standard)
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: my-proxy
  namespace: production
spec:
  virtualhost:
    fqdn: app.example.com
    tls:
      secretName: app-tls
    rateLimitPolicy:
      global:
        descriptors:
        - entries:
          - remoteAddress: {}
  routes:
  - conditions:
    - prefix: /api
    services:
    - name: api-backend
      port: 8080
    timeoutPolicy:
      response: 60s
      idle: 300s
    loadBalancerPolicy:
      strategy: RoundRobin
```

## Section 7: Zero-Downtime Migration Strategy

### Phase 1: Parallel Running

The safest migration runs Ingress and Gateway API resources simultaneously for a period:

```bash
#!/bin/bash
# Phase 1: Deploy Gateway API alongside existing Ingress

# 1. Install Gateway API CRDs
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml

# 2. Create GatewayClass (non-disruptive)
kubectl apply -f gateway-class.yaml

# 3. Create Gateway on a TEST host first
kubectl apply -f gateway.yaml

# 4. Create HTTPRoutes for low-traffic services first
# Use different hostnames (api-v2.example.com) for testing
kubectl apply -f httproutes-test.yaml

# 5. Validate the new route works
curl -v https://api-v2.example.com/health

# 6. Gradually migrate high-traffic services
# Use DNS weighted routing (Route53/Cloud DNS) to shift traffic
```

### Phase 2: Ingress to HTTPRoute Conversion Script

```bash
#!/usr/bin/env python3
"""
ingress-to-httproute.py
Convert Kubernetes Ingress resources to HTTPRoute resources
"""

import sys
import yaml
import json
from typing import Dict, Any, List

def convert_ingress_to_httproute(ingress: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Convert an Ingress resource to HTTPRoute + Gateway resources."""

    metadata = ingress.get("metadata", {})
    namespace = metadata.get("namespace", "default")
    name = metadata.get("name", "")
    annotations = metadata.get("annotations", {})
    spec = ingress.get("spec", {})

    rules = []
    for rule in spec.get("rules", []):
        hostname = rule.get("host", "")
        http = rule.get("http", {})

        for path in http.get("paths", []):
            path_value = path.get("path", "/")
            path_type = path.get("pathType", "Prefix")
            service = path.get("backend", {}).get("service", {})
            service_name = service.get("name", "")
            service_port = service.get("port", {}).get("number", 80)

            # Map pathType
            if path_type == "Exact":
                match_type = "Exact"
            else:
                match_type = "PathPrefix"

            route_rule = {
                "matches": [{
                    "path": {
                        "type": match_type,
                        "value": path_value
                    }
                }],
                "backendRefs": [{
                    "name": service_name,
                    "port": service_port
                }]
            }

            # Handle rewrite annotation
            rewrite_target = annotations.get("nginx.ingress.kubernetes.io/rewrite-target")
            if rewrite_target == "/":
                route_rule["filters"] = [{
                    "type": "URLRewrite",
                    "urlRewrite": {
                        "path": {
                            "type": "ReplacePrefixMatch",
                            "replacePrefixMatch": "/"
                        }
                    }
                }]

            rules.append(route_rule)

    # Build HTTPRoute
    httproute = {
        "apiVersion": "gateway.networking.k8s.io/v1",
        "kind": "HTTPRoute",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {
                "migrated-from": "ingress",
                "original-ingress": name
            }
        },
        "spec": {
            "parentRefs": [{
                "name": "main-gateway",
                "namespace": "ingress-nginx",
                "sectionName": "https"
            }],
            "hostnames": [rule.get("host") for rule in spec.get("rules", []) if rule.get("host")],
            "rules": rules
        }
    }

    return [httproute]


if __name__ == "__main__":
    for filename in sys.argv[1:]:
        with open(filename) as f:
            resources = list(yaml.safe_load_all(f))

        for resource in resources:
            if resource and resource.get("kind") == "Ingress":
                converted = convert_ingress_to_httproute(resource)
                for obj in converted:
                    print("---")
                    print(yaml.dump(obj, default_flow_style=False))
```

Usage:

```bash
# Convert all Ingress resources in a directory
find . -name "*.yaml" -exec python3 ingress-to-httproute.py {} \; > converted-httproutes.yaml

# Review converted resources
cat converted-httproutes.yaml

# Apply to cluster (test namespace first)
kubectl apply -f converted-httproutes.yaml -n test --dry-run=client
kubectl apply -f converted-httproutes.yaml
```

### Phase 3: Validation and Cutover

```bash
#!/bin/bash
# validate-migration.sh
# Verify HTTPRoute is working before removing Ingress

NAMESPACE="${1:-production}"
HTTPROUTE_NAME="${2}"

echo "=== Validating HTTPRoute: ${HTTPROUTE_NAME} in ${NAMESPACE} ==="

# Check HTTPRoute status
kubectl get httproute ${HTTPROUTE_NAME} -n ${NAMESPACE} -o yaml | \
  yq '.status.parents[].conditions'

# Check for accepted status
ACCEPTED=$(kubectl get httproute ${HTTPROUTE_NAME} -n ${NAMESPACE} \
  -o jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}')

RESOLVED=$(kubectl get httproute ${HTTPROUTE_NAME} -n ${NAMESPACE} \
  -o jsonpath='{.status.parents[0].conditions[?(@.type=="ResolvedRefs")].status}')

if [ "${ACCEPTED}" = "True" ] && [ "${RESOLVED}" = "True" ]; then
    echo "[PASS] HTTPRoute is accepted and refs are resolved"
else
    echo "[FAIL] HTTPRoute status issue:"
    echo "  Accepted: ${ACCEPTED}"
    echo "  ResolvedRefs: ${RESOLVED}"
    kubectl describe httproute ${HTTPROUTE_NAME} -n ${NAMESPACE}
    exit 1
fi

# Test endpoint
HOSTNAME=$(kubectl get httproute ${HTTPROUTE_NAME} -n ${NAMESPACE} \
  -o jsonpath='{.spec.hostnames[0]}')

if curl -sf --max-time 5 -H "Host: ${HOSTNAME}" \
    https://$(kubectl get gateway main-gateway -n ingress-nginx \
      -o jsonpath='{.status.addresses[0].value}')/health; then
    echo "[PASS] Endpoint is responding"
else
    echo "[FAIL] Endpoint not responding"
    exit 1
fi

echo ""
echo "Migration validated. Safe to remove original Ingress resource."
echo "Command: kubectl delete ingress ${HTTPROUTE_NAME} -n ${NAMESPACE}"
```

## Section 8: Multi-Cluster and Advanced Patterns

### GRPCRoute for gRPC Services

```yaml
# GRPCRoute (experimental channel, GA in v1.1)
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: GRPCRoute
metadata:
  name: grpc-service
  namespace: production
spec:
  parentRefs:
  - name: main-gateway
    namespace: ingress-nginx
    sectionName: grpc
  hostnames:
  - "grpc-api.example.com"
  rules:
  - matches:
    - method:
        service: myorg.v1.UserService
        method: GetUser
  # Exact method matching
    backendRefs:
    - name: user-service
      port: 50051
  - matches:
    - method:
        service: myorg.v1.UserService
        # No method: matches all methods in service
    backendRefs:
    - name: user-service
      port: 50051
```

### TCPRoute for Non-HTTP Services

```yaml
# TCPRoute (experimental)
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata:
  name: postgres-route
  namespace: databases
spec:
  parentRefs:
  - name: main-gateway
    namespace: ingress-nginx
    sectionName: postgres  # Port 5432
  rules:
  - backendRefs:
    - name: postgres-primary
      port: 5432
```

### PolicyAttachment Pattern

Gateway API uses PolicyAttachment for cross-cutting concerns like timeouts, rate limiting, and auth:

```yaml
# Example: BackendLBPolicy (load balancing configuration)
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: BackendLBPolicy
metadata:
  name: api-lb-policy
  namespace: production
spec:
  targetRef:
    group: ""
    kind: Service
    name: api-backend
  sessionPersistence:
    sessionName: session_id
    type: Cookie
    cookieConfig:
      lifetimeType: Session

---
# BackendTLSPolicy (upstream TLS)
apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: backend-tls
  namespace: production
spec:
  targetRefs:
  - kind: Service
    name: secure-backend
    port: 8443
  validation:
    caCertificateRefs:
    - kind: ConfigMap
      name: ca-bundle
    hostname: secure-backend.production.svc.cluster.local
```

## Section 9: Migration Checklist and Key Takeaways

### Pre-Migration Checklist

```bash
# 1. Verify Gateway API CRDs are installed
kubectl get crd | grep gateway.networking.k8s.io | wc -l
# Expected: 5 or more

# 2. Verify your ingress controller supports Gateway API
# Check implementation support: https://gateway-api.sigs.k8s.io/implementations/

# 3. Audit all Ingress resources
kubectl get ingress -A -o json | jq '
  .items[] |
  {
    namespace: .metadata.namespace,
    name: .metadata.name,
    class: .spec.ingressClassName,
    hosts: [.spec.rules[].host],
    annotations: (.metadata.annotations | keys)
  }
'

# 4. Identify non-standard annotations that need implementation-specific handling
kubectl get ingress -A -o json | jq -r '
  .items[].metadata.annotations |
  to_entries[] |
  select(.key | startswith("nginx.ingress.kubernetes.io")) |
  .key
' | sort -u
```

### Key Migration Rules

- **GatewayClass** replaces `spec.ingressClassName` - one per ingress controller type
- **Gateway** listeners replace the `spec.tls` section of Ingress - one per entry point
- **HTTPRoute hostnames** replace `spec.rules[].host` - multiple hostnames per route supported
- **HTTPRoute matches path** replaces `spec.rules[].http.paths[].path` with richer options
- **HTTPRoute backendRefs weight** replaces canary annotations - native traffic splitting
- **ReferenceGrant** is required for cross-namespace Secret references from Gateways
- **Accepted+ResolvedRefs=True** in HTTPRoute status means the route is active
- Run Ingress and HTTPRoute in parallel during migration - they are independent
- Most implementation-specific Ingress annotations become HTTPRoute filters or implementation CRDs
- Test with low-traffic services and shadow traffic before migrating critical paths
