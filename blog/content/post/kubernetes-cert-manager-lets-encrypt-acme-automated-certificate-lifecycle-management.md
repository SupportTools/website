---
title: "Kubernetes cert-manager with Let's Encrypt and ACME: Automated Certificate Lifecycle Management at Scale"
date: 2031-06-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cert-manager", "TLS", "Let's Encrypt", "ACME", "Certificates", "Security"]
categories:
- Kubernetes
- Security
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to cert-manager on Kubernetes: ClusterIssuer configuration for Let's Encrypt HTTP-01 and DNS-01 challenges, wildcard certificates, multi-issuer strategies, certificate monitoring, and production failure scenarios."
more_link: "yes"
url: "/kubernetes-cert-manager-lets-encrypt-acme-automated-certificate-lifecycle-management/"
---

Managing TLS certificates manually at scale is a maintenance anti-pattern. Missed renewals cause outages; inconsistent key sizes create security gaps; manual processes break in the middle of the night. cert-manager eliminates this operational burden by automating the complete certificate lifecycle — issuance, storage in Kubernetes secrets, and renewal — using standard ACME protocols against Let's Encrypt, ZeroSSL, or any RFC 8555-compliant CA.

This guide covers every aspect of a production cert-manager deployment: installation, ClusterIssuer configuration for both HTTP-01 and DNS-01 challenges, wildcard certificate strategies, multiple issuer patterns for different environments, certificate monitoring, and the operational procedures needed to respond to issuance failures before they impact production.

<!--more-->

# Kubernetes cert-manager with Let's Encrypt and ACME: Automated Certificate Lifecycle Management at Scale

## Architecture

cert-manager watches Certificate and Ingress resources and drives them to the desired state through a reconciliation loop:

```
┌──────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                     │
│                                                           │
│  ┌─────────────┐    ┌──────────────────────────────────┐ │
│  │  Ingress /  │    │       cert-manager Controller    │ │
│  │  Gateway    │───▶│  ┌─────────────────────────────┐ │ │
│  └─────────────┘    │  │  Certificate Controller      │ │ │
│                     │  │  CertificateRequest Ctrl     │ │ │
│  ┌─────────────┐    │  │  Order Controller            │ │ │
│  │  Certificate│    │  │  Challenge Controller        │ │ │
│  │  Resource   │───▶│  └─────────────────────────────┘ │ │
│  └─────────────┘    └──────────────┬──────────────────┘ │
│                                    │                     │
│  ┌─────────────┐                   │                     │
│  │  TLS Secret │◀──────────────────┘                     │
│  │(auto-renewed)│                                        │
│  └─────────────┘                                         │
└──────────────────────────────┬───────────────────────────┘
                               │ ACME HTTP-01 or DNS-01
                               ▼
                    ┌─────────────────────┐
                    │  Let's Encrypt ACME  │
                    │  (or other CA)       │
                    └─────────────────────┘
```

## Installation

```bash
# Install with Helm (recommended)
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.16.3 \
  --set crds.enabled=true \
  --set global.leaderElection.namespace=cert-manager \
  --set replicaCount=2 \
  --set webhook.replicaCount=2 \
  --set cainjector.replicaCount=2 \
  --set prometheus.enabled=true \
  --set prometheus.servicemonitor.enabled=true

# Verify all components are running
kubectl get pods -n cert-manager
kubectl get crds | grep cert-manager
```

## Issuer Configuration

### Let's Encrypt Staging (for testing)

Always test with the staging environment first. Staging has much higher rate limits and uses a separate root CA:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: platform-ops@your-company.com
    privateKeySecretRef:
      name: letsencrypt-staging-account-key
    solvers:
      - http01:
          ingress:
            class: nginx
            serviceType: ClusterIP
            podTemplate:
              metadata:
                labels:
                  app: cert-manager-http-solver
              spec:
                serviceAccountName: cert-manager
                securityContext:
                  runAsNonRoot: true
                  runAsUser: 1000
```

### Let's Encrypt Production (HTTP-01)

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-ops@your-company.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      # Default solver: HTTP-01 via NGINX ingress
      - http01:
          ingress:
            class: nginx
            serviceType: ClusterIP
```

### Let's Encrypt Production (DNS-01) for Wildcard Certificates

