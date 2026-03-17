---
title: "Kubernetes Certificate Management at Scale: cert-manager Cluster Issuers, ACME, and Vault PKI"
date: 2030-01-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cert-manager", "TLS", "PKI", "Vault", "Let's Encrypt", "Security"]
categories: ["Kubernetes", "Security", "PKI"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise cert-manager deployment with ClusterIssuers for Let's Encrypt and Vault PKI, certificate rotation automation, expiry monitoring, multi-cluster certificate distribution, and production operations."
more_link: "yes"
url: "/kubernetes-certificate-management-certmanager-vault-pki/"
---

Certificate management at scale is one of the most operationally demanding aspects of running enterprise Kubernetes. Every service-to-service TLS connection, every ingress HTTPS endpoint, and every internal webhook requires a certificate with a defined validity period, a renewal process, and a distribution mechanism. cert-manager automates this entire lifecycle — from initial ACME challenge completion through rotation and secret distribution — but requires careful configuration to operate correctly at enterprise scale.

This guide covers deploying cert-manager with high availability, configuring ClusterIssuers for both Let's Encrypt and HashiCorp Vault PKI, automating certificate rotation, monitoring expiry with Prometheus alerts, and distributing certificates across multiple clusters.

<!--more-->

## cert-manager Architecture

cert-manager consists of three components:

- **cert-manager Controller**: Processes Certificate, CertificateRequest, and Issuer resources; manages certificate lifecycle
- **cert-manager Webhook**: Validates and mutates cert-manager resources at admission time
- **cert-manager cainjector**: Injects CA bundles into webhook configurations and CRDs

The Certificate resource is the primary abstraction. cert-manager watches for Certificates approaching expiry and automatically creates CertificateRequests, which are handled by the appropriate Issuer.

```
Certificate (desired state)
    └── CertificateRequest (issued on renewal trigger)
            └── Order (for ACME issuers)
                    └── Challenge (HTTP-01 or DNS-01 verification)
```

## Production cert-manager Installation

### Helm Values for HA Deployment

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.14.4 \
  -f cert-manager-values.yaml
```

```yaml
# cert-manager-values.yaml
replicaCount: 3

podDisruptionBudget:
  enabled: true
  minAvailable: 2

topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app.kubernetes.io/name: cert-manager

resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 512Mi

webhook:
  replicaCount: 3
  podDisruptionBudget:
    enabled: true
    minAvailable: 2

cainjector:
  replicaCount: 2

installCRDs: true

# Enable Prometheus metrics
prometheus:
  enabled: true
  servicemonitor:
    enabled: true
    namespace: monitoring
    labels:
      release: prometheus

# Feature gates
featureGates: "AdditionalCertificateOutputFormats=true,ExperimentalCertificateSigningRequestControllers=true"

# Increase rate limits for large clusters
extraArgs:
  - --max-concurrent-challenges=60
  - --dns01-recursive-nameservers=8.8.8.8:53,1.1.1.1:53
  - --dns01-recursive-nameservers-only

# RBAC for leader election
global:
  leaderElection:
    namespace: cert-manager
```

## Let's Encrypt ClusterIssuers

### HTTP-01 ClusterIssuer (Production)

```yaml
# issuer-letsencrypt-production.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certs@yourorg.com
    privateKeySecretRef:
      name: letsencrypt-production-account-key
    solvers:
      - http01:
          ingress:
            class: nginx
            podTemplate:
              metadata:
                annotations:
                  cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
              spec:
                resources:
                  requests:
                    cpu: 10m
                    memory: 32Mi
        selector:
          dnsZones:
            - yourorg.com
            - "*.yourorg.com"
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: certs@yourorg.com
    privateKeySecretRef:
      name: letsencrypt-staging-account-key
    solvers:
      - http01:
          ingress:
            class: nginx
```

### DNS-01 ClusterIssuer for Wildcard Certificates

DNS-01 challenges are required for wildcard certificates and work when HTTP isn't accessible (internal services):

```yaml
# issuer-letsencrypt-dns01.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certs@yourorg.com
    privateKeySecretRef:
      name: letsencrypt-dns01-account-key
    solvers:
      - dns01:
          route53:
            region: us-east-1
            # Uses IAM role via IRSA (recommended over access keys)
            hostedZoneID: Z1234567890ABCDEF
        selector:
          dnsZones:
            - yourorg.com
      - dns01:
          cloudDNS:
            project: yourorg-production
            serviceAccountSecretRef:
              name: clouddns-service-account
              key: key.json
        selector:
          dnsZones:
            - internal.yourorg.com
```

### IRSA for Route53 DNS-01

```yaml
# AWS IRSA: IAM policy for Route53 DNS-01 challenge
# Attach to the cert-manager service account IAM role
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
      "Resource": "arn:aws:route53:::hostedzone/Z1234567890ABCDEF"
    }
  ]
}
```

```yaml
# Annotate cert-manager service account for IRSA
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cert-manager
  namespace: cert-manager
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/cert-manager-route53
```

## HashiCorp Vault PKI Integration

Vault PKI provides an internal CA hierarchy appropriate for internal service-to-service TLS and mTLS without incurring Let's Encrypt rate limits.

### Vault PKI Setup

```bash
# Enable PKI secrets engine
vault secrets enable -path=pki pki
vault secrets tune -max-lease-ttl=87600h pki  # 10 years max

