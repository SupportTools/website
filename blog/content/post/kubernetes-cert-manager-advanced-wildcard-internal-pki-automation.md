---
title: "Kubernetes Certificate Manager Advanced Patterns: Wildcard Certs, Internal PKI, and Automation"
date: 2030-08-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cert-manager", "PKI", "TLS", "HashiCorp Vault", "Certificates", "Security"]
categories:
- Kubernetes
- Security
- PKI
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise cert-manager guide covering wildcard certificate management, ACME DNS-01 challenges, internal CA chains with cert-manager CA issuer, certificate rotation automation, monitoring certificate expiry, and integrating with HashiCorp Vault PKI."
more_link: "yes"
url: "/kubernetes-cert-manager-advanced-wildcard-internal-pki-automation/"
---

Certificate management at scale — hundreds of services, multiple ingress controllers, internal mTLS, and external-facing HTTPS — demands automation that goes beyond issuing a TLS certificate on first deploy. Enterprise cert-manager deployments manage wildcard certificates shared across a team's namespace, internal CA chains that issue certificates to both Kubernetes services and non-Kubernetes workloads, certificate rotation with zero downtime, and integration with enterprise PKI systems like HashiCorp Vault.

<!--more-->

## cert-manager Installation

### Helm Installation with CRD Management

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
    --namespace cert-manager \
    --create-namespace \
    --version v1.15.0 \
    --set installCRDs=true \
    --set prometheus.enabled=true \
    --set prometheus.servicemonitor.enabled=true \
    --set webhook.replicaCount=3 \
    --set cainjector.replicaCount=2 \
    --set controller.replicaCount=2 \
    --set global.leaderElection.namespace=cert-manager

# Verify installation
kubectl rollout status deployment/cert-manager -n cert-manager
kubectl rollout status deployment/cert-manager-webhook -n cert-manager
```

---

## ACME Certificates with DNS-01 Challenge

### Why DNS-01 for Wildcard Certificates

HTTP-01 challenges require the ACME server to reach a specific HTTP endpoint, which is not possible for wildcard certificates (`*.example.com`) because wildcard certs cover all subdomains but the challenge URL is subdomain-specific. DNS-01 challenges work by creating a TXT record in the domain's DNS zone — the ACME server queries DNS, not HTTP — and support wildcard issuance.

### Route53 DNS-01 Issuer

```yaml
# cert-manager-route53-issuer.yaml
apiVersion: v1
kind: Secret
metadata:
  name: route53-credentials
  namespace: cert-manager
type: Opaque
data:
  secret-access-key: <base64-encoded-aws-secret-access-key>
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-route53
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890ABCDEF
            accessKeyID: <aws-access-key-id>
            secretAccessKeySecretRef:
              name: route53-credentials
              key: secret-access-key
        selector:
          dnsZones:
            - example.com
```

### IRSA (IAM Roles for Service Accounts) for Route53

On EKS, prefer IAM Roles for Service Accounts over long-lived credentials:

```yaml
# cert-manager-irsa-service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cert-manager
  namespace: cert-manager
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/cert-manager-route53
---
# ClusterIssuer using IRSA (no secretAccessKeySecretRef needed)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-route53-irsa
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890ABCDEF
            # No accessKeyID or secretAccessKeySecretRef — IRSA handles auth
```

### Wildcard Certificate

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: production
spec:
  secretName: wildcard-example-com-tls
  issuerRef:
    name: letsencrypt-prod-route53
    kind: ClusterIssuer
  dnsNames:
    - "*.example.com"
    - "example.com"    # Include apex domain if needed
  duration: 2160h      # 90 days (Let's Encrypt maximum)
  renewBefore: 720h    # Renew 30 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always
```

### Sharing Wildcard Certificate Across Namespaces

cert-manager issues Secrets into the same namespace as the Certificate resource. To share across namespaces, use Reflector or External Secrets Operator to sync the Secret:

```yaml
# Using reflector annotations on the Certificate Secret
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: cert-manager
spec:
  secretName: wildcard-example-com-tls
  secretTemplate:
    annotations:
      reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
      reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "production,staging,testing"
      reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
  issuerRef:
    name: letsencrypt-prod-route53
    kind: ClusterIssuer
  dnsNames:
    - "*.example.com"
    - "example.com"
```

---

## Internal PKI with cert-manager CA Issuer

### Self-Signed Root CA

For internal services that do not require public trust, a self-signed root CA managed by cert-manager provides the foundation for an internal PKI:

