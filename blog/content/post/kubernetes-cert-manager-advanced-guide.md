---
title: "cert-manager Advanced Configuration: Internal PKI, ACME, and mTLS"
date: 2028-03-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cert-manager", "PKI", "TLS", "mTLS", "ACME", "Let's Encrypt", "Vault"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to advanced cert-manager configuration covering ClusterIssuer vs Issuer hierarchy, ACME DNS01 and HTTP01 challenges, internal CA chains, PKCS12/JKS bundles, Vault PKI integration, and production mTLS certificate provisioning."
more_link: "yes"
url: "/kubernetes-cert-manager-advanced-guide/"
---

cert-manager has become the standard certificate lifecycle manager for Kubernetes, but most teams use only a fraction of its capabilities. Beyond the common Let's Encrypt HTTP01 challenge, cert-manager supports full internal PKI hierarchies, Vault integration, PKCS#12 and JKS bundle generation, and automated mTLS certificate provisioning for service meshes. This guide covers the advanced configuration patterns required for enterprise certificate management at scale.

<!--more-->

## Issuer Hierarchy: ClusterIssuer vs Issuer

The most fundamental architectural decision in cert-manager is the scoping of issuers.

**Issuer** is namespace-scoped. It can only issue certificates for resources in the same namespace. Use Issuer when different teams need different CA certificates or different ACME accounts, and namespace isolation provides a security boundary.

**ClusterIssuer** is cluster-scoped. Any Certificate resource in any namespace can reference a ClusterIssuer. Use ClusterIssuer for shared infrastructure certificates, wildcard certificates, and Let's Encrypt integration that all teams share.

```yaml
# ClusterIssuer: Shared across all namespaces
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-team@example.com
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
---
# Issuer: Namespace-scoped for team isolation
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: team-payments-ca
  namespace: team-payments
spec:
  ca:
    secretName: team-payments-ca-secret
```

## Let's Encrypt ACME Configuration

### HTTP01 Challenge

HTTP01 validation requires that cert-manager can create a temporary Ingress or Gateway route to serve the ACME challenge token on port 80:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-http01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      # Default solver for all domains
      - http01:
          ingress:
            ingressClassName: nginx
            serviceType: ClusterIP
            podTemplate:
              metadata:
                labels:
                  app.kubernetes.io/component: acme-solver
              spec:
                tolerations:
                  - key: "node-role.kubernetes.io/infra"
                    operator: Exists
                resources:
                  requests:
                    cpu: 10m
                    memory: 16Mi
                  limits:
                    cpu: 100m
                    memory: 64Mi
      # Specific solver for Gateway API
      - http01:
          gatewayHTTPRoute:
            parentRefs:
              - name: production-gateway
                namespace: gateway-system
                kind: Gateway
        selector:
          dnsZones:
            - "gateway.example.com"
```

### DNS01 Challenge

DNS01 validation is required for wildcard certificates and for domains where HTTP01 is not possible (internal domains, port 80 blocked). The DNS provider must support programmatic record creation:

```yaml
# Route53 DNS01 solver (AWS)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-dns01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-dns01-account-key
    solvers:
      # Wildcard certificates via DNS01
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z1234567890ABC
            # Use IRSA (IAM Roles for Service Accounts) rather than static credentials
            # cert-manager pod must have the correct service account annotation
        selector:
          dnsZones:
            - "example.com"
            - "*.example.com"
      # Cloudflare for secondary domains
      - dns01:
          cloudflare:
            email: dns-admin@example.com
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
        selector:
          dnsZones:
            - "example.io"
            - "*.example.io"
```

### IRSA Configuration for Route53

```yaml
# ServiceAccount with IRSA annotation for cert-manager
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cert-manager
  namespace: cert-manager
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/cert-manager-route53

