---
title: "Kubernetes Cert-Manager: Advanced Certificate Lifecycle Management"
date: 2029-05-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cert-manager", "TLS", "PKI", "ACME", "Let's Encrypt", "Certificates"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to advanced cert-manager usage covering Issuer vs ClusterIssuer, ACME HTTP-01 and DNS-01 challenges, certificate rotation, cert-manager metrics, and troubleshooting failed certificate issuance."
more_link: "yes"
url: "/kubernetes-cert-manager-advanced-certificate-lifecycle/"
---

Certificate expiry incidents are among the most preventable yet common causes of production outages. The Honeycomb incident, Cloudflare outages, and countless others trace back to TLS certificates that expired without warning. Cert-manager solves this problem for Kubernetes workloads by automating certificate issuance, renewal, and rotation. This guide covers the full spectrum of cert-manager's capabilities — from basic setup to advanced ACME challenge configuration, cross-namespace certificate management, and production monitoring.

<!--more-->

# Kubernetes Cert-Manager: Advanced Certificate Lifecycle Management

## Architecture Overview

Cert-manager extends Kubernetes with several custom resource types that model the certificate lifecycle:

```
ClusterIssuer / Issuer
    │  (defines how to get certs from CA)
    │
    ▼
CertificateRequest
    │  (one-time CSR + signed cert request)
    │
    ▼
Certificate
    │  (desired cert state — triggers CertificateRequests on renewal)
    │
    ▼
Secret (type: kubernetes.io/tls)
    (stores the actual cert, key, and CA)
```

Cert-manager watches `Certificate` objects and ensures the corresponding TLS `Secret` always contains a valid, non-expiring certificate. When renewal time approaches (default: 30 days before expiry), it automatically creates a new `CertificateRequest`.

## Section 1: Installation and Initial Setup

```bash
# Install cert-manager with CRDs
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.15.0/cert-manager.yaml

# Or use Helm (preferred for production)
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.15.0 \
  --set installCRDs=true \
  --set prometheus.enabled=true \
  --set prometheus.servicemonitor.enabled=true \
  --set webhook.timeoutSeconds=30

# Verify installation
kubectl get pods -n cert-manager
# NAME                                       READY   STATUS    RESTARTS
# cert-manager-5c94c76fdc-wxj2q              1/1     Running   0
# cert-manager-cainjector-7bf8b597f-k9xlm    1/1     Running   0
# cert-manager-webhook-5b8d4b5847-vktml      1/1     Running   0
```

## Section 2: Issuers vs ClusterIssuers

The fundamental choice in cert-manager is between namespace-scoped `Issuer` and cluster-scoped `ClusterIssuer`.

### Issuer — Namespace Scoped

An `Issuer` can only sign certificates for `Certificate` resources in the **same namespace**:

```yaml
# issuer-letsencrypt-staging.yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: letsencrypt-staging
  namespace: production
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-staging-key
    solvers:
    - http01:
        ingress:
          class: nginx
```

### ClusterIssuer — Cluster Scoped

A `ClusterIssuer` can sign certificates for any namespace:

```yaml
# clusterissuer-letsencrypt-prod.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-production-key
    solvers:
    - dns01:
        cloudflare:
          email: ops@example.com
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
      selector:
        dnsZones:
        - "example.com"
        - "*.example.com"
    - http01:
        ingress:
          class: nginx
      selector:
        dnsNames:
        - "app.example.com"
        - "api.example.com"
```

### When to Use Each

| Scenario | Use |
|----------|-----|
| Multiple teams, each managing their own certs | `Issuer` per namespace |
| Platform team managing all certs centrally | `ClusterIssuer` |
| Different CAs for different environments | `Issuer` per env namespace |
| Wildcard certs shared across namespaces | `ClusterIssuer` + DNS-01 |

## Section 3: ACME Challenge Types

### HTTP-01 Challenge

HTTP-01 works by having cert-manager create a temporary HTTP server (via an Ingress or Service) that responds to ACME validation requests at `/.well-known/acme-challenge/<token>`.

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-tls
  namespace: production
