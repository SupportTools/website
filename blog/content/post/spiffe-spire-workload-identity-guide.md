---
title: "SPIFFE/SPIRE: Workload Identity for Zero-Trust Infrastructure"
date: 2027-11-02T00:00:00-05:00
draft: false
tags: ["SPIFFE", "SPIRE", "Zero Trust", "mTLS", "Workload Identity"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "SPIFFE ID structure, SPIRE server and agent deployment, attestation plugins, SVID rotation, integration with Envoy and Istio, and building zero-trust service-to-service authentication."
more_link: "yes"
url: "/spiffe-spire-workload-identity-guide/"
---

In a zero-trust network model, every service must prove its identity before being trusted, regardless of network location. Traditional approaches rely on network-level trust (firewall rules, VPCs) or long-lived credentials (API keys, certificates stored in Secrets). SPIFFE and SPIRE provide a better model: short-lived, automatically rotated cryptographic identities that are issued based on workload attestation rather than network location or static credentials.

<!--more-->

# SPIFFE/SPIRE: Workload Identity for Zero-Trust Infrastructure

## SPIFFE Identity Model

SPIFFE (Secure Production Identity Framework for Everyone) defines a standard for workload identity. The core concept is the **SPIFFE ID**, which is a URI with the format:

```
spiffe://<trust-domain>/<path>
```

Examples of SPIFFE IDs:
```
spiffe://company.com/ns/production/sa/payment-service
spiffe://company.com/ns/production/sa/order-service
spiffe://company.com/region/us-east-1/service/database-proxy
```

A **SVID (SPIFFE Verifiable Identity Document)** is the cryptographic representation of a SPIFFE ID. SVIDs come in two forms:
- **X.509-SVID**: An X.509 certificate where the SPIFFE ID appears in the SAN (Subject Alternative Name) extension
- **JWT-SVID**: A JWT containing the SPIFFE ID as the subject claim

SVIDs are short-lived (typically 1-24 hours) and automatically rotated by the SPIRE agent. This means compromised credentials have a short TTL, drastically reducing the blast radius of any breach.

## SPIRE Architecture

SPIRE (SPIFFE Runtime Environment) is the reference implementation of the SPIFFE specification. It consists of:

**SPIRE Server**: The certificate authority for your trust domain. It maintains the registration entry database, signs SVIDs, and bundles trust information. The server itself does not issue SVIDs directly to workloads -- it authenticates agents and provides them with signing authority.

**SPIRE Agent**: Runs on each node (as a DaemonSet in Kubernetes). The agent attests the node to the server, then attests individual workloads based on Kubernetes service account tokens, pod UID, namespace, and other attributes. The agent exposes a Unix domain socket that workloads use to request SVIDs.

**Workload API**: The gRPC API exposed by the SPIRE agent that workloads use to fetch their SVIDs and trust bundles.

## Deploying SPIRE on Kubernetes

### SPIRE Server

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: spire
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spire-server
  namespace: spire
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: spire-server
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
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: spire-server
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: spire-server
subjects:
- kind: ServiceAccount
  name: spire-server
  namespace: spire
---
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
      trust_domain = "company.com"
      data_dir = "/run/spire/data"
      log_level = "INFO"
      log_format = "json"

      # SVID TTL - how long each certificate is valid
      default_svid_ttl = "1h"

      # CA TTL - how long the intermediate CA certificate is valid
      ca_ttl = "24h"

      # CA key type
      ca_key_type = "rsa-2048"

      # CA subject
      ca_subject {
        country = ["US"]
        organization = ["Company Inc"]
        common_name = ""
      }

      # Federation (for multi-trust-domain environments)
      # federation {
      #   bundle_endpoint_url = "https://spire.other-company.com/spiffe/federation/api/v1/bundle"
      # }
    }

    plugins {
      DataStore "sql" {
        plugin_data {
          database_type = "postgres"
          connection_string = "dbname=spire user=spire password=spire-db-password host=postgresql-spire.spire.svc.cluster.local sslmode=require"
        }
      }

      NodeAttestor "k8s_psat" {
        plugin_data {
          clusters = {
            "production-cluster" = {
              service_account_allow_list = ["spire:spire-agent"]
              kube_config_file = ""
              # Use Kubernetes projected service account tokens
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
          config_map = "spire-bundle"
          config_map_key = "bundle.crt"
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
---
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
        image: ghcr.io/spiffe/spire-server:1.9.6
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
        - name: spire-server-socket
          mountPath: /tmp/spire-server/private
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        livenessProbe:
          httpGet:
            path: /live
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
          failureThreshold: 3
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
      accessModes: ["ReadWriteOnce"]
      storageClassName: standard
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
  type: ClusterIP
  ports:
  - name: grpc
    port: 8081
    targetPort: 8081
  selector:
    app: spire-server
```

### SPIRE Agent DaemonSet

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
  name: spire-agent
rules:
- apiGroups: [""]
  resources: ["pods", "nodes", "nodes/proxy"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: spire-agent
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: spire-agent
subjects:
- kind: ServiceAccount
  name: spire-agent
  namespace: spire
---
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
      log_format = "json"
      server_address = "spire-server.spire.svc.cluster.local"
      server_port = "8081"
      socket_path = "/run/spire/sockets/agent.sock"
      trust_bundle_path = "/run/spire/bundle/bundle.crt"
      trust_domain = "company.com"

      # Admin API socket for spire-agent commands
      admin_socket_path = "/tmp/spire-agent/private/api.sock"
    }

    plugins {
      NodeAttestor "k8s_psat" {
        plugin_data {
          cluster = "production-cluster"
          token_path = "/var/run/secrets/tokens/spire-agent"
        }
      }

      KeyManager "memory" {
        plugin_data {}
      }

      WorkloadAttestor "k8s" {
        plugin_data {
          # Skip node attestation for workloads (use pod attributes instead)
          skip_kubelet_verification = true
        }
      }

      WorkloadAttestor "unix" {
        plugin_data {}
      }

      BundleManager "k8sbundle" {
        plugin_data {
          namespace = "spire"
          config_map = "spire-bundle"
          config_map_key = "bundle.crt"
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
---
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
  updateStrategy:
    type: RollingUpdate
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
        image: ghcr.io/spiffe/spire-server:1.9.6
        args:
        - -config
        - /run/spire/config/server.conf
        command:
        - /opt/spire/bin/spire-server
        - healthcheck
        - --socketPath=/run/spire/sockets/server.sock
      containers:
      - name: spire-agent
        image: ghcr.io/spiffe/spire-agent:1.9.6
        args:
        - -config
        - /run/spire/config/agent.conf
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
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 500m
            memory: 256Mi
        livenessProbe:
          httpGet:
            path: /live
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        securityContext:
          runAsNonRoot: false
          runAsUser: 0
          allowPrivilegeEscalation: false
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

## Registration Entries

Registration entries map Kubernetes workload attributes (namespace, service account, pod labels) to SPIFFE IDs:

```bash
# Register all pods in the production namespace under the payment-service service account
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://company.com/ns/production/sa/payment-service \
  -parentID spiffe://company.com/spire/agent/k8s_psat/production-cluster/node-id \
  -selector k8s:ns:production \
  -selector k8s:sa:payment-service \
  -ttl 3600

# Register with additional selectors for stricter matching
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://company.com/ns/production/sa/order-service \
  -parentID spiffe://company.com/spire/agent/k8s_psat/production-cluster/node-id \
  -selector k8s:ns:production \
  -selector k8s:sa:order-service \
  -selector k8s:pod-label:app:order-service \
  -ttl 3600

# List all registration entries
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry show

# Validate that a workload can fetch its SVID
kubectl exec -n production payment-service-pod -- \
  /opt/spire/bin/spire-agent api fetch x509 \
  -socketPath /run/spire/sockets/agent.sock
```

## SPIRE Controller Manager for Automatic Registration

Rather than manually registering each workload, the SPIRE Controller Manager automatically creates registration entries based on Kubernetes resources:

```yaml
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: production-workloads
spec:
  # Auto-generate SPIFFE IDs for all pods in production namespace
  spiffeIDTemplate: "spiffe://company.com/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    namespaceSelector:
      matchLabels:
        spire-workload: "true"
  workloadSelectorTemplates:
  - "k8s:ns:{{ .PodMeta.Namespace }}"
  - "k8s:sa:{{ .PodSpec.ServiceAccountName }}"
  ttl: 1h
  dnsNameTemplates:
  - "{{ .PodSpec.ServiceAccountName }}.{{ .PodMeta.Namespace }}.svc.cluster.local"
```

## Integration with Envoy for mTLS

SPIRE integrates with Envoy through the SDS (Secret Discovery Service) API, providing automatic certificate rotation for Envoy sidecars:

```yaml
# Envoy config using SPIRE for mTLS
static_resources:
  listeners:
  - name: listener_0
    address:
      socket_address:
        address: 0.0.0.0
        port_value: 10000
    filter_chains:
    - transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          require_client_certificate: true
          common_tls_context:
            # Fetch certificates from SPIRE via SDS
            tls_certificate_sds_secret_configs:
            - name: "spiffe://company.com/ns/production/sa/payment-service"
              sds_config:
                api_config_source:
                  api_type: GRPC
                  grpc_services:
                  - envoy_grpc:
                      cluster_name: spire_agent
            # Fetch trust bundle from SPIRE via SDS
            validation_context_sds_secret_config:
              name: "spiffe://company.com"
              sds_config:
                api_config_source:
                  api_type: GRPC
                  grpc_services:
                  - envoy_grpc:
                      cluster_name: spire_agent
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
```

## Integration with Istio

For Istio service mesh deployments, SPIRE can act as the certificate authority, replacing Istio's built-in Citadel CA:

```yaml
# IstioOperator configuration to use SPIRE as CA
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio-control-plane
  namespace: istio-system
spec:
  profile: default
  meshConfig:
    trustDomain: company.com
  values:
    pilot:
      env:
        EXTERNAL_CA: "true"
        USE_TOKEN_FOR_CSR: "true"
    global:
      # Tell Istio to use an external CA
      caAddress: "spire-server.spire.svc.cluster.local:8081"
  components:
    pilot:
      k8s:
        volumes:
        - name: spire-bundle
          configMap:
            name: spire-bundle
        volumeMounts:
        - name: spire-bundle
          mountPath: /etc/spire/bundle
          readOnly: true
```

## JWT SVID for Service-to-Service API Authentication

In addition to X.509 certificates for mTLS, SPIRE issues JWT SVIDs for service-to-service API authentication:

```go
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/svid/jwtsvid"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

func main() {
    ctx := context.Background()

    // Connect to SPIRE agent via Unix socket
    source, err := workloadapi.NewJWTSource(
        ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
        ),
    )
    if err != nil {
        log.Fatalf("Unable to create JWT source: %v", err)
    }
    defer source.Close()

    // Fetch a JWT SVID for authentication to the payments API
    audience := spiffeid.RequireIDFromString("spiffe://company.com/ns/production/sa/payments-api")
    svid, err := source.FetchJWTSVID(ctx, jwtsvid.Params{
        Audience: audience.String(),
    })
    if err != nil {
        log.Fatalf("Unable to fetch JWT SVID: %v", err)
    }

    // Use the JWT token in HTTP requests
    token := svid.Marshal()
    fmt.Printf("Bearer token for payments API: %s\n", token[:20]+"...")

    // The token can now be sent in the Authorization header
    // Authorization: Bearer <token>
}
```

## Production Considerations

### High Availability

For production SPIRE deployments, run multiple SPIRE Server replicas:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: spire-server
  namespace: spire
spec:
  replicas: 3
  # For HA, all servers share the same PostgreSQL database
  # The first server to start will bootstrap the CA
  # Additional servers join as replicas
```

All SPIRE servers share the same PostgreSQL database for state. The CA keys are stored in the database and protected by encryption.

### Nested SPIRE for Multi-Cluster

For organizations with multiple Kubernetes clusters, use nested SPIRE to federate identities:

```
Root SPIRE Server (corporate CA)
  |
  +-- Production Cluster SPIRE Server
  |     |-- Production Workloads
  |
  +-- Staging Cluster SPIRE Server
        |-- Staging Workloads
```

Each downstream SPIRE server is registered as a special entry in the root server. Downstream servers receive their own SVID from the root, which they use to sign SVIDs for their workloads.

### Monitoring

```bash
# Check SPIRE agent health
kubectl exec -n production payment-service-pod -- \
  /opt/spire/bin/spire-agent healthcheck \
  -socketPath /run/spire/sockets/agent.sock

# Count active SVIDs
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry show | grep "SPIFFE ID" | wc -l

# Check SVID expiry for a workload
kubectl exec -n production payment-service-pod -- \
  /opt/spire/bin/spire-agent api fetch x509 \
  -socketPath /run/spire/sockets/agent.sock \
  -write /tmp/svid
openssl x509 -in /tmp/svid/svid.0.pem -noout -dates
```

## Conclusion

SPIFFE/SPIRE provides the cryptographic workload identity foundation that zero-trust architectures require. By replacing long-lived static credentials with short-lived, automatically rotated SVIDs that are issued based on workload attestation, SPIRE eliminates the credential management overhead and blast radius concerns that plague traditional secret-based authentication.

The integration with Envoy and Istio makes SPIRE a natural fit for service mesh deployments, providing a unified identity plane that works across multiple clusters and cloud providers. For organizations moving toward a zero-trust security model, SPIRE is often the right starting point, as establishing a strong workload identity system is prerequisite to implementing meaningful authorization policies.

## X.509 mTLS with Go Applications

The `go-spiffe` library provides a high-level API for Go applications to use SPIFFE identities for mutual TLS:

```go
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "io"
    "log"
    "net/http"
    "time"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

const socketPath = "unix:///run/spire/sockets/agent.sock"

// Server: listen for mTLS connections, only accept requests from order-service
func runServer(ctx context.Context) error {
    // Create an X.509 source from the SPIRE agent
    x509Source, err := workloadapi.NewX509Source(
        ctx,
        workloadapi.WithClientOptions(workloadapi.WithAddr(socketPath)),
    )
    if err != nil {
        return fmt.Errorf("creating x509 source: %w", err)
    }
    defer x509Source.Close()

    // Build TLS config that requires client to present a certificate
    // Only accept connections from order-service in production namespace
    allowedID := spiffeid.RequireIDFromString(
        "spiffe://company.com/ns/production/sa/order-service",
    )

    tlsConfig := tlsconfig.MTLSServerConfig(
        x509Source,
        x509Source,
        tlsconfig.AuthorizeID(allowedID),
    )

    server := &http.Server{
        Addr:      ":8443",
        TLSConfig: tlsConfig,
        Handler:   http.HandlerFunc(handlePayment),
    }

    log.Printf("Payment service listening on :8443")
    return server.ListenAndServeTLS("", "")
}

func handlePayment(w http.ResponseWriter, r *http.Request) {
    // Extract the caller's SPIFFE ID from the TLS connection
    if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
        cert := r.TLS.PeerCertificates[0]
        for _, uri := range cert.URIs {
            log.Printf("Request from: %s", uri.String())
        }
    }
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ok"}`))
}

// Client: make mTLS request to payment-service, only trust payment-service identity
func runClient(ctx context.Context) error {
    x509Source, err := workloadapi.NewX509Source(
        ctx,
        workloadapi.WithClientOptions(workloadapi.WithAddr(socketPath)),
    )
    if err != nil {
        return fmt.Errorf("creating x509 source: %w", err)
    }
    defer x509Source.Close()

    // Build TLS config that presents our certificate and validates server identity
    serverID := spiffeid.RequireIDFromString(
        "spiffe://company.com/ns/production/sa/payment-service",
    )

    tlsConfig := tlsconfig.MTLSClientConfig(
        x509Source,
        x509Source,
        tlsconfig.AuthorizeID(serverID),
    )

    client := &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: tlsConfig,
        },
        Timeout: 10 * time.Second,
    }

    resp, err := client.Get("https://payment-service.production.svc.cluster.local:8443/pay")
    if err != nil {
        return fmt.Errorf("request failed: %w", err)
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return fmt.Errorf("reading body: %w", err)
    }

    log.Printf("Response from payment service: %s", body)
    return nil
}
```

## Troubleshooting SPIRE

### Agent Cannot Attest to Server

```bash
# Check the agent logs
kubectl logs -n spire daemonset/spire-agent --tail=50

