---
title: "Kubernetes Confidential Computing: TEEs, Kata Containers, and SGX Enclaves for Sensitive Workloads"
date: 2028-07-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Confidential Computing", "Kata Containers", "SGX", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to confidential computing on Kubernetes covering Intel SGX enclaves, AMD SEV-SNP, Kata Containers with hardware isolation, attestation workflows, and workload deployment patterns for regulated industries."
more_link: "yes"
url: "/kubernetes-confidential-computing-kata-sgx-guide/"
---

Confidential computing extends the security boundary to protect data in use — the last gap that traditional encryption left open. When a workload runs in a hardware-based Trusted Execution Environment, even the hypervisor, cloud provider, and cluster operator cannot read the workload's memory. This capability is transforming how financial services, healthcare, and government organizations run Kubernetes workloads on untrusted infrastructure.

<!--more-->

# Kubernetes Confidential Computing: TEEs, Kata Containers, and SGX Enclaves for Sensitive Workloads

## Section 1: Confidential Computing Fundamentals

### The Threat Model

Traditional encryption protects data at rest (disk encryption) and data in transit (TLS). Confidential computing protects data in use — the plaintext data being actively processed in CPU registers and RAM.

Without confidential computing, the following actors can potentially access workload memory:
- Cloud provider hypervisors and BIOS firmware
- Other tenants through speculative execution side channels
- Privileged cluster operators with physical host access
- Compromised container runtime or kernel

With confidential computing, hardware-enforced isolation in the CPU creates a protected region — a Trusted Execution Environment (TEE) — where even the host OS cannot read workload memory.

### TEE Technologies Comparison

| Technology | Vendor | Protection Scope | Kubernetes Integration |
|------------|--------|-----------------|----------------------|
| Intel SGX | Intel | Process-level enclave | Enclave-aware apps, EPC memory |
| Intel TDX | Intel | Full VM (TD) | Kata Containers, confidential VMs |
| AMD SEV-SNP | AMD | Full VM | Kata Containers, CVM |
| ARM CCA | ARM | Realm VMs | Emerging |
| IBM SE | IBM | Full LPAR | IBM Cloud specific |

### Architecture on Kubernetes

```
┌─────────────────────────────────────────────────────┐
│                  Kubernetes Control Plane            │
│                  (Untrusted infrastructure)          │
└──────────────────────┬──────────────────────────────┘
                       │ schedules
┌──────────────────────▼──────────────────────────────┐
│                Worker Node                           │
│  ┌─────────────────────────────────────────────────┐│
│  │         Kata Container Runtime (shim v2)         ││
│  │  ┌─────────────────────────────────────────────┐││
│  │  │     Micro-VM (QEMU/Cloud Hypervisor)         │││
│  │  │  ┌─────────────────────────────────────────┐│││
│  │  │  │     Guest Kernel (stripped)              ││││
│  │  │  │  ┌─────────────────────────────────────┐││││
│  │  │  │  │  Container Workload  ← TEE boundary ││││
│  │  │  │  └─────────────────────────────────────┘││││
│  │  │  └─────────────────────────────────────────┘│││
│  │  └─────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────┐│
│  │     Hardware TEE (Intel TDX / AMD SEV-SNP)        ││
│  │     - Memory encryption with hardware key         ││
│  │     - Measurement and attestation                 ││
│  └──────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

---

## Section 2: Kata Containers on Kubernetes

Kata Containers provides VM-level isolation for Kubernetes pods while maintaining the familiar pod API. Each pod runs in a lightweight virtual machine with a minimal guest kernel.

### Installing Kata Containers

```bash
# On Ubuntu 22.04+ with kata-deploy
kubectl apply -f https://raw.githubusercontent.com/kata-containers/kata-containers/main/tools/packaging/kata-deploy/kata-deploy.yaml

# Verify Kata DaemonSet is running
kubectl -n kube-system get pods -l name=kata-deploy

# Apply Kata RuntimeClasses
kubectl apply -f https://raw.githubusercontent.com/kata-containers/kata-containers/main/tools/packaging/kata-deploy/runtimeclasses/kata-runtimeClasses.yaml

