---
title: "Kubernetes Ingress TLS Termination: cert-manager, ACME, and Certificate Rotation"
date: 2027-05-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Ingress", "TLS", "cert-manager", "ACME", "Let's Encrypt", "Security"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes Ingress TLS termination covering cert-manager Issuer and ClusterIssuer configuration, ACME HTTP-01 and DNS-01 challenges, wildcard certificates, DNS provider integrations, certificate rotation, mutual TLS, and production monitoring patterns."
more_link: "yes"
url: "/kubernetes-ingress-tls-termination-guide/"
---

Securing Kubernetes workloads with TLS requires more than pointing an Ingress at a Secret. Production environments demand automated certificate issuance, seamless rotation, wildcard support, mutual TLS enforcement, and observable certificate health—all managed declaratively through the Kubernetes API. cert-manager has become the de facto standard for certificate lifecycle management in Kubernetes, integrating with ACME-compliant CAs, private PKI, and third-party issuers. This guide covers every layer of the stack: from ACME challenge mechanics and DNS provider integrations to certificate rotation procedures and operational monitoring patterns suited to enterprise environments.

<!--more-->

## cert-manager Architecture and Installation

cert-manager operates as a set of Kubernetes controllers that watch Certificate, Issuer, ClusterIssuer, CertificateRequest, Order, and Challenge custom resources. The core components are:

- **cert-manager controller**: Reconciles Certificate resources, manages the issuance workflow, and handles renewal scheduling
- **webhook**: Validates and mutates cert-manager resources at admission time
- **cainjector**: Injects CA bundle data into webhook configurations and API service objects

### Installing cert-manager via Helm

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.14.5 \
  --set installCRDs=true \
  --set global.leaderElection.namespace=cert-manager \
  --set replicaCount=2 \
  --set webhook.replicaCount=2 \
  --set cainjector.replicaCount=2 \
  --set prometheus.enabled=true \
  --set prometheus.servicemonitor.enabled=true
```

### Verifying the Installation

```bash
kubectl get pods -n cert-manager
# NAME                                       READY   STATUS    RESTARTS   AGE
# cert-manager-5c47f46f57-8xnlt              1/1     Running   0          2m
# cert-manager-cainjector-5b6f5bdf74-hmjvd   1/1     Running   0          2m
# cert-manager-webhook-7f9d8c9d9b-4kg2p      1/1     Running   0          2m

kubectl get crds | grep cert-manager
# certificaterequests.cert-manager.io
# certificates.cert-manager.io
# challenges.acme.cert-manager.io
# clusterissuers.cert-manager.io
# issuers.cert-manager.io
# orders.acme.cert-manager.io
```

## Issuer vs ClusterIssuer

The fundamental distinction between `Issuer` and `ClusterIssuer` is scope. An `Issuer` is namespace-scoped and can only issue certificates within its own namespace. A `ClusterIssuer` is cluster-scoped and can serve certificate requests from any namespace.

### When to Use Issuer

Use namespace-scoped `Issuer` resources when:
- Different teams require different CAs or ACME accounts per namespace
- Namespace isolation is a compliance requirement
- Development and production namespaces need separate Let's Encrypt rate limit buckets

### When to Use ClusterIssuer

Use `ClusterIssuer` when:
- A single CA or ACME account serves the entire cluster
- Centralizing certificate management reduces operational overhead
- Wildcard certificates need to be referenced from multiple namespaces

```yaml
# Namespace-scoped Issuer example
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: letsencrypt-prod
  namespace: production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - http01:
        ingress:
          class: nginx
```

```yaml
# Cluster-scoped ClusterIssuer example
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
    - http01:
        ingress:
          class: nginx
```

## ACME Challenge Types

ACME (Automatic Certificate Management Environment) defines two challenge types for domain validation: HTTP-01 and DNS-01. Selecting the right challenge type depends on network topology, DNS provider capabilities, and certificate requirements.

### HTTP-01 Challenge

HTTP-01 proves domain ownership by serving a token at a well-known URL path. The CA makes an HTTP request to `http://<domain>/.well-known/acme-challenge/<token>` and verifies the response.

