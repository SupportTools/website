---
title: "Kubernetes SPIFFE/SPIRE: Workload Identity for Zero-Trust Service Authentication"
date: 2031-03-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "SPIFFE", "SPIRE", "Security", "Zero-Trust", "mTLS", "Identity", "Istio"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to SPIFFE standard, SVIDs, SPIRE server and agent architecture, Kubernetes workload attestation, X.509-SVID and JWT-SVID issuance, Istio SPIFFE integration, and automatic certificate rotation."
more_link: "yes"
url: "/kubernetes-spiffe-spire-workload-identity-zero-trust-authentication/"
---

SPIFFE (Secure Production Identity Framework for Everyone) is a specification for workload identity in dynamic infrastructure. SPIRE (SPIFFE Runtime Environment) is the reference implementation. Together, they solve the fundamental problem of zero-trust networking: how does a workload prove who it is without relying on network location (IP address) or static credentials (long-lived certificates or passwords)?

<!--more-->

# Kubernetes SPIFFE/SPIRE: Workload Identity for Zero-Trust Service Authentication

## Section 1: The Workload Identity Problem

### Why Static Credentials Fail

In traditional environments, services authenticate to each other using:
- **Static TLS certificates**: Manually rotated, expire unexpectedly, difficult to manage at scale.
- **Shared secrets**: Secrets leaked through logs, environment variables, and config files.
- **IP-based access control**: Breaks when services move (autoscaling, rescheduling, multi-cloud).
- **Service accounts with long-lived tokens**: Kubernetes service account tokens mounted into pods don't expire (by default) and can be compromised.

In a cloud-native, zero-trust environment, these approaches create operational complexity and security risks. SPIFFE/SPIRE replaces static credentials with:
- **Cryptographic workload identities** issued based on attestation of the workload's actual identity.
- **Short-lived certificates** (minutes to hours) that rotate automatically.
- **Identity tied to WHAT the workload IS** (its service account, namespace, pod name) rather than WHERE it runs.

### The SPIFFE Specification

A SPIFFE identity is a URI of the form:

```
spiffe://trust-domain/path
```

Examples:
```
spiffe://example.com/ns/production/sa/api-server
spiffe://example.com/ns/production/sa/database-service
spiffe://company.internal/cluster/prod/namespace/payments/pod/payments-api-xyz
```

The trust domain (`example.com`, `company.internal`) is a logical grouping of workloads that share a root CA. The path encodes identity attributes specific to the workload.

A **SVID (SPIFFE Verifiable Identity Document)** is a credential containing the SPIFFE ID. SVIDs come in two forms:
- **X.509-SVID**: A TLS certificate with the SPIFFE URI in the Subject Alternative Name (SAN) field.
- **JWT-SVID**: A JWT token with the SPIFFE ID as the `sub` claim.

## Section 2: SPIRE Architecture

### SPIRE Server

The SPIRE Server is the certificate authority for a trust domain. It:
- Manages registration entries (mappings from attestation attributes to SPIFFE IDs).
- Issues SVIDs to attested workloads via SPIRE Agents.
- Maintains a CA that signs SVIDs.
- Supports upstream CAs (external PKI, Vault, AWS ACM, etc.) for root of trust.

### SPIRE Agent

The SPIRE Agent runs on every node (as a DaemonSet in Kubernetes). It:
- Attests its own identity to the SPIRE Server using a node attestor.
- Maintains a local cache of SVIDs for workloads on its node.
- Serves the SPIFFE Workload API (a Unix domain socket) to workloads.
- Automatically rotates SVIDs before they expire.

### Attestation Flow

```
1. SPIRE Agent starts on a node
   Agent → Server: "I am node X, here is my EC2 instance document / Kubernetes SA token"
   Server validates: Yes, this is a real Kubernetes node in our cluster
   Server issues: Node SVID to the Agent

2. Workload requests a SVID
   Workload → Agent (via Unix socket): "I need a SVID"
   Agent identifies the workload: Kubernetes Pod UID, SA, namespace
   Agent → Server: "Workload matching [pod UID, SA, namespace] needs a SVID"
   Server checks registration entries: This workload matches spiffe://example.com/ns/prod/sa/api-server
   Server issues: X.509-SVID to the Agent
   Agent → Workload: Here is your SVID (valid for 1 hour, will auto-rotate at 50% TTL)

3. Service-to-service authentication
   Service A presents X.509-SVID to Service B
   Service B verifies: SPIFFE URI in cert = spiffe://example.com/ns/prod/sa/api-server
   Service B allows connection based on authorization policy
```

