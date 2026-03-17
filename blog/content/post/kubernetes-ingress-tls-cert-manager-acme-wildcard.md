---
title: "Kubernetes Ingress TLS: cert-manager, ACME, and Wildcard Certificate Automation"
date: 2029-03-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "TLS", "cert-manager", "ACME", "Let's Encrypt", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to automating TLS certificate management in Kubernetes with cert-manager, covering ACME HTTP-01 and DNS-01 challenges, wildcard certificates, certificate rotation, and multi-cluster CA hierarchies."
more_link: "yes"
url: "/kubernetes-ingress-tls-cert-manager-acme-wildcard/"
---

TLS certificate management in Kubernetes clusters is one of the highest-friction operational areas when handled manually, and one of the most seamless when automated correctly. cert-manager extends the Kubernetes API with Certificate, Issuer, and ClusterIssuer resources, integrating with ACME providers (Let's Encrypt, ZeroSSL), internal CAs, and cloud provider certificate services. This guide covers the full operational picture: deploying cert-manager with production-grade settings, configuring ACME issuers for both HTTP-01 and DNS-01 challenges, automating wildcard certificates, and managing certificate rotation across multi-cluster environments.

<!--more-->

## cert-manager Architecture

cert-manager runs three controllers in the `cert-manager` namespace:

- **cert-manager controller**: Reconciles Certificate, CertificateRequest, Issuer, and ClusterIssuer resources
- **cert-manager-webhook**: Validates and mutates cert-manager API objects
- **cert-manager-cainjector**: Injects CA bundles into webhook configurations and CRD conversion webhooks

The certificate issuance flow:

```
Certificate resource created
    → cert-manager creates CertificateRequest
    → CertificateRequest triggers the appropriate Issuer
    → Issuer performs the challenge (ACME, Vault, CA signing)
    → Private key and signed certificate stored in Kubernetes Secret
    → Ingress or application mounts the Secret
    → cert-manager schedules renewal at 2/3 of certificate lifetime
```

## Installation

### Helm Installation with Production Settings

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.16.2 \
  --set crds.enabled=true \
  --set global.leaderElection.namespace=cert-manager \
  --set prometheus.enabled=true \
  --set prometheus.servicemonitor.enabled=true \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=128Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=512Mi \
  --set webhook.resources.requests.cpu=50m \
  --set webhook.resources.requests.memory=64Mi \
  --set cainjector.resources.requests.cpu=50m \
  --set cainjector.resources.requests.memory=128Mi
```

Verify installation:

```bash
kubectl -n cert-manager rollout status deployment cert-manager
kubectl -n cert-manager rollout status deployment cert-manager-webhook
kubectl -n cert-manager rollout status deployment cert-manager-cainjector

# Check all CRDs are installed
kubectl get crds | grep cert-manager.io
```

## ClusterIssuers: ACME with HTTP-01

### Let's Encrypt Staging (for testing)

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: platform-team@example.com
    privateKeySecretRef:
      name: letsencrypt-staging-account-key
    solvers:
    - http01:
        ingress:
          class: nginx
          podTemplate:
            spec:
              tolerations:
              - key: node-role.kubernetes.io/edge
                operator: Exists
              nodeSelector:
                kubernetes.io/os: linux
```

### Let's Encrypt Production with HTTP-01

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-team@example.com
    privateKeySecretRef:
      name: letsencrypt-production-account-key
    solvers:
    # HTTP-01 solver for most domains
    - http01:
        ingress:
          class: nginx
    # DNS-01 solver for wildcard certificates (Route53 in this example)
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1ABC2DEF3GHI4
          role: arn:aws:iam::123456789012:role/cert-manager-route53
      selector:
        dnsZones:
        - "example.com"
        - "*.example.com"
```

## DNS-01 Challenge with Cloud Providers

DNS-01 is required for wildcard certificates. The solver creates a TXT record in the DNS zone to prove domain ownership.

### Route53 DNS-01 with IRSA

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-team@example.com
    privateKeySecretRef:
      name: letsencrypt-dns-production-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1ABC2DEF3GHI4
          # Use IRSA (IAM Roles for Service Accounts) — no static credentials
          # The cert-manager ServiceAccount must have the IRSA annotation
      selector:
        dnsZones:
        - "example.com"
```

IRSA annotation on the cert-manager ServiceAccount:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cert-manager
  namespace: cert-manager
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/cert-manager-route53
```

IAM policy for the cert-manager role:

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
      "Resource": "arn:aws:route53:::hostedzone/Z1ABC2DEF3GHI4"
    },
    {
      "Effect": "Allow",
      "Action": "route53:ListHostedZonesByName",
      "Resource": "*"
    }
  ]
}
```

### Cloudflare DNS-01

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: "cf_token_example_abcdefghijklmnop1234"
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-cloudflare
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-team@example.com
    privateKeySecretRef:
      name: letsencrypt-cloudflare-key
    solvers:
    - dns01:
        cloudflare:
          email: platform-team@example.com
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
```

## Wildcard Certificate Automation

### Wildcard Certificate Resource

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: cert-manager
spec:
  secretName: wildcard-example-com-tls
  issuerRef:
    name: letsencrypt-dns-production
    kind: ClusterIssuer
  dnsNames:
  - "example.com"
  - "*.example.com"
  duration: 2160h      # 90 days (Let's Encrypt maximum)
  renewBefore: 720h    # Renew 30 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 384
    rotationPolicy: Always  # Generate new private key on each renewal
  subject:
    organizations:
    - Example Inc
  usages:
  - digital signature
  - key encipherment
  - server auth
```

### Sharing Wildcard Certificates Across Namespaces

cert-manager stores certificates as Secrets, which are namespace-scoped. To use a wildcard certificate in multiple namespaces, either use a Kubernetes operator like `reflector` or configure the Certificate per namespace with a shared ClusterIssuer.

Using `reflector` for cross-namespace secret replication:

```yaml
# Install reflector
helm install reflector emberstack/reflector \
  --namespace kube-system

# Annotate the source secret for replication
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
      reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "production,staging,dev"
      reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
      reflector.v1.k8s.emberstack.com/reflection-auto-namespaces: "production,staging,dev"
  issuerRef:
    name: letsencrypt-dns-production
    kind: ClusterIssuer
  dnsNames:
  - "example.com"
  - "*.example.com"
  duration: 2160h
  renewBefore: 720h
```

## Ingress TLS Annotation Patterns

### Automatic Certificate Provisioning via Ingress Annotation

cert-manager watches Ingress resources with the `cert-manager.io/cluster-issuer` annotation and automatically creates Certificate resources:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: payment-api
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-production"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "16m"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - api.example.com
    secretName: payment-api-tls  # cert-manager creates this secret
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: payment-api
            port:
              number: 80
```

### Using a Pre-Created Wildcard Certificate in Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: dashboard
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - dashboard.example.com
    # Reference the wildcard cert secret (replicated by reflector)
    secretName: wildcard-example-com-tls
  rules:
  - host: dashboard.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: kubernetes-dashboard
            port:
              number: 443
```

## Internal CA with SelfSigned Root

For internal services that do not need public ACME certificates:

```yaml
# Step 1: Self-signed ClusterIssuer to bootstrap the CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
# Step 2: Root CA Certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-root-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: "Example Internal Root CA"
  secretName: internal-root-ca-secret
  duration: 87600h    # 10 years
  renewBefore: 8760h  # Renew 1 year before expiry
  privateKey:
    algorithm: ECDSA
    size: 384
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
  subject:
    organizations:
    - Example Inc
    organizationalUnits:
    - Platform Engineering
---
# Step 3: ClusterIssuer backed by the internal CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: internal-root-ca-secret
---
# Step 4: Issue certificates from the internal CA
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-service-cert
  namespace: production
spec:
  secretName: internal-service-tls
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
  dnsNames:
  - "payment-api.production.svc.cluster.local"
  - "payment-api.production.svc"
  - "payment-api"
  duration: 8760h    # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always
```

## Monitoring Certificate Expiry

### Prometheus Alerts

```yaml
groups:
- name: cert-manager
  rules:
  - alert: CertificateExpirySoon
    expr: |
      certmanager_certificate_expiration_timestamp_seconds
      - time() < 7 * 24 * 3600
    for: 1h
    labels:
      severity: warning
    annotations:
      summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in less than 7 days"
      description: "Certificate {{ $labels.namespace }}/{{ $labels.name }} expires at {{ $value | humanizeTimestamp }}. Check cert-manager for renewal errors."

  - alert: CertificateExpiryCritical
    expr: |
      certmanager_certificate_expiration_timestamp_seconds
      - time() < 24 * 3600
    for: 15m
    labels:
      severity: critical
    annotations:
      summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in less than 24 hours"
      description: "CRITICAL: Certificate {{ $labels.namespace }}/{{ $labels.name }} expires soon. Immediate action required."

  - alert: CertificateNotReady
    expr: |
      certmanager_certificate_ready_status{condition="False"} == 1
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} is not ready"
      description: "Certificate {{ $labels.namespace }}/{{ $labels.name }} has been in a non-ready state for 10 minutes. Check the CertificateRequest and Order resources for ACME challenge failures."

  - alert: CertManagerAbsent
    expr: absent(up{job="cert-manager"})
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "cert-manager is down"
      description: "cert-manager is not available. Certificate renewal will fail."
```

### Grafana Dashboard Query

```bash
# Check expiry of all certificates across the cluster
kubectl get certificates --all-namespaces -o json | \
  jq -r '.items[] |
    "\(.metadata.namespace)/\(.metadata.name): expires \(.status.notAfter // "unknown") | ready: \(.status.conditions[]? | select(.type=="Ready") | .status)"' | \
  sort
```

## Troubleshooting Certificate Issuance

### Inspect the Issuance Chain

```bash
# Check Certificate status
kubectl describe certificate payment-api-tls -n production

# Check CertificateRequest (created by cert-manager from the Certificate)
kubectl get certificaterequests -n production
kubectl describe certificaterequest payment-api-tls-xxxxx -n production

# Check the ACME Order resource
kubectl get orders -n production
kubectl describe order payment-api-tls-xxxxx -n production

# Check ACME Challenge resources (DNS-01 or HTTP-01)
kubectl get challenges -n production
kubectl describe challenge payment-api-tls-xxxxx-challenge-0 -n production
```

### Common Failure Scenarios

**HTTP-01 challenge fails: solver pod not reachable**

```bash
# Check if the challenge solver pod is running
kubectl get pods -n production -l acme.cert-manager.io/http01-solver=true

# Verify the Ingress for the challenge path was created
kubectl get ingress -n production | grep cm-acme-http-solver

# Test the challenge URL (replace with actual values)
curl -v http://api.example.com/.well-known/acme-challenge/<token>
```

**DNS-01 challenge fails: TXT record not propagating**

```bash
# Check if the TXT record was created
dig _acme-challenge.api.example.com TXT +short

# cert-manager respects DNS propagation delays via RecursiveNameservers
# Force a specific DNS resolver to check propagation
dig @8.8.8.8 _acme-challenge.api.example.com TXT +short

# Review cert-manager logs for ACME responses
kubectl logs -n cert-manager -l app=cert-manager --since=30m | \
  grep -E "acme|challenge|dns01|error"
```

**Certificate stuck in Issuing state**

```bash
# Force cert-manager to re-evaluate the Certificate
kubectl annotate certificate payment-api-tls -n production \
  cert-manager.io/issue-temporary-certificate=""

# Or delete the current CertificateRequest to trigger re-issuance
kubectl delete certificaterequest -n production \
  $(kubectl get certificaterequest -n production -o name | grep payment-api-tls)
```

### Rate Limit Awareness

Let's Encrypt rate limits that affect production operations:

| Limit | Value |
|-------|-------|
| Certificates per registered domain per week | 50 |
| Duplicate certificates per week | 5 |
| Failed validations per account per domain per hour | 5 |
| New orders per account per 3 hours | 300 |

Always test with the staging environment before switching to production issuers. The staging environment has much higher rate limits and provides the same ACME validation flow.

## Certificate Rotation Without Downtime

cert-manager's `renewBefore` field triggers renewal 30 days before expiry by default. The rotation process is:

1. cert-manager creates a new private key and CertificateRequest
2. The ACME challenge completes and the new certificate is obtained
3. The Kubernetes Secret is updated with the new key and certificate
4. Ingress controllers and applications reload on Secret update

For zero-downtime rotation, configure Nginx Ingress or Istio to watch for Secret updates and reload without dropping connections:

```yaml
# Nginx Ingress: configure watch interval
controller:
  config:
    ssl-session-timeout: "10m"
    # Nginx hot-reloads when TLS secrets change
    dynamic-ssl-reload-enabled: "true"
```

Applications consuming TLS certificates directly should use a `Secret` volume mount (not env var) and implement hot-reload watching the certificate files, or use a sidecar that handles reload signaling.