# Verify available RuntimeClasses
kubectl get runtimeclass
# NAME              HANDLER             AGE
# kata              kata-qemu           5m
# kata-clh          kata-clh            5m
# kata-dragonball   kata-dragonball     5m
# kata-qemu-tdx     kata-qemu-tdx       5m    (Intel TDX)
# kata-qemu-snp     kata-qemu-snp       5m    (AMD SEV-SNP)
```

### Manual Kata Installation on Bare Metal

```bash
# Check hardware virtualization support
egrep -c '(vmx|svm)' /proc/cpuinfo

# Install Kata packages (Ubuntu)
sudo apt-get update
sudo apt-get install -y kata-runtime kata-proxy kata-shim

# Verify installation
kata-runtime kata-check

# Configure containerd to use Kata
sudo cat >> /etc/containerd/config.toml << 'EOF'
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
  runtime_type = "io.containerd.kata.v2"
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata.options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration.toml"
EOF

sudo systemctl restart containerd
```

### Running a Pod with Kata

```yaml
# kata-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: kata-test
  annotations:
    # Optional: pass kata-specific configuration
    io.katacontainers.config.agent.log_level: "debug"
spec:
  runtimeClassName: kata    # Use Kata runtime
  containers:
    - name: app
      image: nginx:1.25
      resources:
        requests:
          memory: "64Mi"
          cpu: "250m"
        limits:
          memory: "128Mi"
          cpu: "500m"
```

```bash
kubectl apply -f kata-pod.yaml
kubectl get pod kata-test

# Verify it's running in a VM
kubectl exec kata-test -- uname -r
# 6.1.0-kata  ← guest kernel, not host kernel
```

---

## Section 3: Intel TDX — Trust Domain Extensions

Intel TDX extends Kata Containers with hardware memory encryption for the entire VM, preventing the host from reading VM memory.

### Node Requirements

```bash
# Check TDX support
cpuid | grep -i tdx
# or
ls /dev/tdx*   # Should show /dev/tdx0 or /dev/tdx_guest

# Check TDX module status
dmesg | grep -i tdx

# Required kernel version
uname -r   # Must be 6.2+ with TDX support
```

### Kata TDX Configuration

```toml
# /opt/kata/share/defaults/kata-containers/configuration-qemu-tdx.toml
[hypervisor.qemu]
path = "/opt/kata/bin/qemu-system-x86_64"
kernel = "/opt/kata/share/kata-containers/vmlinuz-tdx.container"
image = "/opt/kata/share/kata-containers/kata-containers-tdx.img"
machine_type = "q35"

# TDX-specific options
tdx = true
firmware = "/opt/kata/share/ovmf/OVMF_CODE.fd"

[factory]
enable_template = false  # Templates don't work with TDX

[agent.kata]
debug = false
```

### TDX Pod Deployment

```yaml
# tdx-workload.yaml
apiVersion: v1
kind: Pod
metadata:
  name: confidential-processor
  labels:
    app: confidential-processor
    security.alpha.kubernetes.io/confidential: "true"
spec:
  runtimeClassName: kata-qemu-tdx
  nodeSelector:
    intel.feature.node.kubernetes.io/tdx: "true"   # Node Feature Discovery label
  containers:
    - name: processor
      image: your-registry/confidential-app:1.0.0
      env:
        - name: ATTESTATION_ENDPOINT
          value: "https://attestation.your-org.internal"
      resources:
        requests:
          memory: "512Mi"
          cpu: "1"
        limits:
          memory: "1Gi"
          cpu: "2"
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
        capabilities:
          drop:
            - ALL
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
```

---

## Section 4: AMD SEV-SNP Configuration

SEV-SNP (Secure Encrypted Virtualization - Secure Nested Paging) provides similar guarantees to TDX on AMD hardware with integrity protection against replay and memory remapping attacks.

### Checking SEV-SNP Support

```bash
# Check for SEV-SNP
sudo dmesg | grep -i sev
# [    0.000000] AMD Memory Encryption Features active: SEV SEV-ES SEV-SNP