## Section 3: Deploying SPIRE on Kubernetes

### Installing SPIRE with Helm

```bash
# Add the SPIRE Helm chart repository
helm repo add spiffe https://spiffe.github.io/helm-charts-hardened/
helm repo update

# Create the spire namespace
kubectl create namespace spire-system

# Install SPIRE
helm install spire spiffe/spire \
  --namespace spire-system \
  --set global.trustDomain="example.com" \
  --set spire-server.replicaCount=3 \
  --set spire-server.persistence.size=10Gi \
  --wait
```

### Manual SPIRE Deployment

For production, use explicit configuration for full control:

```yaml
# spire-server-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-server
  namespace: spire-system
data:
  server.conf: |
    server {
      bind_address = "0.0.0.0"
      bind_port = "8081"
      trust_domain = "example.com"
      data_dir = "/run/spire/data"
      log_level = "INFO"

      # CA TTL: root certificate validity
      ca_ttl = "168h"    # 7 days

      # SVID TTL: workload certificate validity
      default_svid_ttl = "1h"

      # CA subject for generated certificates
      ca_subject = {
        country = ["US"]
        organization = ["My Organization"]
        common_name = "SPIRE"
      }
    }

    plugins {
      # Datastore: stores registration entries and server state
      DataStore "sql" {
        plugin_data {
          database_type = "postgres"
          connection_string = "host=postgresql.spire-system.svc.cluster.local port=5432 user=spire dbname=spire password=<secret> sslmode=require"
        }
      }

      # Node attestor: how SPIRE validates Kubernetes nodes
      NodeAttestor "k8s_psat" {
        plugin_data {
          clusters = {
            "production" = {
              service_account_allow_list = ["spire-system:spire-agent"]
              kube_config_file = ""   # In-cluster config
              allowed_node_label_keys = []
              allowed_pod_label_keys = []
            }
          }
        }
      }

      # Key manager: where SPIRE stores signing keys
      KeyManager "disk" {
        plugin_data {
          keys_path = "/run/spire/data/keys.json"
        }
      }

      # Bundle notifier: distribute trust bundles to other clusters
      BundlePublisher "k8s_bundle" {
        plugin_data {
          cluster = "production"
          namespace = "spire-system"
          configmap = "spire-bundle"
        }
      }

      # Upstream authority (use Vault for production PKI)
      UpstreamAuthority "vault" {
        plugin_data {
          vault_addr = "https://vault.example.com"
          pki_mount_point = "pki"
          approle_auth_mount_point = "auth/approle"
          approle_id = "spire-server"
          approle_secret_id_file_path = "/run/spire/vault/approle-secret"
        }
      }
    }

    health_checks {
      listener_enabled = true
      bind_address = "0.0.0.0"
      bind_port = "8080"
      live_path = "/live"
      ready_path = "/ready"
    }
```

```yaml
# spire-server-deployment.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: spire-server
  namespace: spire-system
spec:
  replicas: 3
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
        volumeMounts:
        - name: spire-config
          mountPath: /run/spire/config
          readOnly: true
        - name: spire-data
          mountPath: /run/spire/data
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /live
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 15
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 1Gi
      volumes:
      - name: spire-config
        configMap:
          name: spire-server
  volumeClaimTemplates:
  - metadata:
      name: spire-data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 10Gi
      storageClassName: fast-ssd
```

### SPIRE Agent DaemonSet

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-agent
  namespace: spire-system