spec:
  secretName: app-tls-secret
  issuerRef:
    name: letsencrypt-production
    kind: ClusterIssuer
  commonName: app.example.com
  dnsNames:
  - app.example.com
  - www.app.example.com
  duration: 2160h    # 90 days
  renewBefore: 720h  # 30 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 256
```

**HTTP-01 solver with specific ingress class:**

```yaml
# In ClusterIssuer spec
solvers:
- http01:
    ingress:
      class: nginx
      # Or for newer ingress controller versions:
      ingressClassName: nginx
      # Custom annotations for the challenge Ingress
      ingressTemplate:
        metadata:
          annotations:
            nginx.ingress.kubernetes.io/ssl-redirect: "false"
            cert-manager.io/http01-edit-in-place: "false"
```

**HTTP-01 limitations:**
- Requires publicly accessible port 80
- Cannot issue wildcard certificates
- Requires load balancer or NodePort for ingress
- Does not work behind strict WAFs

### DNS-01 Challenge

DNS-01 proves domain ownership by creating a `_acme-challenge.<domain>` TXT record. It works for wildcard certificates and environments without public HTTP access.

**Cloudflare DNS-01:**

```yaml
# Step 1: Create API token secret
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: "<CLOUDFLARE_API_TOKEN_VALUE>"
---
# Step 2: ClusterIssuer with DNS-01
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production-dns
spec:
  acme:
    email: ops@example.com
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-production-dns-key
    solvers:
    - dns01:
        cloudflare:
          email: ops@example.com
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
```

**Route53 DNS-01:**

```yaml
# IAM policy needed:
# {
#   "Version": "2012-10-17",
#   "Statement": [{
#     "Effect": "Allow",
#     "Action": ["route53:GetChange", "route53:ChangeResourceRecordSets"],
#     "Resource": ["arn:aws:route53:::hostedzone/ZONE_ID", "arn:aws:route53:::change/*"]
#   }, {
#     "Effect": "Allow",
#     "Action": "route53:ListHostedZonesByName",
#     "Resource": "*"
#   }]
# }

apiVersion: v1
kind: Secret
metadata:
  name: route53-credentials
  namespace: cert-manager
type: Opaque
stringData:
  secret-access-key: "<AWS_SECRET_ACCESS_KEY>"
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production-route53
spec:
  acme:
    email: ops@example.com
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-production-route53-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: ZONE123456
          accessKeyIDSecretRef:
            name: route53-credentials
            key: access-key-id
          secretAccessKeySecretRef:
            name: route53-credentials
            key: secret-access-key
```

**DNS-01 with IRSA (IAM Roles for Service Accounts) on EKS:**

```yaml
# Annotate cert-manager service account for IRSA
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cert-manager
  namespace: cert-manager
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/cert-manager-route53

# In ClusterIssuer — use ambient credentials (no secret needed)
solvers:
- dns01:
    route53:
      region: us-east-1
      hostedZoneID: ZONE123456
```

### Wildcard Certificates with DNS-01

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: cert-manager
spec:
  secretName: wildcard-example-com-tls
  issuerRef:
    name: letsencrypt-production-dns
    kind: ClusterIssuer
  commonName: "*.example.com"
  dnsNames:
  - "*.example.com"
  - "example.com"  # Include apex domain too
  duration: 2160h
  renewBefore: 720h
  privateKey:
    algorithm: RSA
    size: 4096
```

### Copying Wildcard Certs Across Namespaces

```yaml
# Use reflector or kubernetes-reflector to copy secrets across namespaces
# Or use cert-manager's built-in namespace selector on Certificate

# Option 1: Deploy cert-manager-csi-driver for per-pod certs
# Option 2: Use reflector to mirror secrets
# https://github.com/emberstack/kubernetes-reflector

# Annotate the source secret for replication
apiVersion: v1
kind: Secret
metadata:
  name: wildcard-example-com-tls
  namespace: cert-manager
  annotations:
    reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
    reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "production,staging,development"
    reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
    reflector.v1.k8s.emberstack.com/reflection-auto-namespaces: "production,staging,development"
```

