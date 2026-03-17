---
title: "Zero Trust Service Mesh: mTLS, SPIFFE, and Workload Identity"
date: 2028-01-06T00:00:00-05:00
draft: false
tags: ["Service Mesh", "Zero Trust", "mTLS", "SPIFFE", "SPIRE", "Istio", "Linkerd", "Security"]
categories:
- Kubernetes
- Security
- Service Mesh
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into zero trust service mesh architecture covering SPIFFE/SPIRE workload identity, X.509 SVID rotation, Istio and Linkerd mTLS configuration, mesh-level authorization policies, and inter-cluster trust federation."
more_link: "yes"
url: "/servicemesh-zero-trust-mtls-guide/"
---

Zero trust networking rejects the assumption that workloads inside a perimeter are trustworthy. Every service-to-service communication must be authenticated, authorized, and encrypted regardless of network location. Service meshes operationalize zero trust by managing cryptographic identity for workloads, enforcing mutual TLS (mTLS) on every connection, and applying authorization policies at the transport layer. This guide examines the SPIFFE/SPIRE identity framework, X.509 SVID lifecycle management, and the concrete configuration required to achieve zero trust in Istio and Linkerd deployments.

<!--more-->

# Zero Trust Service Mesh: mTLS, SPIFFE, and Workload Identity

## Section 1: Zero Trust Principles for Kubernetes Workloads

Traditional perimeter security grants implicit trust to traffic originating inside a cluster network. A compromised pod in namespace A can freely reach services in namespace B unless explicit network policies restrict that path. Zero trust eliminates implicit trust by requiring:

1. **Cryptographic workload identity**: Every workload has a cryptographically verifiable identity, not just an IP address.
2. **Mutual authentication**: Both client and server verify each other's identity before exchanging data.
3. **Least-privilege authorization**: Workloads can only communicate with explicitly permitted peers.
4. **Encryption in transit**: All traffic is encrypted regardless of whether it crosses a trust boundary.
5. **Continuous verification**: Certificates are short-lived and rotate automatically.

Service meshes implement these properties through a sidecar proxy (Envoy in Istio, linkerd-proxy in Linkerd) that intercepts all network traffic and applies the configured policies transparently to the application.

## Section 2: SPIFFE and SPIRE Architecture

### SPIFFE Standard

SPIFFE (Secure Production Identity Framework for Everyone) defines:

- **SPIFFE ID**: A URI uniquely identifying a workload. Format: `spiffe://<trust-domain>/<workload-path>`
- **SVID (SPIFFE Verifiable Identity Document)**: The credential issued to a workload, implemented as an X.509 certificate or JWT token.
- **Trust bundle**: A set of CA certificates that validators use to verify SVIDs.
- **Workload API**: A gRPC API that workloads call to obtain their SVID.

Example SPIFFE IDs in Kubernetes:
```
spiffe://cluster.local/ns/production/sa/api-server
spiffe://cluster.local/ns/production/sa/database-client
spiffe://cluster.local/ns/ingress/sa/nginx-ingress
```

### SPIRE Architecture

SPIRE (SPIFFE Runtime Environment) is the reference implementation of SPIFFE. It consists of:

- **SPIRE Server**: Root CA and registration authority. Manages registration entries and issues SVIDs.
- **SPIRE Agent**: Node-level daemon. Attests nodes to the server, then attests workloads locally and delivers SVIDs via the Workload API.

```
┌─────────────────────────────────────────────────────┐
│                    Kubernetes Node                   │
│                                                      │
│  ┌────────────────┐     ┌───────────────────────┐   │
│  │  SPIRE Agent   │────▶│  Workload API (Unix   │   │
│  │  (DaemonSet)   │     │  domain socket)       │   │
│  └───────┬────────┘     └──────────┬────────────┘   │
│          │ node attestation         │ SVID request   │
│          ▼                          ▼                │
│  ┌────────────────┐     ┌───────────────────────┐   │
│  │  SPIRE Server  │     │  Application Sidecar  │   │
│  │  (StatefulSet) │     │  (Envoy/linkerd-proxy)│   │
│  └────────────────┘     └───────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Installing SPIRE on Kubernetes

```bash
# Clone SPIRE k8s quickstart
git clone https://github.com/spiffe/spire-tutorials.git
cd spire-tutorials/k8s/quickstart