**Requirements**:
- Port 80 must be reachable from the public internet (or from the CA's servers)
- A working Ingress controller must be running
- Not suitable for wildcard certificates

**How cert-manager implements HTTP-01**:
1. cert-manager creates a temporary Ingress resource that routes `/.well-known/acme-challenge/*` to a solver pod
2. The solver pod serves the challenge token
3. After validation, cert-manager removes the temporary Ingress and pod

```yaml
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
    - http01:
        ingress:
          class: nginx
          podTemplate:
            spec:
              nodeSelector:
                kubernetes.io/os: linux
              tolerations:
              - key: node-role.kubernetes.io/edge
                operator: Exists
```

**Solver selector for HTTP-01 with multiple Ingress classes**:

```yaml
solvers:
- selector:
    matchLabels:
      use-http01-solver: "true"
  http01:
    ingress:
      class: nginx
- selector:
    matchLabels:
      use-traefik-solver: "true"
  http01:
    ingress:
      class: traefik
```

### DNS-01 Challenge

DNS-01 proves domain ownership by creating a TXT record at `_acme-challenge.<domain>`. The CA performs a DNS lookup to verify the record.

**Requirements**:
- API access to the DNS provider
- Credentials stored in Kubernetes Secrets
- Compatible with wildcard certificates

**Advantages of DNS-01**:
- Works for internal clusters not exposed to the internet
- Supports wildcard certificates (`*.example.com`)
- No requirement for port 80 accessibility

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-dns
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-dns-account-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1234567890ABCDEFGHIJ
          accessKeyIDSecretRef:
            name: route53-credentials
            key: access-key-id
          secretAccessKeySecretRef:
            name: route53-credentials
            key: secret-access-key
```

## Let's Encrypt Staging vs Production

Let's Encrypt provides two environments with different rate limits and certificate validity:

| Parameter | Staging | Production |
|-----------|---------|------------|
| Certificate validity | 90 days | 90 days |
| Certificates per domain per week | 30,000 | 50 |
| Failed validations per account per hour | 60 | 5 |
| New orders per account per hour | unlimited | 300 |
| Root CA trusted by browsers | No | Yes |
| Purpose | Testing | Production traffic |

**Always use staging first** to validate configuration before switching to production. The staging environment allows unlimited testing without consuming production rate limits.

```yaml
# Staging ClusterIssuer - use during initial configuration
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-staging-key
    solvers:
    - http01:
        ingress:
          class: nginx

---
# Production ClusterIssuer - use after staging validation
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - http01:
        ingress:
          class: nginx
```

### Switching from Staging to Production

After validating that certificates issue correctly in staging, delete the staging Certificate and Secret, then create a new Certificate referencing the production issuer:

```bash
# Remove staging certificate and secret
kubectl delete certificate myapp-tls -n production
kubectl delete secret myapp-tls -n production

# The new Certificate resource will reference letsencrypt-prod
kubectl apply -f certificate-prod.yaml

# Monitor issuance
kubectl describe certificate myapp-tls -n production
kubectl get certificaterequest -n production
kubectl get order -n production
kubectl get challenge -n production
```

## DNS Provider Integrations

### AWS Route53

cert-manager supports Route53 via either static credentials or IAM roles for service accounts (IRSA).

**Using IRSA (recommended for EKS)**:

```yaml
# IAM policy for cert-manager
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
      "Resource": "arn:aws:route53:::hostedzone/Z1234567890ABCDEFGHIJ"
    },
    {
      "Effect": "Allow",
      "Action": "route53:ListHostedZonesByName",
      "Resource": "*"
    }
  ]
}
```

```yaml
# ServiceAccount with IRSA annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cert-manager
  namespace: cert-manager
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/cert-manager-route53

---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1234567890ABCDEFGHIJ
```

**Using static credentials**:

```bash
kubectl create secret generic route53-credentials \
  --namespace cert-manager \
  --from-literal=access-key-id=EXAMPLE_AWS_ACCESS_KEY_REPLACE_ME \
  --from-literal=secret-access-key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-route53
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1234567890ABCDEFGHIJ
          accessKeyIDSecretRef:
            name: route53-credentials
            key: access-key-id
          secretAccessKeySecretRef:
            name: route53-credentials
            key: secret-access-key