# IAM Policy (applied to the above role):
# {
#   "Version": "2012-10-17",
#   "Statement": [
#     {
#       "Effect": "Allow",
#       "Action": "route53:GetChange",
#       "Resource": "arn:aws:route53:::change/*"
#     },
#     {
#       "Effect": "Allow",
#       "Action": [
#         "route53:ChangeResourceRecordSets",
#         "route53:ListResourceRecordSets"
#       ],
#       "Resource": "arn:aws:route53:::hostedzone/Z1234567890ABC"
#     },
#     {
#       "Effect": "Allow",
#       "Action": "route53:ListHostedZonesByName",
#       "Resource": "*"
#     }
#   ]
# }
```

## Internal PKI: Self-Signed Root CA

For internal services that do not require public trust, build an internal CA hierarchy:

### Step 1: Self-Signed Root CA

```yaml
# Create the self-signed issuer to bootstrap the root CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
# Root CA certificate (signed by itself)
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-root-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: "Example Internal Root CA"
  subject:
    organizations:
      - Example Corp
    organizationalUnits:
      - Platform Engineering
  duration: 87600h        # 10 years
  renewBefore: 8760h      # Renew 1 year before expiry
  secretName: internal-root-ca-secret
  privateKey:
    algorithm: ECDSA
    size: 384
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
    group: cert-manager.io
  usages:
    - cert sign
    - crl sign
    - digital signature
```

### Step 2: Intermediate CA

```yaml
# ClusterIssuer backed by the root CA (to sign the intermediate)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-root-ca-issuer
spec:
  ca:
    secretName: internal-root-ca-secret
---
# Intermediate CA (signed by root)
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-intermediate-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: "Example Internal Intermediate CA"
  subject:
    organizations:
      - Example Corp
    organizationalUnits:
      - Platform Engineering - Services
  duration: 43800h        # 5 years
  renewBefore: 4380h      # Renew 6 months before expiry
  secretName: internal-intermediate-ca-secret
  privateKey:
    algorithm: ECDSA
    size: 384
  issuerRef:
    name: internal-root-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
  usages:
    - cert sign
    - crl sign
    - digital signature
---
# ClusterIssuer backed by the intermediate CA (for service certificates)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca-issuer
spec:
  ca:
    secretName: internal-intermediate-ca-secret
```

### Distributing the CA Bundle

Internal clients must trust the root CA. Distribute it via ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: internal-ca-bundle
  namespace: cert-manager
  labels:
    # trust-manager will sync this ConfigMap to all namespaces
    trust.cert-manager.io/bundle: "true"
data:
  ca-certificates.crt: |
    # Root CA cert (populated by external-secrets or manual process)
    # Applications mount this ConfigMap at /etc/ssl/certs/ca-certificates.crt
```

Using cert-manager's trust-manager for automated CA distribution:

```yaml
apiVersion: trust.cert-manager.io/v1alpha1
kind: Bundle
metadata:
  name: internal-ca-bundle
spec:
  sources:
    - secret:
        name: internal-root-ca-secret
        key: ca.crt
        namespace: cert-manager
    - secret:
        name: internal-intermediate-ca-secret
        key: ca.crt
        namespace: cert-manager
  target:
    configMap:
      key: ca-certificates.crt
    # Sync to all namespaces
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values: ["kube-system", "kube-public"]
```

## Certificate Resource: Full Field Reference

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: production-api-cert
  namespace: team-api
spec:
  # Secret name where the certificate will be stored
  secretName: production-api-tls

  # Subject fields
  commonName: "api.example.com"
  subject:
    organizations:
      - Example Corp
    organizationalUnits:
      - API Team
    countries:
      - US
    localities:
      - New York

  # SAN (Subject Alternative Names)
  dnsNames:
    - api.example.com
    - api-internal.example.com
    - "*.api.example.com"
  ipAddresses:
    - 10.96.0.1        # Kubernetes API server IP (for in-cluster mTLS)
  uris:
    - spiffe://cluster.local/ns/team-api/sa/api-service

  # Lifetime configuration
  duration: 2160h       # 90 days
  renewBefore: 360h     # Renew 15 days before expiry

  # Private key configuration
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always   # Always generate new key on renewal

  # Certificate usages
  usages:
    - server auth
    - client auth
    - digital signature
    - key encipherment

  # Reference to the issuer
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io

  # Additional secret metadata
  secretTemplate:
    labels:
      app: api-service
    annotations:
      reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
      reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "team-api-staging"