# Apply SPIRE Server configuration
kubectl apply -f spire-namespace.yaml
kubectl apply -f server-account.yaml
kubectl apply -f spire-bundle-configmap.yaml
kubectl apply -f server-cluster-role.yaml
kubectl apply -f server-configmap.yaml
kubectl apply -f server-statefulset.yaml
kubectl apply -f server-service.yaml

# Apply SPIRE Agent configuration
kubectl apply -f agent-account.yaml
kubectl apply -f agent-cluster-role.yaml
kubectl apply -f agent-configmap.yaml
kubectl apply -f agent-daemonset.yaml
```

### SPIRE Server Configuration

```hcl
# spire-server-configmap.yaml data section
server {
  bind_address    = "0.0.0.0"
  bind_port       = "8081"
  trust_domain    = "cluster.local"
  data_dir        = "/run/spire/server/data"
  log_level       = "INFO"
  log_format      = "json"

  # Short-lived SVIDs for zero trust
  default_x509_svid_ttl = "1h"
  default_jwt_svid_ttl  = "5m"

  ca_subject {
    country         = ["US"]
    organization    = ["SPIRE"]
    common_name     = "cluster.local"
  }

  ca_ttl = "24h"
}

plugins {
  DataStore "sql" {
    plugin_data {
      database_type   = "sqlite3"
      connection_string = "/run/spire/server/data/datastore.sqlite3"
    }
  }

  NodeAttestor "k8s_psat" {
    plugin_data {
      clusters = {
        "prod-cluster" = {
          service_account_allow_list = ["spire:spire-agent"]
        }
      }
    }
  }

  KeyManager "memory" {
    plugin_data {}
  }

  Notifier "k8sbundle" {
    plugin_data {
      namespace        = "spire"
      config_map       = "spire-bundle"
      config_map_key   = "bundle.crt"
    }
  }
}

health_checks {
  listener_enabled = true
  bind_address     = "0.0.0.0"
  bind_port        = "8080"
  live_path        = "/live"
  ready_path       = "/ready"
}
```

### SPIRE Agent Configuration

```hcl
# spire-agent-configmap.yaml data section
agent {
  data_dir        = "/run/spire/agent/data"
  log_level       = "INFO"
  log_format      = "json"
  trust_domain    = "cluster.local"
  server_address  = "spire-server"
  server_port     = "8081"

  # Trust bundle for server validation
  trust_bundle_path = "/run/spire/bundle/bundle.crt"

  # Insecure bootstrap when bundle is mounted from ConfigMap
  insecure_bootstrap = true
}

plugins {
  NodeAttestor "k8s_psat" {
    plugin_data {
      cluster        = "prod-cluster"
      token_path     = "/var/run/secrets/tokens/spire-agent"
    }
  }

  KeyManager "memory" {
    plugin_data {}
  }

  WorkloadAttestor "k8s" {
    plugin_data {
      # Skip kubelet certificate verification for internal use
      skip_kubelet_verification = true
    }
  }
}
```

### Registering Workload Entries

```bash
# Register a workload entry for the api-server service account
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://cluster.local/ns/production/sa/api-server \
  -parentID spiffe://cluster.local/spire/agent/k8s_psat/prod-cluster/node1 \
  -selector k8s:ns:production \
  -selector k8s:sa:api-server \
  -ttl 3600

# Register database client
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://cluster.local/ns/production/sa/database-client \
  -parentID spiffe://cluster.local/spire/agent/k8s_psat/prod-cluster/node1 \
  -selector k8s:ns:production \
  -selector k8s:sa:database-client \
  -ttl 3600

