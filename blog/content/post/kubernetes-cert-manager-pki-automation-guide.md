---
title: "cert-manager PKI Automation: ACME, Vault, and Private CA Integration"
date: 2027-06-12T00:00:00-05:00
draft: false
tags: ["cert-manager", "Kubernetes", "PKI", "TLS", "Certificate Management", "Vault"]
categories:
- Kubernetes
- Security
- PKI
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete enterprise guide to cert-manager: architecture, ACME with HTTP01 and DNS01 challenges, HashiCorp Vault PKI integration, private CA with cfssl, wildcard certificates, rotation automation, expiry monitoring, and troubleshooting issuance failures."
more_link: "yes"
url: "/kubernetes-cert-manager-pki-automation-guide/"
---

Manual certificate management at scale is operationally unsustainable. Certificates expire, rotation requires coordination across services, and human error in the issuance process creates security gaps. cert-manager automates the full certificate lifecycle within Kubernetes — from initial issuance through renewal — by integrating with public ACME certificate authorities, internal PKI systems like HashiCorp Vault, and self-managed private CAs. This guide covers the complete cert-manager architecture and provides production-ready configurations for every major issuer type.

<!--more-->

## Section 1: cert-manager Architecture

cert-manager runs as a Kubernetes controller. It watches `Certificate`, `CertificateRequest`, `Issuer`, `ClusterIssuer`, and `Order` custom resources and drives the certificate lifecycle based on their specifications.

### Core Resources

| Resource | Scope | Purpose |
|----------|-------|---------|
| `Issuer` | Namespace | Configures a certificate issuer for use within a single namespace |
| `ClusterIssuer` | Cluster | Configures a certificate issuer available cluster-wide |
| `Certificate` | Namespace | Declares a desired TLS certificate and the target Secret |
| `CertificateRequest` | Namespace | Low-level resource representing a single certificate signing request |
| `Order` | Namespace | ACME order resource (managed automatically by cert-manager) |
| `Challenge` | Namespace | ACME challenge resource (managed automatically by cert-manager) |

### Controller Components

```
┌─────────────────────────────────────────────────────────┐
│  cert-manager-controller                                │
│  ├── Certificate controller    (watches Certificate)   │
│  ├── CertificateRequest ctrl   (watches CertReq)       │
│  ├── ACME Order controller     (manages ACME Orders)   │
│  └── ACME Challenge controller (manages Challenges)    │
├─────────────────────────────────────────────────────────┤
│  cert-manager-webhook                                   │
│  └── Validates cert-manager resource mutations         │
├─────────────────────────────────────────────────────────┤
│  cert-manager-cainjector                               │
│  └── Injects CA bundles into webhooks and CRDs         │
└─────────────────────────────────────────────────────────┘
```

### Installation with Helm

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.15.0 \
  --set installCRDs=true \
  --set replicaCount=3 \
  --set webhook.replicaCount=3 \
  --set cainjector.replicaCount=2 \
  --set prometheus.enabled=true \
  --set prometheus.servicemonitor.enabled=true \
  --set global.leaderElection.namespace=cert-manager \
  --set featureGates="ExperimentalGatewayAPISupport=true"
```

### Verify Installation

```bash
kubectl get pods -n cert-manager
kubectl get crds | grep cert-manager

# Run the cert-manager diagnostic tool
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.15.0/cert-manager.yaml
cmctl check api

# Or use the kubectl plugin
kubectl cert-manager check api
```

## Section 2: Issuer vs ClusterIssuer

The choice between `Issuer` and `ClusterIssuer` determines scope and is not interchangeable at runtime.

### When to Use Issuer

- Namespace-scoped issuance: each team manages their own certificates
- Multi-tenant clusters where issuer credentials must be namespace-isolated
- Development namespaces with separate ACME accounts

### When to Use ClusterIssuer

- Organization-wide certificate issuance from a single CA or ACME account
- Ingress-integrated certificate automation (cert-manager Ingress annotations use ClusterIssuer by default)
- Reduced operational overhead — one configuration to maintain

### Referencing in a Certificate

```yaml
# Using an Issuer (namespace-scoped)
spec:
  issuerRef:
    name: letsencrypt-staging
    kind: Issuer