data:
  agent.conf: |
    agent {
      data_dir = "/run/spire"
      log_level = "INFO"
      trust_domain = "example.com"
      server_address = "spire-server.spire-system.svc.cluster.local"
      server_port = "8081"
      insecure_bootstrap = false
      trust_bundle_path = "/run/spire/bundle/bundle.crt"
      authorized_delegates = []
    }

    plugins {
      # Workload Attestor: identifies Kubernetes workloads
      WorkloadAttestor "k8s" {
        plugin_data {
          # Skip container image signature verification (for testing)
          # skip_kubelet_verification = true
          node_name_env = "MY_NODE_NAME"
          kubelet_read_only_port = 10255
        }
      }

      # Node Attestor: how this agent proves its identity to the server
      NodeAttestor "k8s_psat" {
        plugin_data {
          cluster = "production"
          token_path = "/var/run/secrets/tokens/spire-agent"
        }
      }

      # Key Manager: where agent stores private keys for workload SVIDs
      KeyManager "memory" {}

      # Workload API socket location
    }

    health_checks {
      listener_enabled = true
      bind_address = "0.0.0.0"
      bind_port = "8080"
      live_path = "/live"
      ready_path = "/ready"
    }
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: spire-agent
  namespace: spire-system
spec:
  selector:
    matchLabels:
      app: spire-agent
  template:
    metadata:
      labels:
        app: spire-agent
    spec:
      hostPID: true
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      serviceAccountName: spire-agent
      initContainers:
      # Wait for server to be ready
      - name: init
        image: ghcr.io/spiffe/wait-for-it:1.9.4
        args:
        - spire-server.spire-system.svc.cluster.local:8081
        - --timeout=30
      containers:
      - name: spire-agent
        image: ghcr.io/spiffe/spire-agent:1.9.4
        args:
        - -config
        - /run/spire/config/agent.conf
        env:
        - name: MY_NODE_NAME
          valueFrom:
            fieldRef:
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
        - name: spire-agent-socket-dir
          mountPath: /run/spire/sockets
        - name: spire-token
          mountPath: /var/run/secrets/tokens
        - name: kubelet-cert
          mountPath: /run/spire/kubelet
          readOnly: true
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
        livenessProbe:
          httpGet:
            path: /live
            port: 8080
          initialDelaySeconds: 10
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
      volumes:
      - name: spire-config
        configMap:
          name: spire-agent
      - name: spire-bundle
        configMap:
          name: spire-bundle
      - name: spire-agent-socket-dir
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
      - name: kubelet-cert
        hostPath:
          path: /var/lib/kubelet/pki
```

## Section 4: Registration Entries

### Creating Registration Entries

Registration entries define the mapping from attestation attributes to SPIFFE IDs. Every workload that needs a SVID must have a matching registration entry.

```bash
# Register a workload using the SPIRE CLI
kubectl -n spire-system exec deploy/spire-server -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://example.com/ns/production/sa/api-server \
  -parentID spiffe://example.com/k8s-node/worker-1 \
  -selector k8s:ns:production \
  -selector k8s:sa:api-server \
  -ttl 3600

# Register with pod label selectors
kubectl -n spire-system exec deploy/spire-server -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://example.com/service/payments-api \
  -parentID spiffe://example.com/k8s-node/worker-1 \
  -selector k8s:ns:production \
  -selector k8s:pod-label:app:payments-api \
  -selector k8s:pod-label:version:stable \
  -ttl 1800

# List all entries
kubectl -n spire-system exec deploy/spire-server -- \
  /opt/spire/bin/spire-server entry show

# Show entries for a specific spiffeID
kubectl -n spire-system exec deploy/spire-server -- \
  /opt/spire/bin/spire-server entry show \
  -spiffeID spiffe://example.com/ns/production/sa/api-server
```

### Registration Entry YAML (for GitOps)

Use the SPIRE Controller Manager to manage registration entries as Kubernetes CRDs:

```yaml
# Install SPIRE Controller Manager
helm install spire-controller-manager spiffe/spire-controller-manager \
  --namespace spire-system \
  --set trustDomain=example.com

---
# Define a ClusterSPIFFEID (applies to all namespaces)
apiVersion: authentication.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: production-services
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      spiffe-workload: "true"
  namespaceSelector:
    matchLabels:
      environment: production
  ttl: "1h"
  hint: "production"

---
# Define a namespace-scoped SPIFFEID
apiVersion: authentication.spiffe.io/v1alpha1
kind: SPIFFEIDSpec
metadata:
  name: api-server
  namespace: production
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/production/sa/api-server"
  workloadSelectorTemplates:
  - "k8s:ns:production"
  - "k8s:sa:api-server"
  ttl: "1h"
```

## Section 5: X.509-SVID Usage

### Using SVIDs for mTLS

Applications access their SVID via the SPIFFE Workload API (a Unix domain socket at `/run/spire/sockets/agent.sock`). The Go SPIFFE library handles this:

```go
package main

