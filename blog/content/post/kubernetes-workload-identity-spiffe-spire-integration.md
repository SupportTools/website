---
title: "Kubernetes Workload Identity Federation: SPIFFE/SPIRE Integration"
date: 2029-09-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "SPIFFE", "SPIRE", "Security", "Workload Identity", "mTLS", "Zero Trust"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing SPIFFE/SPIRE for workload identity in Kubernetes clusters, covering X.509 SVID issuance, JWT-SVIDs, workload API integration, and federated identity with AWS and GCP."
more_link: "yes"
url: "/kubernetes-workload-identity-spiffe-spire-integration/"
---

Workload identity is the foundation of zero-trust security in modern distributed systems. Rather than relying on network topology, IP addresses, or shared secrets to authenticate services, SPIFFE (Secure Production Identity Framework For Everyone) provides a cryptographic identity standard that allows workloads to prove who they are regardless of where they run. SPIRE (the SPIFFE Runtime Environment) is the reference implementation of the SPIFFE specification, and its integration with Kubernetes enables powerful security architectures that scale from single clusters to multi-cloud federations.

This guide covers the complete SPIFFE/SPIRE stack from architecture through production deployment, including X.509 SVID issuance, JWT-SVID service authentication, the Workload API, and federation with AWS IAM and GCP Workload Identity.

<!--more-->

# Kubernetes Workload Identity Federation: SPIFFE/SPIRE Integration

## Section 1: The SPIFFE Specification

SPIFFE defines a framework for workload identity that consists of three core components: a URI-based identity format (SPIFFE ID), X.509 certificates that carry that identity (X.509-SVIDs), and JWT tokens that carry that identity (JWT-SVIDs).

### SPIFFE IDs

A SPIFFE ID is a URI in the form `spiffe://<trust-domain>/<path>`. The trust domain identifies the administrative domain responsible for the identity, while the path identifies the specific workload.

```
spiffe://prod.example.com/ns/payments/sa/checkout-service
spiffe://prod.example.com/ns/auth/sa/token-service
spiffe://staging.example.com/ns/payments/sa/checkout-service
```

In Kubernetes, SPIRE typically maps SPIFFE IDs to service accounts, namespaces, or pod labels. The trust domain usually corresponds to the cluster or organization, and federation allows trust to span multiple domains.

### X.509-SVIDs

An X.509-SVID is a standard X.509 certificate with two requirements: the Subject Alternative Name (SAN) field must contain the SPIFFE ID as a URI SAN, and the certificate must be signed by a SPIFFE trust bundle.

```bash
# Inspect an X.509-SVID
openssl x509 -in svid.pem -noout -text | grep -A2 "Subject Alternative Name"
# Output:
# X509v3 Subject Alternative Name:
#     URI:spiffe://prod.example.com/ns/payments/sa/checkout-service
```

The certificate chain from leaf SVID to root CA constitutes the trust bundle for the domain. Services validate peer identity by checking that the peer's certificate is signed by a trusted bundle and that the SPIFFE ID matches expected values.

### JWT-SVIDs

JWT-SVIDs are short-lived JWTs (typically 5 minutes) signed by the SPIRE server. They carry the SPIFFE ID in the `sub` claim and an `aud` claim identifying the intended recipient.

```json
{
  "sub": "spiffe://prod.example.com/ns/payments/sa/checkout-service",
  "aud": ["spiffe://prod.example.com/ns/inventory/sa/inventory-service"],
  "exp": 1727345678,
  "iat": 1727345378
}
```

JWT-SVIDs are useful when mTLS is impractical, such as when communicating with external APIs or when a service needs to prove its identity to a non-TLS endpoint.

## Section 2: SPIRE Architecture

SPIRE consists of two main components: the SPIRE Server and SPIRE Agents.

### SPIRE Server

The SPIRE Server is the trust anchor for the system. It maintains the Certificate Authority (CA), stores registration entries that map workload selectors to SPIFFE IDs, and issues SVIDs to agents on behalf of workloads.

Key responsibilities:
- Maintains the signing CA (can integrate with AWS PCA, Vault, or use an embedded CA)
- Stores and manages registration entries
- Attests agents using node attestation plugins
- Issues X.509-SVIDs and JWT-SVIDs to workloads through agents

### SPIRE Agent

The SPIRE Agent runs as a DaemonSet on every Kubernetes node. It performs workload attestation to verify which workloads are running on its node, then fetches SVIDs from the server on their behalf.