# Verify the bundle is populated
kubectl get configmap spire-bundle -n spire -o yaml

# Test agent health
kubectl exec -n spire -it $(kubectl get pods -n spire -l app=spire-agent -o jsonpath='{.items[0].metadata.name}') -- \
  /opt/spire/bin/spire-agent healthcheck -socketPath /run/spire/sockets/agent.sock
```

### Workload Cannot Fetch SVID

```bash
# Verify registration entry exists
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry show \
  -selector k8s:ns:production \
  -selector k8s:sa:payment-service

# Check if workload attestation is working
# Connect to the pod and fetch the SVID
kubectl exec -n production payment-service-78b4c9 -- \
  ls -la /run/spire/sockets/
# Should show agent.sock

# Attempt to fetch SVID
kubectl exec -n production payment-service-78b4c9 -- \
  /tmp/spire-agent api fetch x509 \
  -socketPath /run/spire/sockets/agent.sock
```

### Certificate Expiry Issues

```bash
# Check SVID expiry time for all entries
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry show | grep -E "SPIFFE ID|TTL"

# Verify CA certificate expiry
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle show | openssl x509 -noout -dates

# Check if rotation is working by monitoring SVID serial numbers over time
# A changing serial number indicates successful rotation
kubectl exec -n production payment-service-78b4c9 -- \
  /tmp/spire-agent api fetch x509 \
  -socketPath /run/spire/sockets/agent.sock \
  -write /tmp/ && openssl x509 -in /tmp/svid.0.pem -noout -serial -dates