# Generate internal root CA
vault write -field=certificate pki/root/generate/internal \
    common_name="YourOrg Internal CA" \
    ttl=87600h \
    key_bits=4096 \
    exclude_cn_from_sans=true > /tmp/internal-ca.crt

# Configure CRL and OCSP URLs
vault write pki/config/urls \
    issuing_certificates="https://vault.vault-system.svc.cluster.local:8200/v1/pki/ca" \
    crl_distribution_points="https://vault.vault-system.svc.cluster.local:8200/v1/pki/crl"

# Create intermediate CA for Kubernetes
vault secrets enable -path=pki-k8s pki
vault secrets tune -max-lease-ttl=43800h pki-k8s  # 5 years

# Generate intermediate CSR
vault write -format=json pki-k8s/intermediate/generate/internal \
    common_name="YourOrg Kubernetes Intermediate CA" \
    ttl=43800h \
    key_bits=4096 | jq -r '.data.csr' > /tmp/k8s-intermediate.csr

# Sign intermediate with root
vault write -format=json pki/root/sign-intermediate \
    csr=@/tmp/k8s-intermediate.csr \
    format=pem_bundle \
    ttl=43800h | jq -r '.data.certificate' > /tmp/k8s-intermediate.crt

# Import signed intermediate
vault write pki-k8s/intermediate/set-signed \
    certificate=@/tmp/k8s-intermediate.crt

# Create role for cert-manager
vault write pki-k8s/roles/cert-manager \
    allowed_domains="yourorg.com,svc.cluster.local" \
    allow_subdomains=true \
    allow_glob_domains=true \
    max_ttl=720h \
    ttl=168h \
    require_cn=false \
    allow_ip_sans=true \
    allow_any_name=false \
    server_flag=true \
    client_flag=true

# Create policy for cert-manager
vault policy write cert-manager-pki - <<EOF
path "pki-k8s/sign/cert-manager" {
  capabilities = ["create", "update"]
}
path "pki-k8s/issue/cert-manager" {
  capabilities = ["create", "update"]
}
path "pki-k8s/cert/*" {
  capabilities = ["read"]
}
path "pki-k8s/ca" {
  capabilities = ["read"]
}
path "pki-k8s/ca_chain" {
  capabilities = ["read"]
}
EOF

# Enable Kubernetes auth in Vault
vault auth enable kubernetes
vault write auth/kubernetes/config \
    kubernetes_host=https://kubernetes.default.svc.cluster.local \
    kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

# Bind cert-manager service account to PKI policy
vault write auth/kubernetes/role/cert-manager \
    bound_service_account_names=cert-manager \
    bound_service_account_namespaces=cert-manager \
    policies=cert-manager-pki \
    ttl=1h
```

### Vault ClusterIssuer

```yaml
# issuer-vault-pki.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-pki
spec:
  vault:
    server: https://vault.vault-system.svc.cluster.local:8200
    path: pki-k8s/sign/cert-manager
    caBundle: |-
      -----BEGIN CERTIFICATE-----
      # Base64-encoded internal root CA certificate
      MIIDzTCCArWgAwIBAgIQCnXGz...
      -----END CERTIFICATE-----
    auth:
      kubernetes:
        role: cert-manager
        mountPath: /v1/auth/kubernetes
        serviceAccountRef:
          name: cert-manager