HTTP-01 cannot issue wildcard certificates (`*.example.com`). For wildcards, DNS-01 is required. The following example uses Route53:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-dns
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-ops@your-company.com
    privateKeySecretRef:
      name: letsencrypt-prod-dns-account-key
    solvers:
      # DNS-01 for wildcard certs using Route53
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z2FDTNDATAQYW2  # Replace with your zone ID
            # Use IRSA or ambient credentials
            role: arn:aws:iam::123456789012:role/cert-manager-route53
        selector:
          dnsZones:
            - "example.com"

      # HTTP-01 for all other domains (fallback)
      - http01:
          ingress:
            class: nginx
```

### IAM Policy for Route53 DNS-01

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "route53:GetChange"
      ],
      "Resource": "arn:aws:route53:::change/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets"
      ],
      "Resource": "arn:aws:route53:::hostedzone/Z2FDTNDATAQYW2"
    },
    {
      "Effect": "Allow",
      "Action": [
        "route53:ListHostedZonesByName"
      ],
      "Resource": "*"
    }
  ]
}
```

### DNS-01 with Cloudflare

```yaml
# Store Cloudflare API token in a secret
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: <cloudflare-api-token>
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-cloudflare
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-ops@your-company.com
    privateKeySecretRef:
      name: letsencrypt-prod-cloudflare-key
    solvers:
      - dns01:
          cloudflare:
            email: cloudflare@your-company.com
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
        selector:
          dnsZones:
            - "your-company.com"
            - "*.your-company.com"
```

### Self-Signed CA for Internal Services

```yaml
# Create a CA key pair
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
# Issue a CA certificate from the self-signed issuer
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: internal-ca
  secretName: internal-ca-secret
  duration: 87600h  # 10 years
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
---
# CA-backed issuer for all internal services
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: internal-ca-secret
```

## Certificate Resources

### Standard TLS Certificate

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-service-tls
  namespace: production
spec:
  secretName: api-service-tls
  duration: 2160h      # 90 days
  renewBefore: 720h    # Renew 30 days before expiry
  subject:
    organizations:
      - Your Company Inc
  commonName: api.example.com
  dnsNames:
    - api.example.com
    - api-internal.example.com
  privateKey:
    algorithm: RSA
    encoding: PKCS8
    size: 2048
    rotationPolicy: Always  # Rotate private key on each renewal
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
    group: cert-manager.io

  # Store additional fields in the secret
  secretTemplate:
    annotations:
      reflect.cert-manager.io/strip-binary-prefix: "true"
    labels:
      app: api-service
      managed-by: cert-manager
```

### Wildcard Certificate

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: cert-manager  # Store in cert-manager ns, sync to others
spec:
  secretName: wildcard-example-com-tls
  duration: 2160h
  renewBefore: 720h
  dnsNames:
    - "*.example.com"
    - "example.com"   # Include apex domain
  privateKey:
    algorithm: RSA
    size: 2048
    rotationPolicy: Always
  issuerRef:
    name: letsencrypt-prod-dns
    kind: ClusterIssuer
```

### Syncing Wildcard Certificates Across Namespaces

Use `reflector` or `kubernetes-replicator` to sync a wildcard cert to multiple namespaces:

```yaml
# Install reflector
helm repo add emberstack https://emberstack.github.io/helm-charts
helm upgrade --install reflector emberstack/reflector \
  --namespace cert-manager \
  --set replicateSecrets.enabled=true

# Annotate the wildcard secret to sync everywhere
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: cert-manager
spec:
  secretName: wildcard-example-com-tls
  secretTemplate:
    annotations:
      # Reflector: sync to all namespaces matching pattern
      reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
      reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
      reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "production,staging,*-preview"
  dnsNames:
    - "*.example.com"
    - "example.com"
  issuerRef:
    name: letsencrypt-prod-dns
    kind: ClusterIssuer
```

## Ingress Integration

### nginx-ingress Annotation-Based Certificates

cert-manager can automatically create Certificate resources from Ingress annotations:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service
  namespace: production
  annotations:
    # Trigger cert-manager to issue a certificate
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    # Specific ingress class
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-service-tls  # cert-manager creates this secret
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
                  number: 8080
```

### Gateway API Integration

For clusters using the Kubernetes Gateway API:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: production-gateway
  namespace: istio-system
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  gatewayClassName: istio
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      hostname: "*.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - name: wildcard-example-com-tls
            namespace: cert-manager
      allowedRoutes:
        namespaces:
          from: All
```

## Multi-Issuer Strategy

