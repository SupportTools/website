---
title: "Kubernetes Cert-Manager Advanced: ACME DNS-01 Challenges, Vault PKI, and Certificate Policy Enforcement"
date: 2028-07-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cert-manager", "PKI", "TLS", "Vault", "ACME"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to cert-manager advanced configurations including ACME DNS-01 wildcard certificates, HashiCorp Vault PKI integration, ClusterIssuers, and certificate policy enforcement with approval workflows."
more_link: "yes"
url: "/kubernetes-cert-manager-advanced-pki-guide/"
---

Cert-manager is the de facto certificate management solution for Kubernetes, but most teams only scratch the surface of what it can do. Getting a single domain certificate from Let's Encrypt is straightforward; building a robust enterprise PKI that handles wildcard certificates, internal CAs, Vault integration, automatic rotation, and policy enforcement is a different challenge entirely.

This guide covers the full spectrum of cert-manager production use cases: DNS-01 ACME challenges for wildcard certificates, HashiCorp Vault PKI backends for internal certificates, certificate approval policies, multi-issuer architectures, and operational monitoring.

<!--more-->

# Kubernetes Cert-Manager Advanced: Enterprise PKI

## Architecture Overview

A mature cert-manager deployment typically handles several distinct certificate categories simultaneously:

- **Public TLS certificates**: Issued by Let's Encrypt via ACME DNS-01 for customer-facing hostnames
- **Internal service certificates**: Issued by an internal CA (Vault PKI or self-signed) for service mesh mTLS and internal APIs
- **Webhook and admission controller certificates**: Short-lived certificates for Kubernetes admission webhooks
- **Client certificates**: Issued for mutual TLS authentication between services

Each category has different issuance requirements, rotation frequencies, and validation chains.

## Installation

```bash
# Add the cert-manager Helm repository
helm repo add jetstack https://charts.jetstack.io
helm repo update

# Install cert-manager with CRDs and prometheus metrics
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.14.0 \
  --set installCRDs=true \
  --set prometheus.enabled=true \
  --set prometheus.servicemonitor.enabled=true \
  --set global.leaderElection.namespace=cert-manager \
  --set replicaCount=2 \
  --set webhook.replicaCount=2 \
  --set cainjector.replicaCount=2

# Verify installation
kubectl -n cert-manager get pods
kubectl -n cert-manager get crds | grep cert-manager
```

## Section 1: ACME DNS-01 Challenges

DNS-01 is required for wildcard certificates and is the most reliable ACME challenge type in Kubernetes environments because it does not require port 80/443 to be reachable. The DNS-01 flow works by having cert-manager create a TXT record under `_acme-challenge.<domain>` to prove domain ownership.

### Route53 DNS-01 Issuer

```yaml
# cert-manager/issuers/letsencrypt-prod-route53.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-route53
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          # Use IRSA (IAM Roles for Service Accounts) for credential-free access.
          # The cert-manager pod's service account is annotated with the IAM role ARN.
          role: arn:aws:iam::123456789012:role/cert-manager-route53
      # Restrict this solver to specific domains.
      selector:
        dnsZones:
        - example.com
        - "*.example.com"
```

The IAM policy required for Route53 DNS-01:

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
      "Resource": "arn:aws:route53:::hostedzone/YOUR_HOSTED_ZONE_ID"
    },
    {
      "Effect": "Allow",
      "Action": "route53:ListHostedZonesByName",
      "Resource": "*"
    }
  ]
}
```

Annotate the cert-manager ServiceAccount for IRSA:

```bash
kubectl -n cert-manager annotate serviceaccount cert-manager \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/cert-manager-route53
```

### Wildcard Certificate

```yaml
# cert-manager/certificates/wildcard-example-com.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: ingress-nginx
spec:
  secretName: wildcard-example-com-tls
  duration: 2160h    # 90 days
  renewBefore: 360h  # Renew 15 days before expiry

  # Encode the private key as PKCS8 for better compatibility.
  privateKey:
    algorithm: ECDSA
    size: 384
    encoding: PKCS8
    rotationPolicy: Always  # Always generate a new key on renewal.

  subject:
    organizations:
    - Example Corp

  dnsNames:
  - example.com
  - "*.example.com"

  issuerRef:
    name: letsencrypt-prod-route53
    kind: ClusterIssuer
    group: cert-manager.io
```

### Cloudflare DNS-01 Issuer

```yaml
# cert-manager/issuers/letsencrypt-prod-cloudflare.yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: "YOUR_CLOUDFLARE_API_TOKEN"
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-cloudflare
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-cf-account-key
    solvers:
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
      selector:
        dnsZones:
        - internal.example.com