```

### Vault AppRole ClusterIssuer (for non-Kubernetes auth)

```yaml
# issuer-vault-approle.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-approle
spec:
  vault:
    server: https://vault.vault-system.svc.cluster.local:8200
    path: pki-k8s/sign/cert-manager
    auth:
      appRole:
        path: approle
        roleId: <VAULT_ROLE_ID>
        secretRef:
          name: vault-approle-secret
          key: secret-id
        # Secret: kubectl create secret generic vault-approle-secret \
        #   --from-literal=secret-id=<VAULT_SECRET_ID> -n cert-manager
```

## Creating Certificates

### Basic Certificate for Ingress

```yaml
# certificate-api-ingress.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls
  namespace: production
spec:
  secretName: api-tls-secret
  issuerRef:
    name: letsencrypt-production
    kind: ClusterIssuer
  dnsNames:
    - api.yourorg.com
    - api-v2.yourorg.com
  # Renew at 2/3 of duration (default)
  duration: 2160h    # 90 days
  renewBefore: 720h  # Renew 30 days before expiry
  # Additional output formats
  additionalOutputFormats:
    - type: DER         # For Java keystores
    - type: CombinedPEM # Full chain PEM
  # Private key options
  privateKey:
    algorithm: ECDSA
    size: 384
    rotationPolicy: Always  # Generate new key on every renewal
  # Subject information
  subject:
    organizations:
      - YourOrg Inc.
  usages:
    - server auth
    - client auth
    - digital signature
    - key encipherment
```

### Wildcard Certificate via DNS-01

```yaml
# certificate-wildcard.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-yourorg
  namespace: cert-manager  # Wildcard certs often live in cert-manager namespace
spec:
  secretName: wildcard-yourorg-tls
  issuerRef:
    name: letsencrypt-dns01
    kind: ClusterIssuer
  dnsNames:
    - "*.yourorg.com"
    - yourorg.com
  duration: 2160h
  renewBefore: 720h
  privateKey:
    algorithm: RSA
    size: 4096
    rotationPolicy: Always
```

### Internal Service Certificate via Vault

```yaml
# certificate-internal-service.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: payment-service-tls
  namespace: production
spec:
  secretName: payment-service-tls
  issuerRef:
    name: vault-pki
    kind: ClusterIssuer
  commonName: payment-service.production.svc.cluster.local
  dnsNames:
    - payment-service
    - payment-service.production
    - payment-service.production.svc
    - payment-service.production.svc.cluster.local
  ipAddresses:
    - 127.0.0.1  # Localhost for health checks
  duration: 720h     # 30 days (short-lived internal certs)
  renewBefore: 240h  # Renew 10 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always
  usages:
    - server auth
    - client auth
```

### Using Certificates in Ingress

```yaml
# ingress-with-cert-manager.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-production
    # OR use existing certificate:
    # cert-manager.io/certificate-name: api-tls
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.yourorg.com
      secretName: api-tls-secret
  rules:
    - host: api.yourorg.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 8080
```

## Certificate Rotation Automation

### Monitoring Rotation Events

```bash
# Watch certificate events
kubectl get events -n production --field-selector reason=Issued
kubectl get events -n production --field-selector reason=Failed

# Watch certificate status
kubectl get certificates -n production -w

# Check certificate details
kubectl describe certificate api-tls -n production
# Status:
#   Conditions:
#     Last Transition Time:  2026-01-01T00:00:00Z
#     Message:               Certificate is up to date and has not expired
#     Observed Generation:   1
#     Reason:                Ready
#     Status:                True
#     Type:                  Ready
#   Not After:               2026-04-01T00:00:00Z
#   Not Before:              2026-01-01T00:00:00Z
#   Renewal Time:            2026-03-01T00:00:00Z
```

### Automatic Restart on Certificate Rotation

Some applications need to reload certificates after rotation. Use Reloader for this:

```bash
# Install Stakater Reloader
helm repo add stakater https://stakater.github.io/stakater-charts
helm install reloader stakater/reloader \
  --namespace kube-system \
  --set reloader.watchGlobally=true \
  --set reloader.logFormat=json