```

### Google Cloud DNS

```bash
# Create a service account for cert-manager
gcloud iam service-accounts create cert-manager-dns01 \
  --display-name "cert-manager DNS01 solver"

# Grant DNS administrator role
gcloud projects add-iam-policy-binding my-project \
  --member serviceAccount:cert-manager-dns01@my-project.iam.gserviceaccount.com \
  --role roles/dns.admin

# Create and download key
gcloud iam service-accounts keys create cert-manager-clouddns-key.json \
  --iam-account cert-manager-dns01@my-project.iam.gserviceaccount.com

# Create Kubernetes Secret
kubectl create secret generic clouddns-dns01-solver-svc-acct \
  --namespace cert-manager \
  --from-file=key.json=cert-manager-clouddns-key.json
```

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-clouddns
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - dns01:
        cloudDNS:
          project: my-gcp-project
          serviceAccountSecretRef:
            name: clouddns-dns01-solver-svc-acct
            key: key.json
```

### Cloudflare

```bash
# Create API token with Zone:DNS:Edit permission
kubectl create secret generic cloudflare-api-token \
  --namespace cert-manager \
  --from-literal=api-token=your-cloudflare-api-token
```

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-cloudflare
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - dns01:
        cloudflare:
          email: platform@example.com
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
```

### Multi-Solver Configuration with Domain Selectors

For clusters serving multiple domains hosted on different DNS providers:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    # Route53 for example.com domains
    - selector:
        dnsZones:
        - "example.com"
        - "example.io"
      dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1234567890ABCDEFGHIJ
    # Cloudflare for example.org domains
    - selector:
        dnsZones:
        - "example.org"
      dns01:
        cloudflare:
          email: platform@example.com
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
    # HTTP-01 fallback for everything else
    - http01:
        ingress:
          class: nginx
```

## Wildcard Certificates

Wildcard certificates cover all first-level subdomains of a domain (`*.example.com` matches `api.example.com`, `app.example.com` but not `sub.api.example.com`). They require DNS-01 challenges and are useful for reducing certificate management overhead when running many subdomains.

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: cert-manager
spec:
  secretName: wildcard-example-com-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  commonName: "*.example.com"
  dnsNames:
  - "*.example.com"
  - "example.com"
  duration: 2160h  # 90 days
  renewBefore: 360h  # Renew 15 days before expiry
```

### Sharing Wildcard Certificates Across Namespaces

Wildcard certificates issued in the `cert-manager` namespace can be shared with other namespaces using the `trust-manager` project or by replicating Secrets.

**Using reflector to sync Secrets across namespaces**:

```bash
helm repo add emberstack https://emberstack.github.io/helm-charts
helm install reflector emberstack/reflector \
  --namespace kube-system
```

```yaml
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
      reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "production,staging,development"
      reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  commonName: "*.example.com"
  dnsNames:
  - "*.example.com"
  - "example.com"
```

## TLS Secret Format

cert-manager stores certificates in Kubernetes Secrets of type `kubernetes.io/tls`. The Secret contains three fields:

```
tls.crt  - PEM-encoded certificate chain (leaf + intermediates)
tls.key  - PEM-encoded private key
ca.crt   - PEM-encoded CA certificate (optional, added by cert-manager)
```

### Inspecting a TLS Secret

```bash
# View certificate details
kubectl get secret myapp-tls -n production -o jsonpath='{.data.tls\.crt}' \
  | base64 -d \
  | openssl x509 -noout -text

# Check expiry date
kubectl get secret myapp-tls -n production -o jsonpath='{.data.tls\.crt}' \
  | base64 -d \
  | openssl x509 -noout -enddate

# Verify certificate chain
kubectl get secret myapp-tls -n production -o jsonpath='{.data.tls\.crt}' \
  | base64 -d \
  | openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt
```

### Creating TLS Secrets Manually

For certificates issued outside cert-manager (e.g., from an enterprise CA):

```bash
kubectl create secret tls myapp-tls \
  --namespace production \
  --cert=fullchain.pem \
  --key=privkey.pem
```

## Ingress TLS Configuration

### Basic TLS Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp
  namespace: production
  annotations:
    kubernetes.io/ingress.class: nginx
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  tls:
  - hosts:
    - app.example.com
    secretName: myapp-tls
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: myapp
            port:
              number: 8080
```

When the `cert-manager.io/cluster-issuer` annotation is present, cert-manager automatically creates a Certificate resource for the hostnames listed in `spec.tls`.

### Multiple Domains on One Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: multi-domain
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
  - hosts:
    - api.example.com
    - api.example.io
    secretName: api-multi-tls
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
  - host: api.example.io
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

### Explicitly Managed Certificate Resources

For production environments, prefer explicit Certificate resources over annotation-driven issuance for better visibility and control:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: myapp-tls
  namespace: production
spec:
  secretName: myapp-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  commonName: app.example.com
  dnsNames:
  - app.example.com
  - www.example.com
  duration: 2160h    # 90 days
  renewBefore: 720h  # Renew 30 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always  # Generate new private key on each renewal
  usages:
  - server auth
  - client auth
```

## SNI Routing

Server Name Indication (SNI) allows multiple TLS-enabled virtual hosts to share a single IP address. The Ingress controller uses the SNI hostname in the TLS ClientHello message to select the appropriate certificate before decrypting the connection.

### nginx-ingress SNI Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sni-example
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    # Enable SNI passthrough for backends that handle TLS themselves
    nginx.ingress.kubernetes.io/ssl-passthrough: "false"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - service-a.example.com
    secretName: service-a-tls
  - hosts:
    - service-b.example.com
    secretName: service-b-tls
  rules:
  - host: service-a.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: service-a
            port:
              number: 8080
  - host: service-b.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: service-b
            port:
              number: 8080
```

### SSL Passthrough for mTLS Backends

When backend services require end-to-end TLS (for mutual TLS validation at the application layer):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mtls-passthrough
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
spec:
  ingressClassName: nginx
  rules:
  - host: secure-api.example.com
    http:
      paths:
      - path: /
        pathType: ImplementationSpecific
        backend:
          service:
            name: secure-api
            port:
              number: 443
```

## Mutual TLS (mTLS) at the Ingress Layer

mTLS requires clients to present valid certificates during the TLS handshake. The Ingress controller validates client certificates against a trusted CA.

### Configuring mTLS with nginx-ingress

```bash
# Create CA secret for client certificate validation
kubectl create secret generic client-ca \
  --namespace production \
  --from-file=ca.crt=client-ca.pem
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mtls-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/auth-tls-verify-client: "on"
    nginx.ingress.kubernetes.io/auth-tls-secret: "production/client-ca"
    nginx.ingress.kubernetes.io/auth-tls-verify-depth: "2"
    nginx.ingress.kubernetes.io/auth-tls-pass-certificate-to-upstream: "true"
    nginx.ingress.kubernetes.io/auth-tls-error-page: "https://error.example.com/403"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - secure-api.example.com
    secretName: secure-api-tls
  rules:
  - host: secure-api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: secure-api
            port:
              number: 8080
```

### Issuing Client Certificates with cert-manager

```yaml
# CA Issuer for client certificate issuance
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: client-ca-issuer
  namespace: production
spec:
  ca:
    secretName: client-ca-key-pair

---
# Client certificate for service-to-service auth
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: service-a-client-cert
  namespace: production