```

## PKCS#12 and JKS Bundle Generation

Java applications commonly require certificates in PKCS#12 (PFX) or JKS (Java KeyStore) format rather than PEM. cert-manager supports generating these alongside the standard PEM files:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: java-service-cert
  namespace: team-java
spec:
  secretName: java-service-tls
  commonName: "java-service.example.com"
  dnsNames:
    - java-service.example.com
  duration: 2160h
  renewBefore: 360h
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
  keystores:
    pkcs12:
      create: true
      passwordSecretRef:
        name: keystore-password
        key: password
    jks:
      create: true
      passwordSecretRef:
        name: keystore-password
        key: password
```

The resulting Secret will contain these keys:
- `tls.crt` — PEM certificate chain
- `tls.key` — PEM private key
- `ca.crt` — CA bundle
- `keystore.p12` — PKCS#12 keystore
- `truststore.p12` — PKCS#12 truststore (CA certificates)
- `keystore.jks` — JKS keystore
- `truststore.jks` — JKS truststore

```yaml
# Password Secret for the keystores
apiVersion: v1
kind: Secret
metadata:
  name: keystore-password
  namespace: team-java
type: Opaque
stringData:
  password: "changeit"
```

Mounting in a Java application:

```yaml
containers:
  - name: java-service
    image: registry.example.com/java-service:latest
    env:
      - name: JAVAX_NET_SSL_KEYSTORE
        value: /tls/keystore.jks
      - name: JAVAX_NET_SSL_KEYSTOREPASSWORD
        valueFrom:
          secretKeyRef:
            name: keystore-password
            key: password
      - name: JAVAX_NET_SSL_TRUSTSTORE
        value: /tls/truststore.jks
      - name: JAVAX_NET_SSL_TRUSTSTOREPASSWORD
        valueFrom:
          secretKeyRef:
            name: keystore-password
            key: password
    volumeMounts:
      - name: tls
        mountPath: /tls
        readOnly: true
volumes:
  - name: tls
    secret:
      secretName: java-service-tls
```

## HashiCorp Vault PKI Issuer Integration

Vault PKI is often preferred in enterprise environments because it provides centralized audit logging, policy-based access control, and certificate revocation via CRL:

### Vault PKI Setup

```bash
# Enable PKI secrets engine
vault secrets enable -path=pki pki
vault secrets tune -max-lease-ttl=87600h pki

# Generate root certificate (or import existing)
vault write pki/root/generate/internal \
    common_name="Vault Root CA" \
    issuer_name="root-2025" \
    ttl=87600h

# Enable PKI for intermediate
vault secrets enable -path=pki_int pki
vault secrets tune -max-lease-ttl=43800h pki_int

# Generate intermediate CSR
vault write -format=json pki_int/intermediate/generate/internal \
    common_name="Vault Intermediate CA" \
    issuer_name="intermediate-2025" \
    | jq -r '.data.csr' > pki_intermediate.csr

# Sign with root and import
vault write -format=json pki/root/sign-intermediate \
    issuer_ref="root-2025" \
    csr=@pki_intermediate.csr \
    format=pem_bundle \
    ttl="43800h" \
    | jq -r '.data.certificate' > intermediate.cert.pem

vault write pki_int/intermediate/set-signed certificate=@intermediate.cert.pem

# Create role for Kubernetes services
vault write pki_int/roles/kubernetes-services \
    allowed_domains="svc.cluster.local,example.com" \
    allow_subdomains=true \
    allow_glob_domains=true \
    max_ttl="2160h" \
    key_type=ec \
    key_bits=256 \
    require_cn=false
```