Key responsibilities:
- Attests itself to the SPIRE Server using node attestation (Kubernetes SAT, AWS IID, GCP IIT)
- Exposes the Workload API via a Unix domain socket
- Attests workloads using workload attestation plugins (Kubernetes, Docker, Unix)
- Caches SVIDs and rotates them before expiry

### Registration Entries

Registration entries map workload selectors to SPIFFE IDs. In Kubernetes, selectors typically include namespace, service account name, and optionally pod labels.

```bash
# Create a registration entry for the payments service
spire-server entry create \
  -spiffeID spiffe://prod.example.com/ns/payments/sa/checkout-service \
  -parentID spiffe://prod.example.com/spire/agent/k8s_sat/prod-cluster/node1 \
  -selector k8s:ns:payments \
  -selector k8s:sa:checkout-service \
  -ttl 3600
```

## Section 3: Deploying SPIRE on Kubernetes

### Namespace and RBAC Setup

```yaml
# spire-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: spire
---
# spire-server-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spire-server
  namespace: spire
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: spire-server-cluster-role
rules:
  - apiGroups: [""]
    resources: ["pods", "nodes", "nodes/proxy"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["authentication.k8s.io"]
    resources: ["tokenreviews"]
    verbs: ["create"]
  - apiGroups: ["authorization.k8s.io"]
    resources: ["subjectaccessreviews"]
    verbs: ["create"]
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
  name: spire-server
  namespace: spire
data:
  server.conf: |
    server {
      bind_address = "0.0.0.0"
      bind_port = "8081"
      socket_path = "/tmp/spire-server/private/api.sock"
      trust_domain = "prod.example.com"
      data_dir = "/run/spire/data"
      log_level = "INFO"

      # JWT SVID configuration
      jwt_issuer = "https://spire.prod.example.com"

      # CA configuration
      ca_subject {
        country = ["US"]
        organization = ["Example Corp"]
        common_name = ""
      }

      # CA TTL (how long the CA cert is valid)
      ca_ttl = "168h"

      # Default SVID TTL
      default_svid_ttl = "1h"
    }

    plugins {
      DataStore "sql" {
        plugin_data {
          database_type = "sqlite3"
          connection_string = "/run/spire/data/datastore.sqlite3"
        }
      }

      NodeAttestor "k8s_sat" {
        plugin_data {
          clusters = {
            "prod-cluster" = {
              service_account_allow_list = ["spire:spire-agent"]
              kube_config_file = ""
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

      Notifier "k8sbundle" {
        plugin_data {
          namespace = "spire"
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
spec:
  replicas: 1
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
          image: ghcr.io/spiffe/spire-server:1.9.0
          args: ["-config", "/run/spire/config/server.conf"]
          ports:
            - containerPort: 8081
          livenessProbe:
            httpGet:
              path: /live
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 60
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: spire-config
              mountPath: /run/spire/config
              readOnly: true
            - name: spire-data
              mountPath: /run/spire/data
              readOnly: false
            - name: spire-server-socket
              mountPath: /tmp/spire-server/private
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
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: spire-server
  namespace: spire
spec:
  type: ClusterIP
  ports:
    - name: grpc
      port: 8081
      protocol: TCP
  selector:
    app: spire-server
```

### SPIRE Agent DaemonSet

```yaml
# spire-agent-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-agent
  namespace: spire
data:
  agent.conf: |
    agent {
      data_dir = "/run/spire"
      log_level = "INFO"
      server_address = "spire-server"
      server_port = "8081"
      socket_path = "/run/spire/sockets/agent.sock"
      trust_bundle_path = "/run/spire/bundle/bundle.crt"
      trust_domain = "prod.example.com"
    }

    plugins {
      NodeAttestor "k8s_sat" {
        plugin_data {
          cluster = "prod-cluster"
          token_path = "/var/run/secrets/tokens/spire-agent"
        }
      }

      KeyManager "memory" {
        plugin_data {}
      }

      WorkloadAttestor "k8s" {
        plugin_data {
          skip_kubelet_verification = false
          node_name_env = "MY_NODE_NAME"
          kubelet_read_only_port = 0
          kubelet_secure_port = 10250
        }
      }

      WorkloadAttestor "unix" {
        plugin_data {}
      }
    }

    health_checks {
      listener_enabled = true
      bind_address = "0.0.0.0"
      bind_port = "8080"
      live_path = "/live"
      ready_path = "/ready"
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
        - name: init
          image: ghcr.io/spiffe/spire-agent:1.9.0
          command:
            - "/opt/spire/bin/spire-agent"
            - "api"
            - "fetch"
            - "-socketPath"
            - "/run/spire/sockets/agent.sock"
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
      containers:
        - name: spire-agent
          image: ghcr.io/spiffe/spire-agent:1.9.0
          args: ["-config", "/run/spire/config/agent.conf"]
          env:
            - name: MY_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          volumeMounts:
            - name: spire-config
              mountPath: /run/spire/config
              readOnly: true
            - name: spire-bundle
              mountPath: /run/spire/bundle
              readOnly: true
            - name: spire-agent-socket-dir
              mountPath: /run/spire/sockets
              readOnly: false
            - name: spire-token
              mountPath: /var/run/secrets/tokens
          livenessProbe:
            httpGet:
              path: /live
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 60
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
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
```