# Using a ClusterIssuer (cluster-wide)
spec:
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
    group: cert-manager.io
```

## Section 3: ACME with Let's Encrypt

### HTTP01 Challenge

HTTP01 challenges require the ACME server to reach a specific URL on the domain over port 80. cert-manager creates an Ingress resource that serves the challenge token.

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: platform@company.com
    privateKeySecretRef:
      name: letsencrypt-staging-account-key
    solvers:
    - http01:
        ingress:
          class: nginx
          serviceType: ClusterIP
          podTemplate:
            spec:
              nodeSelector:
                kubernetes.io/os: linux
              tolerations:
              - key: node-role.kubernetes.io/control-plane
                effect: NoSchedule
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@company.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - http01:
        ingress:
          class: nginx
          serviceType: ClusterIP
```

### DNS01 Challenge with Route 53

DNS01 challenges are required for wildcard certificates and domains where HTTP01 is not feasible (private clusters, clusters behind NAT).

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@company.com
    privateKeySecretRef:
      name: letsencrypt-dns01-account-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1234567890ABC
          role: arn:aws:iam::123456789012:role/cert-manager-route53
      selector:
        dnsZones:
        - "example.com"
        - "*.example.com"
```

Create the IAM policy and role for Route 53 access:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "route53:GetChange",
      "Resource": "arn:aws:route53:::change/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets"
      ],
      "Resource": "arn:aws:route53:::hostedzone/Z1234567890ABC"
    },
    {
      "Effect": "Allow",
      "Action": "route53:ListHostedZonesByName",
      "Resource": "*"
    }
  ]
}
```

Configure IRSA (IAM Roles for Service Accounts) for the cert-manager pod:

```bash
eksctl create iamserviceaccount \
  --name cert-manager \
  --namespace cert-manager \
  --cluster my-cluster \
  --role-name cert-manager-route53 \
  --attach-policy-arn arn:aws:iam::123456789012:policy/CertManagerRoute53Policy \
  --approve
```

### DNS01 Challenge with Cloudflare

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-cloudflare
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@company.com
    privateKeySecretRef:
      name: letsencrypt-cloudflare-account-key
    solvers:
    - dns01:
        cloudflare:
          email: platform@company.com
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
      selector:
        dnsZones:
        - "example.com"
---
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: "YOUR_CLOUDFLARE_API_TOKEN"
```

### Wildcard Certificate with DNS01

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: production
spec:
  secretName: wildcard-example-com-tls
  issuerRef:
    name: letsencrypt-dns01
    kind: ClusterIssuer
  commonName: "*.example.com"
  dnsNames:
  - "*.example.com"
  - "example.com"
  duration: 2160h  # 90 days
  renewBefore: 720h  # Renew 30 days before expiry
  privateKey:
    algorithm: RSA
    encoding: PKCS1
    size: 4096
    rotationPolicy: Always
```

### Using Wildcard Certificate in Multiple Namespaces

cert-manager creates Secrets in the same namespace as the Certificate. To use a wildcard certificate across namespaces, use the cert-manager Kubernetes Secret syncing feature or the `reflector` operator:

```bash
# Install reflector for cross-namespace secret sync
helm install reflector emberstack/reflector \
  --namespace kube-system

# Annotate the certificate secret for reflection
kubectl annotate secret wildcard-example-com-tls \
  reflector.v1.k8s.emberstack.com/reflection-allowed=true \
  reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces="production,staging,development" \
  -n cert-manager
```

## Section 4: HashiCorp Vault PKI Issuer

Vault's PKI secrets engine enables cert-manager to issue certificates from an internal CA hierarchy. This is the recommended approach for enterprise environments with compliance requirements that prohibit public CA issuance for internal services.

### Configure Vault PKI