```

## SPIRE with Federated Trust Domains

For organizations with microservices spanning multiple trust domains (cloud providers, on-premises, partner organizations), SPIRE supports trust bundle federation:

```yaml
# Configure federation in server.conf
server {
  trust_domain = "company.com"

  federation {
    bundle_endpoint {
      address = "0.0.0.0"
      port = 8443
      acme {
        domain_name = "spire.company.com"
        email = "spire-admin@company.com"
        tos_accepted = true
      }
    }
  }
}
```

Register the trust relationship:

```bash
# Add partner trust bundle
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle set \
  -id spiffe://partner.com \
  -path /tmp/partner-bundle.pem

# Verify federation
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server bundle list
```

With federation in place, workloads in `company.com` can validate SVIDs issued by `partner.com`'s SPIRE server without any shared secrets or manual certificate distribution.

## Integration with OPA for Authorization

SPIFFE provides authentication (who is the caller), but authorization (what can the caller do) is a separate concern. Combine SPIRE with Open Policy Agent (OPA) for fine-grained authorization:

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"

    "github.com/open-policy-agent/opa/rego"
    "github.com/spiffe/go-spiffe/v2/spiffeid"
)

type AuthzRequest struct {
    CallerID string `json:"caller_id"`
    Resource string `json:"resource"`
    Action   string `json:"action"`
}

// OPA policy for authorization based on SPIFFE ID
const authzPolicy = `
package payment.authz

