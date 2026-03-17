---
title: "Kubernetes SPIFFE/SPIRE Workload Identity: Agent/Server Architecture, Node Attestation, Workload API, and JWT SVIDs"
date: 2032-03-10T00:00:00-05:00
draft: false
tags: ["SPIFFE", "SPIRE", "Kubernetes", "Security", "mTLS", "Zero Trust", "Workload Identity", "Certificate Management"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to SPIFFE/SPIRE workload identity on Kubernetes: server and agent architecture, node attestation via Kubernetes attestor, X.509 and JWT SVID issuance, Workload API integration, and federation across clusters."
more_link: "yes"
url: "/kubernetes-spiffe-spire-workload-identity-node-attestation-jwt-svids/"
---

SPIFFE (Secure Production Identity Framework For Everyone) and its reference implementation SPIRE solve the fundamental problem of workload identity in dynamic, containerized environments: how does a service prove who it is without relying on static secrets or human-managed certificates? SPIRE issues cryptographic identities (SVIDs) to workloads based on platform-verifiable properties, enabling zero-touch mTLS and JWT-based authentication without secret injection. This guide covers the complete deployment and configuration for production Kubernetes clusters.

<!--more-->

# Kubernetes SPIFFE/SPIRE Workload Identity: Agent/Server Architecture, Node Attestation, Workload API, and JWT SVIDs

## The Workload Identity Problem

In a Kubernetes cluster, pods are ephemeral, IPs change on every restart, and service accounts provide coarse-grained identity. When service A needs to authenticate to service B without a human-managed secret, the options are typically:

1. Kubernetes service account tokens (vulnerable to theft, limited to in-cluster)
2. Vault AppRole (requires bootstrapping with a secret)
3. Cloud provider IAM roles (tied to specific providers)
4. Manual certificate management (operationally expensive)

SPIRE provides a fourth option: **cryptographically-attested workload identity** based on properties that the platform itself can verify, such as the node's identity and the pod's service account.

## SPIFFE Identity Format

Every SPIRE-issued identity follows the SPIFFE ID format:

```
spiffe://trust-domain/path
```

Examples:
```
spiffe://prod.example.com/ns/payments/sa/checkout-service
spiffe://prod.example.com/ns/platform/sa/api-gateway
spiffe://staging.example.com/k8s/cluster/node/worker-1
```

The trust domain is configured per SPIRE server and corresponds to an organizational boundary. SVIDs (SPIFFE Verifiable Identity Documents) come in two forms:

- **X.509-SVID**: A TLS certificate with the SPIFFE ID in the Subject Alternative Name URI field
- **JWT-SVID**: A signed JWT containing the SPIFFE ID as the `sub` claim

## Architecture Overview

```
┌─────────────────── Kubernetes Cluster ───────────────────┐
│                                                           │
│  ┌──────────────── Control Plane ─────────────────────┐  │
│  │  SPIRE Server (StatefulSet)                        │  │
│  │  ├── CA (root or intermediate PKI)                 │  │
│  │  ├── Datastore (SQLite/PostgreSQL)                 │  │
│  │  ├── Node Attestor (k8s_psat)                      │  │
│  │  ├── Workload Attestor (k8s)                       │  │
│  │  └── Federation endpoint (optional)               │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌──────────────── Each Worker Node ──────────────────┐  │
│  │  SPIRE Agent (DaemonSet)                           │  │
│  │  ├── Node attestation (via k8s_psat token)         │  │
│  │  ├── Agent SVID cache                              │  │
│  │  └── Workload API (Unix socket)                    │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌──────────────── Application Pod ───────────────────┐  │
│  │  Workload                                          │  │
│  │  ├── Requests SVID via Workload API socket         │  │
│  │  └── Uses X.509-SVID for mTLS or JWT-SVID for auth │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

## SPIRE Server Deployment

### Server Configuration

```yaml
# spire-server-config.yaml
server:
  bind_address: "0.0.0.0"
  bind_port: "8081"
  trust_domain: "prod.example.com"
  data_dir: "/run/spire/data"
  log_level: "INFO"
  log_format: "json"

  # CA configuration - use upstream CA in production
  ca_subject:
    country: ["US"]
    organization: ["Example Corp"]
    common_name: "SPIRE Server"

  # Certificate lifetimes
  ca_ttl: "168h"          # 7 days - CA cert validity
  default_svid_ttl: "1h"  # 1 hour - default SVID validity
  max_svid_ttl: "12h"

  # JWT SVIDs
  jwt_issuer: "https://spire.prod.example.com"

plugins:
  # Datastore: use PostgreSQL for HA
  DataStore "sql" {
    plugin_data {
      database_type = "postgres"
      connection_string = "dbname=spire user=spire host=spire-postgres.spire sslmode=require"
    }
  }

  # Key manager: store in memory (use disk or cloud HSM for production)
  KeyManager "disk" {
    plugin_data {
      keys_path = "/run/spire/data/keys.json"
    }
  }

  # Node attestor: verify nodes using projected service account tokens
  NodeAttestor "k8s_psat" {
    plugin_data {
      clusters = {
        "production-cluster" = {
          service_account_allow_list = ["spire:spire-agent"]
          kube_config_file = ""    # Empty = use in-cluster config
          token_path = ""
          audience = ["spire-server"]
        }
      }
    }
  }

  # Node resolver: enrich node attestation with k8s metadata
  NodeResolver "k8s_sat" {
    plugin_data {
      clusters = {
        "production-cluster" = {
          kube_config_file = ""
        }
      }
    }
  }

  # Workload attestor (server-side validation)
  WorkloadAttestor "k8s" {
    plugin_data {
      skip_kubelet_verification = false
      node_name_env = "MY_NODE_NAME"
    }
  }

  # Notifier: Kubernetes certificate bundle rotation
  Notifier "k8sbundle" {
    plugin_data {
      namespace = "spire"
      config_map = "spire-bundle"
      config_map_key = "bundle.crt"
    }
  }

health_checks:
  listener_enabled = true
  bind_address = "0.0.0.0"
  bind_port = "8080"
  live_path = "/live"
  ready_path = "/ready"
```

### Server Kubernetes Manifests

```yaml
# RBAC for SPIRE Server
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spire-server
  namespace: spire
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: spire-server-role
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["create", "get", "list", "patch", "watch"]
- apiGroups: [""]
  resources: ["nodes", "pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["authentication.k8s.io"]
  resources: ["tokenreviews"]
  verbs: ["create"]
- apiGroups: ["admissionregistration.k8s.io"]
  resources: ["mutatingwebhookconfigurations", "validatingwebhookconfigurations"]
  verbs: ["get", "list", "patch", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: spire-server-binding
subjects:
- kind: ServiceAccount
  name: spire-server
  namespace: spire
roleRef:
  kind: ClusterRole
  name: spire-server-role
  apiGroup: rbac.authorization.k8s.io
---
# SPIRE Server StatefulSet
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: spire-server
  namespace: spire
  labels:
    app: spire-server
spec:
  replicas: 1    # SPIRE server supports HA with PostgreSQL backend
  selector:
    matchLabels:
      app: spire-server
  serviceName: spire-server
  template:
    metadata:
      labels:
        app: spire-server
    spec:
      serviceAccountName: spire-server
      shareProcessNamespace: true
      containers:
      - name: spire-server
        image: ghcr.io/spiffe/spire-server:1.10.3
        args: ["-config", "/run/spire/config/server.conf"]
        ports:
        - containerPort: 8081
          name: grpc
        - containerPort: 8080
          name: health
        volumeMounts:
        - name: spire-config
          mountPath: /run/spire/config
          readOnly: true
        - name: spire-data
          mountPath: /run/spire/data
        - name: spire-server-socket
          mountPath: /tmp/spire-server/private
        resources:
          requests:
            cpu: "500m"
            memory: 512Mi
          limits:
            cpu: "2"
            memory: 1Gi
        livenessProbe:
          httpGet:
            path: /live
            port: 8080
          failureThreshold: 2
          initialDelaySeconds: 15
          periodSeconds: 60
          timeoutSeconds: 3
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: spire-config
        configMap:
          name: spire-server
      - name: spire-server-socket
        emptyDir: {}
  volumeClaimTemplates:
  - metadata:
      name: spire-data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: gp3
      resources:
        requests:
          storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: spire-server
  namespace: spire
spec:
  selector:
    app: spire-server
  ports:
  - name: grpc
    port: 8081
    targetPort: 8081
  type: ClusterIP
```

## SPIRE Agent Deployment

### Agent Configuration

```yaml
# spire-agent-config.yaml
agent:
  data_dir: "/run/spire/data"
  log_level: "INFO"
  log_format: "json"
  server_address: "spire-server.spire"
  server_port: "8081"
  socket_path: "/run/spire/sockets/agent.sock"
  trust_bundle_path: "/run/spire/bundle/bundle.crt"
  trust_domain: "prod.example.com"

  # Sync interval for SVID updates
  sds:
    default_svid_name: "default"
    default_bundle_name: "ROOTCA"
    default_all_bundles_name: "ALL"
    disable_spiffe_cert_validation: false

plugins:
  # Node attestor: use projected service account token (PSAT)
  NodeAttestor "k8s_psat" {
    plugin_data {
      cluster = "production-cluster"
      token_path = "/var/run/secrets/tokens/spire-agent"
    }
  }

  # Key manager: in-memory (keys re-generated on restart; use disk for persistence)
  KeyManager "memory" {
    plugin_data {}
  }

  # Workload attestor: discover pod identity via kubelet API
  WorkloadAttestor "k8s" {
    plugin_data {
      # kubelet URL - use the node-local kubelet socket
      kubelet_read_only_port = 0
      # Annotate pod with node name for attestation
      node_name_env = "MY_NODE_NAME"
    }
  }

  WorkloadAttestor "unix" {
    plugin_data {}
  }

health_checks:
  listener_enabled = true
  bind_address = "0.0.0.0"
  bind_port = "8080"
  live_path = "/live"
  ready_path = "/ready"
```

### Agent DaemonSet

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spire-agent
  namespace: spire
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: spire-agent-role
rules:
- apiGroups: [""]
  resources: ["pods", "nodes", "nodes/proxy"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: spire-agent-binding
subjects:
- kind: ServiceAccount
  name: spire-agent
  namespace: spire
roleRef:
  kind: ClusterRole
  name: spire-agent-role
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: spire-agent
  namespace: spire
spec:
  selector:
    matchLabels:
      app: spire-agent
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: spire-agent
    spec:
      serviceAccountName: spire-agent
      hostPID: true    # Required for Unix workload attestor to resolve PIDs
      initContainers:
      - name: init
        image: ghcr.io/spiffe/wait-for-it:latest
        args: ["spire-server.spire:8081"]
      containers:
      - name: spire-agent
        image: ghcr.io/spiffe/spire-agent:1.10.3
        args: ["-config", "/run/spire/config/agent.conf"]
        env:
        - name: MY_NODE_NAME
          valueFrom:
            fieldRef:
              apiVersion: v1
              fieldPath: spec.nodeName
        ports:
        - containerPort: 8080
          name: health
        volumeMounts:
        - name: spire-config
          mountPath: /run/spire/config
          readOnly: true
        - name: spire-bundle
          mountPath: /run/spire/bundle
          readOnly: true
        - name: spire-agent-socket
          mountPath: /run/spire/sockets
        - name: spire-token
          mountPath: /var/run/secrets/tokens
        resources:
          requests:
            cpu: "100m"
            memory: 128Mi
          limits:
            cpu: "500m"
            memory: 256Mi
        livenessProbe:
          httpGet:
            path: /live
            port: 8080
          failureThreshold: 2
          initialDelaySeconds: 15
          periodSeconds: 60
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: spire-config
        configMap:
          name: spire-agent
      - name: spire-bundle
        configMap:
          name: spire-bundle
      - name: spire-agent-socket
        hostPath:
          path: /run/spire/sockets
          type: DirectoryOrCreate
      - name: spire-token
        projected:
          sources:
          - serviceAccountToken:
              path: spire-agent
              expirationSeconds: 7200
              audience: spire-server
```

## Node Attestation Deep Dive

### k8s_psat: Projected Service Account Token Attestation

PSAT attestation works by having the agent present a projected service account token to the server. The server validates this token against the Kubernetes API, confirming that:

1. The token was issued by the cluster's API server
2. The token belongs to the `spire-agent` service account in the `spire` namespace
3. The node claim in the token matches an actual cluster node

```
Agent Node                          SPIRE Server
    │                                   │
    │─── Attestation request ──────────►│
    │    { token: <PSAT> }              │
    │                                   │─── TokenReview API ──► Kubernetes API
    │                                   │    Validates: SA, namespace, node
    │                                   │◄── { uid: node-name, valid: true }
    │                                   │
    │◄── Agent SVID issued ─────────────│
    │    spiffe://prod.example.com/     │
    │    spire/agent/k8s_psat/          │
    │    production-cluster/node-name   │
    │                                   │
```

### Registering Node SPIFFE IDs

After the agent is attested, you register workload entries that map pod attributes to SPIFFE IDs:

```bash
# Register entry for checkout service pods
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID "spiffe://prod.example.com/ns/payments/sa/checkout-service" \
  -parentID "spiffe://prod.example.com/spire/agent/k8s_psat/production-cluster/$(kubectl get node worker-1 -o jsonpath='{.metadata.uid}')" \
  -selector "k8s:ns:payments" \
  -selector "k8s:sa:checkout-service" \
  -selector "k8s:pod-label:app:checkout" \
  -ttl 3600

# Register for all pods in a namespace regardless of service account
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID "spiffe://prod.example.com/ns/monitoring/workload" \
  -parentID "spiffe://prod.example.com/spire/agent/k8s_psat/production-cluster/$(kubectl get node worker-1 -o jsonpath='{.metadata.uid}')" \
  -selector "k8s:ns:monitoring" \
  -ttl 3600

# List all registered entries
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry show
```

### Automating Entry Registration with SPIRE Controller Manager

```yaml
# SpiffeID CRD for automatic entry management
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: checkout-service
spec:
  spiffeIDTemplate: "spiffe://prod.example.com/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      app: checkout
  namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: payments
  ttlHours: 1
  dnsNameTemplates:
  - "{{ .PodMeta.Name }}.{{ .PodMeta.Namespace }}.svc.cluster.local"
---
# Deploy SPIRE Controller Manager
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spire-controller-manager
  namespace: spire
spec:
  replicas: 1
  selector:
    matchLabels:
      app: spire-controller-manager
  template:
    spec:
      serviceAccountName: spire-controller-manager
      containers:
      - name: spire-controller-manager
        image: ghcr.io/spiffe/spire-controller-manager:0.5.0
        args:
        - --config=controller-manager-config.yaml
        - --spire-api-socket=/spire-server/api.sock
        volumeMounts:
        - name: spire-server-socket
          mountPath: /spire-server
          readOnly: true
      volumes:
      - name: spire-server-socket
        hostPath:
          path: /tmp/spire-server/private
          type: Directory
```

## Workload API: Fetching SVIDs

### X.509-SVID via Workload API

```go
// go-spiffe workload API client
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "log"
    "net/http"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

const socketPath = "unix:///run/spire/sockets/agent.sock"

func main() {
    ctx := context.Background()

    // Create Workload API client
    client, err := workloadapi.New(ctx,
        workloadapi.WithAddr(socketPath),
    )
    if err != nil {
        log.Fatalf("workloadapi.New: %v", err)
    }
    defer client.Close()

    // Fetch current X.509 SVID
    svid, err := client.FetchX509SVID(ctx)
    if err != nil {
        log.Fatalf("FetchX509SVID: %v", err)
    }
    fmt.Printf("SVID ID: %s\n", svid.ID)
    fmt.Printf("SVID TTL: %v\n", svid.Certificates[0].NotAfter)

    // Watch for SVID updates (rotated automatically before expiry)
    go func() {
        err := client.WatchX509SVIDs(ctx, &svidWatcher{})
        if err != nil {
            log.Printf("WatchX509SVIDs: %v", err)
        }
    }()

    // Create mTLS server that accepts clients from the same trust domain
    trustDomain := spiffeid.RequireTrustDomainFromString("prod.example.com")

    // Allow any SPIFFE ID from the trust domain
    tlsConfig := tlsconfig.MTLSServerConfig(
        client,
        client,
        tlsconfig.AuthorizeMemberOf(trustDomain),
    )

    httpServer := &http.Server{
        Addr:      ":8443",
        TLSConfig: tlsConfig,
        Handler:   http.HandlerFunc(echoHandler),
    }

    log.Printf("Starting mTLS server on :8443")
    if err := httpServer.ListenAndServeTLS("", ""); err != nil {
        log.Fatal(err)
    }
}

type svidWatcher struct{}

func (w *svidWatcher) OnX509ContextUpdate(c *workloadapi.X509Context) {
    for _, svid := range c.SVIDs {
        log.Printf("SVID updated: %s (expires: %v)",
            svid.ID, svid.Certificates[0].NotAfter)
    }
}

func (w *svidWatcher) OnX509ContextWatchError(err error) {
    log.Printf("SVID watch error: %v", err)
}

func echoHandler(w http.ResponseWriter, r *http.Request) {
    // Extract peer SPIFFE ID from TLS peer certificates
    tlsConn, ok := r.TLS.(*tls.ConnectionState)
    if ok {
        for _, cert := range tlsConn.PeerCertificates {
            for _, uri := range cert.URIs {
                fmt.Fprintf(w, "Peer identity: %s\n", uri.String())
            }
        }
    }
    fmt.Fprintf(w, "Hello from: %s\n", r.TLS.ServerName)
}
```

### JWT-SVID for Service-to-Service Authentication

```go
// Fetch a JWT SVID for authenticating to a specific audience
func fetchJWTSVID(ctx context.Context, audience string) (string, error) {
    client, err := workloadapi.New(ctx,
        workloadapi.WithAddr(socketPath),
    )
    if err != nil {
        return "", fmt.Errorf("workloadapi client: %w", err)
    }
    defer client.Close()

    svid, err := client.FetchJWTSVID(ctx, jwtsvid.Params{
        Audience: audience,
    })
    if err != nil {
        return "", fmt.Errorf("FetchJWTSVID: %w", err)
    }

    return svid.Marshal(), nil
}

// HTTP client that automatically attaches JWT-SVID Bearer token
type SPIFFEHTTPClient struct {
    inner    *http.Client
    audience string
    wapi     *workloadapi.Client
}

func (c *SPIFFEHTTPClient) Do(req *http.Request) (*http.Response, error) {
    token, err := c.fetchToken(req.Context())
    if err != nil {
        return nil, fmt.Errorf("SPIFFE JWT: %w", err)
    }
    req.Header.Set("Authorization", "Bearer "+token)
    return c.inner.Do(req)
}

func (c *SPIFFEHTTPClient) fetchToken(ctx context.Context) (string, error) {
    svid, err := c.wapi.FetchJWTSVID(ctx, jwtsvid.Params{
        Audience: c.audience,
    })
    if err != nil {
        return "", err
    }
    return svid.Marshal(), nil
}

// Server-side JWT validation
func validateJWTMiddleware(wapi *workloadapi.Client, audience string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            auth := r.Header.Get("Authorization")
            if auth == "" || len(auth) < 8 || auth[:7] != "Bearer " {
                http.Error(w, "missing Bearer token", http.StatusUnauthorized)
                return
            }
            token := auth[7:]

            // Fetch current JWKS from SPIRE (handles key rotation automatically)
            bundleSet, err := wapi.FetchX509Bundles(r.Context())
            if err != nil {
                http.Error(w, "internal error", http.StatusInternalServerError)
                return
            }

            // Parse and validate the JWT-SVID
            svid, err := jwtsvid.ParseAndValidate(token,
                bundleSet,
                []string{audience},
            )
            if err != nil {
                http.Error(w, "invalid token: "+err.Error(), http.StatusUnauthorized)
                return
            }

            // Add SPIFFE ID to request context
            ctx := context.WithValue(r.Context(), spiffeIDKey{}, svid.ID)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

### Envoy SDS Integration

SPIRE integrates natively with Envoy via the Secret Discovery Service (SDS), enabling automatic certificate rotation for service mesh deployments:

```yaml
# Envoy static configuration with SPIRE SDS
static_resources:
  clusters:
  - name: spire_agent
    connect_timeout: 1s
    type: STATIC
    load_assignment:
      cluster_name: spire_agent
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              pipe:
                path: /run/spire/sockets/agent.sock

  listeners:
  - name: local_service
    address:
      socket_address:
        address: 0.0.0.0
        port_value: 8443
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            name: local_route
            virtual_hosts:
            - name: local_service
              domains: ["*"]
              routes:
              - match:
                  prefix: "/"
                route:
                  cluster: local_app
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          require_client_certificate: true
          common_tls_context:
            tls_certificate_sds_secret_configs:
            - name: "spiffe://prod.example.com/ns/payments/sa/checkout-service"
              sds_config:
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
                    prefix: "spiffe://prod.example.com/ns/payments/"
              validation_context_sds_secret_config:
                name: "spiffe://prod.example.com"
                sds_config:
                  api_config_source:
                    api_type: GRPC
                    transport_api_version: V3
                    grpc_services:
                    - envoy_grpc:
                        cluster_name: spire_agent
```

## Cluster Federation

SPIRE federation allows workloads in different clusters (or different organizations) to establish mTLS using identities from different trust domains:

```bash
# On cluster A: add federation relationship with cluster B
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server federation create \
  --bundleEndpointURL "https://spire.cluster-b.example.com:8443" \
  --bundleEndpointProfile https_spiffe \
  --trustDomain "cluster-b.example.com" \
  --endpointSPIFFEID "spiffe://cluster-b.example.com/spire/server"

# Check federation bundle status
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle list

# Show a specific federated bundle
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle show \
  -id "spiffe://cluster-b.example.com"
```

Workload entry allowing cross-cluster access:

```bash
# Allow cluster-A workloads to talk to cluster-B workloads
# Register an entry that maps cluster-B identity as a parent
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID "spiffe://prod.example.com/ns/payments/federated-partner" \
  -parentID "spiffe://cluster-b.example.com/ns/partner/sa/integration-service" \
  -federatesWith "cluster-b.example.com" \
  -selector "spiffe:id:spiffe://cluster-b.example.com/ns/partner/sa/integration-service"
```

## Operational Tasks

### Certificate Bundle Rotation

```bash
# Show current bundle
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle show

# Set an upstream bundle (for intermediate CA mode)
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle set \
  -id "spiffe://prod.example.com" \
  -path /path/to/bundle.pem

# Force bundle rotation
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server upstreamauthority rotate
```

### Monitoring SPIRE Health

```yaml
# PrometheusRule for SPIRE
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: spire-alerts
  namespace: spire
spec:
  groups:
  - name: spire.server
    rules:
    - alert: SPIREServerDown
      expr: up{job="spire-server"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "SPIRE server is down - workload SVIDs cannot be issued"

    - alert: SPIREAgentDown
      expr: |
        count(up{job="spire-agent"} == 0)
        /
        count(up{job="spire-agent"}) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "More than 10% of SPIRE agents are down"

    - alert: SPIRELowSVIDTTL
      expr: |
        min(spire_agent_svid_ttl_seconds) < 300
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "SPIRE SVID TTL below 5 minutes - rotation lag possible"

    - alert: SPIREAttestationFailures
      expr: |
        rate(spire_agent_node_attestation_total{status="failure"}[5m]) > 0
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "SPIRE node attestation failures detected"
```

## Summary

SPIRE provides cryptographic workload identity that scales from single-cluster deployments to federated multi-organization environments. The operational model is:

- SPIRE server issues certificates based on platform-attested node identities; no human interaction is required after initial bootstrap
- SPIRE agent runs on each node, attests using projected service account tokens, and serves SVIDs to local workloads via a Unix socket
- Workloads fetch SVIDs via the Workload API; SVIDs are automatically rotated well before expiry, ensuring continuous availability of valid certificates
- X.509-SVIDs enable mTLS without any Kubernetes secrets; JWT-SVIDs enable bearer token auth for HTTP APIs
- SPIRE Controller Manager automates entry registration via CRDs, eliminating manual `spire-server entry create` commands
- Federation enables cross-cluster trust without sharing CA keys, making it suitable for multi-team and multi-vendor environments