# Verify firmware support
ls /dev/sev*
# /dev/sev   /dev/sev-guest

# Check kernel parameters
cat /proc/cpuinfo | grep sev
```

### Kata SEV-SNP Configuration

```toml
# /opt/kata/share/defaults/kata-containers/configuration-qemu-snp.toml
[hypervisor.qemu]
path = "/opt/kata/bin/qemu-system-x86_64"
kernel = "/opt/kata/share/kata-containers/vmlinuz-snp.container"
image = "/opt/kata/share/kata-containers/kata-containers-snp.img"
machine_type = "q35"

# SEV-SNP settings
sev_snp = true
firmware = "/opt/kata/share/ovmf/OVMF_CODE_SNP.fd"

# Memory encryption
default_memory = 2048
memory_slots = 10

[hypervisor.qemu.confidential_guest]
sev_snp = true
```

### Node Feature Discovery Labels

Use NFD to automatically detect and label TEE-capable nodes:

```yaml
# nfd-worker-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nfd-worker-conf
  namespace: node-feature-discovery
data:
  nfd-worker.conf: |
    core:
      labelWhiteList: ".*"
    sources:
      cpu:
        cpuid:
          attributeWhitelist:
            - "SGX"
            - "SGX_LC"
            - "GFNI_128"
      custom:
        - name: "intel-tdx"
          matchOn:
            - loadedKMod: ["kvm_intel"]
            - pciId:
                vendor: ["8086"]
        - name: "amd-sev-snp"
          matchOn:
            - loadedKMod: ["kvm_amd"]
            - cpuId:
                op: "AND"
                features: ["SEV_SNP"]
```

---

## Section 5: Intel SGX for Process-Level Enclaves

SGX (Software Guard Extensions) operates differently from TDX/SEV — it creates process-level enclaves rather than full VMs, protecting specific code regions with hardware-enforced isolation.

### SGX Use Cases on Kubernetes

SGX is ideal for:
- Key management services (seal keys to specific machine state)
- Confidential ML inference (protect model weights)
- Multi-party computation (process data from multiple parties without any party seeing the combined data)
- Database encryption key stores

### Intel SGX Device Plugin

```bash
# Install SGX device plugin via Helm
helm repo add intel https://intel.github.io/helm-charts/
helm repo update

helm install sgx-device-plugin intel/intel-device-plugins-sgx \
  --namespace sgx-system \
  --create-namespace \
  --set nodeSelector."intel\\.feature\\.node\\.kubernetes\\.io/sgx"="true"

# Verify plugin
kubectl get pods -n sgx-system
kubectl get nodes -o json | jq '.items[].status.allocatable | with_entries(select(.key | contains("sgx")))'
```

### SGX-Enabled Pod

```yaml
# sgx-workload.yaml
apiVersion: v1
kind: Pod
metadata:
  name: sgx-key-manager
spec:
  nodeSelector:
    intel.feature.node.kubernetes.io/sgx: "true"
  containers:
    - name: key-manager
      image: your-registry/sgx-key-manager:1.0.0
      resources:
        limits:
          sgx.intel.com/epc: "512Mi"    # EPC = Enclave Page Cache (protected RAM)
          sgx.intel.com/sgx: "1"
        requests:
          sgx.intel.com/epc: "256Mi"
          sgx.intel.com/sgx: "1"
      volumeMounts:
        - name: dev-sgx
          mountPath: /dev/sgx_enclave
        - name: dev-sgx-provision
          mountPath: /dev/sgx_provision
  volumes:
    - name: dev-sgx
      hostPath:
        path: /dev/sgx_enclave
        type: CharDevice
    - name: dev-sgx-provision
      hostPath:
        path: /dev/sgx_provision
        type: CharDevice
```

### Simple SGX Enclave with Gramine

Gramine (formerly Graphene) runs unmodified applications inside SGX enclaves:

```toml
# gramine-manifest.toml — Gramine configuration for existing app
libos.entrypoint = "/app/server"