### Vault Authentication for cert-manager

```bash
# Enable Kubernetes auth
vault auth enable kubernetes

# Configure Kubernetes auth
vault write auth/kubernetes/config \
    kubernetes_host="https://kubernetes.default.svc.cluster.local" \
    kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
    token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

# Create policy for cert-manager
vault policy write cert-manager - <<EOF
path "pki_int/sign/kubernetes-services" {
  capabilities = ["create", "update"]
}
path "pki_int/issue/kubernetes-services" {
  capabilities = ["create", "update"]
}
EOF

# Bind cert-manager service account to policy
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
    server: https://vault.vault-system.svc.cluster.local:8200
    path: pki_int/sign/kubernetes-services
    caBundle: <base64-encoded-vault-ca-cert>
    auth:
      kubernetes:
        role: cert-manager
        mountPath: /v1/auth/kubernetes
        serviceAccountRef:
          name: cert-manager
```

### Certificate from Vault

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: payments-service-cert
  namespace: team-payments
spec:
  secretName: payments-service-tls
  duration: 2160h
  renewBefore: 360h
  dnsNames:
    - payments-service.team-payments.svc.cluster.local
    - payments-service
    - payments.example.com
  uris:
    - spiffe://cluster.local/ns/team-payments/sa/payments-service
  issuerRef:
    name: vault-issuer
    kind: ClusterIssuer
    group: cert-manager.io
  usages:
    - server auth
    - client auth
```

## mTLS Certificate Provisioning

Mutual TLS requires both client and server to present certificates. cert-manager can provision both:

### Server Certificate

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: orders-server-cert
  namespace: team-orders
spec:
  secretName: orders-server-tls
  commonName: "orders-service.team-orders.svc.cluster.local"
  dnsNames:
    - orders-service
    - orders-service.team-orders
    - orders-service.team-orders.svc
    - orders-service.team-orders.svc.cluster.local
  duration: 2160h
  renewBefore: 360h
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
  usages:
    - server auth
    - digital signature
    - key encipherment
```

### Client Certificate for mTLS

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: payments-client-cert
  namespace: team-payments
spec:
  secretName: payments-client-tls
  # CN is used by the server to identify the client
  commonName: "payments-service"
  subject:
    organizations:
      - Example Corp
    organizationalUnits:
      - team-payments
  duration: 720h    # Short-lived client certs: 30 days
  renewBefore: 72h  # Renew 3 days before expiry
  issuerRef:
    name: internal-ca-issuer
    kind: ClusterIssuer
  usages:
    - client auth
    - digital signature
    - key encipherment
```

### Configuring mTLS in an Application

```go
package main

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "net/http"
    "os"
)

func newMTLSClient(certFile, keyFile, caFile string) (*http.Client, error) {
    // Load client certificate and key
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("load client cert/key: %w", err)
    }

    // Load CA bundle for server verification
    caCert, err := os.ReadFile(caFile)
    if err != nil {
        return nil, fmt.Errorf("read CA file: %w", err)
    }

    caCertPool := x509.NewCertPool()
    if !caCertPool.AppendCertsFromPEM(caCert) {
        return nil, fmt.Errorf("failed to parse CA certificate")
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{cert},
        RootCAs:      caCertPool,
        MinVersion:   tls.VersionTLS13,
    }

    transport := &http.Transport{
        TLSClientConfig: tlsConfig,
    }

    return &http.Client{Transport: transport}, nil
}