default allow = false

allow {
    # Only order-service can call create-payment
    input.caller_id == "spiffe://company.com/ns/production/sa/order-service"
    input.action == "create-payment"
}

allow {
    # Finance service can call all payment APIs
    input.caller_id == "spiffe://company.com/ns/production/sa/finance-service"
}
`

func isAuthorized(callerID spiffeid.ID, resource, action string) (bool, error) {
    ctx := context.Background()

    query, err := rego.New(
        rego.Query("data.payment.authz.allow"),
        rego.Module("authz.rego", authzPolicy),
    ).PrepareForEval(ctx)
    if err != nil {
        return false, fmt.Errorf("preparing OPA query: %w", err)
    }

    input := AuthzRequest{
        CallerID: callerID.String(),
        Resource: resource,
        Action:   action,
    }

    results, err := query.Eval(ctx, rego.EvalInput(input))
    if err != nil {
        return false, fmt.Errorf("evaluating OPA query: %w", err)
    }

    if len(results) == 0 {
        return false, nil
    }

    allowed, ok := results[0].Expressions[0].Value.(bool)
    if !ok {
        return false, fmt.Errorf("unexpected OPA result type")
    }

    return allowed, nil
}

func authzMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract caller SPIFFE ID from TLS peer certificate
        if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
            http.Error(w, "client certificate required", http.StatusUnauthorized)
            return
        }

        cert := r.TLS.PeerCertificates[0]
        if len(cert.URIs) == 0 {
            http.Error(w, "no SPIFFE ID in client certificate", http.StatusUnauthorized)
            return
        }

        callerID, err := spiffeid.IDFromURI(cert.URIs[0])
        if err != nil {
            http.Error(w, "invalid SPIFFE ID", http.StatusUnauthorized)
            return
        }

        // Check authorization
        allowed, err := isAuthorized(callerID, r.URL.Path, r.Method)
        if err != nil || !allowed {
            http.Error(w, "access denied", http.StatusForbidden)
            return
        }

        next.ServeHTTP(w, r)
    })
}

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/pay", func(w http.ResponseWriter, r *http.Request) {
        json.NewEncoder(w).Encode(map[string]string{"status": "payment processed"})
    })

    handler := authzMiddleware(mux)
    http.ListenAndServe(":8080", handler)
}
```

## Conclusion (Extended)

The combination of SPIFFE IDs for identity, X.509 SVIDs for mTLS, JWT SVIDs for API authentication, and OPA for authorization creates a comprehensive zero-trust security model that is independent of network topology. Services can communicate securely whether they are on the same node, in different namespaces, in different clusters, or in different cloud providers.

Adopting SPIRE requires a shift in how teams think about service security. Rather than "which services are on the same VPC and therefore trusted," the question becomes "which SPIFFE ID is this caller presenting, and does it have authorization to perform this action?" This mental model scales to multi-cloud, multi-cluster, and hybrid environments in ways that network-based trust simply cannot.
