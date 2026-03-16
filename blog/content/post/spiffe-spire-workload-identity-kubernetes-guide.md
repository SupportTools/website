---
title: "SPIFFE/SPIRE: Zero-Trust Workload Identity for Kubernetes"
date: 2027-03-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "SPIFFE", "SPIRE", "Zero Trust", "mTLS", "Security"]
categories: ["Kubernetes", "Security", "Zero Trust"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production deployment guide for SPIFFE/SPIRE workload identity on Kubernetes, covering SPIRE Server and Agent setup, SVIDs, trust bundles, federation, Envoy SDS integration, JWT-SVIDs for service authentication, and automated certificate rotation."
more_link: "yes"
url: "/spiffe-spire-workload-identity-kubernetes-guide/"
---

Kubernetes service accounts, IP-based identity, and static TLS certificates are insufficient for a zero-trust security model. They rely on perimeter assumptions, require manual certificate rotation, and do not provide cryptographic proof of workload identity that is portable across clusters and cloud providers. SPIFFE (Secure Production Identity Framework For Everyone) and its reference implementation SPIRE (SPIFFE Runtime Environment) address these limitations by issuing short-lived, automatically rotated cryptographic identities (SVIDs) to workloads based on attestation rather than configuration. This guide covers the full production deployment path on Kubernetes: HA SPIRE Server, SPIRE Agent DaemonSet, node and workload attestation, Envoy SDS integration for automatic mTLS, JWT-SVID issuance, trust bundle federation, and the SPIRE Controller Manager for CRD-driven registration.

<!--more-->

## Section 1: SPIFFE/SPIRE Architecture

SPIFFE defines a specification for workload identities. The core concepts are:

- **SPIFFE ID** — a URI of the form `spiffe://trust-domain/path` that uniquely identifies a workload
- **SVID (SPIFFE Verifiable Identity Document)** — a signed document containing the SPIFFE ID, issued as either an X.509 certificate (X.509-SVID) or a JWT (JWT-SVID)
- **Trust Domain** — the top-level namespace for SPIFFE IDs (maps to an organization or cluster boundary)
- **Trust Bundle** — the set of CA certificates used to verify SVIDs from a trust domain
- **Workload API** — a local Unix socket API that workloads use to retrieve their SVID without credentials

SPIRE implements the SPIFFE specification through two components:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Kubernetes Cluster                         │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │               SPIRE Server (StatefulSet)                 │   │
│  │                                                          │   │
│  │  ┌─────────────────┐   ┌──────────────────────────────┐  │   │
│  │  │  Node Attestor  │   │   Datastore (SQLite / etcd)  │  │   │
│  │  │  (k8s_sat)      │   │                              │  │   │
│  │  └─────────────────┘   └──────────────────────────────┘  │   │
│  │  ┌─────────────────┐   ┌──────────────────────────────┐  │   │
│  │  │  CA / Key Mgr   │   │   Registration API (gRPC)    │  │   │
│  │  │  (on-disk / HSM)│   │                              │  │   │
│  │  └─────────────────┘   └──────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│           │ gRPC (port 8081)     │ Federation API (port 8443)   │
│  ┌────────▼─────────────────────────────────────────────────┐   │
│  │             SPIRE Agent (DaemonSet - one per node)       │   │
│  │                                                          │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │   Workload Attestor (k8s) — pod UID lookup        │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │   Workload API — Unix socket /run/spire/sockets/  │  │   │
│  │  │   agent.sock (bind-mounted into pods)              │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│           │ Unix socket                                          │
│  ┌────────▼─────────────────────────────────────────────────┐   │
│  │              Workload (Pod)                              │   │
│  │  Retrieves X.509-SVID or JWT-SVID via Workload API      │   │
│  │  Identity: spiffe://cluster.example.com/ns/prod/app     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Section 2: SPIRE Server HA Deployment

### Namespace and RBAC

```yaml
# spire-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: spire
  labels:
    app.kubernetes.io/name: spire
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
---
# spire-server-serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spire-server
  namespace: spire
---
# RBAC for SPIRE Server to list and watch pods/nodes for attestation
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: spire-server-cluster-role
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["authentication.k8s.io"]
    resources: ["tokenreviews"]
    verbs: ["create"]
  - apiGroups: ["spire.spiffe.io"]
    resources: ["clusterspiffeids", "clusterfederatedtrustdomains", "clusterstaticentries"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: spire-server-cluster-role-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: spire-server-cluster-role
subjects:
  - kind: ServiceAccount
    name: spire-server
    namespace: spire
```

### SPIRE Server ConfigMap

```yaml
# spire-server-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-server-config
  namespace: spire
data:
  server.conf: |
    server {
      bind_address = "0.0.0.0"
      bind_port = "8081"
      socket_path = "/tmp/spire-server/private/api.sock"
      trust_domain = "cluster.example.com"
      data_dir = "/run/spire/data"
      log_level = "INFO"
      log_format = "json"

      # X.509 certificate TTL for issued SVIDs
      default_x509_svid_ttl = "1h"

      # JWT-SVID TTL
      default_jwt_svid_ttl = "5m"

      # CA certificate TTL
      ca_ttl = "24h"

      # Federation configuration for cross-cluster trust
      federation {
        bundle_endpoint {
          address = "0.0.0.0"
          port = 8443
          acme {
            directory_url = "https://acme.example.com/acme/directory"
            domain_name = "spire-server.spire.svc.cluster.local"
            email = "platform@example.com"
          }
        }
      }

      # Prometheus metrics endpoint
      health_checks {
        listener_enabled = true
        bind_address = "0.0.0.0"
        bind_port = "8080"
        live_path = "/live"
        ready_path = "/ready"
      }
    }

    plugins {
      DataStore "sql" {
        plugin_data {
          database_type = "postgres"
          connection_string = "dbname=spire user=spire password=EXAMPLE_DB_PASSWORD_REPLACE_ME host=postgres.spire.svc.cluster.local sslmode=verify-full"
        }
      }

      NodeAttestor "k8s_sat" {
        plugin_data {
          clusters = {
            "production-cluster" = {
              service_account_allow_list = ["spire:spire-agent"]
              use_token_review_api_validation = true
            }
          }
        }
      }

      KeyManager "disk" {
        plugin_data {
          keys_path = "/run/spire/data/keys.json"
        }
      }

      UpstreamAuthority "disk" {
        plugin_data {
          key_file_path = "/run/spire/secrets/bootstrap/server-key.pem"
          cert_file_path = "/run/spire/secrets/bootstrap/server.pem"
          bundle_file_path = "/run/spire/secrets/bootstrap/root-cert.pem"
        }
      }

      Notifier "k8sbundle" {
        plugin_data {
          config_map = "spire-bundle"
          config_map_key = "bundle.crt"
          namespace = "spire"
        }
      }
    }

    telemetry {
      Prometheus {
        port = 9988
      }
    }
```

### SPIRE Server StatefulSet

```yaml
# spire-server-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: spire-server
  namespace: spire
  labels:
    app: spire-server
    app.kubernetes.io/name: spire-server
    app.kubernetes.io/version: "1.9.4"
spec:
  replicas: 3   # HA: 3 replicas with leader election via Raft
  selector:
    matchLabels:
      app: spire-server
  serviceName: spire-server
  template:
    metadata:
      labels:
        app: spire-server
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9988"
    spec:
      serviceAccountName: spire-server
      shareProcessNamespace: true
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
        - name: spire-server
          image: ghcr.io/spiffe/spire-server:1.9.4
          args:
            - -config
            - /run/spire/config/server.conf
          ports:
            - containerPort: 8081
              name: grpc
            - containerPort: 8080
              name: health
            - containerPort: 8443
              name: federation
            - containerPort: 9988
              name: metrics
          volumeMounts:
            - name: spire-server-config
              mountPath: /run/spire/config
              readOnly: true
            - name: spire-data
              mountPath: /run/spire/data
            - name: spire-server-socket
              mountPath: /tmp/spire-server/private
            - name: bootstrap-certs
              mountPath: /run/spire/secrets/bootstrap
              readOnly: true
          livenessProbe:
            httpGet:
              path: /live
              port: health
            initialDelaySeconds: 15
            periodSeconds: 30
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /ready
              port: health
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            limits:
              cpu: 1000m
              memory: 512Mi
            requests:
              cpu: 200m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
      volumes:
        - name: spire-server-config
          configMap:
            name: spire-server-config
        - name: spire-server-socket
          emptyDir: {}
        - name: bootstrap-certs
          secret:
            secretName: spire-server-bootstrap-certs
  volumeClaimTemplates:
    - metadata:
        name: spire-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 10Gi
---
apiVersion: v1
kind: Service
metadata:
  name: spire-server
  namespace: spire
  labels:
    app: spire-server
spec:
  selector:
    app: spire-server
  ports:
    - name: grpc
      port: 8081
      targetPort: 8081
    - name: federation
      port: 8443
      targetPort: 8443
    - name: health
      port: 8080
      targetPort: 8080
    - name: metrics
      port: 9988
      targetPort: 9988
  clusterIP: None  # Headless service for StatefulSet
```

## Section 3: SPIRE Agent DaemonSet

```yaml
# spire-agent-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-agent-config
  namespace: spire
data:
  agent.conf: |
    agent {
      data_dir = "/run/spire"
      log_level = "INFO"
      log_format = "json"
      server_address = "spire-server"
      server_port = "8081"
      socket_path = "/run/spire/sockets/agent.sock"
      trust_domain = "cluster.example.com"
      trust_bundle_path = "/run/spire/bootstrap/bundle.crt"

      # Reconnection settings for HA server
      experimental {
        named_pipe_name = ""
      }

      health_checks {
        listener_enabled = true
        bind_address = "0.0.0.0"
        bind_port = "8080"
        live_path = "/live"
        ready_path = "/ready"
      }
    }

    plugins {
      NodeAttestor "k8s_sat" {
        plugin_data {
          cluster = "production-cluster"
        }
      }

      KeyManager "memory" {
        plugin_data {}
      }

      WorkloadAttestor "k8s" {
        plugin_data {
          # Use kubelet API to verify workload attributes
          skip_kubelet_verification = false
          max_poll_attempts = 10
          poll_retry_interval = "500ms"
        }
      }
    }

    telemetry {
      Prometheus {
        port = 9988
      }
    }
---
# spire-agent-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: spire-agent
  namespace: spire
  labels:
    app: spire-agent
    app.kubernetes.io/name: spire-agent
    app.kubernetes.io/version: "1.9.4"
spec:
  selector:
    matchLabels:
      app: spire-agent
  template:
    metadata:
      labels:
        app: spire-agent
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9988"
    spec:
      serviceAccountName: spire-agent
      hostPID: true       # Required for workload attestation
      hostNetwork: false
      securityContext:
        runAsNonRoot: false   # Required: agent needs to run as root for hostPID attestation
      initContainers:
        # Wait for the SPIRE Server to be available before starting the agent
        - name: init-wait
          image: cgr.dev/chainguard/wait-for-it:latest
          args:
            - spire-server:8081
            - --timeout=60
      containers:
        - name: spire-agent
          image: ghcr.io/spiffe/spire-agent:1.9.4
          args:
            - -config
            - /run/spire/config/agent.conf
          ports:
            - containerPort: 8080
              name: health
            - containerPort: 9988
              name: metrics
          volumeMounts:
            - name: spire-agent-config
              mountPath: /run/spire/config
              readOnly: true
            - name: spire-bundle
              mountPath: /run/spire/bootstrap
              readOnly: true
            - name: spire-agent-socket
              mountPath: /run/spire/sockets
            - name: spire-data
              mountPath: /run/spire/data
          livenessProbe:
            httpGet:
              path: /live
              port: health
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /ready
              port: health
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            limits:
              cpu: 500m
              memory: 256Mi
            requests:
              cpu: 100m
              memory: 128Mi
      volumes:
        - name: spire-agent-config
          configMap:
            name: spire-agent-config
        - name: spire-bundle
          configMap:
            name: spire-bundle
        - name: spire-agent-socket
          hostPath:
            # Expose agent socket to pods on this node
            path: /run/spire/sockets
            type: DirectoryOrCreate
        - name: spire-data
          hostPath:
            path: /run/spire/data
            type: DirectoryOrCreate
      tolerations:
        - effect: NoSchedule
          operator: Exists
        - effect: NoExecute
          operator: Exists
```

## Section 4: Node and Workload Attestation

### Node Attestation (k8s_sat)

Node attestation proves to the SPIRE Server that the SPIRE Agent is running on a legitimate Kubernetes node. The `k8s_sat` (Kubernetes Service Account Token) attestor works as follows:

1. The SPIRE Agent presents its Kubernetes service account token to the SPIRE Server
2. The SPIRE Server calls the Kubernetes TokenReview API to validate the token
3. If valid, the Server creates a unique agent SVID for the node

```bash
# Verify node attestation is working
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server agent list

# Expected output:
# Found 3 attested agents:
# SPIFFE ID: spiffe://cluster.example.com/spire/agent/k8s_sat/production-cluster/abc123
#   Attestation type: k8s_sat
#   Expiration time: 2027-03-10T12:00:00Z
#   Serial number: 1
```

### Workload Attestation (k8s)

Workload attestation proves to the SPIRE Agent that a process belongs to a specific Kubernetes pod. The `k8s` workload attestor:

1. Receives a connection on the Workload API socket from a pod
2. Identifies the calling process using the PID
3. Uses the kubelet API to look up pod metadata for that container
4. Returns selectors (namespace, service account, labels) used to match registration entries

### Registration Entry Creation

Registration entries map selector combinations to SPIFFE IDs:

```bash
# Register an entry for the payment-service
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
    -spiffeID spiffe://cluster.example.com/ns/production/sa/payment-service \
    -parentID spiffe://cluster.example.com/spire/agent/k8s_sat/production-cluster/$(kubectl get node worker-1 -o jsonpath='{.status.nodeInfo.machineID}') \
    -selector k8s:ns:production \
    -selector k8s:sa:payment-service \
    -ttl 3600

# Register an entry matching pods by label
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
    -spiffeID spiffe://cluster.example.com/ns/production/app/api-server \
    -parentID spiffe://cluster.example.com/spire/agent/k8s_sat/production-cluster/any \
    -selector k8s:ns:production \
    -selector k8s:pod-label:app:api-server \
    -ttl 3600

# List all registration entries
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry show

# Delete an entry (replace ENTRY_ID with the ID from 'entry show' output)
ENTRY_ID="abc1234-5678-90ab-cdef-example00001"
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry delete \
    -id "${ENTRY_ID}"
```

## Section 5: SPIRE Controller Manager (CRD-Based Registration)

The SPIRE Controller Manager automates registration entry management using Kubernetes CRDs, eliminating the need for manual `spire-server entry create` commands.

### Installation

```bash
# Install SPIRE Controller Manager via Helm
helm repo add spire https://spiffe.github.io/helm-charts-hardened/
helm install spire-crds spire/spire-crds \
  --namespace spire \
  --version 0.4.0

helm install spire-controller-manager spire/spire-controller-manager \
  --namespace spire \
  --version 0.4.0 \
  --set config.trustDomain=cluster.example.com \
  --set config.serverAddress=spire-server:8081
```

### ClusterSPIFFEID CRD

```yaml
# cluster-spiffe-id.yaml
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: production-workloads
spec:
  # Template for generating SPIFFE IDs
  spiffeIDTemplate: "spiffe://cluster.example.com/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  # Pod selector — applies to all pods in production namespace
  podSelector:
    matchLabels:
      spiffe.io/spiffe-id: "true"
  namespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: In
        values:
          - production
          - staging
  # SVID TTL
  ttl: 1h
  # DNS SANs to include in X.509-SVID
  dnsNameTemplates:
    - "{{ .PodMeta.Name }}.{{ .PodMeta.Namespace }}.svc.cluster.local"
  # Workload-specific registration entries
  workloadSelectorTemplates:
    - "k8s:ns:{{ .PodMeta.Namespace }}"
    - "k8s:sa:{{ .PodSpec.ServiceAccountName }}"
---
# ClusterStaticEntry for a fixed SPIFFE ID (used by infrastructure components)
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterStaticEntry
metadata:
  name: prometheus-scraper
spec:
  entry:
    spiffeId:
      trustDomain: cluster.example.com
      path: /infrastructure/prometheus
    parentId:
      trustDomain: cluster.example.com
      path: /spire/agent/k8s_sat/production-cluster/ANY
    selectors:
      - type: k8s
        value: ns:monitoring
      - type: k8s
        value: sa:prometheus
    x509SvidTtl: 3600
```

Enable SPIFFE ID assignment on a pod:

```yaml
# Annotate pods to receive SPIFFE IDs via ClusterSPIFFEID
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  template:
    metadata:
      labels:
        app: payment-service
        spiffe.io/spiffe-id: "true"   # Matches ClusterSPIFFEID selector
    spec:
      serviceAccountName: payment-service
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:v2.3.1
          volumeMounts:
            # Mount the SPIRE Agent socket for Workload API access
            - name: spire-agent-socket
              mountPath: /run/spire/sockets
              readOnly: true
      volumes:
        - name: spire-agent-socket
          hostPath:
            path: /run/spire/sockets
            type: Directory
```

## Section 6: X.509-SVID Retrieval in Application Code

```go
// workload_identity.go
package identity

import (
    "context"
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "log"
    "net/http"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

const (
    // spireSocketPath is the path to the SPIRE Agent Workload API socket
    spireSocketPath = "unix:///run/spire/sockets/agent.sock"
)

// GetX509Source returns a live X.509-SVID source that automatically rotates
func GetX509Source(ctx context.Context) (*workloadapi.X509Source, error) {
    source, err := workloadapi.NewX509Source(
        ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr(spireSocketPath),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating X.509 source: %w", err)
    }
    return source, nil
}

// NewMTLSServer creates an HTTP server with automatic mTLS using SVIDs
func NewMTLSServer(ctx context.Context, port int) (*http.Server, error) {
    source, err := GetX509Source(ctx)
    if err != nil {
        return nil, err
    }

    // Build TLS config that:
    // 1. Presents our X.509-SVID to clients
    // 2. Requires clients to present a valid SVID from the same trust domain
    trustDomain := spiffeid.RequireTrustDomainFromString("cluster.example.com")
    tlsConfig := tlsconfig.MTLSServerConfig(
        source,
        source,
        tlsconfig.AuthorizeMemberOf(trustDomain),
    )

    server := &http.Server{
        Addr:      fmt.Sprintf(":%d", port),
        TLSConfig: tlsConfig,
    }

    // Log certificate details for observability
    svid, err := source.GetX509SVID()
    if err != nil {
        return nil, fmt.Errorf("getting SVID: %w", err)
    }
    log.Printf(
        "SPIRE SVID issued: ID=%s, ExpiresAt=%s",
        svid.ID.String(),
        svid.Certificates[0].NotAfter,
    )

    return server, nil
}

// NewMTLSClient creates an HTTP client with automatic mTLS using SVIDs
func NewMTLSClient(
    ctx context.Context,
    serverSPIFFEID string,
) (*http.Client, error) {
    source, err := GetX509Source(ctx)
    if err != nil {
        return nil, err
    }

    // Authorize only the specific server SPIFFE ID
    serverID := spiffeid.RequireIDFromString(serverSPIFFEID)
    tlsConfig := tlsconfig.MTLSClientConfig(
        source,
        source,
        tlsconfig.AuthorizeID(serverID),
    )

    transport := &http.Transport{
        TLSClientConfig: tlsConfig,
    }

    return &http.Client{Transport: transport}, nil
}

// WatchSVIDRotation logs whenever the SVID is rotated (useful for debugging)
func WatchSVIDRotation(ctx context.Context) error {
    source, err := GetX509Source(ctx)
    if err != nil {
        return err
    }

    // The X509Source automatically handles rotation; log for observability
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            default:
                svid, err := source.GetX509SVID()
                if err != nil {
                    log.Printf("error fetching SVID: %v", err)
                    continue
                }
                log.Printf(
                    "current SVID: ID=%s expires=%s",
                    svid.ID.String(),
                    svid.Certificates[0].NotAfter,
                )
                // Check every 5 minutes
                time.Sleep(5 * time.Minute)
            }
        }
    }()
    return nil
}
```

## Section 7: JWT-SVID for Service Authentication

JWT-SVIDs are used for service-to-service authentication in scenarios where TLS termination happens at a proxy (e.g., API gateway) but the backend service still needs to verify the caller's identity.

```go
// jwt_svid.go
package identity

import (
    "context"
    "fmt"
    "net/http"

    "github.com/spiffe/go-spiffe/v2/svid/jwtsvid"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

// FetchJWTSVID retrieves a JWT-SVID for authenticating to a specific audience
func FetchJWTSVID(ctx context.Context, audience string) (string, error) {
    client, err := workloadapi.New(ctx,
        workloadapi.WithAddr(spireSocketPath),
    )
    if err != nil {
        return "", fmt.Errorf("creating workload API client: %w", err)
    }
    defer client.Close()

    // Request a JWT-SVID for the given audience
    svid, err := client.FetchJWTSVID(ctx, jwtsvid.Params{
        Audience: audience,
    })
    if err != nil {
        return "", fmt.Errorf("fetching JWT-SVID: %w", err)
    }

    return svid.Marshal(), nil
}

// NewAuthorizingHandler creates an HTTP middleware that validates JWT-SVIDs
func NewAuthorizingHandler(
    next http.Handler,
    trustedAudience string,
    allowedCallers []string,
) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Extract Bearer token from Authorization header
        authHeader := r.Header.Get("Authorization")
        if len(authHeader) < 8 || authHeader[:7] != "Bearer " {
            http.Error(w, "missing or invalid Authorization header", http.StatusUnauthorized)
            return
        }
        tokenStr := authHeader[7:]

        // Fetch JWT bundle for validation
        client, err := workloadapi.New(ctx,
            workloadapi.WithAddr(spireSocketPath),
        )
        if err != nil {
            http.Error(w, "internal error", http.StatusInternalServerError)
            return
        }
        defer client.Close()

        jwtBundleSet, err := client.FetchJWTBundles(ctx)
        if err != nil {
            http.Error(w, "internal error", http.StatusInternalServerError)
            return
        }

        // Validate the JWT-SVID
        svid, err := jwtsvid.ParseAndValidate(tokenStr, jwtBundleSet, []string{trustedAudience})
        if err != nil {
            http.Error(w, fmt.Sprintf("invalid JWT-SVID: %v", err), http.StatusUnauthorized)
            return
        }

        // Check that the caller is in the allowed list
        callerAllowed := false
        for _, allowed := range allowedCallers {
            if svid.ID.String() == allowed {
                callerAllowed = true
                break
            }
        }

        if !callerAllowed {
            http.Error(w, fmt.Sprintf("caller %s is not authorized", svid.ID), http.StatusForbidden)
            return
        }

        // Add the caller identity to the request context
        ctx = context.WithValue(ctx, callerIdentityKey{}, svid.ID.String())
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

type callerIdentityKey struct{}
```

## Section 8: Envoy SDS Integration for Automatic mTLS

Envoy's Secret Discovery Service (SDS) integrates with SPIRE to provide automatic mTLS certificate rotation without restarting Envoy or the application.

```yaml
# envoy-spiffe-config.yaml
# Envoy configuration for SPIRE-based mTLS
static_resources:
  listeners:
    - name: inbound_listener
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 8443
      filter_chains:
        - transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              require_client_certificate: true
              common_tls_context:
                # Fetch our certificate from SPIRE Agent via SDS
                tls_certificate_sds_secret_configs:
                  - name: "spiffe://cluster.example.com/ns/production/sa/payment-service"
                    sds_config:
                      api_config_source:
                        api_type: GRPC
                        grpc_services:
                          - envoy_grpc:
                              cluster_name: spire_agent
                        transport_api_version: V3
                      resource_api_version: V3
                # Fetch trust bundle from SPIRE Agent for client verification
                validation_context_sds_secret_config:
                  name: "spiffe://cluster.example.com"
                  sds_config:
                    api_config_source:
                      api_type: GRPC
                      grpc_services:
                        - envoy_grpc:
                            cluster_name: spire_agent
                      transport_api_version: V3
                    resource_api_version: V3
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: inbound
                codec_type: AUTO
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
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router

  clusters:
    # SPIRE Agent SDS cluster — connects to Workload API
    - name: spire_agent
      connect_timeout: 1s
      type: STATIC
      http2_protocol_options: {}
      load_assignment:
        cluster_name: spire_agent
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    pipe:
                      path: /run/spire/sockets/agent.sock

    # Local application cluster
    - name: local_app
      connect_timeout: 0.25s
      type: STATIC
      load_assignment:
        cluster_name: local_app
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: 127.0.0.1
                      port_value: 8080
```

Deploy Envoy as a sidecar with SPIRE socket access:

```yaml
# payment-service-with-envoy-sidecar.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:v2.3.1
          ports:
            - containerPort: 8080
        # Envoy sidecar for mTLS termination
        - name: envoy
          image: envoyproxy/envoy:v1.29.1
          args:
            - -c
            - /etc/envoy/envoy.yaml
            - --log-level
            - warn
          ports:
            - containerPort: 8443
              name: https
          volumeMounts:
            - name: envoy-config
              mountPath: /etc/envoy
              readOnly: true
            - name: spire-agent-socket
              mountPath: /run/spire/sockets
              readOnly: true
          resources:
            limits:
              cpu: 200m
              memory: 128Mi
            requests:
              cpu: 50m
              memory: 64Mi
      volumes:
        - name: envoy-config
          configMap:
            name: envoy-spiffe-config
        - name: spire-agent-socket
          hostPath:
            path: /run/spire/sockets
            type: Directory
```

## Section 9: Trust Bundle Federation Between Clusters

Federation enables workloads in separate trust domains (separate clusters) to authenticate each other using their respective SVIDs.

### Configure Federation on SPIRE Server

```bash
# On cluster-1: configure cluster-2 as a federated trust domain
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle set \
    -id spiffe://cluster2.example.com \
    -path /tmp/cluster2-bundle.pem

# On cluster-2: configure cluster-1 as a federated trust domain
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle set \
    -id spiffe://cluster.example.com \
    -path /tmp/cluster1-bundle.pem

# Verify federation is configured
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle list
```

### ClusterFederatedTrustDomain CRD

```yaml
# cluster-federated-trust-domain.yaml
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterFederatedTrustDomain
metadata:
  name: cluster2-federation
spec:
  trustDomain: cluster2.example.com
  bundleEndpointURL: https://spire-server.spire.cluster2.example.com:8443
  bundleEndpointProfile:
    type: https_spiffe
    endpointSPIFFEID: spiffe://cluster2.example.com/spire/server
  trustDomainBundle:
    x509Authorities:
      - asn1: "<base64-encoded-DER-certificate>"
```

### Registration Entries for Federated Access

```bash
# Allow payments-service in cluster-1 to call inventory-service in cluster-2
# Register on cluster-2's SPIRE Server:
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
    -spiffeID spiffe://cluster2.example.com/ns/production/sa/inventory-service \
    -parentID spiffe://cluster2.example.com/spire/agent/k8s_sat/cluster2/any \
    -selector k8s:ns:production \
    -selector k8s:sa:inventory-service \
    -federatesWith spiffe://cluster.example.com \
    -ttl 3600
```

## Section 10: Prometheus Metrics and Rotation Monitoring

### SPIRE Server and Agent Metrics

```
# HELP spire_server_agent_count Number of attested agents
# TYPE spire_server_agent_count gauge
spire_server_agent_count 12

# HELP spire_server_entry_count Number of registration entries
# TYPE spire_server_entry_count gauge
spire_server_entry_count 487

# HELP spire_server_svid_issuance_total Total SVIDs issued
# TYPE spire_server_svid_issuance_total counter
spire_server_svid_issuance_total{type="x509"} 24891
spire_server_svid_issuance_total{type="jwt"} 3421

# HELP spire_agent_svid_renewal_total Total SVID renewals performed
# TYPE spire_agent_svid_renewal_total counter
spire_agent_svid_renewal_total 1247

# HELP spire_agent_svid_rotation_rpc_duration_seconds Duration of SVID rotation RPC
# TYPE spire_agent_svid_rotation_rpc_duration_seconds histogram
spire_agent_svid_rotation_rpc_duration_seconds_bucket{le="0.01"} 892
spire_agent_svid_rotation_rpc_duration_seconds_bucket{le="0.05"} 1201
```

### Monitoring SVID Expiry

```bash
# Check SVID expiry via the SPIRE Agent CLI
kubectl exec -n spire $(kubectl get pods -n spire -l app=spire-agent -o jsonpath='{.items[0].metadata.name}') -- \
  /opt/spire/bin/spire-agent api fetch x509 \
    -socketPath /run/spire/sockets/agent.sock

# Prometheus alert for expiring SVIDs
# Add to alerting rules:
```

```yaml
# spire-alerting-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: spire-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: spire.rules
      interval: 30s
      rules:
        - alert: SPIREAgentDown
          expr: absent(up{job="spire-agent"} == 1)
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "SPIRE Agent is down on {{ $labels.instance }}"
            description: "No SPIRE Agent metrics received. Workload identity issuance is unavailable on this node."

        - alert: SPIREServerHighSVIDIssuanceRate
          expr: rate(spire_server_svid_issuance_total[5m]) > 100
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High SVID issuance rate on SPIRE Server"
            description: "SVID issuance rate is {{ $value | humanize }} per second, which may indicate a misconfigured TTL or certificate storm."

        - alert: SPIREAgentSVIDRotationFailure
          expr: increase(spire_agent_svid_rotation_rpc_duration_seconds_count[5m]) == 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "SPIRE Agent SVID rotation appears stalled"
            description: "No SVID rotation RPCs observed in the past 15 minutes. SVIDs may be expiring without renewal."
```

## Section 11: OIDC Federation for Cloud IAM

SPIRE can federate with cloud IAM systems (AWS IAM, GCP Workload Identity, Azure AD) using the OIDC Discovery endpoint, enabling Kubernetes workloads to obtain cloud credentials without static keys.

### OIDC Discovery Provider

```yaml
# spire-server-oidc-config.yaml (addition to server.conf)
# Add to the plugins section:
#
# BundlePublisher "aws_s3" {
#   plugin_data {
#     region = "us-east-1"
#     bucket = "example-spire-bundles"
#     object_key = "spiffe/cluster.example.com/bundle.jwks"
#   }
# }
#
# The OIDC discovery document is served by spire-oidc-provider:

apiVersion: apps/v1
kind: Deployment
metadata:
  name: spire-oidc-provider
  namespace: spire
spec:
  replicas: 2
  selector:
    matchLabels:
      app: spire-oidc-provider
  template:
    spec:
      containers:
        - name: spire-oidc-provider
          image: ghcr.io/spiffe/oidc-discovery-provider:1.9.4
          args:
            - -config
            - /etc/spire/oidc/config.hcl
          volumeMounts:
            - name: spire-server-socket
              mountPath: /tmp/spire-server/private
            - name: oidc-config
              mountPath: /etc/spire/oidc
          ports:
            - containerPort: 8080
              name: http
      volumes:
        - name: spire-server-socket
          emptyDir: {}
        - name: oidc-config
          configMap:
            name: spire-oidc-config
```

### AWS IAM Role for SPIFFE Workloads

```bash
# Create an AWS IAM role that trusts the SPIRE OIDC provider
aws iam create-role \
  --role-name payment-service-s3-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.spire.example.com"
        },
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": {
          "StringEquals": {
            "oidc.spire.example.com:sub": "spiffe://cluster.example.com/ns/production/sa/payment-service",
            "oidc.spire.example.com:aud": "sts.amazonaws.com"
          }
        }
      }
    ]
  }'

# Workloads can now call STS AssumeRoleWithWebIdentity
# using their JWT-SVID as the web identity token
```

## Section 12: Production Recommendations

**Trust Domain Design:** Use a DNS-like trust domain name that reflects the organizational boundary rather than the cluster name (e.g., `prod.example.com` not `k8s-prod-us-east-1`). The trust domain is baked into all SVIDs and cannot be changed without re-issuing all certificates.

**SVID TTL Tuning:** The default 1-hour X.509-SVID TTL balances security (short exposure window) and load (rotation RPCs). For highly sensitive workloads, reduce to 15 minutes. For workloads in batch jobs that run longer than the TTL, ensure the application uses the `go-spiffe` library's automatic rotation rather than fetching a one-time SVID at startup.

**Datastore HA:** The embedded SQLite datastore is not suitable for production HA. Use the PostgreSQL datastore plugin with at least two replicas and regular backups. The datastore holds all registration entries and trust bundles — losing it requires re-attestation of all agents.

**Key Manager Selection:** The `disk` key manager stores the server's CA key on the StatefulSet PVC. For production environments handling regulated data, use the `awskms` or `gcpkms` key manager to store keys in a Hardware Security Module (HSM) via cloud KMS services. This prevents CA key extraction even if the server pod is compromised.

**Bootstrap Bundle Distribution:** The SPIRE Agent requires the initial trust bundle to bootstrap its connection to the SPIRE Server. Use the `k8sbundle` Notifier plugin to publish the trust bundle to a Kubernetes ConfigMap automatically. This ConfigMap is mounted into Agent pods via the DaemonSet volume configuration and updated automatically when the CA rotates.