## Section 4: Workload API and SVID Fetching

The Workload API is a gRPC API exposed by the SPIRE Agent via a Unix domain socket. Workloads call this API to obtain their SVIDs without needing any credentials — identity is established through the workload attestation process.

### Go Client for the Workload API

```go
package main

import (
    "context"
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "log"
    "time"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Connect to the Workload API
    client, err := workloadapi.New(ctx,
        workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
    )
    if err != nil {
        log.Fatalf("failed to create workload API client: %v", err)
    }
    defer client.Close()

    // Fetch X.509-SVIDs
    svids, err := client.FetchX509SVIDs(ctx)
    if err != nil {
        log.Fatalf("failed to fetch X.509-SVIDs: %v", err)
    }

    for _, svid := range svids {
        fmt.Printf("SPIFFE ID: %s\n", svid.ID)
        fmt.Printf("Certificate expiry: %s\n", svid.Certificates[0].NotAfter)
    }

    // Watch for SVID updates (for long-running services)
    err = client.WatchX509SVIDs(ctx, &x509SVIDWatcher{})
    if err != nil && ctx.Err() == nil {
        log.Fatalf("SVID watcher error: %v", err)
    }
}

type x509SVIDWatcher struct{}

func (w *x509SVIDWatcher) OnX509SVIDsUpdate(svids *workloadapi.X509SVIDs) {
    for _, svid := range svids.SVIDs {
        log.Printf("SVID updated: %s, expires: %s", svid.ID, svid.Certificates[0].NotAfter)
    }
}

func (w *x509SVIDWatcher) OnX509SVIDsWatchError(err error) {
    log.Printf("SVID watch error: %v", err)
}
```

### mTLS Server with SPIFFE Identity Verification

```go
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "log"
    "net"
    "net/http"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

func runServer(ctx context.Context) error {
    // Define allowed client identities
    authorizedClient := spiffeid.RequireIDFromString(
        "spiffe://prod.example.com/ns/payments/sa/checkout-service",
    )

    // Create TLS configuration using SPIFFE
    source, err := workloadapi.NewX509Source(ctx,
        workloadapi.WithDefaultX509SVIDPicker(),
    )
    if err != nil {
        return fmt.Errorf("failed to create X.509 source: %w", err)
    }
    defer source.Close()

    tlsConfig := tlsconfig.MTLSServerConfig(
        source,
        source,
        tlsconfig.AuthorizeID(authorizedClient),
    )

    listener, err := tls.Listen("tcp", ":8443", tlsConfig)
    if err != nil {
        return fmt.Errorf("failed to listen: %w", err)
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/api/v1/data", func(w http.ResponseWriter, r *http.Request) {
        // The peer identity is available in the TLS connection state
        tlsState := r.TLS
        if tlsState != nil && len(tlsState.PeerCertificates) > 0 {
            cert := tlsState.PeerCertificates[0]
            log.Printf("Request from: %v", cert.URIs)
        }
        w.WriteHeader(http.StatusOK)
        w.Write([]byte(`{"status": "ok"}`))
    })

    server := &http.Server{Handler: mux}
    return server.Serve(listener)
}

func runClient(ctx context.Context, serverID spiffeid.ID) error {
    source, err := workloadapi.NewX509Source(ctx)
    if err != nil {
        return fmt.Errorf("failed to create X.509 source: %w", err)
    }
    defer source.Close()

    // Create an mTLS connection that verifies the server's SPIFFE ID
    conn, err := spiffetls.Dial(ctx, "tcp", "inventory-service:8443",
        spiffetls.MTLSClient(
            tlsconfig.AuthorizeID(serverID),
            source,
        ),
    )
    if err != nil {
        return fmt.Errorf("failed to connect: %w", err)
    }
    defer conn.Close()

    log.Printf("Connected to server with identity: %s", serverID)
    return nil
}
```