```

```yaml
# Annotate deployments to restart on cert secret change
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
  annotations:
    reloader.stakater.com/auto: "true"    # Restart on ANY mounted secret/configmap change
    # OR specific secret:
    secret.reloader.stakater.com/reload: "api-tls-secret"
spec:
  template:
    spec:
      volumes:
        - name: tls
          secret:
            secretName: api-tls-secret
```

### Manual Certificate Rotation

```bash
# Trigger immediate renewal (before renewBefore threshold)
kubectl annotate certificate api-tls -n production \
  cert-manager.io/renew-before=99999h

# OR use cmctl
cmctl renew api-tls -n production

# Verify renewal
kubectl get certificate api-tls -n production
# READY   SECRET           ISSUER                    STATUS   AGE
# True    api-tls-secret   letsencrypt-production    ...      2d
```

## Monitoring Certificate Expiry

### cert-manager Prometheus Metrics

```yaml
# prometheus-rules-cert-manager.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cert-manager-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: cert-manager
      rules:
        - alert: CertificateExpiringSoon
          expr: |
            certmanager_certificate_expiration_timestamp_seconds - time() < (14 * 24 * 3600)
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}"
            runbook: "https://wiki.yourorg.com/runbooks/cert-manager-expiry"

        - alert: CertificateExpiryCritical
          expr: |
            certmanager_certificate_expiration_timestamp_seconds - time() < (3 * 24 * 3600)
          for: 30m
          labels:
            severity: critical
          annotations:
            summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in {{ $value | humanizeDuration }} — URGENT"

        - alert: CertificateNotReady
          expr: |
            certmanager_certificate_ready_status{condition="False"} == 1
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} is not ready"

        - alert: CertificateRenewalFailed
          expr: |
            increase(certmanager_certificate_renewal_failure_count_total[1h]) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Certificate renewal failed for {{ $labels.name }} in {{ $labels.namespace }}"

        - alert: ACMEChallengeFailure
          expr: |
            increase(certmanager_acme_client_request_count{status!="200"}[5m]) > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ACME challenge failures detected for issuer {{ $labels.issuer }}"
```

### Grafana Dashboard Queries

```promql
# Certificates expiring within 30 days
count(
  certmanager_certificate_expiration_timestamp_seconds - time() < (30 * 24 * 3600)
)

# Certificate validity by namespace
sort_desc(
  (certmanager_certificate_expiration_timestamp_seconds - time()) / 86400
)

# ACME success rate
sum(rate(certmanager_acme_client_request_count{status="200"}[5m])) /
sum(rate(certmanager_acme_client_request_count[5m]))

# Certificate controller processing time
histogram_quantile(0.99,
  rate(certmanager_controller_sync_call_count_bucket[5m])
)
```

## Multi-Cluster Certificate Distribution

For multi-cluster setups, certificates issued in one cluster need to be available in others. Use the External Secrets Operator or Kubernetes Federation:

### External Secrets for Cross-Cluster Certificate Distribution

```yaml
# external-secret-cert-distribution.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: cluster-a-secrets
spec:
  provider:
    kubernetes:
      remoteNamespace: cert-manager
      server:
        url: https://cluster-a-api.internal:6443
        caBundle: <base64-CA>
      auth:
        serviceAccount:
          name: external-secrets-reader
          namespace: external-secrets
---
# Import wildcard cert from cluster-a to cluster-b
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: import-wildcard-cert
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: cluster-a-secrets
  target:
    name: wildcard-yourorg-tls
    template:
      type: kubernetes.io/tls
  data:
    - secretKey: tls.crt
      remoteRef:
        key: wildcard-yourorg-tls
        property: tls.crt
    - secretKey: tls.key
      remoteRef:
        key: wildcard-yourorg-tls
        property: tls.key
```

### ClusterSecret Controller for Distribution

```yaml
# Use the cluster-secret-store pattern with reflector
helm repo add emberstack https://emberstack.github.io/helm-charts
helm install reflector emberstack/reflector \
  --namespace kube-system

# Annotate the source secret to replicate to all namespaces
apiVersion: v1
kind: Secret
metadata:
  name: wildcard-yourorg-tls
  namespace: cert-manager
  annotations:
    # Replicate to all namespaces
    reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
    reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "production,staging,development"
    reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
type: kubernetes.io/tls
```

## Troubleshooting Certificate Issues

### Common Issues and Diagnostics

```bash
# Check certificate status
kubectl describe certificate api-tls -n production

