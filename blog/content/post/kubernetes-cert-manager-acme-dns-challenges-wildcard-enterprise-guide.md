---
title: "Kubernetes cert-manager ACME DNS Challenges: Route53, Cloudflare, Webhook Solvers, Wildcard Certificates, and Renewals"
date: 2032-02-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "cert-manager", "TLS", "ACME", "Let's Encrypt", "DNS", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to cert-manager DNS-01 ACME challenges covering Route53 and Cloudflare solvers, custom webhook solvers for private DNS, wildcard certificate issuance, rotation automation, and certificate lifecycle monitoring."
more_link: "yes"
url: "/kubernetes-cert-manager-acme-dns-challenges-wildcard-enterprise-guide/"
---

DNS-01 ACME challenges allow cert-manager to issue certificates for domains that are not publicly reachable over HTTP — including internal services, wildcard certificates, and private infrastructure. This guide covers configuring DNS-01 solvers for AWS Route53 and Cloudflare, deploying custom webhook solvers for private DNS providers, issuing wildcard certificates, and monitoring the full certificate lifecycle including renewal failures.

<!--more-->

# Kubernetes cert-manager ACME DNS Challenges: Enterprise Guide

## Section 1: Why DNS-01 Instead of HTTP-01

The HTTP-01 ACME challenge requires the domain to be publicly reachable on port 80. DNS-01 works differently: cert-manager creates a `_acme-challenge.<domain>` TXT record in the DNS zone, and Let's Encrypt (or another ACME CA) validates it by querying DNS.

DNS-01 enables:
- **Wildcard certificates**: `*.example.com` — HTTP-01 cannot issue wildcards
- **Private services**: internal services not exposed to the internet
- **Cross-namespace issuance**: a single ClusterIssuer serves all namespaces
- **Rate limit avoidance**: one wildcard certificate covers all subdomains

## Section 2: cert-manager Installation

```bash
# Install cert-manager via Helm (recommended)
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.15.0 \
  --set installCRDs=true \
  --set prometheus.enabled=true \
  --set prometheus.servicemonitor.enabled=true \
  --set global.leaderElection.namespace=cert-manager

# Verify
kubectl -n cert-manager get pods
kubectl get crds | grep cert-manager
```

### IRSA for Route53 Access (EKS)

cert-manager needs IAM permissions to create/delete DNS records in Route53. Use IRSA (IAM Roles for Service Accounts) to avoid storing credentials in Kubernetes secrets.

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
      "Resource": "arn:aws:route53:::hostedzone/<hosted-zone-id>"
    },
    {
      "Effect": "Allow",
      "Action": "route53:ListHostedZonesByName",
      "Resource": "*"
    }
  ]
}
```

```bash
# Create IAM role and annotate ServiceAccount
eksctl create iamserviceaccount \
  --name cert-manager \
  --namespace cert-manager \
  --cluster <cluster-name> \
  --attach-policy-arn arn:aws:iam::<account-id>:policy/CertManagerRoute53Policy \
  --approve \
  --override-existing-serviceaccounts

# Patch Helm-created ServiceAccount with the annotation
kubectl -n cert-manager annotate serviceaccount cert-manager \
  eks.amazonaws.com/role-arn=arn:aws:iam::<account-id>:role/cert-manager-route53 \
  --overwrite
```

## Section 3: Route53 DNS-01 Issuer

### ClusterIssuer with IRSA (No Credentials in K8s)

```yaml
# cluster-issuer-route53.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-route53
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-route53-account-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: <hosted-zone-id>
          # No accessKeyID/secretAccessKeySecretRef = use IRSA
      selector:
        dnsZones:
        - example.com
---
# Staging issuer for testing (higher rate limits, not trusted in browsers)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging-route53
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-staging-route53-account-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: <hosted-zone-id>
      selector:
        dnsZones:
        - example.com
```

### ClusterIssuer with IAM User Credentials (Non-EKS)

```yaml
# IAM credentials as a Kubernetes Secret
apiVersion: v1
kind: Secret
metadata:
  name: route53-credentials-secret
  namespace: cert-manager
type: Opaque
stringData:
  secret-access-key: <aws-secret-access-key>
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-route53
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: <hosted-zone-id>
          accessKeyID: <aws-access-key-id>
          secretAccessKeySecretRef:
            name: route53-credentials-secret
            key: secret-access-key
