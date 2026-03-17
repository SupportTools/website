---
title: "cert-manager Advanced Configuration: Enterprise PKI and Certificate Lifecycle"
date: 2027-12-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cert-manager", "PKI", "TLS", "Certificates", "Vault", "ACME", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into cert-manager for enterprise PKI: ClusterIssuer vs Issuer, ACME DNS-01 with Route53 and Cloudflare, internal CA with HashiCorp Vault PKI, certificate rotation, expiry monitoring, and trust bundles."
more_link: "yes"
url: "/cert-manager-advanced-production-guide/"
---

cert-manager is the de facto standard for automating TLS certificate management in Kubernetes. Beyond basic Let's Encrypt integration, cert-manager supports the full enterprise PKI lifecycle: internal Certificate Authorities via HashiCorp Vault, DNS-01 challenges for wildcard certificates, fine-grained CertificateRequest policies, automatic rotation before expiry, and trust bundle distribution across namespaces. This guide covers the complete enterprise production configuration.

<!--more-->

# cert-manager Advanced Configuration: Enterprise PKI and Certificate Lifecycle

## cert-manager Architecture

cert-manager consists of three controllers running in the `cert-manager` namespace:

1. **cert-manager controller** - Reconciles Certificate, CertificateRequest, and Issuer resources
2. **cert-manager webhook** - Validates and mutates cert-manager CRDs on admission
3. **cert-manager cainjector** - Injects CA bundles into webhook configurations and CRDs

```
Certificate (desired state)
    └── cert-manager controller
            └── CertificateRequest (issued request)
                    └── Issuer / ClusterIssuer
                            ├── ACME (Let's Encrypt, ZeroSSL)
                            ├── CA (internal CA from Secret)
                            ├── Vault (HashiCorp Vault PKI)
                            ├── Venafi (TPP / Cloud)
                            └── SelfSigned
```

## Installation

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
  --set global.leaderElection.namespace=cert-manager \
  --set replicaCount=2 \
  --set webhook.replicaCount=2 \
  --set cainjector.replicaCount=2

# Verify installation
kubectl get pods -n cert-manager
kubectl get crds | grep cert-manager.io
```

## ClusterIssuer vs Issuer

The choice between `ClusterIssuer` and `Issuer` determines scope and ownership:

| Aspect | Issuer | ClusterIssuer |
|---|---|---|
| Scope | Single namespace | All namespaces |
| Certificates it can issue | Only in its namespace | Any namespace |
| Use case | Team-owned issuers | Platform-owned issuers |
| Secret reference | Same namespace | Must specify namespace |

### When to Use Each

Use `Issuer` when:
- A team owns their own CA or ACME account
- Certificates should be isolated to a specific namespace
- Compliance requirements mandate namespace-scoped PKI boundaries

Use `ClusterIssuer` when:
- The platform team manages certificates cluster-wide
- A single ACME account serves multiple namespaces
- Vault PKI integration is centrally managed

## ACME DNS-01 Challenge: Route53

DNS-01 challenges are required for wildcard certificates (`*.example.com`). The challenge proves domain control by creating a TXT record at `_acme-challenge.example.com`.

### Route53 Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "route53:GetChange",
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets"
      ],
      "Resource": [
        "arn:aws:route53:::hostedzone/Z1234567890ABC",
        "arn:aws:route53:::change/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "route53:ListHostedZonesByName",
      "Resource": "*"
    }
  ]
}
```

### Route53 ClusterIssuer with IRSA

```yaml
# Store credentials in Secret (or use IRSA for IAM role annotation)
apiVersion: v1
kind: Secret
metadata:
  name: route53-credentials
  namespace: cert-manager
type: Opaque
stringData:
  # Use an IAM user with minimal permissions, or prefer IRSA
  secret-access-key: "EXAMPLE_SECRET_KEY_PLACEHOLDER"
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-dns01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: pki@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - selector:
          dnsZones:
            - "example.com"
        dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890ABC
            accessKeyIDSecretRef:
              name: route53-credentials
              key: access-key-id
            secretAccessKeySecretRef:
              name: route53-credentials
              key: secret-access-key
      - selector:
          dnsZones:
            - "internal.example.com"
        dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z9876543210DEF
            # Use IRSA - no credentials needed when running on EKS with IAM role
```