For enterprise clusters with mixed internal/external services:

```yaml
# Three-tier issuer strategy

# 1. Public internet services: Let's Encrypt
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: public-tls
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-ops@example.com
    privateKeySecretRef:
      name: public-tls-account-key
    solvers:
      - http01:
          ingress:
            class: nginx-external

# 2. Internal services: Corporate CA via Vault
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-tls
spec:
  vault:
    server: https://vault.internal.example.com
    path: pki_internal/sign/kubernetes-role
    caBundle: <base64-encoded-vault-ca-certificate>
    auth:
      kubernetes:
        role: cert-manager
        mountPath: /v1/auth/kubernetes
        secretRef:
          name: vault-token
          key: token

# 3. Self-signed for development namespaces
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: dev-selfsigned
spec:
  selfSigned: {}
```

## Monitoring and Alerting

### Prometheus Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cert-manager-alerts
  namespace: cert-manager
  labels:
    release: prometheus-operator
spec:
  groups:
    - name: cert-manager
      interval: 1m
      rules:
        # Certificate expiring within 7 days
        - alert: CertificateExpiringSoon
          expr: |
            certmanager_certificate_expiration_timestamp_seconds - time() < 7 * 24 * 3600
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}"
            runbook: "https://docs.example.com/runbooks/cert-expiry"

        # Certificate expiring within 24 hours — critical
        - alert: CertificateExpiryCritical
          expr: |
            certmanager_certificate_expiration_timestamp_seconds - time() < 24 * 3600
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "CRITICAL: Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}"

        # Certificate not ready
        - alert: CertificateNotReady
          expr: |
            certmanager_certificate_ready_status{condition="True"} == 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} is not ready"

        # cert-manager controller errors
        - alert: CertManagerHighReconcileError
          expr: |
            rate(certmanager_http_acme_client_request_total{status=~"4..|5.."}[5m]) > 0.1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "cert-manager is experiencing high ACME error rate"

        # ACME order failures
        - alert: ACMEOrderFailed
          expr: |
            increase(certmanager_acme_client_request_total{status=~"4..|5.."}[30m]) > 5
          labels:
            severity: warning
          annotations:
            summary: "ACME orders are failing — check certificate events"
```

### Certificate Expiry Dashboard (Grafana)

Key metrics to visualize:

```
# Days until expiry for each certificate
(certmanager_certificate_expiration_timestamp_seconds - time()) / 86400

# Certificate ready status
certmanager_certificate_ready_status

# ACME challenge success rate
rate(certmanager_http_acme_client_request_total{status="200"}[5m]) /
rate(certmanager_http_acme_client_request_total[5m])

# Certificate renewal count over time
increase(certmanager_certificate_renewal_timestamp_seconds[24h])
```

## Operational Procedures

### Debugging Certificate Issuance Failures

```bash
# Check certificate status
kubectl describe certificate api-service-tls -n production

# Check CertificateRequest (created by cert-manager from Certificate)
kubectl get certificaterequests -n production
kubectl describe certificaterequest api-service-tls-xxxxx -n production

# Check ACME Order
kubectl get orders -n production
kubectl describe order api-service-tls-xxxxx-yyyyy -n production

# Check ACME Challenge
kubectl get challenges -n production
kubectl describe challenge api-service-tls-xxxxx-yyyyy-zzzzz -n production

# Common issue: HTTP-01 challenge pod not accessible
kubectl get pods -n production -l acme.cert-manager.io/http01-solver=true

# Check ingress for challenge path
kubectl get ingress -n production | grep cm-acme-http-solver
```

### Force Certificate Renewal

```bash
# Delete the TLS secret to trigger immediate re-issue
# (cert-manager will recreate within seconds)
kubectl delete secret api-service-tls -n production

# Alternative: annotate the certificate to trigger renewal
kubectl annotate certificate api-service-tls \
  -n production \
  cert-manager.io/issuer-name=letsencrypt-prod \
  --overwrite

# Watch renewal progress
kubectl get certificate api-service-tls -n production -w
kubectl events -n production --for=certificate/api-service-tls
```

### Rate Limit Recovery

Let's Encrypt enforces rate limits (50 certs/domain/week for production). If you hit them:

```bash
# Check current rate limit status
# Let's Encrypt does not expose an API for this; use:
# https://crt.sh/?q=example.com to see recent certificate issuance