```

## Section 4: Cloudflare DNS-01 Issuer

```bash
# Create Cloudflare API token with Zone:DNS:Edit permission
# Token scoped to specific zone for least privilege
```

```yaml
# cloudflare-api-token-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token-secret
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
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-cloudflare-account-key
    solvers:
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-api-token-secret
            key: api-token
      selector:
        dnsZones:
        - example.com
        - example.io
```

### Multiple Solvers for Multiple Domains

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    # Route53 for *.example.com
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: <route53-zone-id>
      selector:
        dnsZones:
        - example.com

    # Cloudflare for *.example.io
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-api-token-secret
            key: api-token
      selector:
        dnsZones:
        - example.io

    # HTTP-01 fallback for other domains
    - http01:
        ingress:
          class: nginx
      selector:
        matchLabels:
          use-http01: "true"
```

## Section 5: Wildcard Certificate Issuance

```yaml
# wildcard-cert.yaml
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
  # Wildcard requires DNS-01
  commonName: "*.example.com"
  dnsNames:
  - "*.example.com"
  - example.com   # Also cover the apex domain
  duration: 2160h    # 90 days
  renewBefore: 360h  # Renew 15 days before expiry
  # Additional certificate options
  privateKey:
    algorithm: ECDSA
    size: 384
    rotationPolicy: Always   # Rotate private key on every renewal
  usages:
  - server auth
  - client auth
```

```bash
# Apply and monitor
kubectl apply -f wildcard-cert.yaml
kubectl -n production describe certificate wildcard-example-com

# Watch CertificateRequest and Order
kubectl -n production get certificaterequests -w
kubectl -n production get orders -w
kubectl -n production get challenges -w

# Check the issued certificate
kubectl -n production get secret wildcard-example-com-tls -o jsonpath='{.data.tls\.crt}' | \
  base64 -d | openssl x509 -noout -text | grep -A2 "Subject Alternative"
```

### Sharing a Wildcard Secret Across Namespaces

cert-manager creates secrets in the namespace where the Certificate resource lives. To share across namespaces, use the `reflector` sidecar or `kubernetes-reflector`:

```yaml
# Install reflector
helm repo add emberstack https://emberstack.github.io/helm-charts
helm upgrade --install reflector emberstack/reflector -n cert-manager

# Annotate the certificate secret for reflection
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: cert-manager
spec:
  secretName: wildcard-example-com-tls
  secretTemplate:
    annotations:
      # Reflect this secret to all namespaces matching the pattern
      reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
      reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "production,staging,.*"
      reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
  issuerRef:
    name: letsencrypt-prod-route53
    kind: ClusterIssuer
  dnsNames:
  - "*.example.com"
  - example.com
```

## Section 6: Custom Webhook Solvers for Private DNS

For private DNS providers (Infoblox, PowerDNS, Windows DNS, Akamai), cert-manager supports a webhook solver interface.

### Webhook Solver Contract

A webhook solver is an HTTP server that cert-manager calls to Present (add) and CleanUp (remove) DNS TXT records.