import (
    "context"
    "crypto/tls"
    "log"
    "net/http"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

func main() {
    ctx := context.Background()

    // Connect to SPIRE Agent via Workload API
    source, err := workloadapi.NewX509Source(
        ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
        ),
    )
    if err != nil {
        log.Fatalf("failed to create X.509 source: %v", err)
    }
    defer source.Close()

    // Create an mTLS server using the SVID
    tlsConfig := tlsconfig.MTLSServerConfig(
        source,
        source,
        // Only accept clients with this SPIFFE ID
        tlsconfig.AuthorizeID(
            spiffeid.RequireIDFromString("spiffe://example.com/ns/production/sa/api-client"),
        ),
    )

    server := &http.Server{
        Addr:      ":443",
        TLSConfig: tlsConfig,
        Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract the client's SPIFFE ID from the TLS connection
            tlsConn := r.TLS
            if tlsConn != nil && len(tlsConn.PeerCertificates) > 0 {
                cert := tlsConn.PeerCertificates[0]
                log.Printf("Client SPIFFE ID: %s", cert.URIs[0].String())
            }
            w.WriteHeader(http.StatusOK)
            w.Write([]byte("authenticated"))
        }),
    }

    log.Println("Starting mTLS server on :443")
    log.Fatal(server.ListenAndServeTLS("", ""))
}
```

### mTLS Client

```go
package main

import (
    "context"
    "fmt"
    "io"
    "log"
    "net/http"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

func main() {
    ctx := context.Background()

    source, err := workloadapi.NewX509Source(ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
        ),
    )
    if err != nil {
        log.Fatalf("failed to create X.509 source: %v", err)
    }
    defer source.Close()

    // Create mTLS client config
    // Only connect to servers with the specified SPIFFE ID
    serverID := spiffeid.RequireIDFromString(
        "spiffe://example.com/ns/production/sa/api-server",
    )
    tlsConfig := tlsconfig.MTLSClientConfig(source, source,
        tlsconfig.AuthorizeID(serverID),
    )

    client := &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: tlsConfig,
        },
    }

    resp, err := client.Get("https://api-server.production.svc.cluster.local/health")
    if err != nil {
        log.Fatalf("request failed: %v", err)
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Printf("Response: %s\n", string(body))
}
```

The `source` automatically watches the SPIRE Agent for SVID updates. When the SVID is about to expire, the SPIRE Agent rotates it and the `source` automatically picks up the new certificate — zero downtime, zero manual intervention.

## Section 6: JWT-SVID Usage

JWT-SVIDs are used for authorization tokens in request headers, similar to OIDC tokens:

```go
package main

import (
    "context"
    "log"
    "net/http"

    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

func main() {
    ctx := context.Background()

    jwtSource, err := workloadapi.NewJWTSource(ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
        ),
    )
    if err != nil {
        log.Fatalf("failed to create JWT source: %v", err)
    }
    defer jwtSource.Close()

    // Fetch a JWT-SVID for the "api-server" audience
    svid, err := jwtSource.FetchJWTSVID(ctx,
        workloadapi.JWTSVIDParams{
            Audience: []string{"spiffe://example.com/ns/production/sa/api-server"},
        },
    )
    if err != nil {
        log.Fatalf("failed to fetch JWT SVID: %v", err)
    }

    // Use the JWT token in HTTP Authorization header
    req, _ := http.NewRequest("GET", "https://api-server/protected", nil)
    req.Header.Set("Authorization", "Bearer "+svid.Marshal())

    client := &http.Client{}
    resp, err := client.Do(req)
    if err != nil {
        log.Fatalf("request failed: %v", err)
    }
    defer resp.Body.Close()

    log.Printf("Status: %s", resp.Status)
}
```

### JWT-SVID Validation

```go
package main

import (
    "context"
    "log"
    "net/http"
    "strings"

    "github.com/spiffe/go-spiffe/v2/workloadapi"
    "github.com/spiffe/go-spiffe/v2/svid/jwtsvid"
)