```bash
# Enable PKI secrets engine
vault secrets enable -path=pki pki
vault secrets tune -max-lease-ttl=87600h pki

# Generate root CA (or import an existing one)
vault write pki/root/generate/internal \
  common_name="company.com Root CA" \
  ttl=87600h \
  key_type=rsa \
  key_bits=4096

# Configure CRL distribution
vault write pki/config/urls \
  issuing_certificates="https://vault.company.com/v1/pki/ca" \
  crl_distribution_points="https://vault.company.com/v1/pki/crl"

# Create intermediate CA
vault secrets enable -path=pki_int pki
vault secrets tune -max-lease-ttl=43800h pki_int

vault write -format=json pki_int/intermediate/generate/internal \
  common_name="company.com Intermediate CA" \
  | jq -r '.data.csr' > pki_intermediate.csr

vault write -format=json pki/root/sign-intermediate \
  csr=@pki_intermediate.csr \
  format=pem_bundle \
  ttl=43800h \
  | jq -r '.data.certificate' > intermediate.cert.pem

vault write pki_int/intermediate/set-signed \
  certificate=@intermediate.cert.pem

# Create role for Kubernetes cert issuance
vault write pki_int/roles/kubernetes-certs \
  allowed_domains="svc.cluster.local,example.com" \
  allow_subdomains=true \
  allow_bare_domains=false \
  allow_glob_domains=true \
  max_ttl=8760h \
  key_type=rsa \
  key_bits=2048 \
  require_cn=false \
  server_flag=true \
  client_flag=true
```

### Vault Kubernetes Authentication

```bash
# Enable Kubernetes auth method
vault auth enable kubernetes

# Configure Kubernetes auth
vault write auth/kubernetes/config \
  kubernetes_host="https://10.96.0.1:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

# Create policy for cert-manager
vault policy write cert-manager - <<EOF
path "pki_int/sign/kubernetes-certs" {
  capabilities = ["create", "update"]
}
path "pki_int/issue/kubernetes-certs" {
  capabilities = ["create", "update"]
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
  name: vault-issuer
spec:
  vault:
    server: https://vault.company.com
    path: pki_int/sign/kubernetes-certs
    caBundle: |-
      -----BEGIN CERTIFICATE-----
      # Insert your Vault TLS CA certificate here (base64-decoded PEM)
      -----END CERTIFICATE-----
    auth:
      kubernetes:
        role: cert-manager
        mountPath: /v1/auth/kubernetes
        serviceAccountRef:
          name: cert-manager
```

### Issuing a Certificate from Vault

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-service-tls
  namespace: production
spec:
  secretName: api-service-tls
  issuerRef:
    name: vault-issuer
    kind: ClusterIssuer
  commonName: api-service.production.svc.cluster.local
  dnsNames:
  - api-service.production.svc.cluster.local
  - api-service.production.svc
  - api-service.production
  - api-service
  - api.example.com
  ipAddresses:
  - 10.96.45.100
  duration: 8760h
  renewBefore: 720h
  privateKey:
    algorithm: RSA
    size: 2048
    rotationPolicy: Always
  usages:
  - server auth
  - client auth
```

### Vault Agent Injector Integration

For workloads that need certificates without cert-manager (legacy apps, non-Kubernetes workloads on the same Vault):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-app
  namespace: production
spec:
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "legacy-app"
        vault.hashicorp.com/agent-inject-secret-tls.crt: "pki_int/issue/kubernetes-certs"
        vault.hashicorp.com/agent-inject-template-tls.crt: |
          {{- with secret "pki_int/issue/kubernetes-certs" "common_name=legacy-app.example.com" "ttl=24h" -}}
          {{ .Data.certificate }}
          {{- end }}
        vault.hashicorp.com/agent-inject-secret-tls.key: "pki_int/issue/kubernetes-certs"
        vault.hashicorp.com/agent-inject-template-tls.key: |
          {{- with secret "pki_int/issue/kubernetes-certs" "common_name=legacy-app.example.com" "ttl=24h" -}}
          {{ .Data.private_key }}
          {{- end }}
```