```go
// webhook/main.go — custom ACME webhook solver
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"

    // cert-manager webhook SDK
    "github.com/cert-manager/cert-manager/pkg/acme/webhook/apis/acme/v1alpha1"
    "github.com/cert-manager/cert-manager/pkg/acme/webhook/cmd"
)

const GroupName = "dns.example.com"

func main() {
    cmd.RunWebhookServer(GroupName, &internalDNSSolver{})
}

type internalDNSSolver struct {
    client *InternalDNSClient
}

type internalDNSConfig struct {
    // Config fields from the solver's configJSON
    ServerURL    string `json:"serverURL"`
    ZoneName     string `json:"zoneName"`
    CredSecretRef struct {
        Name string `json:"name"`
        Key  string `json:"key"`
    } `json:"credentialsSecretRef"`
}

func (s *internalDNSSolver) Name() string {
    return "internal-dns"
}

func (s *internalDNSSolver) Present(ch *v1alpha1.ChallengeRequest) error {
    cfg, err := loadConfig(ch.Config)
    if err != nil {
        return fmt.Errorf("load config: %w", err)
    }

    client, err := s.newClient(cfg)
    if err != nil {
        return fmt.Errorf("create DNS client: %w", err)
    }

    // Add TXT record: _acme-challenge.<domain> TXT <key>
    return client.AddTXTRecord(ch.ResolvedFQDN, ch.Key, cfg.ZoneName)
}

func (s *internalDNSSolver) CleanUp(ch *v1alpha1.ChallengeRequest) error {
    cfg, err := loadConfig(ch.Config)
    if err != nil {
        return fmt.Errorf("load config: %w", err)
    }

    client, err := s.newClient(cfg)
    if err != nil {
        return fmt.Errorf("create DNS client: %w", err)
    }

    return client.DeleteTXTRecord(ch.ResolvedFQDN, ch.Key, cfg.ZoneName)
}

func (s *internalDNSSolver) Initialize(kubeClientConfig *rest.Config, stopCh <-chan struct{}) error {
    // Initialize k8s client if needed to read secrets
    return nil
}

func loadConfig(cfgJSON *extapi.JSON) (internalDNSConfig, error) {
    cfg := internalDNSConfig{}
    if cfgJSON == nil {
        return cfg, nil
    }
    return cfg, json.Unmarshal(cfgJSON.Raw, &cfg)
}

func (s *internalDNSSolver) newClient(cfg internalDNSConfig) (*InternalDNSClient, error) {
    return NewInternalDNSClient(cfg.ServerURL), nil
}
```

### Deploying the Webhook Solver

```yaml
# webhook-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cert-manager-webhook-internal-dns
  namespace: cert-manager
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cert-manager-webhook-internal-dns
  template:
    metadata:
      labels:
        app: cert-manager-webhook-internal-dns
    spec:
      serviceAccountName: cert-manager-webhook-internal-dns
      containers:
      - name: webhook
        image: registry.example.com/cert-manager-webhook-internal-dns:v1.0.0
        args:
        - --tls-cert-file=/tls/tls.crt
        - --tls-private-key-file=/tls/tls.key
        ports:
        - containerPort: 443
          name: https
        volumeMounts:
        - name: tls
          mountPath: /tls
          readOnly: true
      volumes:
      - name: tls
        secret:
          secretName: cert-manager-webhook-internal-dns-tls
---
apiVersion: v1
kind: Service
metadata:
  name: cert-manager-webhook-internal-dns
  namespace: cert-manager
spec:
  selector:
    app: cert-manager-webhook-internal-dns
  ports:
  - name: https
    port: 443
    targetPort: 443
---
# Register the webhook with cert-manager
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: cert-manager-webhook-internal-dns
  annotations:
    cert-manager.io/inject-apiserver-ca: "true"
webhooks:
- name: internal-dns.dns.example.com
  rules:
  - apiGroups: ["acme.cert-manager.io"]
    apiVersions: ["v1"]
    operations: ["CREATE", "UPDATE"]
    resources: ["challenges"]
  admissionReviewVersions: ["v1"]
  sideEffects: None
  clientConfig:
    service:
      name: cert-manager-webhook-internal-dns
      namespace: cert-manager
      path: /validate
```

### ClusterIssuer Using the Custom Webhook

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-internal
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-internal-account-key
    solvers:
    - dns01:
        webhook:
          # Must match the GroupName in the webhook binary
          groupName: dns.example.com
          solverName: internal-dns
          config:
            serverURL: http://internal-dns.example.corp:8080
            zoneName: example.corp
            credentialsSecretRef:
              name: internal-dns-credentials
              key: password
      selector:
        dnsZones:
        - example.corp
        - internal.example.com
```

## Section 7: Certificate Renewal Mechanics

cert-manager automatically renews certificates based on `renewBefore`. The renewal timeline:

```
Certificate issued (Day 0)
     │
     ▼
Duration = 90 days → Expiry at Day 90
                      │
RenewBefore = 30 days → Renewal triggered at Day 60
```

### Monitoring Renewal

```bash
# List all certificates and their expiry
kubectl get certificates -A -o custom-columns=\
"NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[?(@.type=='Ready')].status,EXPIRY:.status.notAfter"

# Certificates expiring within 7 days
kubectl get certificates -A -o json | \
  jq '.items[] | select(
    .status.notAfter != null and
    ((.status.notAfter | fromdate) - now) < (7 * 86400)
  ) | {
    namespace: .metadata.namespace,
    name: .metadata.name,
    expires: .status.notAfter
  }'