```yaml
# Step 1: Create a self-signed issuer to bootstrap the root CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
# Step 2: Issue the root CA certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-root-ca
  namespace: cert-manager
spec:
  secretName: internal-root-ca-secret
  isCA: true
  commonName: "Example Internal Root CA"
  subject:
    organizations:
      - Example Corp
    countries:
      - US
    organizationalUnits:
      - Platform Engineering
  duration: 87600h    # 10 years for root CA
  renewBefore: 8760h  # Renew 1 year before expiry
  privateKey:
    algorithm: ECDSA
    size: 384          # P-384 for root CA
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
---
# Step 3: Create a CA issuer backed by the root CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: internal-root-ca-secret
```

### Intermediate CA

For production PKI, never issue end-entity certificates directly from the root. Use an intermediate CA:

```yaml
# Step 4: Issue intermediate CA signed by root
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-intermediate-ca
  namespace: cert-manager
spec:
  secretName: internal-intermediate-ca-secret
  isCA: true
  commonName: "Example Internal Intermediate CA"
  subject:
    organizations:
      - Example Corp
    organizationalUnits:
      - Kubernetes Services
  duration: 43800h     # 5 years for intermediate CA
  renewBefore: 8760h
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
---
# Step 5: Create issuer backed by intermediate CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-intermediate-issuer
spec:
  ca:
    secretName: internal-intermediate-ca-secret
```

### Issuing Service Certificates

```yaml
# Service certificate for internal mTLS
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: order-service-tls
  namespace: production
spec:
  secretName: order-service-tls
  issuerRef:
    name: internal-intermediate-issuer
    kind: ClusterIssuer
  commonName: order-service.production.svc.cluster.local
  dnsNames:
    - order-service
    - order-service.production
    - order-service.production.svc
    - order-service.production.svc.cluster.local
  usages:
    - digital signature
    - key encipherment
    - server auth
    - client auth    # Enable if client authentication is required
  duration: 2160h    # 90 days
  renewBefore: 360h  # Renew 15 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always
```

---

## HashiCorp Vault PKI Integration

### Vault PKI Secrets Engine Setup

```bash
# Enable the PKI secrets engine
vault secrets enable pki

# Configure max lease TTL
vault secrets tune -max-lease-ttl=87600h pki

# Generate internal root CA
vault write pki/root/generate/internal \
    common_name="Example Vault Root CA" \
    ttl=87600h \
    key_type=ec \
    key_bits=384

# Enable intermediate PKI
vault secrets enable -path=pki_int pki
vault secrets tune -max-lease-ttl=43800h pki_int

# Generate intermediate CA CSR
vault write -format=json pki_int/intermediate/generate/internal \
    common_name="Example Vault Intermediate CA" \
    key_type=ec \
    key_bits=256 | jq -r '.data.csr' > intermediate.csr

# Sign the intermediate CSR with root
vault write -format=json pki/root/sign-intermediate \
    csr=@intermediate.csr \
    format=pem_bundle \
    ttl=43800h | jq -r '.data.certificate' > intermediate.pem

# Set the signed intermediate certificate
vault write pki_int/intermediate/set-signed certificate=@intermediate.pem

# Create a role for Kubernetes service certificates
vault write pki_int/roles/kubernetes-services \
    allowed_domains="svc.cluster.local,example.com" \
    allow_subdomains=true \
    allow_glob_domains=false \
    max_ttl=2160h \
    ttl=720h \
    key_type=ec \
    key_bits=256 \
    require_cn=true
```

### Vault Authentication for cert-manager

```bash
# Enable Kubernetes authentication in Vault
vault auth enable kubernetes

# Configure Kubernetes auth
vault write auth/kubernetes/config \
    token_reviewer_jwt="$(kubectl get secret vault-auth -n cert-manager -o jsonpath='{.data.token}' | base64 -d)" \
    kubernetes_host="https://$(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}'):443" \
    kubernetes_ca_cert="$(kubectl get configmap kube-root-ca.crt -o jsonpath='{.data.ca\.crt}')"

# Create a policy for cert-manager
vault policy write cert-manager-pki - <<EOF
path "pki_int/sign/kubernetes-services" {
  capabilities = ["create", "update"]
}
path "pki_int/issue/kubernetes-services" {
  capabilities = ["create", "update"]
}
EOF

# Create a role binding cert-manager service account to the policy
vault write auth/kubernetes/role/cert-manager-pki \
    bound_service_account_names=cert-manager \
    bound_service_account_namespaces=cert-manager \
    policies=cert-manager-pki \
    ttl=1h
```

### Vault Issuer in cert-manager