## Section 5: Private CA with cfssl

For environments without Vault, cert-manager can use a private CA managed with cfssl or a manually maintained CA certificate/key pair.

### Generate CA with cfssl

```bash
# Install cfssl
go install github.com/cloudflare/cfssl/cmd/cfssl@latest
go install github.com/cloudflare/cfssl/cmd/cfssljson@latest

# CA configuration
cat > ca-config.json <<EOF
{
  "signing": {
    "default": {
      "expiry": "87600h"
    },
    "profiles": {
      "server": {
        "usages": ["signing", "key encipherment", "server auth"],
        "expiry": "8760h"
      },
      "client": {
        "usages": ["signing", "key encipherment", "client auth"],
        "expiry": "8760h"
      },
      "peer": {
        "usages": ["signing", "key encipherment", "server auth", "client auth"],
        "expiry": "8760h"
      }
    }
  }
}
EOF

# CA certificate signing request
cat > ca-csr.json <<EOF
{
  "CN": "company.com Internal CA",
  "key": {
    "algo": "rsa",
    "size": 4096
  },
  "names": [
    {
      "C": "US",
      "ST": "California",
      "L": "San Francisco",
      "O": "Company Inc",
      "OU": "Platform Engineering"
    }
  ],
  "ca": {
    "expiry": "87600h"
  }
}
EOF

# Generate root CA
cfssl gencert -initca ca-csr.json | cfssljson -bare ca

# Store in Kubernetes secret
kubectl create secret tls internal-ca-secret \
  --cert=ca.pem \
  --key=ca-key.pem \
  -n cert-manager
```

### CA ClusterIssuer

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: internal-ca-secret
```

### Intermediate CA Setup

Using an intermediate CA is strongly recommended. Never expose the root CA private key to Kubernetes secrets:

```bash
# Generate intermediate CA CSR
cat > intermediate-csr.json <<EOF
{
  "CN": "company.com Kubernetes Intermediate CA",
  "key": {
    "algo": "rsa",
    "size": 2048
  },
  "names": [
    {
      "C": "US",
      "ST": "California",
      "O": "Company Inc",
      "OU": "Kubernetes Platform"
    }
  ]
}
EOF

cfssl genkey intermediate-csr.json | cfssljson -bare intermediate

# Sign intermediate with root CA
cfssl sign \
  -ca ca.pem \
  -ca-key ca-key.pem \
  -config ca-config.json \
  -profile peer \
  intermediate.csr | cfssljson -bare intermediate-signed

# Create cert bundle (intermediate + root chain)
cat intermediate-signed.pem ca.pem > ca-bundle.pem

# Store intermediate in Kubernetes
kubectl create secret tls intermediate-ca-secret \
  --cert=ca-bundle.pem \
  --key=intermediate-key.pem \
  -n cert-manager
```

## Section 6: Certificate Resources and Rotation

### Standard Certificate Configuration

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: web-service-tls
  namespace: production
spec:
  # The name of the Secret where the certificate will be stored
  secretName: web-service-tls

  # Certificate validity and renewal window
  duration: 2160h     # 90 days
  renewBefore: 360h   # Renew 15 days before expiry

  # Subject information
  subject:
    organizations:
    - Company Inc
    organizationalUnits:
    - Platform Engineering
    countries:
    - US
    provinces:
    - California
    localities:
    - San Francisco

  isCA: false

  privateKey:
    algorithm: RSA
    encoding: PKCS1
    size: 2048
    rotationPolicy: Always   # Always rotate private key on renewal

  usages:
  - digital signature
  - key encipherment
  - server auth

  # DNS names for the certificate
  commonName: web-service.example.com
  dnsNames:
  - web-service.example.com
  - www.example.com
  - web-service.production.svc.cluster.local

  # Issuer reference
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
    group: cert-manager.io
```

### Certificate Status Inspection