# Check CertificateRequest (created automatically by cert-manager)
kubectl get certificaterequests -n production
kubectl describe certificaterequest api-tls-12345 -n production

# For ACME: check Order and Challenge
kubectl get orders -n production
kubectl describe order api-tls-12345-67890 -n production

kubectl get challenges -n production
kubectl describe challenge api-tls-12345-67890-1 -n production

# Enable debug logging temporarily
kubectl scale deployment cert-manager -n cert-manager --replicas=1
kubectl set env deployment/cert-manager -n cert-manager \
  CERT_MANAGER_LOG_LEVEL=debug

# Check for HTTP-01 challenge endpoint reachability
# The ACME server hits: http://<domain>/.well-known/acme-challenge/<token>
kubectl get pods -n cert-manager -l acme.cert-manager.io/http01-solver=true

# Test DNS propagation for DNS-01
dig +short TXT _acme-challenge.api.yourorg.com
nslookup -type=TXT _acme-challenge.api.yourorg.com 8.8.8.8

# Vault PKI: test token
vault write pki-k8s/issue/cert-manager \
  common_name=test.yourorg.com \
  ttl=1h
```

### Certificate Status Script

```bash
#!/bin/bash
# cert-status.sh - Report all certificate statuses
echo "=== Certificate Status Report ==="
echo "Timestamp: $(date -u)"
echo ""

kubectl get certificates --all-namespaces -o json | \
  jq -r '
    .items[] |
    {
      namespace: .metadata.namespace,
      name: .metadata.name,
      issuer: .spec.issuerRef.name,
      not_after: .status.notAfter,
      ready: (.status.conditions[] | select(.type=="Ready") | .status),
      renew_at: .status.renewalTime
    } |
    [.namespace, .name, .issuer, .not_after, .ready, .renew_at] |
    @tsv
  ' | column -t -s $'\t' | \
  awk 'BEGIN {
    printf "%-20s %-30s %-25s %-25s %-7s %-25s\n", "NAMESPACE", "NAME", "ISSUER", "EXPIRES", "READY", "RENEW AT"
    print "--------------------------------------------------------------------------------------------------------------"
  } NR>0 {print}'

echo ""
echo "=== Certificates Expiring Within 30 Days ==="
kubectl get certificates --all-namespaces -o json | \
  jq -r --argjson now "$(date +%s)" '
    .items[] |
    select(.status.notAfter != null) |
    .status.notAfter as $exp |
    ($exp | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) as $exp_ts |
    select(($exp_ts - $now) < (30 * 86400)) |
    "\(.metadata.namespace)/\(.metadata.name): expires \(.status.notAfter) (\((($exp_ts - $now) / 86400 | floor))d remaining)"
  '
```

## Key Takeaways

Enterprise certificate management with cert-manager requires careful design of the issuer hierarchy, renewal cadences, and operational monitoring:

1. **Use ClusterIssuers not Issuers**: ClusterIssuers are namespace-agnostic, simplifying policy. Namespace-scoped Issuers make sense only when different teams need different PKI backends.

2. **Internal services get Vault PKI, public endpoints get ACME**: Vault PKI provides short-lived (30-day) internal certificates at high volume without rate limits. Let's Encrypt is for internet-facing endpoints only.

3. **DNS-01 enables wildcards and internal services**: HTTP-01 requires inbound internet access. DNS-01 works everywhere including airgapped clusters and enables wildcard certificates.

4. **ECDSA over RSA for new certificates**: P-256 ECDSA certificates are smaller, faster to process, and as secure as 3072-bit RSA. Use `algorithm: ECDSA, size: 256` for all new certificate objects.

5. **Always rotate private keys on renewal**: Set `rotationPolicy: Always`. Reusing private keys means a compromised key remains valid until manual intervention.

6. **Renew early and alert loudly**: The default 2/3 duration renewal trigger (60 days for 90-day certs) is conservative. Alert at 14 days and critical at 3 days to catch renewal failures before expiry.

7. **Reloader handles application restarts**: Applications reading TLS certificates from disk need to restart when certificates rotate. Stakater Reloader automates this by watching Secret changes.

8. **Test certificate rotation monthly**: Automated rotation can silently fail. Run a monthly drill verifying that all critical certificates renew successfully before production load.