# List registered entries
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry show
```

## Section 3: X.509 SVID Rotation

SVIDs are short-lived certificates. Rotation must be continuous and transparent to applications. The sidecar proxy handles rotation by fetching new SVIDs from the Workload API before the current SVID expires.

### SVID Rotation Timeline

```
t=0:     SVID issued, TTL=1h
t=45m:   Agent begins rotation (75% of TTL elapsed)
t=50m:   New SVID obtained from SPIRE Server
t=55m:   Envoy sidecar receives new SVID via SDS API
t=1h:    Old SVID expires (graceful overlap period)
```

### Verifying SVID Rotation with spire-agent

```bash
# Watch SVIDs on a specific pod's node
kubectl exec -n spire daemonset/spire-agent -- \
  /opt/spire/bin/spire-agent api fetch x509 \
  -socketPath /run/spire/sockets/agent.sock

# Output shows current SVIDs and their expiry:
# SPIFFE ID:         spiffe://cluster.local/ns/production/sa/api-server
# SVID Valid After:  2028-01-06 10:00:00 +0000 UTC
# SVID Valid Until:  2028-01-06 11:00:00 +0000 UTC
# CA #1 Valid After: 2028-01-06 00:00:00 +0000 UTC
# CA #1 Valid Until: 2028-01-07 00:00:00 +0000 UTC
```

### Configuring Envoy SDS for SPIRE Integration

```yaml
# envoy-sds-config.yaml
static_resources:
  clusters:
  - name: spire_agent
    connect_timeout: 0.25s
    http2_protocol_options: {}
    load_assignment:
      cluster_name: spire_agent
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              pipe:
                path: /run/spire/sockets/agent.sock

dynamic_resources:
  # Use SPIRE's Workload API as SDS provider
  ads_config:
    api_type: GRPC
    grpc_services:
    - envoy_grpc:
        cluster_name: spire_agent
  lds_config:
    resource_api_version: V3
    api_config_source:
      api_type: GRPC
      transport_api_version: V3
      grpc_services:
      - envoy_grpc:
          cluster_name: spire_agent

# SDS certificate configuration in downstream TLS context
transport_socket:
  name: envoy.transport_sockets.tls
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
    require_client_certificate: true
    common_tls_context:
      tls_certificate_sds_secret_configs:
      - name: "spiffe://cluster.local/ns/production/sa/api-server"
        sds_config:
          resource_api_version: V3
          api_config_source:
            api_type: GRPC
            transport_api_version: V3
            grpc_services:
            - envoy_grpc:
                cluster_name: spire_agent
      combined_validation_context:
        default_validation_context:
          match_typed_subject_alt_names:
          - san_type: URI
            matcher:
              prefix: "spiffe://cluster.local/"
        validation_context_sds_secret_config:
          name: "spiffe://cluster.local"
          sds_config:
            resource_api_version: V3
            api_config_source:
              api_type: GRPC
              transport_api_version: V3
              grpc_services:
              - envoy_grpc:
                  cluster_name: spire_agent
```

## Section 4: Istio mTLS Configuration

Istio integrates tightly with SPIFFE. Istiod acts as the SPIFFE CA when using the built-in PKI, or can be configured to integrate with an external SPIRE server.

### Enabling Strict mTLS Across the Mesh

```yaml
# mesh-wide-peer-authentication.yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system
spec:
  mtls:
    mode: STRICT
```

This configuration enforces mTLS for all services in the mesh. Any plaintext connection is rejected.

### Namespace-Scoped PeerAuthentication

```yaml
# namespace-peer-authentication.yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: production-strict
  namespace: production
spec:
  mtls:
    mode: STRICT
---
# Allow PERMISSIVE for a migration period in another namespace
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: legacy-permissive
  namespace: legacy
spec:
  mtls:
    mode: PERMISSIVE
```

### Port-Level mTLS Override

```yaml
# port-level-peer-auth.yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: api-server-port-override
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  mtls:
    mode: STRICT
  portLevelMtls:
    # Allow plaintext on metrics port (scraped by Prometheus outside mesh)
    9090:
      mode: DISABLE
    # Enforce mTLS on application port
    8080:
      mode: STRICT