```bash
# Check certificate status
kubectl describe certificate web-service-tls -n production

# Check the generated Secret
kubectl get secret web-service-tls -n production -o yaml

# Decode and inspect the certificate
kubectl get secret web-service-tls -n production \
  -o jsonpath='{.data.tls\.crt}' | \
  base64 -d | \
  openssl x509 -text -noout | \
  grep -E "Subject:|Not Before:|Not After:|DNS:|IP:"

# Check CertificateRequest history
kubectl get certificaterequest -n production

# View cert-manager events
kubectl get events -n production \
  --field-selector reason=Issued \
  --sort-by='.lastTimestamp'
```

### Manual Certificate Renewal

```bash
# Trigger immediate renewal
kubectl cert-manager renew web-service-tls -n production

# Or annotate to trigger renewal
kubectl annotate certificate web-service-tls \
  cert-manager.io/issuetemporarycertificate="true" \
  -n production \
  --overwrite

# Force renewal by deleting the CertificateRequest
kubectl delete certificaterequest -n production \
  -l cert-manager.io/certificate-name=web-service-tls
```

### Automatic Rotation with Private Key Rotation Policy

The `rotationPolicy: Always` setting ensures the private key is regenerated on every renewal. This limits the exposure window of any compromised private key.

```yaml
spec:
  privateKey:
    rotationPolicy: Always
    algorithm: ECDSA
    size: 256
```

ECDSA P-256 provides equivalent security to RSA 3072 with significantly smaller key sizes and faster operations. For most services, ECDSA is preferred over RSA.

## Section 7: Ingress-Integrated Certificate Automation

cert-manager integrates directly with Ingress resources via annotations:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-app-ingress
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    cert-manager.io/duration: "2160h"
    cert-manager.io/renew-before: "360h"
    cert-manager.io/private-key-rotation-policy: "Always"
    cert-manager.io/private-key-algorithm: "ECDSA"
    cert-manager.io/private-key-size: "256"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - app.example.com
    - www.example.com
    secretName: web-app-tls    # cert-manager creates and manages this Secret
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web-app-service
            port:
              number: 8080
```

cert-manager detects the `tls` block and `cert-manager.io/cluster-issuer` annotation, creates a Certificate resource, and populates the specified Secret.

## Section 8: Monitoring Certificate Expiry

### Prometheus Metrics

cert-manager exposes Prometheus metrics including certificate expiry times:

```
certmanager_certificate_expiration_timestamp_seconds{name, namespace}
certmanager_certificate_ready_status{name, namespace, condition}
certmanager_certificate_renewal_timestamp_seconds{name, namespace}
```

### PrometheusRule for Expiry Alerts

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
    - alert: CertManagerCertificateExpiringSoon
      expr: |
        certmanager_certificate_expiration_timestamp_seconds - time() < 604800
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Certificate expiring within 7 days"
        description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}"

    - alert: CertManagerCertificateExpiringCritical
      expr: |
        certmanager_certificate_expiration_timestamp_seconds - time() < 86400
      for: 15m
      labels:
        severity: critical
      annotations:
        summary: "Certificate expiring within 24 hours"
        description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}"

    - alert: CertManagerCertificateNotReady
      expr: |
        certmanager_certificate_ready_status{condition="False"} == 1
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Certificate not in Ready state"
        description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} is not ready"

    - alert: CertManagerCertificateMissing
      expr: |
        certmanager_certificate_ready_status{condition="Unknown"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Certificate in Unknown state"
        description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} is in Unknown state"

    - alert: CertManagerACMEOrderFailed
      expr: |
        increase(certmanager_acme_client_request_count{status="error"}[1h]) > 5
      labels:
        severity: warning
      annotations:
        summary: "ACME order failures detected"
        description: "ACME client requests are failing at {{ $value }} errors/hour for issuer {{ $labels.issuer }}"
```

### Certificate Expiry Audit Script