```yaml
# vault-issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-pki-issuer
spec:
  vault:
    server: https://vault.vault.svc.cluster.local:8200
    path: pki_int/sign/kubernetes-services
    caBundle: <base64-encoded-vault-ca-certificate>
    auth:
      kubernetes:
        mountPath: /v1/auth/kubernetes
        role: cert-manager-pki
        serviceAccountRef:
          name: cert-manager
```

### Certificate Using Vault Issuer

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: payment-service-tls
  namespace: production
spec:
  secretName: payment-service-tls
  issuerRef:
    name: vault-pki-issuer
    kind: ClusterIssuer
  commonName: payment-service.production.svc.cluster.local
  dnsNames:
    - payment-service.production.svc.cluster.local
    - payment-service.production.svc
    - payment-service.production
  ipAddresses:
    - 10.96.45.23   # ClusterIP if known
  usages:
    - digital signature
    - key encipherment
    - server auth
    - client auth
  duration: 720h      # 30 days — shorter for Vault-issued certs
  renewBefore: 240h   # Renew 10 days before expiry
```

---

## Certificate Rotation Automation

### Rotation Policy Configuration

cert-manager's `rotationPolicy: Always` ensures the private key is rotated on every certificate renewal. This prevents long-lived private keys that could be compromised without detection:

```yaml
spec:
  privateKey:
    rotationPolicy: Always    # Rotate key on every renewal
    algorithm: ECDSA
    size: 256
```

### Zero-Downtime Rotation

cert-manager renews certificates before expiry and stores them in the Secret's `tls.crt` and `tls.key` fields. Applications using the Secret as a mounted volume receive the new certificate when kubelet refreshes the projected volume (default: every 60–90 seconds). Applications must reload TLS configuration from disk without restarting.

```go
// internal/tls/watcher.go — automatic TLS credential reload
package tls

import (
    "crypto/tls"
    "fmt"
    "log/slog"
    "sync"
    "time"
)

type CertWatcher struct {
    mu       sync.RWMutex
    certFile string
    keyFile  string
    cert     *tls.Certificate
    logger   *slog.Logger
}

func NewCertWatcher(certFile, keyFile string, logger *slog.Logger) (*CertWatcher, error) {
    w := &CertWatcher{
        certFile: certFile,
        keyFile:  keyFile,
        logger:   logger,
    }
    if err := w.reload(); err != nil {
        return nil, err
    }
    return w, nil
}

func (w *CertWatcher) reload() error {
    cert, err := tls.LoadX509KeyPair(w.certFile, w.keyFile)
    if err != nil {
        return fmt.Errorf("loading TLS key pair: %w", err)
    }
    w.mu.Lock()
    w.cert = &cert
    w.mu.Unlock()
    w.logger.Info("TLS certificate reloaded",
        "cert_file", w.certFile,
        "expiry", cert.Leaf.NotAfter,
    )
    return nil
}

func (w *CertWatcher) GetCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
    w.mu.RLock()
    defer w.mu.RUnlock()
    return w.cert, nil
}

func (w *CertWatcher) Watch(interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    for range ticker.C {
        if err := w.reload(); err != nil {
            w.logger.Error("reloading TLS certificate", "error", err)
        }
    }
}

func (w *CertWatcher) TLSConfig() *tls.Config {
    return &tls.Config{
        GetCertificate: w.GetCertificate,
        MinVersion:     tls.VersionTLS12,
        CipherSuites: []uint16{
            tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
            tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
        },
    }
}
```

---

## Monitoring Certificate Expiry

### cert-manager Prometheus Metrics

cert-manager exposes metrics for monitoring certificate health:

```
certmanager_certificate_expiration_timestamp_seconds{name, namespace} ← Unix timestamp of cert expiry
certmanager_certificate_ready_status{condition, name, namespace}       ← 1 if ready, 0 otherwise
certmanager_http_acme_client_request_duration_seconds                  ← ACME request latency
certmanager_controller_sync_call_count{controller}                     ← Reconciliation activity
```

### Alerting Rules

```yaml
# cert-manager-alerts.yaml
groups:
  - name: cert-manager
    rules:
      - alert: CertificateExpiringSoon
        expr: |
          (certmanager_certificate_expiration_timestamp_seconds - time()) < (14 * 24 * 3600)
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} expires in less than 14 days"
          description: "Certificate will expire at {{ humanizeTimestamp $value }}. Check cert-manager renewal status."

      - alert: CertificateExpiringCritical
        expr: |
          (certmanager_certificate_expiration_timestamp_seconds - time()) < (3 * 24 * 3600)
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} expires in less than 3 days"

      - alert: CertificateNotReady
        expr: |
          certmanager_certificate_ready_status{condition="False"} == 1
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} is not ready"
          description: "Run: kubectl describe certificate {{ $labels.name }} -n {{ $labels.namespace }}"

      - alert: CertManagerACMERequestErrors
        expr: |
          rate(certmanager_http_acme_client_request_count{status!="200"}[5m]) > 0.1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "cert-manager is experiencing ACME request errors"