```

### Authorization Policies

```yaml
# workload-authorization-policy.yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: api-server-policy
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  action: ALLOW
  rules:
  # Allow frontend to call api-server
  - from:
    - source:
        principals:
        - "cluster.local/ns/production/sa/frontend"
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/*"]
  # Allow health checks from kube-system
  - from:
    - source:
        namespaces: ["kube-system"]
    to:
    - operation:
        methods: ["GET"]
        paths: ["/healthz", "/readyz"]
---
# Default deny-all for the namespace
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: default-deny
  namespace: production
spec:
  {}
# Empty spec with no rules = deny all
```

### JWT-Based Authorization

```yaml
# jwt-request-authentication.yaml
apiVersion: security.istio.io/v1beta1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"
    audiences:
    - "api.example.com"
    forwardOriginalToken: true
---
# Require valid JWT for external traffic
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: require-jwt
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  action: ALLOW
  rules:
  # Internal service-to-service via mTLS (no JWT needed)
  - from:
    - source:
        principals: ["cluster.local/ns/production/sa/*"]
  # External traffic requires valid JWT
  - from:
    - source:
        requestPrincipals: ["https://auth.example.com/*"]
    when:
    - key: request.auth.claims[role]
      values: ["admin", "service"]
```

### Istio Integration with External SPIRE

```yaml
# istio-spire-integration.yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio-control-plane
  namespace: istio-system
spec:
  profile: default
  meshConfig:
    defaultConfig:
      # Use SPIRE workload API instead of Istiod-issued certs
      proxyMetadata:
        PROXY_CONFIG_XDS_AGENT: "true"
    # Configure SPIFFE trust domain
    trustDomain: "cluster.local"
  values:
    pilot:
      env:
        # Point Istiod to external SPIRE for cert validation
        EXTERNAL_CA: "true"
        USE_TOKEN_FOR_CSR_AUTH: "true"
    global:
      # Enable SDS (Secret Discovery Service) from SPIRE
      sds:
        enabled: true
      # SPIRE agent socket path
      pilotCertProvider: "spire"
  components:
    pilot:
      k8s:
        env:
        - name: PILOT_CERT_PROVIDER
          value: "spire"
        volumes:
        - name: spire-agent-socket
          hostPath:
            path: /run/spire/sockets
            type: Directory
        volumeMounts:
        - name: spire-agent-socket
          mountPath: /run/secrets/workload-spiffe-credentials
          readOnly: true
```

## Section 5: Linkerd Automatic mTLS

Linkerd implements mTLS by default for all meshed services with minimal configuration, using its own certificate hierarchy.

### Linkerd Certificate Bootstrap

```bash
# Generate root CA for Linkerd (keep private key offline)
step certificate create root.linkerd.cluster.local ca.crt ca.key \
  --profile root-ca \
  --no-password \
  --insecure \
  --not-after 87600h  # 10 years

# Generate intermediate CA signed by root
step certificate create identity.linkerd.cluster.local issuer.crt issuer.key \
  --profile intermediate-ca \
  --not-after 8760h \  # 1 year
  --no-password \
  --insecure \
  --ca ca.crt \
  --ca-key ca.key

# Install Linkerd with the certificates
linkerd install \
  --identity-trust-anchors-file=ca.crt \
  --identity-issuer-certificate-file=issuer.crt \
  --identity-issuer-key-file=issuer.key \
  | kubectl apply -f -

# Verify installation
linkerd check
```

### Linkerd Identity Certificate Rotation

Linkerd's identity issuer certificate should be rotated before expiry:

```bash
# Check current certificate expiry
kubectl get secret linkerd-identity-issuer \
  -n linkerd \
  -o jsonpath='{.data.crt\.pem}' \
  | base64 -d \
  | openssl x509 -noout -dates

# Generate new issuer certificate
step certificate create identity.linkerd.cluster.local \
  new-issuer.crt new-issuer.key \
  --profile intermediate-ca \
  --not-after 8760h \
  --no-password \
  --insecure \
  --ca ca.crt \
  --ca-key ca.key

# Update the issuer secret (Linkerd watches for changes)
kubectl create secret generic linkerd-identity-issuer \
  --from-file=crt.pem=new-issuer.crt \
  --from-file=key.pem=new-issuer.key \
  --namespace linkerd \
  --dry-run=client -o yaml \
  | kubectl apply -f -

# Verify Linkerd detects the new certificate
linkerd check --proxy
```

### Linkerd Authorization Policy

```yaml
# linkerd-server.yaml
apiVersion: policy.linkerd.io/v1beta3
kind: Server
metadata:
  name: api-server-http
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-server
  port: 8080
  proxyProtocol: HTTP/2
---
# Allow frontend to call api-server
apiVersion: policy.linkerd.io/v1beta3
kind: HTTPRoute
metadata:
  name: api-server-route
  namespace: production
spec:
  parentRefs:
  - name: api-server-http
    kind: Server
    group: policy.linkerd.io
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api/
    - method: GET
    - method: POST
---
# Authorization policy binding route to allowed clients
apiVersion: policy.linkerd.io/v1alpha1
kind: AuthorizationPolicy
metadata:
  name: api-server-allow-frontend
  namespace: production
spec:
  targetRef:
    group: policy.linkerd.io
    kind: HTTPRoute
    name: api-server-route
  requiredAuthenticationRefs:
  - name: frontend-service-account
    kind: MeshTLSAuthentication
    group: policy.linkerd.io
---
# Define what "frontend" means
apiVersion: policy.linkerd.io/v1alpha1
kind: MeshTLSAuthentication
metadata:
  name: frontend-service-account
  namespace: production
spec:
  identities:
  - "*.production.serviceaccount.identity.linkerd.cluster.local"
  - "frontend.production.serviceaccount.identity.linkerd.cluster.local"
```

### Linkerd mTLS Verification

```bash
# Verify mTLS is active between two pods
linkerd viz edges deployment -n production

# Expected output:
# SRC               DST         SECURED
# frontend          api-server  √ mTLS

# Check individual connection details
linkerd viz stat deploy/api-server -n production --to deploy/frontend

# Tap traffic to inspect TLS metadata
linkerd viz tap deploy/api-server -n production \
  --namespace production \
  | grep "tls"
```

## Section 6: Certificate Bootstrap Security

The certificate bootstrap problem: how does a new workload get its first certificate? Several approaches exist.

### Node Attestation via TPM

In high-security environments, SPIRE agents can attest nodes using Trusted Platform Module (TPM) hardware:

```hcl
# spire-agent-tpm-config.hcl
agent {
  trust_domain    = "cluster.local"
  server_address  = "spire-server.spire.svc.cluster.local"
  server_port     = "8081"
}

plugins {
  NodeAttestor "tpm_devid" {
    plugin_data {
      devid_cert_path = "/var/lib/tpm/devid.pem"
      devid_priv_path = "/var/lib/tpm/devid.key"
    }
  }
}
```

### Kubernetes PSAT (Projected Service Account Token) Attestation

The most common bootstrap method for Kubernetes is PSAT attestation. The agent uses its projected service account token to authenticate to the SPIRE Server:

```yaml
# agent-token-projection.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: spire-agent
  namespace: spire
spec:
  template:
    spec:
      serviceAccountName: spire-agent
      containers:
      - name: spire-agent
        image: ghcr.io/spiffe/spire-agent:1.8.0
        volumeMounts:
        - name: spire-token
          mountPath: /var/run/secrets/tokens
        - name: spire-socket
          mountPath: /run/spire/sockets
      volumes:
      # Short-lived PSAT for attestation bootstrap
      - name: spire-token
        projected:
          sources:
          - serviceAccountToken:
              path: spire-agent
              expirationSeconds: 600
              audience: spire-server
      - name: spire-socket
        hostPath:
          path: /run/spire/sockets
          type: DirectoryOrCreate
```

## Section 7: Mesh-Level Authorization Policies

### OPA Integration with Istio

For complex authorization logic beyond what native Istio policies support, OPA (Open Policy Agent) can be integrated as an external authorizer:

```yaml
# opa-ext-authz-filter.yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: opa-ext-authz
  namespace: production
spec:
  configPatches:
  - applyTo: HTTP_FILTER
    match:
      context: SIDECAR_INBOUND
      listener:
        filterChain:
          filter:
            name: envoy.filters.network.http_connection_manager
    patch:
      operation: INSERT_BEFORE
      value:
        name: envoy.filters.http.ext_authz
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
          grpc_service:
            envoy_grpc:
              cluster_name: outbound|9191||opa.production.svc.cluster.local
            timeout: 0.25s
          failure_mode_allow: false
          with_request_body:
            max_request_bytes: 8192
            allow_partial_message: true
```

```rego
# policy.rego
package istio.authz

import future.keywords.if
import future.keywords.in

default allow = false

# Allow health check endpoints without any identity check
allow if {
    input.parsed_path[0] == "healthz"
}

# Allow requests from specific service accounts with correct path
allow if {
    principal := input.attributes.source.principal
    startswith(principal, "cluster.local/ns/production/sa/")
    allowed_principals[principal]
    allowed_methods[input.attributes.request.http.method]
}

allowed_principals := {
    "cluster.local/ns/production/sa/frontend",
    "cluster.local/ns/production/sa/backend-api",
    "cluster.local/ns/monitoring/sa/prometheus",
}

allowed_methods := {"GET", "POST", "PUT", "DELETE"}
```

### Deny by Default Pattern

```yaml
# namespace-default-deny.yaml
# Applied after all allow policies to ensure default deny
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-nothing
  namespace: production
spec:
  # No selector = applies to all workloads
  # No rules = deny all
```

```bash
# Verify the deny-all baseline
kubectl exec -n production deploy/test-client -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://api-server.production.svc.cluster.local:8080/api/data
# Expected: 403
```

## Section 8: Workload Attestation

Workload attestation is how the SPIRE agent determines which SPIFFE ID to assign to a process requesting an SVID.

### Kubernetes Workload Attestor Configuration

```hcl
# workload-attestor-k8s.hcl
WorkloadAttestor "k8s" {
  plugin_data {
    # Pod metadata endpoint
    kubelet_read_only_port = 0
    kubelet_secure_port    = 10250

    # Use node service account for kubelet API access
    use_anonymous_authentication = false

    # Match pods by namespace, service account, label
    node_name_env = "MY_NODE_NAME"
  }
}
```

### Custom Workload Attestation with Process Metadata

```bash
# Register a specific workload entry matching container image digest
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID "spiffe://cluster.local/ns/production/sa/api-server/v2" \
  -parentID "spiffe://cluster.local/spire/agent/k8s_psat/prod-cluster" \
  -selector "k8s:ns:production" \
  -selector "k8s:sa:api-server" \
  -selector "k8s:container-image:myregistry.io/api-server@sha256:abc123def456" \
  -ttl 3600 \
  -admin
```

## Section 9: Inter-Cluster Trust Federation

When clusters in different trust domains need to communicate, trust bundles must be exchanged and federation relationships established.

### SPIRE Federation Configuration

```hcl
# spire-server-federation.hcl
server {
  trust_domain = "cluster-a.local"

  federation {
    bundle_endpoint {
      address = "0.0.0.0"
      port    = 8443
      acme {
        domain_name = "spire-federation.cluster-a.example.com"
        email       = "ops@example.com"
      }
    }

    # Trust relationship with cluster B
    federates_with "cluster-b.local" {
      bundle_endpoint_url = "https://spire-federation.cluster-b.example.com/bundle"
      bundle_endpoint_profile "https_web" {}
    }
  }
}
```

### Istio Trust Bundle Exchange

```bash
# Export trust bundle from cluster A
kubectl --context cluster-a \
  get configmap istio-ca-root-cert \
  -n istio-system \
  -o jsonpath='{.data.root-cert\.pem}' > cluster-a-ca.pem

# Export trust bundle from cluster B
kubectl --context cluster-b \
  get configmap istio-ca-root-cert \
  -n istio-system \
  -o jsonpath='{.data.root-cert\.pem}' > cluster-b-ca.pem

# Create combined trust bundle
cat cluster-a-ca.pem cluster-b-ca.pem > combined-ca.pem

# Apply to both clusters
for ctx in cluster-a cluster-b; do
  kubectl --context "${ctx}" \
    create configmap combined-ca-root-cert \
    --from-file=root-cert.pem=combined-ca.pem \
    -n istio-system \
    --dry-run=client -o yaml \
    | kubectl apply -f -
done
```

### ServiceEntry for Cross-Cluster Services

```yaml
# cross-cluster-service-entry.yaml
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: cluster-b-api-server
  namespace: production
spec:
  hosts:
  - api-server.production.cluster-b.svc.cluster.local
  location: MESH_INTERNAL
  ports:
  - number: 8080
    name: http
    protocol: HTTP
  resolution: DNS
  endpoints:
  - address: api-server.production.svc.cluster.local
    network: cluster-b
    locality: us-central1/us-central1-a
    labels:
      cluster: cluster-b
---
# DestinationRule for mTLS with cluster B services
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: cluster-b-mtls
  namespace: production
spec:
  host: "*.production.cluster-b.svc.cluster.local"
  trafficPolicy:
    tls:
      mode: ISTIO_MUTUAL
      # Use combined trust bundle
      caCertificates: /etc/certs/combined-ca.pem
```

## Section 10: Security Hardening and Compliance

### Audit Logging for mTLS Events

```yaml
# istio-access-log-telemetry.yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: access-logging
  namespace: production
spec:
  accessLogging:
  - providers:
    - name: envoy
    filter:
      expression: |
        response.code >= 400 ||
        connection.mtls == false ||
        request.auth.principal == ""
```

### Certificate Expiry Monitoring

```yaml
# cert-expiry-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: spire-cert-expiry
  namespace: monitoring
spec:
  groups:
  - name: spiffe.alerts
    interval: 60s
    rules:
    - alert: SPIRECertExpiryWarning
      expr: |
        (spire_agent_svid_rotation_seconds - time()) / 3600 < 2
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "SPIRE SVID expiring within 2 hours"
        description: "SVID for {{ $labels.spiffe_id }} expires in {{ $value | humanizeDuration }}"

    - alert: IstioCACertExpiry
      expr: |
        (istio_agent_cert_expiry_seconds - time()) / 86400 < 30
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Istio CA certificate expiring within 30 days"
        description: "Rotate the Istio intermediate CA before expiry"
```

### mTLS Compliance Dashboard Queries

```promql
# Percentage of meshed traffic using mTLS
sum(rate(istio_requests_total{connection_security_policy="mutual_tls"}[5m]))
/
sum(rate(istio_requests_total[5m]))
* 100

# Services still accepting plaintext connections
count by (destination_service_name) (
  rate(istio_requests_total{
    connection_security_policy!="mutual_tls",
    destination_service_namespace="production"
  }[5m]) > 0
)

# Average SVID rotation latency
histogram_quantile(0.99,
  rate(spire_agent_svid_rotation_duration_seconds_bucket[10m])
)
```

## Conclusion

Zero trust service mesh security is not a configuration applied once but an ongoing operational discipline. SPIFFE provides the foundation—cryptographic workload identity that is independent of network location. SPIRE implements that foundation with automatic rotation, node attestation, and workload attestation. Istio and Linkerd consume SPIFFE identities to enforce mTLS and fine-grained authorization policies without application changes.

The operational requirements are significant: certificate rotation monitoring, trust bundle management across clusters, and authorization policy governance. However, the security properties gained—every connection mutually authenticated, every authorization decision based on cryptographic identity rather than IP address—are foundational to operating Kubernetes at enterprise scale with confidence that a compromised workload cannot pivot laterally through the cluster.