### Using IRSA for Route53 (Recommended for EKS)

```yaml
# Annotate cert-manager ServiceAccount with IAM role ARN
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cert-manager
  namespace: cert-manager
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/cert-manager-route53

---
# ClusterIssuer without explicit credentials
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-irsa
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: pki@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890ABC
            # auth from IRSA, no secretAccessKeySecretRef needed
```

## ACME DNS-01 Challenge: Cloudflare

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: "CLOUDFLARE_API_TOKEN_PLACEHOLDER"
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-cloudflare
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: pki@example.com
    privateKeySecretRef:
      name: letsencrypt-cloudflare-account-key
    solvers:
      - selector:
          dnsZones:
            - "example.com"
            - "*.example.com"
        dns01:
          cloudflare:
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
```

### Cloudflare API Token Permissions

The Cloudflare API token requires:
- Zone: DNS: Edit
- Zone: Zone: Read

Scope to only the zones cert-manager needs to modify.

## Internal CA with HashiCorp Vault PKI

Vault PKI provides enterprise-grade internal certificate management with automatic rotation, revocation, and audit logging.

### Vault PKI Engine Configuration

```bash
# Enable PKI secret engine
vault secrets enable -path=pki pki

# Set max TTL for root CA (10 years)
vault secrets tune -max-lease-ttl=87600h pki

# Generate root CA
vault write -field=certificate pki/root/generate/internal \
  common_name="Example Internal Root CA" \
  ttl=87600h \
  key_type=ec \
  key_bits=384 \
  | tee root_ca.crt

# Configure CRL and OCSP
vault write pki/config/urls \
  issuing_certificates="https://vault.example.com/v1/pki/ca" \
  crl_distribution_points="https://vault.example.com/v1/pki/crl" \
  ocsp_servers="https://vault.example.com/v1/pki/ocsp"

# Enable intermediate CA for Kubernetes
vault secrets enable -path=pki_k8s pki
vault secrets tune -max-lease-ttl=8760h pki_k8s

# Generate intermediate CSR
vault write -format=json pki_k8s/intermediate/generate/internal \
  common_name="Example Kubernetes Intermediate CA" \
  ttl=8760h \
  key_type=ec \
  key_bits=256 | jq -r '.data.csr' > intermediate.csr

# Sign intermediate with root
vault write -format=json pki/root/sign-intermediate \
  csr=@intermediate.csr \
  format=pem_bundle \
  ttl=8760h | jq -r '.data.certificate' > intermediate.pem

# Import signed intermediate
vault write pki_k8s/intermediate/set-signed certificate=@intermediate.pem

# Create Vault role for cert-manager
vault write pki_k8s/roles/cert-manager \
  allowed_domains="svc.cluster.local,example.com,example.internal" \
  allow_subdomains=true \
  allow_localhost=true \
  allow_ip_sans=true \
  max_ttl=8760h \
  ttl=2160h \
  key_type=ec \
  key_bits=256 \
  organization="Example Corp" \
  require_cn=false
```

### Vault Kubernetes Auth

```bash
# Enable Kubernetes auth
vault auth enable kubernetes

# Configure with cluster info
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc.cluster.local" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

# Create policy for cert-manager
vault policy write cert-manager - <<EOF
path "pki_k8s/sign/cert-manager" {
  capabilities = ["create", "update"]
}
path "pki_k8s/issue/cert-manager" {
  capabilities = ["create"]
}
EOF

# Bind policy to cert-manager service account
vault write auth/kubernetes/role/cert-manager \
  bound_service_account_names=cert-manager \
  bound_service_account_namespaces=cert-manager \
  policies=cert-manager \
  ttl=1h