loader.argv = ["/app/server", "--port", "8443"]
loader.env.LD_LIBRARY_PATH = "/lib:/lib/x86_64-linux-gnu"

# Allow specific SGX features
sgx.remote_attestation = "dcap"   # Use DCAP attestation (cloud-native)
sgx.enclave_size = "2G"
sgx.max_threads = 64
sgx.isvprodid = 1
sgx.isvsvn = 1

# Files that must be integrity-protected
sgx.trusted_files = [
  "file:/app/server",
  "file:/lib/x86_64-linux-gnu/",
]

# Files allowed in/out (encrypted volumes for sensitive data)
sgx.allowed_files = [
  "file:/tmp/",
]
```

```bash
# Build Gramine SGX manifest
gramine-sgx-sign --key signing_key.pem --manifest gramine-manifest.toml --output server.manifest.sgx

# Generate signing key
openssl genrsa -3 -out signing_key.pem 3072

# Package into container
docker build -t your-registry/sgx-gramine-app:1.0.0 .
docker push your-registry/sgx-gramine-app:1.0.0
```

---

## Section 6: Remote Attestation Workflow

Attestation proves to a relying party that code is running in a genuine TEE with specific measurements (hashes of the loaded code).

### DCAP Attestation Flow

```
1. TEE generates Quote (signed measurement of enclave state)
2. Quote contains: MRENCLAVE (code hash), MRSIGNER (key hash),
   security version, custom data (e.g., public key)
3. Relying party sends Quote to Intel/AMD PCCS for verification
4. PCCS returns signed attestation result
5. Relying party grants access based on verified measurements
```

### Quote Generation Service

```go
// attestation/quote_service.go
package attestation

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"

	"github.com/intel/go-tdx-guest/api"
	pb "github.com/intel/go-tdx-guest/proto/tdx"
)

type QuoteService struct {
	quoteProvider api.QuoteProvider
}

func NewQuoteService() (*QuoteService, error) {
	qp, err := api.NewQuoteProvider()
	if err != nil {
		return nil, fmt.Errorf("failed to initialize quote provider: %w", err)
	}
	return &QuoteService{quoteProvider: qp}, nil
}

// GenerateQuote creates a TDX quote with a nonce bound to the request
func (s *QuoteService) GenerateQuote(ctx context.Context, userData []byte) (*pb.QuoteV4, error) {
	// userData is typically a hash of the public key or session token
	// this binds the attestation to a specific key/session
	if len(userData) > 64 {
		h := sha256.Sum256(userData)
		userData = h[:]
	}

	// Pad to 64 bytes
	reportData := make([]byte, 64)
	copy(reportData, userData)

	quote, err := s.quoteProvider.IsSupported()
	if err != nil {
		return nil, fmt.Errorf("TDX not available: %w", err)
	}
	_ = quote

	rawQuote, err := s.quoteProvider.GetRawQuote(reportData)
	if err != nil {
		return nil, fmt.Errorf("failed to get quote: %w", err)
	}

	parsedQuote, err := api.QuoteToProto(rawQuote)
	if err != nil {
		return nil, fmt.Errorf("failed to parse quote: %w", err)
	}

	return parsedQuote.(*pb.QuoteV4), nil
}

// GetMeasurements returns the current TEE measurements
func (s *QuoteService) GetMeasurements() (map[string]string, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}

	quote, err := s.GenerateQuote(context.Background(), nonce)
	if err != nil {
		return nil, err
	}

	return map[string]string{
		"mrtd":  hex.EncodeToString(quote.TdQuoteBody.MrTd),
		"rtmr0": hex.EncodeToString(quote.TdQuoteBody.Rtmrs[0]),
		"rtmr1": hex.EncodeToString(quote.TdQuoteBody.Rtmrs[1]),
		"rtmr2": hex.EncodeToString(quote.TdQuoteBody.Rtmrs[2]),
		"rtmr3": hex.EncodeToString(quote.TdQuoteBody.Rtmrs[3]),
	}, nil
}