## Section 4: Internal PKI with Self-Signed and CA Issuers

For internal services, you can build your own PKI:

### Self-Signed Bootstrap

```yaml
# Step 1: Self-signed issuer to bootstrap the root CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
---
# Step 2: Create root CA certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-root-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: internal-root-ca
  subject:
    organizations:
    - "Example Corp"
  secretName: internal-root-ca-tls
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
---
# Step 3: CA issuer using the root CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca
spec:
  ca:
    secretName: internal-root-ca-tls
```

### Intermediate CA Chain

```yaml
# Create an intermediate CA
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-intermediate-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: internal-intermediate-ca
  subject:
    organizations:
    - "Example Corp"
  secretName: internal-intermediate-ca-tls
  duration: 43800h  # 5 years
  renewBefore: 8760h  # 1 year
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
---
# Issuer that uses the intermediate CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-intermediate
spec:
  ca:
    secretName: internal-intermediate-ca-tls
```

## Section 5: Advanced Certificate Configuration

### Key Algorithm Selection

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ecdsa-cert
  namespace: production
spec:
  secretName: ecdsa-tls
  issuerRef:
    name: internal-intermediate
    kind: ClusterIssuer
  dnsNames:
  - internal-service.production.svc.cluster.local
  - internal-service.production.svc
  privateKey:
    algorithm: ECDSA
    size: 256        # P-256 — best performance + security balance
    # size: 384      # P-384 — higher security, slower
  duration: 8760h    # 1 year for internal certs
  renewBefore: 168h  # 7 days
```

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: rsa-cert
  namespace: production
spec:
  secretName: rsa-tls
  issuerRef:
    name: letsencrypt-production
    kind: ClusterIssuer
  dnsNames:
  - api.example.com
  privateKey:
    algorithm: RSA
    size: 2048       # RSA-2048 — sufficient for ACME certs
    encoding: PKCS1
  usages:
  - digital signature
  - key encipherment
  - server auth
```

### Certificate Subject and SANs

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: service-cert
  namespace: production
spec:
  secretName: service-tls
  issuerRef:
    name: internal-intermediate
    kind: ClusterIssuer
  subject:
    organizations:
    - "Example Corp"
    organizationalUnits:
    - "Engineering"
    countries:
    - "US"
    localities:
    - "San Francisco"
  commonName: my-service.production.svc.cluster.local
  dnsNames:
  - my-service
  - my-service.production
  - my-service.production.svc
  - my-service.production.svc.cluster.local
  ipAddresses:
  - 10.96.0.100   # Service ClusterIP
  uriSANs:
  - spiffe://cluster.local/ns/production/sa/my-service
  duration: 8760h
  renewBefore: 720h
```

## Section 6: Certificate Rotation and Zero-Downtime Renewal

### How Cert-Manager Handles Renewal

Cert-manager starts renewal when `renewBefore` duration is reached before expiry. The process:

1. Creates a new `CertificateRequest`
2. Gets new cert from the issuer
3. Updates the `Secret` with new cert + key
4. The old cert remains valid until its actual expiry

### Ensuring Zero-Downtime with Proper Reload

Applications must watch for secret changes and reload:

```yaml
# For nginx ingress — no action needed, it watches TLS secrets
# For custom applications, use a sidecar or init container

# Option 1: Reloader (Stakater Reloader)
# https://github.com/stakater/Reloader
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  annotations:
    secret.reloader.stakater.com/reload: "my-app-tls"
spec:
  template:
    spec:
      containers:
      - name: my-app
        image: my-app:latest
        volumeMounts:
        - name: tls
          mountPath: /etc/tls
          readOnly: true
      volumes:
      - name: tls
        secret:
          secretName: my-app-tls
```

```yaml
# Option 2: projected volume with CSI driver for auto-rotation
# Using cert-manager CSI driver
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
      - name: my-app
        image: my-app:latest
        volumeMounts:
        - name: tls
          mountPath: /var/run/secrets/tls
          readOnly: true
      volumes:
      - name: tls
        csi:
          driver: csi.cert-manager.io
          readOnly: true
          volumeAttributes:
            csi.cert-manager.io/issuer-name: internal-intermediate
            csi.cert-manager.io/issuer-kind: ClusterIssuer
            csi.cert-manager.io/dns-names: ${POD_NAME}.${POD_NAMESPACE}.svc.cluster.local
            csi.cert-manager.io/duration: 24h
            csi.cert-manager.io/renew-before: 8h