```

### Vault ClusterIssuer

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-internal
spec:
  vault:
    path: pki_k8s/sign/cert-manager
    server: https://vault.vault.svc.cluster.local:8200
    caBundle: |-
      -----BEGIN CERTIFICATE-----
      MIIBxzCCAW2gAwIBAgIRAOBiKmqnf0eijepL4vEJc+kwCgYIKoZIzj0EAwIwLjEs
      # ... (base64 encoded Vault CA certificate)
      -----END CERTIFICATE-----
    auth:
      kubernetes:
        mountPath: /v1/auth/kubernetes
        role: cert-manager
        secretRef:
          name: cert-manager-vault-token
          key: token
```

### Issuing Internal Certificates

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-service-cert
  namespace: production
spec:
  secretName: internal-service-tls
  issuerRef:
    name: vault-internal
    kind: ClusterIssuer
  commonName: "payment-service.production.svc.cluster.local"
  dnsNames:
    - "payment-service"
    - "payment-service.production"
    - "payment-service.production.svc"
    - "payment-service.production.svc.cluster.local"
  ipAddresses:
    - "10.96.0.1"
  duration: 2160h    # 90 days
  renewBefore: 720h  # Renew 30 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always
  usages:
    - digital signature
    - key encipherment
    - server auth
    - client auth
```

## Certificate Rotation

cert-manager handles rotation automatically based on `renewBefore`. The rotation process:

1. cert-manager watches Certificate resources
2. When `now > (notAfter - renewBefore)`, a new `CertificateRequest` is created
3. The issuer signs the new certificate
4. The Secret is updated with the new certificate and private key
5. Applications using the Secret see the updated certificate on their next read

### Rotation Policy: Always vs Never

```yaml
spec:
  privateKey:
    # Always rotate private key on renewal (more secure)
    rotationPolicy: Always

    # Never rotate private key (maintains stable public key)
    # rotationPolicy: Never
```

`Always` is recommended because it limits the exposure of any single private key. Applications that cache the private key must be able to reload it; see the CSI driver integration below for volume-based rotation.

### Triggering Manual Rotation

```bash
# Force immediate renewal of a certificate
kubectl annotate certificate <cert-name> -n <namespace> \
  cert-manager.io/issuer-name="" \
  --overwrite

# Or delete the TLS secret to force re-issuance
kubectl delete secret <tls-secret-name> -n <namespace>
# cert-manager will detect the missing Secret and create a new CertificateRequest
```

## cert-manager CSI Driver for Volume-Based Injection

The cert-manager CSI driver mounts certificates directly as volumes, with automatic reload when certificates rotate:

```bash
helm install cert-manager-csi-driver jetstack/cert-manager-csi-driver \
  --namespace cert-manager \
  --version v0.8.0
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-service
  namespace: production
spec:
  template:
    spec:
      containers:
        - name: app
          image: company/secure-service:1.0.0
          volumeMounts:
            - name: tls
              mountPath: /etc/tls
              readOnly: true
      volumes:
        - name: tls
          csi:
            driver: csi.cert-manager.io
            readOnly: true
            volumeAttributes:
              csi.cert-manager.io/issuer-name: vault-internal
              csi.cert-manager.io/issuer-kind: ClusterIssuer
              csi.cert-manager.io/dns-names: "secure-service.production.svc.cluster.local"
              csi.cert-manager.io/duration: "2160h"
              csi.cert-manager.io/renew-before: "720h"
              csi.cert-manager.io/key-usages: "digital signature,key encipherment,server auth,client auth"
              csi.cert-manager.io/fs-group: "1000"
```

The CSI driver handles the full lifecycle. When the certificate rotates, the volume content is updated automatically without pod restart.

## CertificateRequest Policies with approver-policy

The `approver-policy` controller enforces policies on what certificates can be requested. This is essential for preventing namespace users from requesting certificates for domains they don't own.

```bash
helm install cert-manager-approver-policy jetstack/cert-manager-approver-policy \
  --namespace cert-manager \
  --version v0.13.0
```

### CertificateRequestPolicy

```yaml
apiVersion: policy.cert-manager.io/v1alpha1
kind: CertificateRequestPolicy
metadata:
  name: allow-production-namespace