# Force renewal of a specific certificate
kubectl -n production annotate certificate wildcard-example-com \
  cert-manager.io/issuer-kind=ClusterIssuer \
  --overwrite
# Or delete the CertificateRequest to trigger re-issuance
kubectl -n production get certificaterequests | grep wildcard
kubectl -n production delete certificaterequest wildcard-example-com-<hash>
```

### Renewal Troubleshooting

```bash
# Check certificate events
kubectl -n production describe certificate wildcard-example-com

# Check the CertificateRequest
kubectl -n production describe certificaterequest wildcard-example-com-<hash>

# Check the ACME Order
kubectl -n production describe order wildcard-example-com-<hash>

# Check the Challenge
kubectl -n production describe challenge wildcard-example-com-<hash>-<index>

# Common issues:
# 1. DNS record not created — check solver credentials and IAM permissions
# 2. DNS propagation delay — increase timeout
# 3. Rate limiting — switch to staging issuer for testing

# cert-manager controller logs
kubectl -n cert-manager logs -l app=cert-manager --tail=100 | \
  grep -E "ERROR|WARN|challenge|order" | head -50

# Check ACME account status
kubectl -n cert-manager get secrets | grep account-key
kubectl -n cert-manager describe clusterissuer letsencrypt-prod-route53
```

## Section 8: Ingress Integration

### Automatic Certificate via Ingress Annotation

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-service
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod-route53
    # For a wildcard cert already provisioned, reference it directly:
    # Do NOT use issuer annotation; reference the existing secret in spec.tls
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - my-service.example.com
    secretName: my-service-tls   # cert-manager creates this secret
  rules:
  - host: my-service.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-service
            port:
              number: 80
```

### Using a Pre-Issued Wildcard Secret

```yaml
# Reference the wildcard secret (reflected via kubernetes-reflector)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-service
  namespace: production
  # No cert-manager annotation — certificate already exists
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - my-service.example.com
    - another-service.example.com
    secretName: wildcard-example-com-tls   # pre-provisioned wildcard
  rules:
  - host: my-service.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-service
            port:
              number: 80
```

## Section 9: Certificate Monitoring with Prometheus

cert-manager exposes Prometheus metrics. Key alerts to configure:

```yaml
# prometheus-alerts.yaml
groups:
- name: cert-manager.rules
  rules:
  # Certificate expiring within 14 days
  - alert: CertificateExpiryWarning
    expr: |
      certmanager_certificate_expiration_timestamp_seconds
      - time() < 14 * 24 * 3600
    for: 1h
    labels:
      severity: warning
    annotations:
      summary: "Certificate expiring soon: {{ $labels.namespace }}/{{ $labels.name }}"
      description: "Certificate expires in {{ $value | humanizeDuration }}"

  # Certificate expiring within 7 days
  - alert: CertificateExpiryCritical
    expr: |
      certmanager_certificate_expiration_timestamp_seconds
      - time() < 7 * 24 * 3600
    for: 1h
    labels:
      severity: critical
    annotations:
      summary: "Certificate critical expiry: {{ $labels.namespace }}/{{ $labels.name }}"

  # Certificate not ready
  - alert: CertificateNotReady
    expr: |
      certmanager_certificate_ready_status{condition="False"} == 1
    for: 30m
    labels:
      severity: warning
    annotations:
      summary: "Certificate not ready: {{ $labels.namespace }}/{{ $labels.name }}"
      description: "Certificate {{ $labels.namespace }}/{{ $labels.name }} has been not-ready for 30+ minutes"

  # ACME challenge failures
  - alert: ACMEChallengeFailed
    expr: |
      increase(certmanager_acme_client_request_count{status="error"}[5m]) > 0
    labels:
      severity: warning
    annotations:
      summary: "ACME challenge request failed on {{ $labels.instance }}"

  # Renewal rate (should be > 0 periodically)
  - alert: NoCertificateRenewals
    expr: |
      increase(certmanager_http_acme_client_request_count[24h]) == 0
    for: 2h
    labels:
      severity: warning
    annotations:
      summary: "No ACME requests in 24 hours — cert-manager may be stuck"
```

### Grafana Dashboard Queries