```

### Forced Renewal

```bash
# Trigger immediate renewal by deleting the secret
# cert-manager will recreate it
kubectl delete secret my-app-tls -n production

# Or annotate the Certificate to trigger renewal
kubectl annotate certificate my-app-tls \
  cert-manager.io/trigger-renewal: "true" \
  -n production

# Check if a certificate is due for renewal
kubectl get certificate my-app-tls -n production -o jsonpath='{.status.renewalTime}'

# List all certificates and their expiry
kubectl get certificates -A -o custom-columns=\
"NAMESPACE:.metadata.namespace,\
NAME:.metadata.name,\
READY:.status.conditions[?(@.type=='Ready')].status,\
EXPIRY:.status.notAfter,\
RENEWAL:.status.renewalTime"
```

## Section 7: Cert-Manager Metrics and Monitoring

Cert-manager exposes Prometheus metrics via its `/metrics` endpoint.

### Key Metrics

```promql
# Certificate expiration (seconds until expiry)
certmanager_certificate_expiration_timestamp_seconds{namespace="production"}

# Certificate ready status (1 = ready, 0 = not ready)
certmanager_certificate_ready_status{condition="True"}

# ACMEClient request count and errors
certmanager_http_acme_client_request_count_total
certmanager_http_acme_client_request_duration_seconds

# Controller reconcile counts
controller_runtime_reconcile_total{controller="certificate"}

# Webhook admission review duration
certmanager_webhook_admission_review_duration_seconds
```

### Alerting Rules

```yaml
# prometheus-cert-manager-alerts.yaml
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
    interval: 1m
    rules:
    # Certificate expiring within 14 days
    - alert: CertificateExpiringSoon
      expr: |
        (certmanager_certificate_expiration_timestamp_seconds - time()) < (14 * 24 * 3600)
        and
        certmanager_certificate_ready_status{condition="True"} == 1
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} expiring soon"
        description: "Certificate expires in {{ $value | humanizeDuration }}"

    # Certificate expiring within 7 days
    - alert: CertificateExpiringCritical
      expr: |
        (certmanager_certificate_expiration_timestamp_seconds - time()) < (7 * 24 * 3600)
      for: 1h
      labels:
        severity: critical
      annotations:
        summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} expiring critically soon"
        description: "Certificate expires in {{ $value | humanizeDuration }}"

    # Certificate not ready
    - alert: CertificateNotReady
      expr: |
        certmanager_certificate_ready_status{condition="True"} == 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Certificate {{ $labels.namespace }}/{{ $labels.name }} is not ready"

    # High rate of ACME errors
    - alert: ACMEClientErrors
      expr: |
        rate(certmanager_http_acme_client_request_count_total{status=~"4..|5.."}[5m]) > 0.1
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "High ACME client error rate"
        description: "ACME client error rate is {{ $value }} req/s"

    # Cert-manager controller not running
    - alert: CertManagerDown
      expr: |
        absent(up{job="cert-manager"} == 1)
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "cert-manager is down"
```

### Grafana Dashboard Queries

```promql
# Time until certificate expiry (grouped by namespace)
min by (namespace, name) (
  certmanager_certificate_expiration_timestamp_seconds - time()
)

# Certificates expiring in the next 30 days
count(
  (certmanager_certificate_expiration_timestamp_seconds - time()) < (30 * 24 * 3600)
)

# Certificate ready ratio
sum(certmanager_certificate_ready_status{condition="True"}) /
sum(certmanager_certificate_ready_status)

# ACME request success rate
sum(rate(certmanager_http_acme_client_request_count_total{status="200"}[5m])) /
sum(rate(certmanager_http_acme_client_request_count_total[5m]))
```

## Section 8: Troubleshooting Failed Certificate Issuance

### Diagnostic Commands

```bash
# Check certificate status
kubectl describe certificate my-cert -n production

