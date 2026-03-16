---
title: "cert-manager Advanced Issuers: ACME, Vault, Venafi, and Custom PKI"
date: 2027-01-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cert-manager", "TLS", "PKI", "Security"]
categories: ["Kubernetes", "Security", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep-dive guide to cert-manager issuers in production: ACME HTTP-01 and DNS-01 challenges, HashiCorp Vault PKI, Venafi TPP, CA chains, CSI driver, trust-manager, and troubleshooting failed issuance."
more_link: "yes"
url: "/cert-manager-advanced-issuers-certificate-automation-guide/"
---

Manual certificate management is an operational liability. Forgotten renewals cause outages, inconsistent key sizes create audit findings, and per-service certificate tracking in spreadsheets does not scale past a dozen workloads. **cert-manager** eliminates this category of failure by automating the full certificate lifecycle — issuance, renewal, and distribution — through declarative Kubernetes resources backed by any number of certificate authorities.

<!--more-->

## cert-manager Architecture

Understanding the three controller components clarifies which failure modes belong to which component.

### Controller

The **cert-manager controller** watches `Certificate`, `Issuer`, `ClusterIssuer`, `CertificateRequest`, and `Order` resources. When a `Certificate` resource is created or its spec changes, the controller:

1. Creates a `CertificateRequest` specifying the desired X.509 attributes
2. Selects the configured issuer and creates an `Order` (for ACME) or routes directly to the issuer
3. Stores the issued certificate and private key in a Kubernetes `Secret`
4. Sets renewal timers based on the certificate's `notAfter` field minus the `renewBefore` duration

### cainjector

The **cainjector** component watches `MutatingWebhookConfiguration`, `ValidatingWebhookConfiguration`, `APIService`, and `CustomResourceDefinition` objects annotated with `cert-manager.io/inject-ca-from`. It automatically populates the `caBundle` field with the CA certificate from the referenced cert-manager `Certificate` secret. This eliminates manual CA bundle injection during webhook deployments.

### webhook

The **cert-manager webhook** validates and defaults cert-manager API objects at admission time. It rejects syntactically invalid `Certificate` objects (e.g., DNS names that are not valid hostnames, key usages that conflict with the issuer's constraints) before they reach the controller, providing fast feedback to operators.

## Installation

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.16.2 \
  --set installCRDs=true \
  --set replicaCount=2 \
  --set webhook.replicaCount=2 \
  --set cainjector.replicaCount=2 \
  --set global.leaderElection.namespace=cert-manager
```

### Resource Requirements for Production

```yaml
# cert-manager-values.yaml
resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 256Mi

webhook:
  resources:
    requests:
      cpu: 20m
      memory: 32Mi
    limits:
      cpu: 200m
      memory: 128Mi

cainjector:
  resources:
    requests:
      cpu: 20m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi

# Ensure webhook survives node disruptions
webhook:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: webhook
              app.kubernetes.io/instance: cert-manager
          topologyKey: kubernetes.io/hostname
```

## ClusterIssuer vs Issuer

**Issuer** is namespace-scoped. A `Certificate` in namespace `payments` referencing an `Issuer` must reference an `Issuer` in the same `payments` namespace. Use `Issuer` when different teams should control their own CA credentials.

**ClusterIssuer** is cluster-scoped. Any `Certificate` in any namespace can reference it. Use `ClusterIssuer` for:
- Centralized ACME accounts (Let's Encrypt) managed by the platform team
- Shared internal CAs where all teams should use the same trust root
- Vault or Venafi integrations maintained by a security team

```yaml
# Namespace-scoped — only usable from namespace 'payments'
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: internal-ca
  namespace: payments
spec:
  ca:
    secretName: payments-internal-ca

---
# Cluster-scoped — usable from any namespace
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
      - http01:
          ingress:
            ingressClassName: nginx
```

## ACME HTTP-01 Challenge

HTTP-01 is the simplest ACME challenge type. ACME places a token at `http://<domain>/.well-known/acme-challenge/<token>` and the CA validates it over the internet. This requires:

- The Kubernetes cluster to be reachable from the internet on port 80
- An Ingress controller to serve the challenge token

### HTTP-01 with nginx-ingress

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-http01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-team@example.com
    privateKeySecretRef:
      name: letsencrypt-http01-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
            # Optional: override service type for the challenge solver pod
            serviceType: ClusterIP
            podTemplate:
              spec:
                tolerations:
                  - key: node-role.kubernetes.io/ingress
                    operator: Exists
                    effect: NoSchedule
```

### Certificate Using HTTP-01

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-example-com
  namespace: production
spec:
  secretName: api-example-com-tls
  issuerRef:
    name: letsencrypt-http01
    kind: ClusterIssuer
  commonName: api.example.com
  dnsNames:
    - api.example.com
  duration: 2160h     # 90 days
  renewBefore: 720h   # Renew 30 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 384
    rotationPolicy: Always   # Generate new private key on each renewal
```

**`rotationPolicy: Always`** is recommended for production. Without it, a compromised private key continues to be used after renewal. With it, a new key pair is generated on every renewal cycle.

## ACME DNS-01 Challenge

DNS-01 proves domain ownership by creating a TXT record under `_acme-challenge.<domain>`. This is required for:
- Wildcard certificates (`*.example.com`)
- Clusters not exposed to the internet (private clusters)
- Domains whose DNS provider supports API-based record creation

### DNS-01 with AWS Route53

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: route53-credentials
  namespace: cert-manager
type: Opaque
stringData:
  # Use IRSA (IAM Roles for Service Accounts) instead of static credentials when possible
  # Only needed if not using IRSA
  secret-access-key: "EXAMPLE_AWS_SECRET_REPLACE_ME"

---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns01-route53
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-team@example.com
    privateKeySecretRef:
      name: letsencrypt-dns01-account-key
    solvers:
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890EXAMPLE
            # IRSA: omit accessKeyID and secretAccessKeySecretRef
            # cert-manager uses the pod's service account token automatically
```

#### IRSA Configuration for Route53

```yaml
# cert-manager-values.yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/cert-manager-route53

# IAM policy document for the role
# {
#   "Version": "2012-10-17",
#   "Statement": [
#     {
#       "Effect": "Allow",
#       "Action": ["route53:GetChange"],
#       "Resource": "arn:aws:route53:::change/*"
#     },
#     {
#       "Effect": "Allow",
#       "Action": [
#         "route53:ChangeResourceRecordSets",
#         "route53:ListResourceRecordSets"
#       ],
#       "Resource": "arn:aws:route53:::hostedzone/Z1234567890EXAMPLE"
#     },
#     {
#       "Effect": "Allow",
#       "Action": ["route53:ListHostedZonesByName"],
#       "Resource": "*"
#     }
#   ]
# }
```

### DNS-01 with Cloudflare

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: "EXAMPLE_CLOUDFLARE_TOKEN_REPLACE_ME"

---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns01-cloudflare
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-team@example.com
    privateKeySecretRef:
      name: letsencrypt-dns01-cf-account-key
    solvers:
      - dns01:
          cloudflare:
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
        selector:
          dnsZones:
            - example.com
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
    name: letsencrypt-dns01-cloudflare
    kind: ClusterIssuer
  commonName: "*.example.com"
  dnsNames:
    - "*.example.com"
    - example.com       # Include apex domain separately
  duration: 2160h
  renewBefore: 720h
  privateKey:
    algorithm: RSA
    size: 4096
    rotationPolicy: Always
```

### Let's Encrypt Staging vs Production

Always test issuance workflows against the Let's Encrypt **staging** environment first. The staging environment has much higher rate limits and issues certificates signed by a test CA (not trusted by browsers). Use it to validate solver configuration without risking production rate limit exhaustion.

```yaml
# Staging issuer for testing
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
      - dns01:
          cloudflare:
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
```

## HashiCorp Vault PKI Issuer

Vault's PKI secrets engine is the standard internal CA for many enterprise Kubernetes deployments. cert-manager supports two Vault authentication methods.

### Vault PKI Setup

```bash
# Enable PKI secrets engine
vault secrets enable -path=pki pki
vault secrets tune -max-lease-ttl=87600h pki

# Generate root CA (or import an existing one)
vault write -field=certificate pki/root/generate/internal \
  common_name="Platform Root CA" \
  issuer_name="root-2027" \
  ttl=87600h > /tmp/root-cert.crt

# Create intermediate CA
vault secrets enable -path=pki_int pki
vault secrets tune -max-lease-ttl=43800h pki_int

vault write -format=json pki_int/intermediate/generate/internal \
  common_name="Platform Intermediate CA" \
  | jq -r .data.csr > /tmp/pki_int.csr

vault write -format=json pki/root/sign-intermediate \
  csr=@/tmp/pki_int.csr \
  format=pem_bundle \
  ttl="43800h" \
  | jq -r .data.certificate > /tmp/int-cert.pem

vault write pki_int/intermediate/set-signed certificate=@/tmp/int-cert.pem

# Create a role for cert-manager to use
vault write pki_int/roles/kubernetes-certificates \
  allowed_domains="example.com,svc.cluster.local" \
  allow_subdomains=true \
  allow_glob_domains=false \
  max_ttl="2160h" \
  require_cn=false \
  allowed_uri_sans="spiffe://cluster.local/*"
```

### Vault AppRole Authentication

```bash
# Enable AppRole
vault auth enable approle

# Create policy for cert-manager
vault policy write cert-manager - <<EOF
path "pki_int/sign/kubernetes-certificates" {
  capabilities = ["create", "update"]
}
path "pki_int/issue/kubernetes-certificates" {
  capabilities = ["create"]
}
EOF

# Create AppRole
vault write auth/approle/role/cert-manager \
  token_policies="cert-manager" \
  token_ttl=1h \
  token_max_ttl=4h

# Get role ID and secret ID
vault read auth/approle/role/cert-manager/role-id
vault write -f auth/approle/role/cert-manager/secret-id
```

```yaml
# Store AppRole credentials
apiVersion: v1
kind: Secret
metadata:
  name: vault-approle-secret-id
  namespace: cert-manager
type: Opaque
stringData:
  secretId: "EXAMPLE_VAULT_SECRET_ID_REPLACE_ME"

---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-pki-approle
spec:
  vault:
    server: https://vault.example.com:8200
    path: pki_int/sign/kubernetes-certificates
    caBundle: |
      -----BEGIN CERTIFICATE-----
      MIIBvzCCAWWgAwIBAgIRAVAULTEXAMPLECABUNDLE...
      -----END CERTIFICATE-----
    auth:
      appRole:
        path: approle
        roleId: "EXAMPLE_VAULT_ROLE_ID_REPLACE_ME"
        secretRef:
          name: vault-approle-secret-id
          key: secretId
```

### Vault Kubernetes Authentication

Kubernetes auth is preferred in Kubernetes environments because it uses projected service account tokens with short TTLs instead of long-lived AppRole secret IDs:

```bash
# Enable Kubernetes auth
vault auth enable kubernetes

# Configure with the cluster's API server
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  disable_local_ca_jwt=false

# Bind cert-manager's service account
vault write auth/kubernetes/role/cert-manager \
  bound_service_account_names=cert-manager \
  bound_service_account_namespaces=cert-manager \
  policies=cert-manager \
  ttl=1h
```

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-pki-k8s-auth
spec:
  vault:
    server: https://vault.example.com:8200
    path: pki_int/sign/kubernetes-certificates
    auth:
      kubernetes:
        role: cert-manager
        mountPath: /v1/auth/kubernetes
        serviceAccountRef:
          name: cert-manager
```

## Venafi TPP Issuer

For organizations that have standardized on Venafi Trust Protection Platform, cert-manager provides a native Venafi issuer:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: venafi-tpp-credentials
  namespace: cert-manager
type: Opaque
stringData:
  username: "svc-cert-manager"
  password: "EXAMPLE_VENAFI_PASSWORD_REPLACE_ME"

---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: venafi-tpp
spec:
  venafi:
    zone: "DevOps\\Kubernetes\\Production"
    tpp:
      url: https://venafi.example.com/vedsdk
      caBundle: |
        -----BEGIN CERTIFICATE-----
        MIIBvzCCAWWgAWWgEXAMPLEVENAFICABUNDLE...
        -----END CERTIFICATE-----
      credentialsRef:
        name: venafi-tpp-credentials
```

Venafi enforces certificate policy (allowed key algorithms, maximum validity, required SANs) at the platform level, independent of the cert-manager configuration. This integration allows security teams to maintain policy ownership in Venafi while application teams self-service certificates through Kubernetes.

## Self-Signed and CA Issuer Chain

For internal services that do not need public trust, a self-signed bootstrapping issuer creates a CA certificate that a `CA` issuer then uses to sign workload certificates.

```yaml
# Step 1: Bootstrap issuer to sign the CA certificate
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}

---
# Step 2: Create the CA certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: platform-internal-ca
  namespace: cert-manager
spec:
  isCA: true
  secretName: platform-internal-ca-secret
  commonName: "Platform Internal CA"
  subject:
    organizations:
      - "Example Platform Engineering"
  duration: 87600h   # 10 years
  renewBefore: 17520h # Renew 2 years before expiry
  privateKey:
    algorithm: ECDSA
    size: 384
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer

---
# Step 3: CA issuer backed by the CA certificate
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: platform-internal-ca
spec:
  ca:
    secretName: platform-internal-ca-secret
```

### Workload Certificate Using CA Issuer

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: payments-service-tls
  namespace: payments
spec:
  secretName: payments-service-tls
  issuerRef:
    name: platform-internal-ca
    kind: ClusterIssuer
  commonName: payments.payments.svc.cluster.local
  dnsNames:
    - payments
    - payments.payments
    - payments.payments.svc
    - payments.payments.svc.cluster.local
  uris:
    - spiffe://cluster.local/ns/payments/sa/payments-service
  duration: 2160h
  renewBefore: 720h
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

## Certificate Resource Lifecycle

Understanding the full lifecycle prevents confusion during troubleshooting:

```
Certificate (desired state)
        │
        │ controller creates
        ▼
CertificateRequest (CSR + metadata)
        │
        │ ACME: controller creates Order
        │ Vault/CA: issuer processes directly
        ▼
Order (ACME only)
        │
        │ controller creates
        ▼
Challenge (ACME only)
  - HTTP-01: creates Ingress + Service + Pod
  - DNS-01: creates DNS TXT record via provider API
        │
        │ CA validates challenge
        │ Certificate issued
        ▼
Secret (tls.crt + tls.key + ca.crt)
        │
        │ controller sets status on Certificate
        ▼
Certificate.status.notBefore
Certificate.status.notAfter
Certificate.status.renewalTime
```

### Monitoring Certificate Status

```bash
# View all certificates and their readiness
kubectl get certificates -A

# Describe a specific certificate — shows conditions and events
kubectl describe certificate api-example-com -n production

# Check the underlying CertificateRequest
kubectl get certificaterequests -n production
kubectl describe certificaterequest api-example-com-<suffix> -n production

# View the issued certificate details
kubectl -n production get secret api-example-com-tls \
  -o jsonpath='{.data.tls\.crt}' \
  | base64 -d \
  | openssl x509 -noout -dates -subject -issuer
```

### Automatic Renewal

cert-manager calculates `renewalTime` as `notAfter - renewBefore`. A certificate with `duration: 2160h` and `renewBefore: 720h` is renewed 30 days before expiry. The renewal process creates a new `CertificateRequest`, issues a new certificate, and atomically replaces the contents of the backing `Secret`.

Applications consuming the `Secret` via volume mounts receive the new certificate on the next kubelet sync cycle (typically within 60–90 seconds). Applications that cache the certificate at startup (e.g., some Java TLS implementations) may require a pod restart. Use a tool like `wave` or `reloader` to trigger rolling restarts when the secret changes:

```yaml
# Reloader annotation on the Deployment
metadata:
  annotations:
    secret.reloader.stakater.com/reload: "api-example-com-tls"
```

## cert-manager CSI Driver

The **cert-manager CSI driver** mounts certificates directly into pods as ephemeral volumes, eliminating the need to create and manage `Certificate` objects manually. The certificate request is tied to the pod lifecycle — when the pod is deleted, the certificate is automatically cleaned up.

```bash
helm install cert-manager-csi-driver \
  jetstack/cert-manager-csi-driver \
  --namespace cert-manager
```

### Pod Using CSI Driver

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: workload
  namespace: production
spec:
  containers:
    - name: app
      image: registry.example.com/app:v1.0.0
      volumeMounts:
        - name: tls
          mountPath: /tls
          readOnly: true
  volumes:
    - name: tls
      csi:
        driver: csi.cert-manager.io
        readOnly: true
        volumeAttributes:
          csi.cert-manager.io/issuer-name: platform-internal-ca
          csi.cert-manager.io/issuer-kind: ClusterIssuer
          csi.cert-manager.io/common-name: workload.production.svc.cluster.local
          csi.cert-manager.io/dns-names: >
            workload,workload.production,
            workload.production.svc,
            workload.production.svc.cluster.local
          csi.cert-manager.io/duration: 1h
          csi.cert-manager.io/renew-before: 20m
          csi.cert-manager.io/certificate-file: tls.crt
          csi.cert-manager.io/privatekey-file: tls.key
          csi.cert-manager.io/ca-file: ca.crt
```

The CSI driver is ideal for service mesh adjacent use cases where certificates should have short TTLs (minutes to hours) and be automatically revoked when the pod terminates.

## trust-manager for CA Bundle Distribution

**trust-manager** solves the complementary problem: distributing the CA certificate (the trust anchor) to all namespaces so that applications can validate certificates issued by cert-manager issuers.

```bash
helm install trust-manager jetstack/trust-manager \
  --namespace cert-manager
```

### Bundle Resource

```yaml
apiVersion: trust.cert-manager.io/v1alpha1
kind: Bundle
metadata:
  name: platform-ca-bundle
spec:
  sources:
    # Include the platform internal CA
    - secret:
        name: platform-internal-ca-secret
        key: ca.crt
    # Include system CA bundle (distro trust store)
    - useDefaultCAs: true
  target:
    configMap:
      key: ca-certificates.crt
    # Namespace selector — empty matches all namespaces
    namespaceSelector:
      matchLabels: {}
    additionalFormats:
      jks:
        key: truststore.jks
      pkcs12:
        key: truststore.p12
        password: "EXAMPLE_TRUSTSTORE_PASS_REPLACE_ME"
```

trust-manager creates a `ConfigMap` named `platform-ca-bundle` in every namespace, containing the CA bundle. Applications reference it as a volume:

```yaml
volumes:
  - name: ca-bundle
    configMap:
      name: platform-ca-bundle
      items:
        - key: ca-certificates.crt
          path: ca-certificates.crt
```

## Monitoring Certificate Expiry

### x509-certificate-exporter

The `x509-certificate-exporter` scrapes TLS certificates from Kubernetes secrets and exposes their expiry as Prometheus metrics:

```bash
helm repo add enix https://charts.enix.io
helm install x509-certificate-exporter enix/x509-certificate-exporter \
  --namespace cert-manager \
  --set secretsExporter.enabled=true
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cert-manager-certificate-expiry
  namespace: cert-manager
spec:
  groups:
    - name: certmanager.certificates
      rules:
        - alert: CertManagerCertificateExpiringSoon
          expr: |
            certmanager_certificate_expiration_timestamp_seconds
            - time() < 604800
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Certificate {{ $labels.name }}/{{ $labels.namespace }} expires in less than 7 days"

        - alert: CertManagerCertificateExpired
          expr: |
            certmanager_certificate_expiration_timestamp_seconds - time() < 0
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "Certificate {{ $labels.name }}/{{ $labels.namespace }} has expired"

        - alert: CertManagerCertificateNotReady
          expr: |
            certmanager_certificate_ready_status{condition="False"} == 1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Certificate {{ $labels.name }}/{{ $labels.namespace }} is not Ready"

        - alert: CertManagerACMEChallengeStuck
          expr: |
            certmanager_acme_client_request_duration_seconds_count{status="400"} > 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "ACME challenge failures detected — check issuer configuration"
```

## Troubleshooting Failed Issuance

### ACME DNS-01 TXT Record Not Appearing

```bash
# Check the Order status
kubectl describe order -n production

# Check the Challenge status — shows solver log and error
kubectl describe challenge -n production

# Manually verify the DNS record
dig TXT _acme-challenge.api.example.com @8.8.8.8

# Check cert-manager logs for DNS solver errors
kubectl -n cert-manager logs -l app=cert-manager --tail=100 \
  | grep -i "dns\|route53\|cloudflare"
```

### Vault Auth Failure

```bash
# Test Vault connectivity from cert-manager pod
kubectl -n cert-manager exec -it \
  $(kubectl -n cert-manager get pod -l app=cert-manager -o name | head -1) \
  -- curl -k https://vault.example.com:8200/v1/sys/health

# Check CertificateRequest events
kubectl describe certificaterequest -n payments

# Common error: Vault token expired — check AppRole TTL
# Common error: Vault policy denied — verify vault policy allows pki_int/sign/*
```

### Rate Limit Hit on Let's Encrypt

```bash
# Check for rate limit errors in CertificateRequest events
kubectl describe certificaterequest -n production | grep -i "rate\|limit"

# Switch to staging issuer temporarily
kubectl patch certificate api-example-com -n production \
  --type merge \
  -p '{"spec":{"issuerRef":{"name":"letsencrypt-staging"}}}'

# Let's Encrypt rate limits (as of 2027):
# 50 Certificates per Registered Domain per week
# 5 Duplicate Certificates per week
# 300 New Orders per account per 3 hours
```

### Certificate Stuck in Pending

```bash
# Check all resources in the issuance chain
kubectl get certificate,certificaterequest,order,challenge -n production

# Check for CertificateRequest approval (if external approver is configured)
kubectl describe certificaterequest <name> -n production \
  | grep -A5 "Approved\|Denied\|Status"

# Force a re-issuance by bumping the certificate's renew annotation
kubectl annotate certificate api-example-com -n production \
  cert-manager.io/issue-temporary-certificate="true" --overwrite
# Then remove it
kubectl annotate certificate api-example-com -n production \
  cert-manager.io/issue-temporary-certificate-
```

cert-manager's declarative model, combined with the breadth of issuer integrations, makes it the de facto certificate automation layer for Kubernetes. The combination of `Certificate` resources for workload TLS, the CSI driver for short-lived pod certificates, and trust-manager for CA bundle distribution covers the full spectrum of certificate use cases in modern Kubernetes platforms.