```

## Section 2: HashiCorp Vault PKI Backend

For internal certificates, Vault PKI provides a production-grade CA with fine-grained role policies, certificate revocation, and audit logging. Cert-manager integrates with Vault through the `vault` issuer type.

### Vault PKI Setup

```bash
# Enable the PKI secrets engine.
vault secrets enable -path=pki pki

# Tune the max lease TTL to 10 years for the root CA.
vault secrets tune -max-lease-ttl=87600h pki

# Generate the root CA certificate.
vault write -field=certificate pki/root/generate/internal \
  common_name="Example Corp Root CA" \
  ttl=87600h \
  key_type=ec \
  key_bits=384 \
  > /tmp/root-ca.pem

# Configure CRL and issuing certificate URLs.
vault write pki/config/urls \
  issuing_certificates="https://vault.example.com:8200/v1/pki/ca" \
  crl_distribution_points="https://vault.example.com:8200/v1/pki/crl"

# Enable an intermediate CA path.
vault secrets enable -path=pki_int pki
vault secrets tune -max-lease-ttl=43800h pki_int

# Generate an intermediate CSR.
vault write -format=json pki_int/intermediate/generate/internal \
  common_name="Example Corp Intermediate CA" \
  key_type=ec \
  key_bits=384 \
  | jq -r '.data.csr' > /tmp/int-ca.csr

# Sign the intermediate CA with the root CA.
vault write -format=json pki/root/sign-intermediate \
  csr=@/tmp/int-ca.csr \
  format=pem_bundle \
  ttl=43800h \
  | jq -r '.data.certificate' > /tmp/int-ca-signed.pem

# Import the signed certificate.
vault write pki_int/intermediate/set-signed certificate=@/tmp/int-ca-signed.pem

# Configure URLs for the intermediate CA.
vault write pki_int/config/urls \
  issuing_certificates="https://vault.example.com:8200/v1/pki_int/ca" \
  crl_distribution_points="https://vault.example.com:8200/v1/pki_int/crl"

# Create a role for Kubernetes service certificates.
vault write pki_int/roles/kubernetes-services \
  allowed_domains="svc.cluster.local,example.com" \
  allow_subdomains=true \
  allow_glob_domains=false \
  max_ttl=72h \
  key_type=ec \
  key_bits=256 \
  require_cn=true \
  server_flag=true \
  client_flag=true
```

### Vault Authentication for cert-manager

```bash
# Enable Kubernetes auth method.
vault auth enable kubernetes

# Configure the Kubernetes auth backend.
vault write auth/kubernetes/config \
  kubernetes_host="https://$(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}'):443" \
  kubernetes_ca_cert=@/tmp/kubernetes-ca.pem \
  issuer="https://kubernetes.default.svc.cluster.local"

# Create a policy for cert-manager.
vault policy write cert-manager - <<EOF
path "pki_int/sign/kubernetes-services" {
  capabilities = ["create", "update"]
}

path "pki_int/issue/kubernetes-services" {
  capabilities = ["create", "update"]
}
EOF

# Create a Kubernetes auth role for cert-manager.
vault write auth/kubernetes/role/cert-manager \
  bound_service_account_names=cert-manager \
  bound_service_account_namespaces=cert-manager \
  policies=cert-manager \
  ttl=1h
```

### Vault Issuer

```yaml
# cert-manager/issuers/vault-pki-issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-pki
spec:
  vault:
    server: https://vault.example.com:8200
    path: pki_int/sign/kubernetes-services
    # caBundle contains the Vault server TLS CA certificate (base64-encoded).
    caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...
    auth:
      kubernetes:
        role: cert-manager
        mountPath: /v1/auth/kubernetes
        # cert-manager uses its own service account token.
        serviceAccountRef:
          name: cert-manager
```

### Internal Service Certificate

```yaml
# app/certificates/api-service-cert.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-service-tls
  namespace: production
spec:
  secretName: api-service-tls
  duration: 24h      # Short-lived internal certificates.
  renewBefore: 8h    # Renew 8 hours before expiry.

  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always

  subject:
    organizations:
    - Example Corp

  dnsNames:
  - api-service.production.svc.cluster.local
  - api-service.production.svc
  - api-service

  issuerRef:
    name: vault-pki
    kind: ClusterIssuer
    group: cert-manager.io