```bash
#!/usr/bin/env bash
# cert-expiry-audit.sh — report certificates expiring within threshold

set -euo pipefail

THRESHOLD_DAYS="${1:-30}"
THRESHOLD_SECONDS=$((THRESHOLD_DAYS * 86400))
NOW=$(date +%s)

echo "=== Certificates expiring within ${THRESHOLD_DAYS} days ==="
echo ""

while IFS= read -r line; do
  namespace=$(echo "${line}" | awk '{print $1}')
  name=$(echo "${line}" | awk '{print $2}')
  secret=$(echo "${line}" | awk '{print $3}')

  if kubectl get secret "${secret}" -n "${namespace}" &>/dev/null; then
    expiry=$(kubectl get secret "${secret}" -n "${namespace}" \
      -o jsonpath='{.data.tls\.crt}' | \
      base64 -d | \
      openssl x509 -noout -enddate 2>/dev/null | \
      sed 's/notAfter=//')

    if [ -n "${expiry}" ]; then
      expiry_epoch=$(date -d "${expiry}" +%s 2>/dev/null || date -j -f "%b %e %T %Y %Z" "${expiry}" +%s)
      days_remaining=$(( (expiry_epoch - NOW) / 86400 ))

      if [ "${days_remaining}" -lt "${THRESHOLD_DAYS}" ]; then
        if [ "${days_remaining}" -lt 0 ]; then
          echo "EXPIRED  | ${namespace}/${name} | secret=${secret} | expired ${days_remaining#-} days ago"
        else
          echo "WARNING  | ${namespace}/${name} | secret=${secret} | expires in ${days_remaining} days"
        fi
      fi
    fi
  else
    echo "NO_SECRET | ${namespace}/${name} | secret=${secret} | Secret not found"
  fi
done < <(kubectl get certificate -A \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.secretName}{"\n"}{end}')

echo ""
echo "=== Scan complete ==="
```

## Section 9: Troubleshooting Issuance Failures

### Common Failure Patterns

#### HTTP01 Challenge Failing

```bash
# Check challenge status
kubectl get challenge -n production
kubectl describe challenge -n production <challenge-name>

# Common causes:
# 1. Ingress controller not reachable on port 80
# 2. DNS not pointing to cluster
# 3. Firewall blocking ACME server

# Verify challenge path is reachable
curl -v "http://app.example.com/.well-known/acme-challenge/<token>"

# Check temporary Ingress created by cert-manager
kubectl get ingress -n production
kubectl describe ingress cm-acme-http-solver-xxxxx -n production

# Check ingress controller logs during challenge
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller --since=5m | \
  grep "acme-challenge"
```

#### DNS01 Challenge Failing

```bash
# Check challenge status
kubectl describe challenge -n production <challenge-name>

# Verify DNS record was created
dig TXT _acme-challenge.example.com +short

# Check cert-manager logs for DNS provider errors
kubectl logs -n cert-manager deployment/cert-manager --since=5m | \
  grep -i "dns\|route53\|cloudflare\|error"

# Common causes:
# 1. Incorrect IAM permissions
# 2. Wrong hosted zone ID
# 3. DNS propagation delay (wait up to 300 seconds)
# 4. API rate limiting
```

#### Vault Issuer Failing

```bash
# Check CertificateRequest status
kubectl describe certificaterequest -n production

# Check cert-manager logs
kubectl logs -n cert-manager deployment/cert-manager --since=5m | \
  grep -i "vault\|error"

# Test Vault connectivity from cert-manager pod
kubectl exec -n cert-manager deployment/cert-manager -- \
  wget -q -O- https://vault.company.com/v1/sys/health

# Verify Kubernetes auth in Vault
vault write auth/kubernetes/login \
  role=cert-manager \
  jwt="$(kubectl get secret -n cert-manager \
    $(kubectl get serviceaccount cert-manager -n cert-manager \
      -o jsonpath='{.secrets[0].name}') \
    -o jsonpath='{.data.token}' | base64 -d)"
```

#### Certificate Stuck in Pending