## Section 5: JWT-SVID for Service Authentication

JWT-SVIDs are particularly useful for authenticating to services that don't support mTLS, such as external APIs or services behind an API gateway.

### Fetching and Using JWT-SVIDs

```go
package main

import (
    "context"
    "fmt"
    "log"
    "net/http"
    "time"

    "github.com/spiffe/go-spiffe/v2/svid/jwtsvid"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

type JWTSVIDManager struct {
    client    *workloadapi.Client
    audience  string
    cache     *jwtsvid.SVID
    cacheTime time.Time
}

func NewJWTSVIDManager(ctx context.Context, socketPath, audience string) (*JWTSVIDManager, error) {
    client, err := workloadapi.New(ctx,
        workloadapi.WithAddr("unix://"+socketPath),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create workload API client: %w", err)
    }

    return &JWTSVIDManager{
        client:   client,
        audience: audience,
    }, nil
}

func (m *JWTSVIDManager) GetToken(ctx context.Context) (string, error) {
    // Check if cached token is still valid (with 30-second buffer)
    if m.cache != nil && time.Now().Before(m.cache.Expiry.Add(-30*time.Second)) {
        return m.cache.Marshal(), nil
    }

    // Fetch new JWT-SVID
    svid, err := m.client.FetchJWTSVID(ctx, jwtsvid.Params{
        Audience: m.audience,
    })
    if err != nil {
        return "", fmt.Errorf("failed to fetch JWT-SVID: %w", err)
    }

    m.cache = svid
    m.cacheTime = time.Now()

    log.Printf("Fetched new JWT-SVID for audience %s, expires: %s",
        m.audience, svid.Expiry)

    return svid.Marshal(), nil
}

// HTTP middleware that adds JWT-SVID as Bearer token
func (m *JWTSVIDManager) AuthenticatedHTTPClient(ctx context.Context) *http.Client {
    return &http.Client{
        Transport: &jwtTransport{
            manager: m,
            base:    http.DefaultTransport,
            ctx:     ctx,
        },
    }
}

type jwtTransport struct {
    manager *JWTSVIDManager
    base    http.RoundTripper
    ctx     context.Context
}

func (t *jwtTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    token, err := t.manager.GetToken(t.ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to get JWT-SVID: %w", err)
    }

    reqCopy := req.Clone(req.Context())
    reqCopy.Header.Set("Authorization", "Bearer "+token)

    return t.base.RoundTrip(reqCopy)
}

// JWT-SVID validation on the server side
func validateJWTSVID(ctx context.Context, tokenString, expectedAudience string) error {
    source, err := workloadapi.NewJWTSource(ctx)
    if err != nil {
        return fmt.Errorf("failed to create JWT source: %w", err)
    }
    defer source.Close()

    svid, err := jwtsvid.ParseAndValidate(tokenString, source, []string{expectedAudience})
    if err != nil {
        return fmt.Errorf("invalid JWT-SVID: %w", err)
    }

    log.Printf("Validated JWT-SVID for workload: %s", svid.ID)
    return nil
}
```

## Section 6: AWS IAM Federation

SPIRE can federate with AWS IAM, allowing Kubernetes workloads to assume AWS IAM roles using their SPIFFE identity without storing static credentials.

### SPIRE-AWS OIDC Configuration

```hcl
# SPIRE Server configuration for AWS OIDC
server {
  trust_domain = "prod.example.com"
  jwt_issuer   = "https://spire.prod.example.com"
}

plugins {
  # Use AWS PCA as the upstream CA
  UpstreamAuthority "aws_pca" {
    plugin_data {
      region = "us-east-1"
      certificate_authority_arn = "arn:aws:acm-pca:us-east-1:123456789012:certificate-authority/abc123"
      signing_algorithm = "SHA256WITHRSA"
      assume_role_arn = "arn:aws:iam::123456789012:role/SpireServerRole"
    }
  }
}
```