```promql
# Certificates near expiry
certmanager_certificate_expiration_timestamp_seconds - time() < 30 * 24 * 3600

# Certificate renewal failures over time
increase(certmanager_certificate_renewal_errors_total[1h])

# ACME request rate by action
rate(certmanager_acme_client_request_count[5m]) by (method, status)

# Active challenges by type
certmanager_acme_client_request_count by (solverType)
```

## Section 10: Private CA with cert-manager (No ACME)

For internal services that don't need publicly trusted certificates:

```yaml
# private-ca-secret.yaml
# First, create a self-signed CA cert to bootstrap
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
---
# Bootstrap CA certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: internal-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: internal-ca
  secretName: internal-ca-tls
  privateKey:
    algorithm: ECDSA
    size: 384
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
---
# CA-backed ClusterIssuer
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca
spec:
  ca:
    secretName: internal-ca-tls
```

```yaml
# Issue a certificate from the private CA
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: my-internal-service
  namespace: production
spec:
  secretName: my-internal-service-tls
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
  dnsNames:
  - my-service.production.svc.cluster.local
  - my-service.production.svc
  - my-service
  duration: 8760h    # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
```

## Section 11: Operational Runbook

### Pre-Production Validation Checklist

```bash
#!/bin/bash
# cert-manager-validate.sh

NAMESPACE="${1:-production}"
echo "=== cert-manager Validation ==="

# 1. Check issuer is ready
echo "--- ClusterIssuers ---"
kubectl get clusterissuers -o custom-columns=\
"NAME:.metadata.name,READY:.status.conditions[?(@.type=='Ready')].status,MESSAGE:.status.conditions[?(@.type=='Ready')].message"

# 2. Check certificates
echo "--- Certificates in ${NAMESPACE} ---"
kubectl -n "${NAMESPACE}" get certificates -o custom-columns=\
"NAME:.metadata.name,READY:.status.conditions[?(@.type=='Ready')].status,EXPIRY:.status.notAfter,ISSUER:.spec.issuerRef.name"

# 3. Check for failing CertificateRequests
echo "--- Failing CertificateRequests ---"
kubectl -n "${NAMESPACE}" get certificaterequests | grep -v "True"

# 4. Check for active Challenges
echo "--- Active Challenges ---"
kubectl -n "${NAMESPACE}" get challenges 2>/dev/null || echo "No active challenges"

# 5. Verify TLS secret contents
echo "--- TLS Secret Validation ---"
kubectl -n "${NAMESPACE}" get secrets --field-selector type=kubernetes.io/tls | while read -r line; do
    name=$(echo "${line}" | awk '{print $1}')
    if [[ "${name}" != "NAME" ]]; then
        expiry=$(kubectl -n "${NAMESPACE}" get secret "${name}" \
            -o jsonpath='{.data.tls\.crt}' | \
            base64 -d | \
            openssl x509 -noout -enddate 2>/dev/null | \
            cut -d= -f2)
        echo "  ${name}: expires ${expiry}"
    fi
done
```

### Emergency Certificate Renewal

```bash
# Force immediate renewal (delete the existing cert secret)
kubectl -n production delete secret wildcard-example-com-tls
# cert-manager detects the missing secret and re-issues immediately

# Or: annotate with force-renewed timestamp
kubectl -n production annotate certificate wildcard-example-com \
  cert-manager.io/issue-temporary-certificate="true" \
  --overwrite

# Monitor issuance
kubectl -n production get certificate wildcard-example-com -w
```

## Summary

cert-manager DNS-01 challenges provide the most flexible certificate issuance strategy for enterprise Kubernetes environments:

- **Route53 with IRSA** eliminates the need to store AWS credentials in Kubernetes — the workload identity model is preferred for EKS
- **Cloudflare** is similarly straightforward using an API token scoped to only the required zone
- **Custom webhook solvers** bridge cert-manager to private DNS infrastructure that ACME providers cannot reach directly
- **Wildcard certificates** require DNS-01 and cover all subdomains, reducing the total number of issued certificates and renewal operations
- **Prometheus alerts on expiry** provide defense-in-depth against renewal failures that could cause production outages

The combination of ClusterIssuer for centralized credential management, Certificate resources for per-namespace provisioning, and reflector for cross-namespace sharing provides a complete, operationally manageable certificate lifecycle on Kubernetes.