```

## Section 3: Self-Signed Cluster CA for Internal Use

For smaller deployments without Vault, cert-manager can manage its own internal CA:

```yaml
# cert-manager/issuers/internal-ca.yaml

# Step 1: Generate a self-signed root certificate.
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
# Step 2: Create the root CA certificate.
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: cluster-root-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: cluster-root-ca
  secretName: cluster-root-ca
  duration: 87600h   # 10 years
  renewBefore: 8760h # 1 year

  privateKey:
    algorithm: ECDSA
    size: 384

  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
    group: cert-manager.io
---
# Step 3: Create a ClusterIssuer that uses the root CA.
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: cluster-ca
spec:
  ca:
    secretName: cluster-root-ca
```

## Section 4: Certificate Approval Policies

In enterprise environments, you may require human or automated approval before cert-manager issues a certificate. The `CertificateSigningRequest` approval workflow integrates with Kubernetes RBAC.

### Policy Enforcement with approver-policy

```bash
# Install the cert-manager approver-policy webhook.
helm install cert-manager-approver-policy \
  jetstack/cert-manager-approver-policy \
  --namespace cert-manager \
  --wait
```

```yaml
# cert-manager/policies/production-cert-policy.yaml
apiVersion: policy.cert-manager.io/v1alpha1
kind: CertificateRequestPolicy
metadata:
  name: production-tls-policy
spec:
  # Apply this policy to all ClusterIssuers named vault-pki.
  issuerRef:
    name: vault-pki
    kind: ClusterIssuer
    group: cert-manager.io

  allowed:
    # Only allow certificates with these DNS patterns.
    dnsNames:
      values:
      - "*.production.svc.cluster.local"
      - "*.example.com"
      required: false
      # Reject certificates for internal domains from external issuers.

    # Only allow ECDSA keys.
    privateKey:
      algorithm:
        values: ["ECDSA"]
      size:
        min: 256
        max: 384

    # Maximum validity period is 72 hours.
    duration:
      value: 72h

    # Require organization to be set.
    subject:
      organizations:
        required: true
        values: ["Example Corp"]

  # Specify which namespaces this policy applies to.
  namespaceSelector:
    matchLabels:
      environment: production
---
# Grant the policy to specific service accounts.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cert-manager-requestor-production
rules:
- apiGroups: ["policy.cert-manager.io"]
  resources: ["certificaterequestpolicies"]
  verbs: ["use"]
  resourceNames: ["production-tls-policy"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cert-manager-requestor-production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cert-manager-requestor-production
subjects:
- kind: ServiceAccount
  name: cert-manager
  namespace: cert-manager
```

## Section 5: Ingress TLS Automation

Cert-manager integrates with Ingress resources through annotations. The controller watches for the annotation and automatically creates a Certificate resource:

```yaml
# app/ingress/api-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: production
  annotations:
    # Tell cert-manager which issuer to use.
    cert-manager.io/cluster-issuer: letsencrypt-prod-route53
    # Optional: override certificate duration.
    cert-manager.io/duration: "2160h"
    cert-manager.io/renew-before: "360h"
    # Optional: use ECDSA keys.
    cert-manager.io/private-key-algorithm: ECDSA
    cert-manager.io/private-key-size: "384"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - api.example.com
    secretName: api-example-com-tls  # cert-manager creates this Secret.
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
```

## Section 6: Gateway API Integration

With the newer Gateway API, cert-manager uses a different annotation approach:

```yaml
# app/gateway/http-route.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod-route53
spec:
  gatewayClassName: nginx
  listeners:
  - name: https
    port: 443
    protocol: HTTPS
    hostname: "*.example.com"
    tls:
      mode: Terminate
      certificateRefs:
      - name: wildcard-example-com-tls
        kind: Secret
```

## Section 7: Multi-Issuer Architecture

Production clusters commonly need multiple issuers for different use cases:

```yaml
# cert-manager/issuers/issuer-registry.yaml

# Staging Let's Encrypt for testing.
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-staging-account-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          role: arn:aws:iam::123456789012:role/cert-manager-route53
---
# Production Let's Encrypt.
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          role: arn:aws:iam::123456789012:role/cert-manager-route53
      selector:
        dnsZones:
        - example.com
    - http01:
        ingress:
          class: nginx
      selector:
        matchLabels:
          use-http01: "true"
---
# Vault for internal services.
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-internal
spec:
  vault:
    server: https://vault.example.com:8200
    path: pki_int/sign/kubernetes-services
    caBundle: LS0tLS1CRUdJTi...
    auth:
      kubernetes:
        role: cert-manager
        mountPath: /v1/auth/kubernetes
        serviceAccountRef:
          name: cert-manager
```

## Section 8: Certificate Rotation and Secret Sync

When a certificate rotates, applications need to reload it. There are two strategies:

**Option 1: Restart pod via annotation watch** — Use the `reloader` sidecar pattern to restart pods when the TLS secret changes.

```yaml
# Deploy stakater/Reloader alongside your application.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  annotations:
    # Reloader watches this secret and restarts the deployment on change.
    secret.reloader.stakater.com/reload: "api-service-tls"
spec:
  template:
    spec:
      containers:
      - name: api
        volumeMounts:
        - name: tls
          mountPath: /etc/tls
          readOnly: true
      volumes:
      - name: tls
        secret:
          secretName: api-service-tls
```

**Option 2: Dynamic reload** — Mount the certificate as a file and use `inotify` or polling to reload without a restart. This is the preferred approach for high-availability services.

```go
// pkg/tlsconfig/watcher.go
package tlsconfig

import (
	"crypto/tls"
	"sync"
	"time"
)

// DynamicTLSConfig holds a TLS certificate that can be refreshed without
// restarting the server.
type DynamicTLSConfig struct {
	mu       sync.RWMutex
	cert     *tls.Certificate
	certFile string
	keyFile  string
}

func New(certFile, keyFile string) (*DynamicTLSConfig, error) {
	d := &DynamicTLSConfig{certFile: certFile, keyFile: keyFile}
	if err := d.reload(); err != nil {
		return nil, err
	}
	go d.watchLoop()
	return d, nil
}

func (d *DynamicTLSConfig) reload() error {
	cert, err := tls.LoadX509KeyPair(d.certFile, d.keyFile)
	if err != nil {
		return err
	}
	d.mu.Lock()
	d.cert = &cert
	d.mu.Unlock()
	return nil
}

func (d *DynamicTLSConfig) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.cert, nil
}