func newMTLSServer(certFile, keyFile, caFile string) (*http.Server, error) {
    // Load server certificate
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("load server cert/key: %w", err)
    }

    // Load CA bundle for client verification
    caCert, err := os.ReadFile(caFile)
    if err != nil {
        return nil, fmt.Errorf("read CA file: %w", err)
    }

    caCertPool := x509.NewCertPool()
    if !caCertPool.AppendCertsFromPEM(caCert) {
        return nil, fmt.Errorf("failed to parse CA certificate")
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientCAs:    caCertPool,
        ClientAuth:   tls.RequireAndVerifyClientCert,
        MinVersion:   tls.VersionTLS13,
    }

    return &http.Server{
        Addr:      ":8443",
        TLSConfig: tlsConfig,
    }, nil
}
```

## Certificate Monitoring and Alerting

### Prometheus Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cert-manager-alerts
  namespace: cert-manager
spec:
  groups:
    - name: cert-manager.certificates
      interval: 1m
      rules:
        - alert: CertificateExpiryWarning
          expr: |
            certmanager_certificate_expiration_timestamp_seconds
              - time() < (14 * 24 * 3600)
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Certificate expiring in less than 14 days"
            description: >
              Certificate {{ $labels.name }} in namespace {{ $labels.namespace }}
              expires in {{ $value | humanizeDuration }}.

        - alert: CertificateExpiryUrgent
          expr: |
            certmanager_certificate_expiration_timestamp_seconds
              - time() < (3 * 24 * 3600)
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: "Certificate expiring in less than 3 days"
            description: >
              Certificate {{ $labels.name }} in namespace {{ $labels.namespace }}
              expires in {{ $value | humanizeDuration }}.

        - alert: CertificateRenewalFailed
          expr: |
            certmanager_certificate_ready_status{condition="False"} == 1
          for: 30m
          labels:
            severity: critical
          annotations:
            summary: "Certificate renewal failed"
            description: >
              Certificate {{ $labels.name }} in namespace {{ $labels.namespace }}
              is not in Ready state for 30 minutes.

        - alert: ACMEAccountKeyLost
          expr: |
            certmanager_acme_client_request_count{status="error"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ACME client request errors"
```

## Operational Commands

```bash
# List all certificates and their expiry
kubectl get certificates --all-namespaces -o custom-columns=\
"NAMESPACE:.metadata.namespace,NAME:.metadata.name,\
READY:.status.conditions[?(@.type=='Ready')].status,\
EXPIRY:.status.notAfter,\
ISSUER:.spec.issuerRef.name"

# Check certificate renewal status
kubectl describe certificate <cert-name> -n <namespace>

# Manually trigger renewal (for testing or emergency)
kubectl annotate certificate <cert-name> -n <namespace> \
  cert-manager.io/issueTime="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# Inspect the actual certificate in a Secret
kubectl get secret <secret-name> -n <namespace> -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl x509 -noout -text \
  | grep -E "(Subject|DNS|Not After|Issuer)"

# Check ACME order/challenge status
kubectl get orders --all-namespaces
kubectl get challenges --all-namespaces
kubectl describe challenge <challenge-name> -n <namespace>

# Rotate CA (emergency procedure)
# 1. Create new CA certificate
# 2. Update ClusterIssuer to reference new CA
# 3. Annotate all Certificates to trigger renewal
kubectl get certificates --all-namespaces -o json \
  | jq -r '.items[] | "\(.metadata.namespace) \(.metadata.name)"' \
  | while read ns name; do
      kubectl annotate certificate "$name" -n "$ns" \
        cert-manager.io/issueTime="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    done
```

## Summary

cert-manager's strength lies in its composable issuer hierarchy. A ClusterIssuer backed by Vault provides centralized audit and revocation. An intermediate CA signed by an air-gapped root provides defense in depth. ACME DNS01 solvers enable wildcard certificates for domains where HTTP01 is infeasible.

The critical operational parameters are `duration` and `renewBefore`. A 90-day certificate with 15-day renewBefore gives cert-manager 15 days to succeed at renewal before the certificate expires — sufficient for most outage windows. For short-lived mTLS client certificates (30 days), reduce renewBefore to 3 days and ensure the application reloads certificates from the Secret on a schedule, since most TLS libraries only read certificates at startup.