```bash
# Create AWS OIDC provider for SPIRE
OIDC_URL="https://spire.prod.example.com"
THUMBPRINT=$(openssl s_client -connect spire.prod.example.com:443 -servername spire.prod.example.com \
  </dev/null 2>/dev/null | openssl x509 -fingerprint -noout | sed 's/SHA1 Fingerprint=//;s/://g' | tr '[:upper:]' '[:lower:]')

aws iam create-open-id-connect-provider \
  --url "${OIDC_URL}" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "${THUMBPRINT}"

# Create IAM role for SPIFFE-authenticated workloads
cat > trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/spire.prod.example.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "spire.prod.example.com:sub": "spiffe://prod.example.com/ns/payments/sa/checkout-service",
          "spire.prod.example.com:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
  --role-name CheckoutServiceRole \
  --assume-role-policy-document file://trust-policy.json
```

### Go Code for AWS Credential Exchange

```go
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/credentials/stscreds"
    "github.com/aws/aws-sdk-go-v2/service/sts"
    "github.com/spiffe/go-spiffe/v2/svid/jwtsvid"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

type SPIFFEAWSCredentialProvider struct {
    workloadClient *workloadapi.Client
    roleARN        string
    sessionName    string
}

func (p *SPIFFEAWSCredentialProvider) getAWSCredentials(ctx context.Context) (aws.Credentials, error) {
    // Fetch JWT-SVID with AWS STS as audience
    jwtSVID, err := p.workloadClient.FetchJWTSVID(ctx, jwtsvid.Params{
        Audience: "sts.amazonaws.com",
    })
    if err != nil {
        return aws.Credentials{}, fmt.Errorf("failed to fetch JWT-SVID: %w", err)
    }

    token := jwtSVID.Marshal()
    log.Printf("Exchanging JWT-SVID for AWS credentials, SPIFFE ID: %s", jwtSVID.ID)

    // Exchange JWT-SVID for AWS credentials via STS
    cfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        return aws.Credentials{}, fmt.Errorf("failed to load AWS config: %w", err)
    }

    stsClient := sts.NewFromConfig(cfg)
    result, err := stsClient.AssumeRoleWithWebIdentity(ctx,
        &sts.AssumeRoleWithWebIdentityInput{
            RoleArn:          aws.String(p.roleARN),
            RoleSessionName:  aws.String(p.sessionName),
            WebIdentityToken: aws.String(token),
            DurationSeconds:  aws.Int32(3600),
        },
    )
    if err != nil {
        return aws.Credentials{}, fmt.Errorf("failed to assume role: %w", err)
    }

    return aws.Credentials{
        AccessKeyID:     *result.Credentials.AccessKeyId,
        SecretAccessKey: *result.Credentials.SecretAccessKey,
        SessionToken:    *result.Credentials.SessionToken,
        Expires:         *result.Credentials.Expiration,
        CanExpire:       true,
    }, nil
}
```

## Section 7: GCP Workload Identity Federation

```bash
# Configure GCP Workload Identity Federation with SPIRE
gcloud iam workload-identity-pools create spire-pool \
  --project=my-project \
  --location=global \
  --display-name="SPIRE Workload Identity Pool"

gcloud iam workload-identity-pools providers create-oidc spire-provider \
  --project=my-project \
  --location=global \
  --workload-identity-pool=spire-pool \
  --display-name="SPIRE OIDC Provider" \
  --issuer-uri="https://spire.prod.example.com" \
  --allowed-audiences="https://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/spire-pool/providers/spire-provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.spiffe_id=assertion.sub" \
  --attribute-condition="assertion.sub.startsWith('spiffe://prod.example.com/')"

# Grant service account access to GCP resources
gcloud iam service-accounts add-iam-policy-binding payments-sa@my-project.iam.gserviceaccount.com \
  --project=my-project \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/spire-pool/attribute.spiffe_id/spiffe://prod.example.com/ns/payments/sa/checkout-service"
```

## Section 8: SPIFFE Federation Between Clusters

Trust federation allows workloads in different trust domains to authenticate with each other. This is essential in multi-cluster or multi-organization scenarios.

### Server Configuration for Federation

```hcl
# Server A configuration (prod.example.com)
server {
  trust_domain = "prod.example.com"

  federation {
    bundle_endpoint {
      address = "0.0.0.0"
      port = 8443
    }

    federates_with "staging.example.com" {
      bundle_endpoint_url = "https://spire-server.staging.example.com:8443"
      bundle_endpoint_profile "https_spiffe" {
        endpoint_spiffe_id = "spiffe://staging.example.com/spire/server"
      }
    }
  }
}
```