spec:
  secretName: service-a-client-tls
  issuerRef:
    name: client-ca-issuer
    kind: Issuer
  commonName: service-a
  dnsNames:
  - service-a.production.svc.cluster.local
  duration: 720h    # 30 days
  renewBefore: 168h # Renew 7 days before expiry
  usages:
  - client auth
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always
```

## Certificate Renewal

cert-manager automatically renews certificates before expiry. The renewal window is controlled by the `renewBefore` field on the Certificate resource. If `renewBefore` is not set, cert-manager defaults to renewing 30 days before the `duration` expires.

### Renewal Timeline for Let's Encrypt (90-day certificates)

```
Day 0:   Certificate issued
Day 60:  cert-manager triggers renewal (30 days before expiry)
Day 75:  Renewal warning alert fires (15 days before expiry)
Day 85:  Critical alert fires (5 days before expiry)
Day 90:  Certificate expires
```

### Forcing a Certificate Renewal

```bash
# Method 1: Delete the managed Secret (cert-manager will re-issue)
kubectl delete secret myapp-tls -n production

# Method 2: Annotate the Certificate to force re-issuance
kubectl annotate certificate myapp-tls \
  -n production \
  cert-manager.io/issue-temporary-certificate="true" \
  --overwrite

# Method 3: Use cmctl (cert-manager CLI)
cmctl renew myapp-tls -n production

# Monitor the renewal process
kubectl get certificate myapp-tls -n production -w
kubectl describe certificaterequest -n production
```

### Certificate Status Conditions

```bash
# Check all certificates in a namespace
kubectl get certificates -n production

# Detailed status
kubectl describe certificate myapp-tls -n production
# Status:
#   Conditions:
#     Last Transition Time:  2027-05-01T10:00:00Z
#     Message:               Certificate is up to date and has not expired
#     Reason:                Ready
#     Status:                True
#     Type:                  Ready
#   Not After:               2027-07-30T10:00:00Z
#   Not Before:              2027-05-01T10:00:00Z
#   Renewal Time:            2027-07-15T10:00:00Z
```

## ZeroSSL and Custom CA Issuers

cert-manager is not limited to Let's Encrypt. Any ACME-compliant CA works with the same configuration, simply by changing the `server` URL.

### ZeroSSL Configuration

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: zerossl-prod
spec:
  acme:
    server: https://acme.zerossl.com/v2/DV90
    email: platform@example.com
    externalAccountBinding:
      keyID: your-zerossl-eab-kid
      keySecretRef:
        name: zerossl-eab-credentials
        key: secret
    privateKeySecretRef:
      name: zerossl-account-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1234567890ABCDEFGHIJ
```

```bash
# Store ZeroSSL EAB secret
kubectl create secret generic zerossl-eab-credentials \
  --namespace cert-manager \
  --from-literal=secret=your-zerossl-eab-hmac-key
```

### Private CA Issuer

For enterprise environments with an internal CA:

```bash
# Import CA certificate and key
kubectl create secret tls internal-ca-key-pair \
  --namespace cert-manager \
  --cert=internal-ca.pem \
  --key=internal-ca-key.pem
```

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: internal-ca
spec:
  ca:
    secretName: internal-ca-key-pair
```

### Vault PKI Issuer

```yaml
# Vault token authentication
apiVersion: v1
kind: Secret
metadata:
  name: vault-token
  namespace: cert-manager
type: Opaque
stringData:
  token: "s.XXXXXXXXXXXXXXXXXXXXXXX"

---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-issuer
spec:
  vault:
    server: https://vault.example.com
    path: pki/sign/my-role
    caBundle: <base64-encoded-vault-ca>
    auth:
      tokenSecretRef:
        name: vault-token
        key: token
```

**Using Kubernetes authentication (recommended)**:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-issuer
spec:
  vault:
    server: https://vault.example.com
    path: pki/sign/kubernetes-role
    caBundle: <base64-encoded-vault-ca>
    auth:
      kubernetes:
        role: cert-manager
        mountPath: /v1/auth/kubernetes
        serviceAccountRef:
          name: cert-manager
```

## Certificate Monitoring and Alerting

### Prometheus Metrics from cert-manager

cert-manager exposes Prometheus metrics at `/metrics` on port 9402:

```
certmanager_certificate_expiration_timestamp_seconds
certmanager_certificate_ready_status
certmanager_http_acme_client_request_count
certmanager_controller_sync_call_count
```