func validateJWTMiddleware(jwtSource *workloadapi.JWTSource) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            authHeader := r.Header.Get("Authorization")
            if !strings.HasPrefix(authHeader, "Bearer ") {
                http.Error(w, "missing authorization", http.StatusUnauthorized)
                return
            }

            token := strings.TrimPrefix(authHeader, "Bearer ")

            // Parse and validate the JWT-SVID
            svid, err := jwtsvid.ParseAndValidate(
                token,
                jwtSource,
                []string{"spiffe://example.com/ns/production/sa/api-server"},
            )
            if err != nil {
                log.Printf("JWT validation failed: %v", err)
                http.Error(w, "invalid token", http.StatusUnauthorized)
                return
            }

            log.Printf("Authenticated workload: %s", svid.ID.String())

            // Pass the SPIFFE ID downstream for authorization
            r = r.WithContext(
                context.WithValue(r.Context(), "spiffe-id", svid.ID.String()),
            )
            next.ServeHTTP(w, r)
        })
    }
}
```

## Section 7: Istio Integration with SPIFFE

### Istio Using SPIRE as the CA

Istio's Citadel CA can be replaced with SPIRE, enabling Istio's mTLS to use SPIFFE-compliant certificates with full attestation.

```bash
# Install Istio with SPIRE integration
istioctl install --set values.pilot.env.PILOT_ENABLE_CROSS_CLUSTER_WORKLOAD_ENTRY=true \
  -f - << 'EOF'
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio
spec:
  meshConfig:
    # Use SPIRE for certificate issuance
    certificates:
    - secretName: cacerts
      dnsNames:
      - istiod.istio-system.svc

    trustDomain: "example.com"
    defaultConfig:
      proxyMetadata:
        # Tell Envoy to use the SPIFFE Workload API
        ISTIO_META_CERT_PROVIDER: custom
        ISTIO_META_TLS_CLIENT_ROOT_CERT: /run/spire/sockets/agent.sock

  values:
    global:
      caAddress: "spire-server.spire-system.svc.cluster.local:8081"
EOF
```

Configure SPIRE's Envoy SDS (Secret Discovery Service) integration:

```yaml
# SPIRE Entry for Istio sidecars
apiVersion: authentication.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: istio-sidecar-identity
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchExpressions:
    - key: security.istio.io/tlsMode
      operator: Exists
  namespaceSelector: {}
  ttl: "1h"
```

### Verifying SPIFFE IDs in Istio

```bash
# Check the SPIFFE ID being used by a sidecar
kubectl exec -it -n production deploy/api-server -c istio-proxy -- \
  openssl s_client -connect payments-api.production.svc.cluster.local:443 \
  -showcerts 2>/dev/null | openssl x509 -noout -text | grep "URI:"
# URI:spiffe://example.com/ns/production/sa/payments-api

# List all active certificates in the mesh
istioctl proxy-config secret -n production deploy/api-server

# Check Istio AuthorizationPolicy using SPIFFE IDs
kubectl apply -f - << 'EOF'
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-api-server
  namespace: production
spec:
  selector:
    matchLabels:
      app: payments-api
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        - "spiffe://example.com/ns/production/sa/api-server"
    to:
    - operation:
        methods: ["POST"]
        paths: ["/api/v1/payments/*"]
EOF
```

## Section 8: SVID Rotation and Certificate Management

### Automatic Rotation

SPIRE Agents automatically rotate SVIDs before they expire. The rotation happens at 50% of the TTL by default:

```
SVID TTL = 1 hour
Rotation at = 30 minutes (50% of TTL)

Timeline:
t=0:00  SVID issued (valid for 1 hour)
t=0:30  SPIRE Agent requests new SVID from Server
t=0:31  New SVID available in Agent's cache
t=0:32  workloadapi.X509Source picks up new SVID
t=0:33  New SVID starts being used for new TLS handshakes
t=1:00  Old SVID expires (any connections using it will see handshake failures)
```

For critical services, configure shorter TTLs and more frequent rotation:

```bash
# Create entry with 30-minute TTL (rotation at 15 minutes)
kubectl -n spire-system exec deploy/spire-server -- \
  /opt/spire/bin/spire-server entry update \
  -entryID <entry-id> \
  -ttl 1800
```

### Monitoring Certificate Rotation

```go
package main