// ReadMRTD reads measurement register directly from sysfs (Linux)
func ReadMRTD() (string, error) {
	data, err := os.ReadFile("/sys/kernel/security/integrity/platform/attestation/mrtd")
	if err != nil {
		return "", fmt.Errorf("cannot read MRTD (are we in a TDX VM?): %w", err)
	}
	return hex.EncodeToString(data), nil
}
```

### Attestation Policy Enforcement (OPA)

```rego
# attestation_policy.rego
package attestation

import future.keywords.if
import future.keywords.in

# Known-good measurements (updated via CI/CD when code changes)
known_good_measurements := {
    "mrtd": "a1b2c3d4e5f6...",   # Hash of TD initial state
    "mrowner": "0000000000...",   # All-zero for unowned TDs
}

# Allow request if attestation is valid and measurements match
allow if {
    input.attestation.verified == true
    input.attestation.measurements.mrtd == known_good_measurements.mrtd
    input.attestation.svn >= data.policies.min_svn
    not input.attestation.debug_mode   # Reject debug enclaves in production
}

# Deny with reason
deny[reason] if {
    input.attestation.verified != true
    reason := "attestation verification failed"
}

deny[reason] if {
    input.attestation.measurements.mrtd != known_good_measurements.mrtd
    reason := sprintf("MRTD mismatch: got %v, expected %v",
        [input.attestation.measurements.mrtd, known_good_measurements.mrtd])
}

deny[reason] if {
    input.attestation.debug_mode == true
    reason := "debug mode enclaves not permitted in production"
}
```

---

## Section 7: Confidential Containers (CoCo)

The Confidential Containers project integrates multiple TEE backends into a unified Kubernetes workflow.

### Installing CoCo Operator

```bash
# Install CoCo operator
kubectl apply -k github.com/confidential-containers/operator/config/release?ref=v0.8.0

# Wait for operator to be ready
kubectl -n confidential-containers-system wait --for=condition=ready pod \
  -l control-plane=controller-manager --timeout=5m

# Create CoCo install configuration
kubectl apply -f - <<'EOF'
apiVersion: confidentialcontainers.org/v1beta1
kind: CcRuntime
metadata:
  name: ccruntime-sample
  namespace: confidential-containers-system
spec:
  runtimeName: kata
  ccNodeSelector:
    matchLabels:
      node.kubernetes.io/worker: ""
  config:
    installType: bundle
    payloadImage: quay.io/confidential-containers/runtime-payload:kata-containers-9c7099852b5b...
    installDoneLabel:
      confidential-containers.io/node: "true"
    uninstallDoneLabel:
      confidential-containers.io/node: ""
EOF

# Verify RuntimeClasses created
kubectl get runtimeclass | grep kata
```

### CoCo Encrypted Container Images

CoCo supports encrypted OCI images where the image layers are encrypted and only decryptable inside a genuine TEE:

```bash
# Encrypt container image for confidential use
# Install skopeo and ocicrypt tools
sudo apt-get install -y skopeo

# Generate encryption key pair
openssl genrsa -out image-key.pem 4096
openssl rsa -in image-key.pem -pubout -out image-key-pub.pem

# Encrypt the image
skopeo copy \
  --encryption-key jwe:image-key-pub.pem \
  docker://nginx:1.25 \
  docker://your-registry/nginx-encrypted:1.25

# Create Kubernetes secret with decryption key
kubectl create secret generic image-decryption-key \
  --from-file=key.pem=image-key.pem \
  -n confidential-workloads
```

---

## Section 8: Workload Identity and Secrets in TEEs

### SPIFFE/SPIRE Integration

SPIRE can attest workloads based on their TEE measurements, issuing SVIDs only to workloads running in verified TEEs.

```hcl
# spire-server-config.hcl (relevant attestation section)
plugins {
  NodeAttestor "k8s_sat" {
    plugin_data {
      clusters = {
        "production" = {
          service_account_allow_list = ["spire:spire-agent"]
        }
      }
    }
  }

  # TEE attestor plugin
  NodeAttestor "tpm" {
    plugin_data {
      # Combine with TDX measurement verification
    }
  }
}
```

### Vault Integration with TEE Attestation

```go
// secrets/vault_client.go
package secrets

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"

	"github.com/hashicorp/vault/api"
)