spec:
  allowed:
    commonName:
      required: false
      value: "*.production.svc.cluster.local"
    dnsNames:
      required: false
      values:
        - "*.production.svc.cluster.local"
        - "*.production.svc"
        - "*.production"
    subject:
      organizations:
        required: false
        values: ["Example Corp"]
    usages:
      - "digital signature"
      - "key encipherment"
      - "server auth"
      - "client auth"
    duration:
      value: 2160h
    isCA: false
    privateKey:
      algorithm: ECDSA
      minSize: 256
  selector:
    issuerRef:
      name: vault-internal
      kind: ClusterIssuer
      group: cert-manager.io
    namespace:
      matchLabels:
        environment: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cert-manager-policy-production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cert-manager-controller-approve:cert-manager.io
subjects:
  - kind: ServiceAccount
    name: cert-manager-approver-policy
    namespace: cert-manager
```

## Monitoring Certificate Expiry

### Prometheus Metrics

cert-manager exposes metrics on port 9402. Key expiry metrics:

```promql
# Certificates expiring within 7 days
certmanager_certificate_expiration_timestamp_seconds - time() < (7 * 24 * 3600)

# Ready status of all certificates
certmanager_certificate_ready_status

# Certificate renewal duration
rate(certmanager_certificate_renewal_timestamp_seconds[1h])
```

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cert-manager
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: cert-manager
      app.kubernetes.io/component: controller
  endpoints:
    - port: http-metrics
      interval: 60s
      honorLabels: true
```

### Expiry Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cert-manager-alerts
  namespace: monitoring
spec:
  groups:
    - name: cert-manager
      rules:
        - alert: CertificateExpiringIn7Days
          expr: |
            certmanager_certificate_expiration_timestamp_seconds - time() < (7 * 24 * 3600)
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} expires in less than 7 days"
            description: "Certificate expires at {{ $value | humanizeTimestamp }}"
        - alert: CertificateExpiringIn24Hours
          expr: |
            certmanager_certificate_expiration_timestamp_seconds - time() < 86400
          for: 30m
          labels:
            severity: critical
          annotations:
            summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} expires in less than 24 hours"
        - alert: CertificateNotReady
          expr: |
            certmanager_certificate_ready_status{condition="False"} == 1
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} is not ready"
            description: "Certificate has been not ready for more than 10 minutes"
        - alert: CertificateRenewalFailed
          expr: |
            increase(certmanager_http_acme_client_request_count{status="error"}[1h]) > 5
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "cert-manager ACME client is experiencing errors"
```

## Trust Bundles with trust-manager

`trust-manager` distributes CA trust bundles across namespaces. This solves the problem of applications that need to trust internal CAs but cannot access the `cert-manager` namespace.

```bash
helm install trust-manager jetstack/trust-manager \
  --namespace cert-manager \
  --version v0.9.0 \
  --set app.trust.namespace=cert-manager
```

### Bundle Resource

```yaml
apiVersion: trust.cert-manager.io/v1alpha1
kind: Bundle
metadata:
  name: internal-ca-bundle
spec:
  sources:
    - inLine: |
        -----BEGIN CERTIFICATE-----
        MIIBxzCCAW2gAwIBAgIRAExample...
        -----END CERTIFICATE-----
    - secret:
        name: vault-internal-ca
        key: ca.crt
        namespace: cert-manager
    - configMap:
        name: additional-ca-certs
        key: ca.crt
        namespace: cert-manager
    # Include system trust store
    - useDefaultCAs: true
  target:
    configMap:
      key: ca-certificates.crt
    namespaceSelector:
      matchLabels:
        trust-bundle: "enabled"
    additionalFormats:
      jks:
        key: "truststore.jks"
      pkcs12:
        key: "truststore.p12"
        password: "changeit"
```

Applications can mount the ConfigMap created by trust-manager in every labeled namespace:

```yaml
spec:
  containers:
    - name: app
      volumeMounts:
        - name: ca-bundle
          mountPath: /etc/ssl/certs/ca-certificates.crt
          subPath: ca-certificates.crt
  volumes:
    - name: ca-bundle
      configMap:
        name: internal-ca-bundle