import (
    "context"
    "log"
    "time"

    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

func monitorSVIDRotation(ctx context.Context) {
    source, err := workloadapi.NewX509Source(ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
        ),
    )
    if err != nil {
        log.Fatalf("failed to create source: %v", err)
    }
    defer source.Close()

    for {
        svids, err := source.GetX509BundleForTrustDomain(
            // context
        )
        _ = svids

        // Get current SVID and check expiry
        svid, _, err := source.GetX509SVID()
        if err != nil {
            log.Printf("failed to get SVID: %v", err)
            time.Sleep(10 * time.Second)
            continue
        }

        certs := svid.Certificates
        if len(certs) > 0 {
            leaf := certs[0]
            timeUntilExpiry := time.Until(leaf.NotAfter)
            log.Printf("SVID expires in: %v", timeUntilExpiry)

            if timeUntilExpiry < 5*time.Minute {
                log.Printf("WARNING: SVID expiring soon! ID: %s", svid.ID)
                // Alert!
            }
        }

        time.Sleep(60 * time.Second)
    }
}
```

## Section 9: Trust Federation Between Clusters

SPIRE supports federating trust between multiple clusters, allowing workloads in one cluster to authenticate to workloads in another:

```bash
# Configure federation between cluster-a and cluster-b

# On cluster-a SPIRE server: declare federation with cluster-b
kubectl -n spire-system exec deploy/spire-server -- \
  /opt/spire/bin/spire-server federation create \
  --bundle-endpoint-url https://spire-server.cluster-b.example.com:8443 \
  --bundle-endpoint-profile https_spiffe \
  --trust-domain cluster-b.example.com \
  --endpoint-spiffe-id spiffe://cluster-b.example.com/spire/server

# Create a registration entry that allows a workload from cluster-b
kubectl -n spire-system exec deploy/spire-server -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://example.com/federated/payments-processor \
  -federatesWith "cluster-b.example.com" \
  -selector k8s:ns:production \
  -selector k8s:sa:payments-processor
```

## Section 10: Operational Monitoring

### SPIRE Health Metrics

```yaml
# Prometheus ServiceMonitor for SPIRE
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: spire-server
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: spire-server
  endpoints:
  - port: health
    path: /metrics
    interval: 30s
```

Key metrics to monitor:

```promql
# SVID issuance rate
rate(spire_agent_svid_rotations_total[5m])

# Server attestation rate
rate(spire_server_attestor_success_total[5m])

# Rotation failures (critical alert)
rate(spire_agent_svid_rotation_failed_total[5m]) > 0

# Time since last successful rotation (alert if > TTL/2)
time() - spire_agent_last_bundle_update_time > 1800   # 30 min threshold

# Number of active SVIDs per node
spire_agent_active_svids_total

# Certificate expiry (agent node certificate)
(spire_agent_svid_expiry_time - time()) / 3600 < 1   # Alert if < 1 hour
```

### Alert Rules

```yaml
groups:
- name: spire.rules
  rules:
  - alert: SPIREAgentDown
    expr: up{job="spire-agent"} == 0
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "SPIRE Agent is down on node {{ $labels.instance }}"
      description: "Workloads on this node cannot get new SVIDs or rotate existing ones."

  - alert: SPIREServerDown
    expr: up{job="spire-server"} == 0
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "SPIRE Server is down"

  - alert: SPIRESVIDRotationFailing
    expr: rate(spire_agent_svid_rotation_failed_total[15m]) > 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "SPIRE SVID rotation failures detected on {{ $labels.instance }}"
```

## Summary

SPIFFE/SPIRE provides a foundation for zero-trust workload authentication:

- **SPIFFE IDs** are URI-based identities that uniquely identify workloads independent of network location.
- **SVIDs** (X.509 and JWT) are short-lived credentials that prove a workload's SPIFFE identity.
- **SPIRE Agent** runs on every node, attests workloads via Kubernetes attestation, and provides SVIDs via the Workload API socket.
- **SPIRE Server** manages registration entries, signs SVIDs, and federates trust with other clusters.
- **Automatic rotation** happens at 50% TTL — workloads never need to manage certificate rotation.
- **Istio integration** replaces Citadel CA with SPIRE, adding cryptographic attestation to Istio's mTLS.

The result is a PKI system where every service's identity is continuously proven by attestation against known cluster properties, certificates are valid for minutes or hours rather than years, and rotation is fully automated without service restarts.