```

### External Certificate Scanner (Complement to cert-manager)

For certificates issued outside cert-manager (load balancer-terminated TLS, third-party certificates), use a dedicated scanner:

```yaml
# x509-certificate-exporter for Prometheus
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: x509-certificate-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: x509-certificate-exporter
  template:
    metadata:
      labels:
        app: x509-certificate-exporter
    spec:
      hostNetwork: true
      hostPID: true
      containers:
        - name: x509-certificate-exporter
          image: enix/x509-certificate-exporter:3.13.0
          args:
            - --watch-file=/etc/kubernetes/pki/apiserver.crt
            - --watch-file=/etc/kubernetes/pki/etcd/server.crt
            - --watch-kubeconf=/etc/kubernetes/admin.conf
            - --expose-per-cert-error-metrics
          ports:
            - containerPort: 9793
          volumeMounts:
            - name: pki
              mountPath: /etc/kubernetes/pki
              readOnly: true
            - name: kubeconfig
              mountPath: /etc/kubernetes/admin.conf
              readOnly: true
      volumes:
        - name: pki
          hostPath:
            path: /etc/kubernetes/pki
        - name: kubeconfig
          hostPath:
            path: /etc/kubernetes/admin.conf
```

---

## Advanced Certificate Patterns

### Client Certificate Authentication

cert-manager can issue client certificates for mutual TLS (mTLS):

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-gateway-client-cert
  namespace: production
spec:
  secretName: api-gateway-client-cert
  issuerRef:
    name: internal-intermediate-issuer
    kind: ClusterIssuer
  commonName: api-gateway
  subject:
    organizations:
      - Example Corp
    organizationalUnits:
      - API Gateway
  usages:
    - digital signature
    - key encipherment
    - client auth     # Client authentication only — not server auth
  duration: 720h
  renewBefore: 240h
```

### Certificate Request Policy with Approver Policy

The `cert-manager-approver-policy` plugin enforces policies on CertificateRequests, preventing namespaces from requesting certificates for domains they do not own:

```yaml
apiVersion: policy.cert-manager.io/v1alpha1
kind: CertificateRequestPolicy
metadata:
  name: namespace-restricted-policy
spec:
  allowed:
    dnsNames:
      allowed: true
      required: false
      validations:
        - rule: "self.endsWith('.production.svc.cluster.local')"
          message: "DNS names must be in the production namespace's cluster-local domain"
    usages:
      - digital signature
      - key encipherment
      - server auth
  selector:
    issuerRef:
      name: internal-intermediate-issuer
      kind: ClusterIssuer
    namespace:
      matchLabels:
        environment: production
```

---

## Troubleshooting Certificate Issuance

### Common Failure States

```bash
# List all certificates and their status
kubectl get certificates -A -o wide

# Describe a failing certificate
kubectl describe certificate <name> -n <namespace>

# Check the CertificateRequest for the current attempt
kubectl get certificaterequests -n <namespace>

# Check the Order for ACME challenges
kubectl get orders -n <namespace>
kubectl describe order <name> -n <namespace>

# Check Challenges (ACME DNS-01 or HTTP-01 in progress)
kubectl get challenges -n <namespace>
kubectl describe challenge <name> -n <namespace>
```

### DNS-01 Challenge Debugging

```bash
# Verify the DNS TXT record was created
dig +short TXT _acme-challenge.example.com

# Check cert-manager controller logs for Route53 errors
kubectl logs -n cert-manager deployment/cert-manager --since=5m | grep -i "route53\|dns01\|error"

# Force retry of a failed certificate
kubectl annotate certificate <name> -n <namespace> \
    cert-manager.io/issue-temporary-certificate="true" --overwrite
```

---

## Conclusion

cert-manager has matured into the de facto standard for Kubernetes certificate lifecycle management. Wildcard certificates via DNS-01 challenge eliminate the per-subdomain certificate management burden. Internal CA chains — either self-managed via cert-manager's CA issuer or delegated to HashiCorp Vault PKI — provide the infrastructure for service-to-service mTLS without public CA fees or latency. Automatic rotation with `rotationPolicy: Always` and application-side certificate reloading without restarts closes the gap between certificate management automation and actual certificate usage. Prometheus-based monitoring with early expiry alerting transforms certificate management from a reactive firefighting activity into a well-understood, observable system component.