# Check associated CertificateRequest
kubectl get certificaterequest -n production
kubectl describe certificaterequest my-cert-xxxxx -n production

# Check ACME Order (for ACME issuers)
kubectl get order -n production
kubectl describe order my-cert-xxxxx -n production

# Check ACME Challenge
kubectl get challenge -n production
kubectl describe challenge my-cert-xxxxx -n production

# Check cert-manager controller logs
kubectl logs -n cert-manager deploy/cert-manager -f

# Check cainjector logs (for CA injection issues)
kubectl logs -n cert-manager deploy/cert-manager-cainjector -f

# Check webhook logs
kubectl logs -n cert-manager deploy/cert-manager-webhook -f
```

### Common Failures and Solutions

**1. HTTP-01 Challenge Failing**

```bash
# Check challenge status
kubectl describe challenge -n production

# Status will show:
# Reason: Waiting for HTTP-01 challenge propagation
# or
# Reason: Error getting challengeSolver for challenge

# Common causes:
# a) Port 80 not accessible from internet
# b) Ingress controller not forwarding /.well-known/acme-challenge

# Test HTTP-01 reachability
curl -v http://app.example.com/.well-known/acme-challenge/test-token

# Fix: Ensure ingress allows HTTP (not just HTTPS)
kubectl annotate ingress my-ingress \
  nginx.ingress.kubernetes.io/ssl-redirect: "false" \
  -n production
```

**2. DNS-01 Challenge Failing**

```bash
# Check DNS propagation
dig TXT _acme-challenge.example.com @8.8.8.8

# Check if cert-manager has permissions
kubectl get secret cloudflare-api-token -n cert-manager

# Check RBAC
kubectl auth can-i create secrets --as=system:serviceaccount:cert-manager:cert-manager -n cert-manager

# Test DNS API credentials
kubectl exec -n cert-manager deploy/cert-manager -- \
  curl -X GET "https://api.cloudflare.com/client/v4/zones" \
  -H "Authorization: Bearer $(kubectl get secret cloudflare-api-token -n cert-manager -o jsonpath='{.data.api-token}' | base64 -d)"
```

**3. Rate Limiting**

Let's Encrypt has strict rate limits: 50 certificates per domain per week.

```bash
# Use staging issuer for testing
# https://acme-staging-v02.api.letsencrypt.org/directory

# Check current rate limit status
# Visit: https://crt.sh/?q=example.com

# Symptoms
kubectl describe order -n production | grep "too many certificates"

# Fix: Wait for rate limit to reset or use staging issuer
# Rate limits: https://letsencrypt.org/docs/rate-limits/
```

**4. Certificate Request Stuck in Pending**

```bash
kubectl describe certificaterequest -n production

# Check events
kubectl get events -n production --field-selector reason=CertificateRequestDenied
kubectl get events -n production --field-selector reason=CertificateRequestFailed

# Common fix: check that issuer exists and is ready
kubectl get clusterissuer letsencrypt-production
kubectl describe clusterissuer letsencrypt-production
# Look for: Status: True, Type: Ready

# Check for ACME account registration
kubectl get secret letsencrypt-production-key -n cert-manager
```

**5. Webhook Not Ready**

```bash
# Symptom: Error from server (InternalError): error when creating:
# Internal error occurred: failed calling webhook...

# Check webhook pod
kubectl get pods -n cert-manager

# Check webhook certificate
kubectl get certificate -n cert-manager cert-manager-webhook-ca
kubectl get secret -n cert-manager cert-manager-webhook-ca

# Restart webhook if needed
kubectl rollout restart deployment/cert-manager-webhook -n cert-manager
```

### Certificate Status Script

```bash
#!/bin/bash
# cert_status.sh — check status of all certificates in the cluster

echo "=== Certificate Status Report ==="
echo ""