type TEEVaultClient struct {
	client    *vault.Client
	roleID    string
	quoteGen  QuoteGenerator
}

type QuoteGenerator interface {
	GenerateQuote(ctx context.Context, userData []byte) ([]byte, error)
}

func NewTEEVaultClient(vaultAddr, roleID string, qg QuoteGenerator) (*TEEVaultClient, error) {
	config := vault.DefaultConfig()
	config.Address = vaultAddr
	config.HttpClient = &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: mtlsConfig(), // mTLS to Vault
		},
	}

	client, err := vault.NewClient(config)
	if err != nil {
		return nil, fmt.Errorf("vault client init failed: %w", err)
	}

	return &TEEVaultClient{
		client:   client,
		roleID:   roleID,
		quoteGen: qg,
	}, nil
}

// Authenticate authenticates to Vault using TEE attestation as proof
func (c *TEEVaultClient) Authenticate(ctx context.Context) error {
	// Generate attestation quote with nonce from Vault
	// 1. Get nonce from Vault
	resp, err := c.client.Logical().Read("auth/tee/nonce")
	if err != nil {
		return fmt.Errorf("failed to get attestation nonce: %w", err)
	}
	nonce := []byte(resp.Data["nonce"].(string))

	// 2. Generate quote binding this nonce
	quote, err := c.quoteGen.GenerateQuote(ctx, nonce)
	if err != nil {
		return fmt.Errorf("failed to generate TEE quote: %w", err)
	}

	// 3. Submit quote to Vault TEE auth method
	authResp, err := c.client.Logical().Write("auth/tee/login", map[string]interface{}{
		"role":       c.roleID,
		"quote":      base64.StdEncoding.EncodeToString(quote),
		"nonce":      string(nonce),
	})
	if err != nil {
		return fmt.Errorf("TEE vault authentication failed: %w", err)
	}

	c.client.SetToken(authResp.Auth.ClientToken)
	return nil
}

// GetSecret retrieves a secret — only succeeds if TEE auth succeeded
func (c *TEEVaultClient) GetSecret(ctx context.Context, path string) (map[string]interface{}, error) {
	secret, err := c.client.KVv2("secret").Get(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("secret retrieval failed: %w", err)
	}
	return secret.Data, nil
}

func mtlsConfig() interface{} { return nil } // placeholder
```

---

## Section 9: Network Security for Confidential Workloads

### Mutual TLS with Attestation-Bound Certificates

```yaml
# cert-manager issuer that validates TEE attestation before issuing certs
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: tee-attestation-issuer
spec:
  # External issuer that validates TEE measurements
  external:
    name: tee-attestation
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: confidential-app-cert
  namespace: confidential-workloads
spec:
  secretName: confidential-app-tls
  duration: 1h           # Short-lived — reissue frequently
  renewBefore: 10m
  subject:
    organizations:
      - "your-org"
  dnsNames:
    - "confidential-app.confidential-workloads.svc.cluster.local"
  issuerRef:
    name: tee-attestation-issuer
    kind: ClusterIssuer
```

### NetworkPolicy for Confidential Namespace

```yaml
# Restrict all traffic — confidential workloads are isolated
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: confidential-isolation
  namespace: confidential-workloads
spec:
  podSelector: {}   # Applies to all pods in namespace
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Only allow traffic from approved namespaces
    - from:
        - namespaceSelector:
            matchLabels:
              confidential.access/allowed: "true"
      ports:
        - protocol: TCP
          port: 8443
  egress:
    # Allow DNS
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
    # Allow Vault
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: vault
      ports:
        - protocol: TCP
          port: 8200
    # Allow attestation service
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: attestation
      ports:
        - protocol: TCP
          port: 9443
```

---

## Section 10: Monitoring and Compliance

### Prometheus Metrics for TEE Workloads

```yaml
# Custom metrics to track TEE health
# Application exports these via /metrics endpoint