```bash
# Full status inspection
kubectl describe certificate web-service-tls -n production
kubectl get certificaterequest -n production \
  -l cert-manager.io/certificate-name=web-service-tls

# Check Order and Challenge status
kubectl get order -n production
kubectl get challenge -n production

# Check cert-manager controller logs
kubectl logs -n cert-manager deployment/cert-manager --since=10m

# Check webhook is operational
kubectl logs -n cert-manager deployment/cert-manager-webhook --since=5m

# Force a retry by deleting the stuck CertificateRequest
kubectl delete certificaterequest -n production \
  -l cert-manager.io/certificate-name=web-service-tls
```

#### ACME Rate Limiting

Let's Encrypt enforces rate limits: 50 certificates per domain per week, 5 failed validations per domain per hour.

```bash
# Check current rate limit status
# Use staging for testing before production
kubectl describe clusterissuer letsencrypt-prod | grep "Last Registration"

# Switch to staging issuer for testing
kubectl patch certificate web-service-tls -n production \
  --type=merge \
  -p '{"spec":{"issuerRef":{"name":"letsencrypt-staging"}}}'
```

### Diagnostic Commands Reference

```bash
# All-in-one cert-manager status check
cmctl status certificate web-service-tls -n production

# Check all certificates cluster-wide
kubectl get certificate -A

# Check certificates with Ready=False
kubectl get certificate -A \
  -o jsonpath='{range .items[?(@.status.conditions[0].status=="False")]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.status.conditions[0].message}{"\n"}{end}'

# Check cert-manager version
cmctl version

# Run cert-manager e2e check
cmctl check api --wait 2m
```

## Section 10: Advanced Certificate Patterns

### Certificate for etcd and Control Plane

For clusters requiring custom control plane certificates:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: etcd-server-tls
  namespace: kube-system
spec:
  secretName: etcd-server-tls
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
  commonName: etcd
  dnsNames:
  - etcd
  - etcd.kube-system.svc.cluster.local
  - localhost
  ipAddresses:
  - 127.0.0.1
  - 10.0.0.10  # etcd node IP
  - 10.0.0.11
  - 10.0.0.12
  duration: 8760h
  renewBefore: 720h
  usages:
  - server auth
  - client auth
  - key encipherment
  - digital signature
```

### JKS and PKCS12 Output Formats

Some Java applications require JKS or PKCS12 format:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: java-app-tls
  namespace: production
spec:
  secretName: java-app-tls
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
  commonName: java-app.example.com
  dnsNames:
  - java-app.example.com
  duration: 8760h
  keystores:
    pkcs12:
      create: true
      passwordSecretRef:
        name: java-app-keystore-password
        key: password
    jks:
      create: true
      passwordSecretRef:
        name: java-app-keystore-password
        key: password
```

### CSI Driver Integration

cert-manager's CSI driver mounts certificates directly into pod filesystems without creating Kubernetes Secrets:

```bash
helm install cert-manager-csi-driver jetstack/cert-manager-csi-driver \
  --namespace cert-manager
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-app
  namespace: production
spec:
  template:
    spec:
      volumes:
      - name: tls
        csi:
          driver: csi.cert-manager.io
          readOnly: true
          volumeAttributes:
            csi.cert-manager.io/issuer-name: internal-ca-issuer
            csi.cert-manager.io/issuer-kind: ClusterIssuer
            csi.cert-manager.io/common-name: secure-app.production.svc.cluster.local
            csi.cert-manager.io/dns-names: secure-app.production.svc.cluster.local,secure-app.example.com
            csi.cert-manager.io/duration: 1h
            csi.cert-manager.io/is-ca: "false"
      containers:
      - name: app
        image: secure-app:latest
        volumeMounts:
        - name: tls
          mountPath: /var/run/certs
          readOnly: true
```

The CSI driver issues short-lived certificates (hourly or shorter) that are rotated transparently without pod restarts.

---

cert-manager transforms certificate management from a manual, error-prone operational task into an automated, policy-driven process. The ACME integration eliminates the need for manual public certificate renewal. The Vault PKI issuer brings the same automation to internal certificates with enterprise CA hierarchy requirements. Monitoring certificate expiry through Prometheus and alerting before renewal failures occur ensures that certificate-related outages — historically a leading cause of production incidents — become rare exceptions rather than recurring events.