kubectl get certificates -A -o json | jq -r '
.items[] |
[
  .metadata.namespace,
  .metadata.name,
  (.status.conditions[] | select(.type=="Ready") | .status) // "Unknown",
  (.status.notAfter // "N/A"),
  (.status.renewalTime // "N/A")
] | @tsv' | \
column -t -s $'\t' -N "NAMESPACE,NAME,READY,EXPIRY,RENEWAL"

echo ""
echo "=== Certificates Expiring in < 30 Days ==="
kubectl get certificates -A -o json | jq -r '
.items[] |
select(.status.notAfter != null) |
. as $cert |
.status.notAfter |
(now - (. | fromdate)) as $age |
if $age < 0 and (-$age) < (30 * 24 * 3600) then
  [$cert.metadata.namespace, $cert.metadata.name, .] | @tsv
else empty end' | \
column -t -s $'\t' -N "NAMESPACE,NAME,EXPIRY"

echo ""
echo "=== Failed CertificateRequests ==="
kubectl get certificaterequest -A -o json | jq -r '
.items[] |
select(.status.conditions[] | .type == "Ready" and .status == "False") |
[.metadata.namespace, .metadata.name, (.status.conditions[] | select(.type=="Ready") | .message)] |
@tsv' | column -t -s $'\t' -N "NAMESPACE,NAME,REASON"
```

## Section 9: Integration with Ingress

### Automatic Certificate via Ingress Annotation

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
    # Or for namespace-scoped issuer:
    # cert-manager.io/issuer: "letsencrypt-staging"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - app.example.com
    - www.app.example.com
    secretName: app-example-com-tls  # cert-manager creates this
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-app
            port:
              number: 8080
```

### Gateway API Integration

```yaml
# cert-manager supports Gateway API with gateway-shim
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: my-gateway
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
spec:
  gatewayClassName: nginx
  listeners:
  - name: https
    protocol: HTTPS
    port: 443
    hostname: "*.example.com"
    tls:
      mode: Terminate
      certificateRefs:
      - name: wildcard-example-com-tls
        kind: Secret
```

## Section 10: Production Best Practices

```yaml
# Production-grade Certificate resource
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: production-service
  namespace: production
  labels:
    app: my-service
    environment: production
  annotations:
    # Useful for auditability
    cert-manager.io/certificate-owner: "platform-team"
spec:
  secretName: production-service-tls
  secretTemplate:
    labels:
      app: my-service
    annotations:
      # Tell reloader to trigger rollout
      reloader.stakater.com/match: "true"
  issuerRef:
    name: letsencrypt-production-dns
    kind: ClusterIssuer
  commonName: my-service.example.com
  dnsNames:
  - my-service.example.com
  duration: 2160h    # 90 days (Let's Encrypt max)
  renewBefore: 720h  # Renew 30 days before expiry (generous buffer)
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always  # Generate new key on each renewal
  usages:
  - digital signature
  - key encipherment
  - server auth
```

```bash
# Regularly audit certificate status
# Add to your monitoring runbook:

# 1. Count certificates by ready status
kubectl get certificates -A -o json | \
  jq '[.items[] | .status.conditions[] | select(.type=="Ready") | .status] | group_by(.) | map({(.[0]): length}) | add'

# 2. Find any certificates with issues
kubectl get certificates -A | grep -v "True"

# 3. Check ClusterIssuer readiness
kubectl get clusterissuer -o wide

# 4. Verify ACME account registration
kubectl get secret letsencrypt-production-key -n cert-manager -o json | \
  jq '.data["tls.key"]' | base64 -d | openssl pkey -noout -text | head -5
```

## Conclusion

Cert-manager transforms certificate management from a manual, error-prone process into a declarative, automated system. The key decisions are: choosing the right issuer scope (namespace vs cluster), selecting the appropriate ACME challenge type for your infrastructure, and implementing robust monitoring with Prometheus alerts for expiring certificates.

For production deployments, always use DNS-01 challenges when possible — they work behind firewalls, support wildcards, and don't require port 80. Configure renewal 30 days before expiry, enable Prometheus metrics, and set up alerts at both 14-day and 7-day thresholds. The brief time investment in proper cert-manager setup pays enormous dividends in preventing the inevitable 3 AM certificate expiry incident.