# Gauge: current attestation status (1=valid, 0=invalid)
tee_attestation_valid{workload="confidential-processor",tee_type="tdx"} 1

# Counter: attestation refresh count
tee_attestation_refreshes_total{workload="confidential-processor"} 42

# Gauge: TEE memory usage (EPC pages for SGX, guest memory for TDX)
tee_protected_memory_bytes{workload="confidential-processor"} 536870912

# Histogram: attestation latency
tee_attestation_duration_seconds_bucket{le="0.1"} 890
tee_attestation_duration_seconds_bucket{le="0.5"} 1050
```

### Alerting Rules

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: confidential-computing-alerts
  namespace: monitoring
spec:
  groups:
    - name: tee.rules
      interval: 30s
      rules:
        - alert: TEEAttestationFailed
          expr: tee_attestation_valid == 0
          for: 1m
          labels:
            severity: critical
            team: security
          annotations:
            summary: "TEE attestation failure detected"
            description: "Workload {{ $labels.workload }} failed TEE attestation. Pod may be running outside trusted hardware."

        - alert: TEEAttestationExpiring
          expr: tee_attestation_expires_at - time() < 300
          labels:
            severity: warning
          annotations:
            summary: "TEE attestation expiring soon"
            description: "Attestation for {{ $labels.workload }} expires in < 5 minutes."

        - alert: ConfidentialWorkloadOutsideTEE
          expr: |
            kube_pod_info{namespace="confidential-workloads"} unless
            on(pod, namespace) tee_attestation_valid == 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Confidential workload running without TEE protection"
```

### Audit Logging

```yaml
# Kubernetes audit policy for confidential workloads
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all access to confidential namespaces at RequestResponse level
  - level: RequestResponse
    namespaces: ["confidential-workloads"]
    resources:
      - group: ""
        resources: ["pods", "secrets", "configmaps"]
      - group: "apps"
        resources: ["deployments"]
  # Log exec/portforward to confidential pods — high risk
  - level: RequestResponse
    namespaces: ["confidential-workloads"]
    verbs: ["create"]
    resources:
      - group: ""
        resources: ["pods/exec", "pods/portforward"]
```

---

## Section 11: Production Deployment Checklist

```bash
#!/bin/bash
# verify-confidential-node.sh — pre-flight checks before scheduling confidential workloads

set -euo pipefail
NODE=${1:-}
if [[ -z "$NODE" ]]; then
  echo "Usage: $0 <node-name>"
  exit 1
fi

echo "=== Confidential Computing Pre-flight Check for $NODE ==="

# Check 1: TEE capability labels
echo -n "TEE capability labels: "
kubectl get node "$NODE" -o json | jq -r '.metadata.labels | to_entries[] | select(.key | startswith("intel.feature") or startswith("amd.feature")) | "\(.key)=\(.value)"'

# Check 2: Kata RuntimeClass exists
echo -n "Kata RuntimeClass: "
kubectl get runtimeclass kata-qemu-tdx 2>/dev/null && echo "OK" || echo "MISSING"

# Check 3: SGX device plugin (if SGX)
echo -n "SGX device allocation: "
kubectl get node "$NODE" -o json | jq '.status.allocatable["sgx.intel.com/epc"] // "not present"'

# Check 4: Node attestation status
echo -n "Node attestation label: "
kubectl get node "$NODE" -o json | jq -r '.metadata.labels["confidential-containers.io/node"] // "not set"'

# Check 5: Container runtime
echo -n "Container runtime: "
kubectl get node "$NODE" -o json | jq -r '.status.nodeInfo.containerRuntimeVersion'

echo "=== Pre-flight check complete ==="
```

Confidential computing on Kubernetes represents a significant capability for organizations processing regulated data in cloud environments. The combination of Kata Containers for VM isolation, TDX/SEV-SNP for hardware memory encryption, and attestation-based identity creates a trust model where workloads can remain isolated even from the infrastructure operators who run the underlying platform.