### PrometheusRule for Certificate Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cert-manager-alerts
  namespace: cert-manager
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: cert-manager
    rules:
    - alert: CertificateExpiringSoon
      expr: |
        (certmanager_certificate_expiration_timestamp_seconds - time()) / 86400 < 15
      for: 1h
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Certificate expiring soon: {{ $labels.name }}/{{ $labels.namespace }}"
        description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}."

    - alert: CertificateExpiringCritical
      expr: |
        (certmanager_certificate_expiration_timestamp_seconds - time()) / 86400 < 5
      for: 30m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Certificate expiring critically soon: {{ $labels.name }}/{{ $labels.namespace }}"
        description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}. Immediate action required."

    - alert: CertificateNotReady
      expr: |
        certmanager_certificate_ready_status{condition="False"} == 1
      for: 10m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Certificate not ready: {{ $labels.name }}/{{ $labels.namespace }}"
        description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} has been in a not-ready state for more than 10 minutes."

    - alert: CertificateRenewalFailure
      expr: |
        increase(certmanager_controller_sync_call_count{controller="certificate-trigger"}[1h]) > 10
        and certmanager_certificate_ready_status{condition="False"} == 1
      for: 30m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Certificate renewal failing: {{ $labels.name }}/{{ $labels.namespace }}"
        description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} is repeatedly failing to renew."
```

### Grafana Dashboard Queries

```promql
# Certificates by expiry date (days remaining)
sort_desc(
  (certmanager_certificate_expiration_timestamp_seconds - time()) / 86400
)

# Certificates not ready
count by (namespace) (certmanager_certificate_ready_status{condition="False"} == 1)

# Certificate issuance rate
rate(certmanager_http_acme_client_request_count[5m])

# Failed ACME requests
rate(certmanager_http_acme_client_request_count{status=~"4..|5.."}[5m])
```

### Checking Certificate Health via cmctl

```bash
# Install cmctl
brew install cmctl  # macOS
# or download from https://github.com/cert-manager/cert-manager/releases

# Check all certificates in a namespace
cmctl status certificate myapp-tls -n production

# Inspect the full certificate chain
cmctl inspect secret myapp-tls -n production

# Check what certificates are expiring soon across all namespaces
kubectl get certificate --all-namespaces \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[0].status,EXPIRY:.status.notAfter' \
  | sort -k4
```

## TLS Policy Hardening

### Enforcing Minimum TLS Version

```yaml
# nginx-ingress ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-configuration
  namespace: ingress-nginx
data:
  ssl-protocols: "TLSv1.2 TLSv1.3"
  ssl-ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305"
  ssl-prefer-server-ciphers: "true"
  hsts: "true"
  hsts-max-age: "31536000"
  hsts-include-subdomains: "true"
  hsts-preload: "true"
```

### Per-Ingress TLS Configuration

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: secure-app
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ssl-ciphers: "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384"
    nginx.ingress.kubernetes.io/ssl-protocols: "TLSv1.3"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
      add_header X-Frame-Options DENY always;
      add_header X-Content-Type-Options nosniff always;
      add_header Referrer-Policy "strict-origin-when-cross-origin" always;
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - secure.example.com
    secretName: secure-app-tls
  rules:
  - host: secure.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: secure-app
            port:
              number: 8080
```

## Troubleshooting Certificate Issuance

### Debugging Failed Orders

```bash
# Check Certificate status
kubectl describe certificate myapp-tls -n production

# Check CertificateRequest
kubectl get certificaterequest -n production
kubectl describe certificaterequest myapp-tls-<hash> -n production

# Check ACME Order
kubectl get order -n production
kubectl describe order myapp-tls-<hash>-<hash> -n production

# Check ACME Challenge
kubectl get challenge -n production
kubectl describe challenge myapp-tls-<hash>-<hash>-<hash> -n production
```

### Common Failure Scenarios

**HTTP-01 challenge failing**:
```bash
# Verify the solver pod is running
kubectl get pods -n production -l acme.cert-manager.io/http01-solver=true

# Test the challenge URL manually
curl -v http://app.example.com/.well-known/acme-challenge/<token>

# Check that port 80 is accessible
nmap -p 80 app.example.com

# Verify the Ingress was created for the challenge
kubectl get ingress -n production | grep cm-acme
```