# Switch to staging issuer temporarily
kubectl patch certificate api-service-tls -n production \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/issuerRef/name", "value": "letsencrypt-staging"}]'

# Once rate limit resets (check https://api.letsencrypt.org/directory for reset times)
kubectl patch certificate api-service-tls -n production \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/issuerRef/name", "value": "letsencrypt-prod"}]'
```

### Bulk Certificate Status Check

```bash
# List all certificates and their expiry
kubectl get certificates -A \
  -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[0].status,EXPIRY:.status.notAfter'

# Find certificates expiring within 30 days
kubectl get certificates -A -o json | \
  jq -r '.items[] |
    select(.status.notAfter != null) |
    select(
      ((.status.notAfter | fromdateiso8601) - now) < (30 * 86400)
    ) |
    "\(.metadata.namespace)/\(.metadata.name): expires \(.status.notAfter)"'

# Check certificates in error state
kubectl get certificates -A \
  -o json | \
  jq -r '.items[] |
    select(.status.conditions[] | select(.type=="Ready" and .status=="False")) |
    "\(.metadata.namespace)/\(.metadata.name): \(.status.conditions[] | select(.type=="Ready") | .message)"'
```

### cert-manager Upgrade Procedure

```bash
# Backup all cert-manager resources before upgrading
kubectl get certificates,clusterissuers,issuers,certificaterequests,orders,challenges \
  -A -o yaml > cert-manager-backup-$(date +%Y%m%d).yaml

# Review cert-manager release notes for breaking changes
# https://cert-manager.io/docs/releases/

# Upgrade Helm release
helm upgrade cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --version v1.17.0 \
  --reuse-values \
  --wait

# Verify all pods restart cleanly
kubectl rollout status deployment cert-manager -n cert-manager
kubectl rollout status deployment cert-manager-webhook -n cert-manager
kubectl rollout status deployment cert-manager-cainjector -n cert-manager

# Validate webhook is functional
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Namespace
metadata:
  name: cert-manager-test
EOF

cat <<EOF | kubectl apply -f - && kubectl delete -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: webhook-test
  namespace: cert-manager-test
spec:
  secretName: webhook-test-tls
  dnsNames:
    - test.example.com
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
EOF

kubectl delete namespace cert-manager-test
```

## Common Production Patterns

### Certificate Rotation Without Downtime

cert-manager rotates certificates before expiry (`renewBefore`). For zero-downtime rotation:

1. Set `renewBefore` to at least 30 days (30 days of overlap)
2. Ensure your ingress controller watches for secret changes (NGINX and Envoy do this automatically)
3. Configure `rotationPolicy: Always` to rotate private keys on each renewal

```yaml
spec:
  duration: 2160h     # 90 days
  renewBefore: 720h   # Start renewal 30 days before expiry
  privateKey:
    rotationPolicy: Always
```

### Namespace-Scoped Issuers for Team Isolation

```yaml
# Each team manages their own namespace issuer
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: team-alpha-issuer
  namespace: team-alpha
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: team-alpha@example.com
    privateKeySecretRef:
      name: team-alpha-acme-key
    solvers:
      - http01:
          ingress:
            class: nginx
        selector:
          dnsNames:
            - "*.alpha.example.com"
```

### Emergency Certificate from Vault for Outages

When ACME is unavailable (DNS outage, CA maintenance), a Vault-backed issuer can issue certificates immediately:

```bash
# Issue emergency cert via Vault PKI directly
vault write pki_internal/issue/kubernetes-role \
  common_name="api.example.com" \
  alt_names="api.example.com,api-internal.example.com" \
  ttl="72h" \
  format="pem_bundle"

# Store in Kubernetes secret
kubectl create secret tls api-service-tls-emergency \
  --cert=certificate.pem \
  --key=private_key.pem \
  -n production

# Update ingress to use emergency certificate
kubectl patch ingress api-service -n production \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/tls/0/secretName", "value": "api-service-tls-emergency"}]'
```

## Summary

cert-manager transforms certificate management from a manual, error-prone process into a declarative, self-healing system. The key operational points are: use staging for validation before production issuance, prefer DNS-01 for wildcard certificates and multi-cluster flexibility, set `renewBefore` generously (30+ days), configure Prometheus alerts at 7-day and 24-hour thresholds, and maintain a documented emergency issuance procedure for when ACME is unavailable. With these practices, certificate-related outages become a historical footnote rather than a recurring operational risk.