```

## Multi-Issuer Strategy

Production clusters often need multiple issuers for different certificate types:

```yaml
# External-facing certificates via Let's Encrypt
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: pki@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890ABC
---
# Internal mTLS certificates via Vault
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-mtls
spec:
  vault:
    path: pki_k8s/sign/mtls
    server: https://vault.vault.svc.cluster.local:8200
    auth:
      kubernetes:
        mountPath: /v1/auth/kubernetes
        role: cert-manager
---
# Staging/test certificates via Let's Encrypt staging
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: pki@example.com
    privateKeySecretRef:
      name: letsencrypt-staging-key
    solvers:
      - http01:
          ingress:
            class: nginx
```

## Certificate Inventory and Auditing

```bash
#!/bin/bash
# cert-audit.sh - Generate certificate inventory report

set -euo pipefail

echo "=== Certificate Inventory Report ==="
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

echo "--- Certificate Status Summary ---"
kubectl get certificate -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,EXPIRY:.status.notAfter,ISSUER:.spec.issuerRef.name' \
  | sort -k1,1 -k2,2

echo ""
echo "--- Certificates Expiring in 30 Days ---"
NOW=$(date +%s)
THRESHOLD=$((NOW + 30 * 24 * 3600))

kubectl get certificate -A -o json | jq -r --argjson threshold "$THRESHOLD" '
  .items[] |
  select(.status.notAfter != null) |
  (.status.notAfter | sub("\\.[0-9]+Z$"; "Z") | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) as $expiry |
  select($expiry < $threshold) |
  "\(.metadata.namespace)/\(.metadata.name): expires \(.status.notAfter)"
'

echo ""
echo "--- CertificateRequest Failures (last 24h) ---"
kubectl get certificaterequest -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,APPROVED:.status.conditions[?(@.type=="Approved")].status,READY:.status.conditions[?(@.type=="Ready")].status' \
  | grep -v "True"
```

## Troubleshooting

### Certificate Stuck in Pending

```bash
# Check Certificate status
kubectl describe certificate <cert-name> -n <namespace>

# Check CertificateRequest
kubectl get certificaterequest -n <namespace> -l cert-manager.io/certificate-name=<cert-name>
kubectl describe certificaterequest <cr-name> -n <namespace>

# Check Order (for ACME issuers)
kubectl get order -n <namespace>
kubectl describe order <order-name> -n <namespace>

# Check Challenge (for HTTP-01 or DNS-01)
kubectl get challenge -n <namespace>
kubectl describe challenge <challenge-name> -n <namespace>
```

### DNS-01 Challenge Failing

```bash
# Verify DNS propagation manually
dig -t TXT _acme-challenge.example.com @8.8.8.8

# Check cert-manager logs for DNS errors
kubectl logs -n cert-manager \
  -l app.kubernetes.io/component=controller \
  --tail=200 | grep -i "dns\|route53\|cloudflare\|error"

# Common causes:
# 1. IAM permissions insufficient
# 2. Incorrect hosted zone ID
# 3. DNS propagation timeout (increase with --dns01-recursive-nameservers-only)
```

### Vault Auth Failing

```bash
# Test Vault connectivity from cert-manager pod
kubectl exec -n cert-manager \
  -l app.kubernetes.io/component=controller \
  -- vault status -address=https://vault.vault.svc.cluster.local:8200

# Verify Kubernetes auth config
vault write auth/kubernetes/login \
  role=cert-manager \
  jwt=$(kubectl create token cert-manager -n cert-manager)
```

## Summary

cert-manager in enterprise environments requires more than basic HTTP-01 ACME configuration. The combination of DNS-01 challenges (for wildcard certificates), Vault PKI integration (for internal mTLS certificates), CertificateRequest policies (for preventing unauthorized certificate issuance), and trust-manager (for CA bundle distribution) provides a complete PKI automation platform.

Key operational guidelines: use `ClusterIssuer` for platform-managed certificate authorities, always configure `renewBefore` to be at least 25% of the certificate `duration`, use `rotationPolicy: Always` for private keys when applications can reload certificates without restart, and deploy monitoring alerts for certificates expiring within 7 days to provide sufficient response time when automation fails.