**DNS-01 challenge failing**:
```bash
# Check if TXT record was created
dig TXT _acme-challenge.example.com @8.8.8.8

# Verify credentials secret exists
kubectl get secret route53-credentials -n cert-manager

# Check cert-manager controller logs
kubectl logs -n cert-manager deployment/cert-manager -f | grep -i error

# Check RBAC for cert-manager to read the credentials secret
kubectl auth can-i get secrets \
  --namespace cert-manager \
  --as system:serviceaccount:cert-manager:cert-manager
```

**Rate limit exceeded**:
```bash
# Check if using Let's Encrypt production
kubectl describe clusterissuer letsencrypt-prod

# Switch to staging temporarily
kubectl patch certificate myapp-tls -n production \
  --type merge \
  -p '{"spec":{"issuerRef":{"name":"letsencrypt-staging"}}}'

# Wait until rate limit resets (1 week for certificates/domain)
# Then switch back to production issuer
```

### cert-manager Diagnostics Commands

```bash
# Check controller health
kubectl get pods -n cert-manager
kubectl logs -n cert-manager deployment/cert-manager --tail=100

# Check webhook health
kubectl get pods -n cert-manager -l app.kubernetes.io/component=webhook
kubectl logs -n cert-manager deployment/cert-manager-webhook --tail=50

# Verify CRDs are installed
kubectl get crds | grep cert-manager.io

# Check for any resource errors
kubectl get events -n production --field-selector reason=Failed --sort-by='.lastTimestamp'

# Validate cert-manager installation
cmctl check api
```

## GitOps Integration

When managing certificates via GitOps, define Certificate resources in the repository and allow ArgoCD or Flux to reconcile them:

```yaml
# cert-manager namespace and ClusterIssuer in infrastructure repository
# apps/cert-manager/clusterissuer-prod.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1234567890ABCDEFGHIJ

---
# Application certificate in app repository
# Certificate resources managed by app teams
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: myapp-tls
  namespace: production
  annotations:
    argocd.argoproj.io/sync-wave: "2"
spec:
  secretName: myapp-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - app.example.com
  duration: 2160h
  renewBefore: 720h
```

```yaml
# ArgoCD Application for cert-manager
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
spec:
  project: infrastructure
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager
    targetRevision: v1.14.5
    helm:
      values: |
        installCRDs: true
        replicaCount: 2
        prometheus:
          enabled: true
          servicemonitor:
            enabled: true
  destination:
    server: https://kubernetes.default.svc
    namespace: cert-manager
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ServerSideApply=true
```

## Production Checklist

The following items should be verified before relying on cert-manager for production TLS:

```
Certificate Issuance
[ ] ClusterIssuer tested with staging environment first
[ ] Production ClusterIssuer created after staging validation
[ ] DNS-01 solver configured for wildcard certificates
[ ] Rate limits understood and accounted for in provisioning plans

Certificate Management
[ ] Explicit Certificate resources defined (not just Ingress annotations)
[ ] renewBefore set to at least 30 days before expiry
[ ] rotationPolicy: Always set for private key rotation on renewal
[ ] Certificate duration appropriate for use case

Monitoring
[ ] Prometheus metrics enabled on cert-manager
[ ] ServiceMonitor created for metrics scraping
[ ] Alerts configured for expiry < 15 days (warning) and < 5 days (critical)
[ ] Alerts configured for Certificate not-ready state
[ ] Grafana dashboard deployed for certificate visibility

Security
[ ] TLS 1.2 minimum enforced at Ingress level
[ ] HSTS headers configured
[ ] Private keys stored in Secrets with appropriate RBAC
[ ] IRSA or Workload Identity used instead of static credentials
[ ] cert-manager RBAC follows least-privilege principle

High Availability
[ ] cert-manager deployed with multiple replicas
[ ] webhook deployed with multiple replicas
[ ] PodDisruptionBudget defined for cert-manager components
[ ] Certificate renewal happens well before expiry (buffer for failures)
```