func (d *DynamicTLSConfig) GetClientCertificate(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.cert, nil
}

func (d *DynamicTLSConfig) watchLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		_ = d.reload()
	}
}

// TLSConfig returns a *tls.Config that uses the dynamic certificate.
func (d *DynamicTLSConfig) TLSConfig() *tls.Config {
	return &tls.Config{
		GetCertificate: d.GetCertificate,
		MinVersion:     tls.VersionTLS13,
	}
}
```

## Section 9: Monitoring and Alerting

Cert-manager exposes Prometheus metrics that enable alerting on certificate expiry and issuance failures.

```yaml
# monitoring/cert-manager-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cert-manager-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: cert-manager
    rules:

    # Alert when a certificate is about to expire.
    - alert: CertificateExpiringSoon
      expr: |
        certmanager_certificate_expiration_timestamp_seconds
        - time() < 7 * 24 * 3600
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Certificate expiring within 7 days"
        description: >
          Certificate {{ $labels.name }} in namespace
          {{ $labels.namespace }} expires in
          {{ $value | humanizeDuration }}.

    # Alert when a certificate expires in less than 24 hours.
    - alert: CertificateExpiringCritical
      expr: |
        certmanager_certificate_expiration_timestamp_seconds
        - time() < 24 * 3600
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Certificate expiring within 24 hours"
        description: >
          Certificate {{ $labels.name }} in namespace
          {{ $labels.namespace }} expires in
          {{ $value | humanizeDuration }}. Immediate action required.

    # Alert when cert-manager cannot issue or renew a certificate.
    - alert: CertificateNotReady
      expr: |
        certmanager_certificate_ready_status{condition="False"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Certificate not ready"
        description: >
          Certificate {{ $labels.name }} in namespace
          {{ $labels.namespace }} has condition
          {{ $labels.condition }}.

    # Alert when ACME orders are failing.
    - alert: CertManagerACMEOrdersFailing
      expr: |
        increase(certmanager_http_acme_client_request_count{status=~"4..|5.."}[5m]) > 5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "ACME orders failing"
        description: >
          cert-manager is experiencing {{ $value }} ACME request failures
          in the last 5 minutes.

    # Alert when sync errors are elevated.
    - alert: CertManagerSyncErrors
      expr: |
        increase(certmanager_controller_sync_error_count[5m]) > 10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "cert-manager sync errors elevated"
        description: >
          cert-manager controller has {{ $value }} sync errors in the
          last 5 minutes.
```

### Grafana Dashboard Query Examples

```promql
# Certificate expiration timeline
certmanager_certificate_expiration_timestamp_seconds - time()

# Certificates by ready state
certmanager_certificate_ready_status

# ACME request rate
rate(certmanager_http_acme_client_request_count[5m])

# Certificate renewal lag (time since last renewal)
time() - certmanager_certificate_renewal_timestamp_seconds
```

## Section 10: Troubleshooting

### Diagnosing Failed Certificates

```bash
# Check the certificate status.
kubectl describe certificate my-certificate -n my-namespace

# Check the CertificateRequest (created by cert-manager when issuing).
kubectl get certificaterequest -n my-namespace
kubectl describe certificaterequest my-certificate-xxxxx -n my-namespace

# Check the ACME Order resource.
kubectl get order -n my-namespace
kubectl describe order my-certificate-xxxxx -n my-namespace

# Check the ACME Challenge resource.
kubectl get challenge -n my-namespace
kubectl describe challenge my-certificate-xxxxx-1234567890 -n my-namespace

# Check cert-manager controller logs.
kubectl -n cert-manager logs deploy/cert-manager -f | grep -i error
```

### Common DNS-01 Failures

**TXT record not found:**
```bash
# Manually verify the DNS challenge record.
dig +short TXT _acme-challenge.example.com

# Check if the Route53/Cloudflare credentials are valid.
kubectl -n cert-manager get secret -l app.kubernetes.io/name=cert-manager

# Force a retry by deleting the challenge.
kubectl delete challenge -n my-namespace --all
```

**Vault integration failures:**
```bash
# Test the Vault token path from within the cluster.
kubectl -n cert-manager exec deploy/cert-manager -- \
  curl -sk \
  --header "X-Vault-Token: $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
  https://vault.example.com:8200/v1/auth/kubernetes/login \
  -d '{"jwt": "'"$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"'", "role": "cert-manager"}'

# Check Vault audit logs for cert-manager requests.
vault audit list
```

### Certificate Stuck in Pending

```bash
# Look at all cert-manager events.
kubectl get events -n cert-manager --sort-by='.lastTimestamp'

# Check the order state machine.
kubectl -n my-namespace get order -o yaml

# Force reprocessing by adding an annotation.
kubectl -n my-namespace annotate certificate my-cert \
  cert-manager.io/issue-temporary-certificate="true"
```

## Section 11: Best Practices

**Certificate Lifetimes**
- Public certificates (Let's Encrypt): 90-day validity, renew at 75 days
- Internal service certificates: 24-72 hours, renew at 50% of lifetime
- Root/intermediate CAs: 10 years / 5 years respectively

**Key Algorithms**
- Prefer ECDSA P-256 or P-384 for new certificates; faster than RSA and equally secure
- Use RSA-2048 only when required by legacy clients
- Always set `rotationPolicy: Always` to generate new keys on each renewal

**Secrets Management**
- Never commit TLS secrets to version control
- Use External Secrets Operator to sync Vault-issued certificates to Kubernetes Secrets
- Restrict Secret access with RBAC: only the pods that need the certificate should have read access

**Multi-Cluster**
- Use ClusterIssuers to share issuers across namespaces
- For multi-cluster deployments, replicate the CA trust bundle to all clusters
- Consider a dedicated certificate namespace to centralize management

```bash
# Verify a certificate chain completely.
kubectl get secret my-cert-tls -o jsonpath='{.data.tls\.crt}' \
  | base64 -d \
  | openssl verify -CAfile /tmp/root-ca.pem

# Check days remaining.
kubectl get secret my-cert-tls -o jsonpath='{.data.tls\.crt}' \
  | base64 -d \
  | openssl x509 -noout -enddate

# Show the full chain.
kubectl get secret my-cert-tls -o jsonpath='{.data.tls\.crt}' \
  | base64 -d \
  | openssl crl2pkcs7 -nocrl \
  | openssl pkcs7 -print_certs -noout
```

## Conclusion

cert-manager's true power emerges when you combine multiple issuers with approval policies and comprehensive monitoring. DNS-01 ACME challenges solve the wildcard certificate problem without exposing port 80. Vault PKI provides a production-grade internal CA with fine-grained policy control. Certificate approval policies prevent unauthorized certificate issuance. Together, these features give you a complete PKI for a Kubernetes-based infrastructure that can scale from a handful of services to thousands of certificates managed automatically.

The operational investment in proper cert-manager configuration pays dividends immediately: certificate-related outages become a thing of the past, and developers can provision TLS for new services without filing tickets with the security team.