```bash
# Create federation registration entries that cross trust domains
spire-server entry create \
  -spiffeID spiffe://prod.example.com/ns/payments/sa/checkout-service \
  -parentID spiffe://prod.example.com/spire/agent/k8s_sat/prod-cluster/node1 \
  -selector k8s:ns:payments \
  -selector k8s:sa:checkout-service \
  -federatesWith spiffe://staging.example.com

# Refresh the federation bundle
spire-server bundle refresh \
  -id spiffe://staging.example.com
```

## Section 9: Monitoring and Operational Considerations

### Prometheus Metrics

SPIRE Server and Agent expose Prometheus metrics on port 9988 by default.

```yaml
# ServiceMonitor for SPIRE
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: spire-server
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: spire-server
  namespaceSelector:
    matchNames:
      - spire
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

Key metrics to monitor:

```promql
# SVID rotation rate
rate(spire_server_svid_issued_total[5m])

# Agent attestation failures
increase(spire_agent_attestation_failures_total[1h])

# JWT-SVID issue rate
rate(spire_server_jwt_svid_issued_total[5m])

# Number of registered entries
spire_server_registered_entries

# CA rotation events
increase(spire_server_ca_rotated_total[24h])
```

### Operational Runbook

```bash
# Check SPIRE Server health
kubectl -n spire exec -it spire-server-0 -- \
  /opt/spire/bin/spire-server healthcheck

# List all registration entries
kubectl -n spire exec -it spire-server-0 -- \
  /opt/spire/bin/spire-server entry show

# Show entries for a specific namespace
kubectl -n spire exec -it spire-server-0 -- \
  /opt/spire/bin/spire-server entry show \
  -selector k8s:ns:payments

# Show agents registered with the server
kubectl -n spire exec -it spire-server-0 -- \
  /opt/spire/bin/spire-server agent show

# Fetch the current trust bundle
kubectl -n spire exec -it spire-server-0 -- \
  /opt/spire/bin/spire-server bundle show \
  -format spiffe

# Force rotation of the CA
kubectl -n spire exec -it spire-server-0 -- \
  /opt/spire/bin/spire-server ca rotate

# Check agent SVIDs on a specific node
NODE="node1"
AGENT_POD=$(kubectl -n spire get pods -l app=spire-agent \
  --field-selector spec.nodeName=${NODE} -o jsonpath='{.items[0].metadata.name}')
kubectl -n spire exec -it ${AGENT_POD} -- \
  /opt/spire/bin/spire-agent api fetch x509 \
  -socketPath /run/spire/sockets/agent.sock
```

## Section 10: Security Hardening

### Node Attestation Security

The default Kubernetes Service Account Token (SAT) attestor relies on the Kubernetes API for validation. For higher security, configure attestation with additional selectors:

```hcl
NodeAttestor "k8s_psat" {
  plugin_data {
    clusters = {
      "prod-cluster" = {
        service_account_allow_list = ["spire:spire-agent"]
        audience                   = ["spire-server"]
        allowed_node_label_keys    = []
        allowed_pod_label_keys     = []
      }
    }
  }
}
```

### Admission Control for SPIRE Socket Access

```yaml
# OPA/Gatekeeper policy: only pods in allowed namespaces can mount the SPIRE socket
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredSpireMount
metadata:
  name: require-spire-socket-restriction
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
  parameters:
    allowedNamespaces:
      - "payments"
      - "auth"
      - "inventory"
    spireSocketPath: "/run/spire/sockets/agent.sock"
```

### Network Policy for SPIRE Components

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: spire-agent-to-server
  namespace: spire
spec:
  podSelector:
    matchLabels:
      app: spire-agent
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: spire-server
      ports:
        - protocol: TCP
          port: 8081
    - to: []
      ports:
        - protocol: TCP
          port: 443
        - protocol: UDP
          port: 53
```

## Summary

SPIFFE/SPIRE provides a production-grade workload identity system that integrates naturally with Kubernetes. Key takeaways:

- SPIFFE IDs provide a universal identity format that works across environments and cloud providers
- SPIRE's attestation model means workloads obtain identity automatically based on their runtime context — no secrets bootstrapping required
- X.509-SVIDs enable automatic mTLS between services without certificate management overhead
- JWT-SVIDs bridge the identity model to systems that use bearer token authentication
- Federation enables cross-cluster and cross-cloud identity without shared secrets
- AWS and GCP workload identity federation eliminates static cloud credentials entirely

The combination of SPIFFE/SPIRE with Kubernetes service mesh technologies like Istio (which can use SPIRE as its CA) creates a complete zero-trust security architecture where every service-to-service communication is mutually authenticated and encrypted.
