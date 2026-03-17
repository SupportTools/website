---
title: "Kubernetes Cert-Manager ACME: Wildcard Certificates and DNS-01 Challenge Automation"
date: 2030-12-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cert-Manager", "ACME", "TLS", "DNS", "Route53", "Cloudflare", "Let's Encrypt"]
categories:
- Kubernetes
- Security
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to cert-manager ACME wildcard certificate automation using DNS-01 challenges with Route53 and Cloudflare, covering certificate rotation, multi-domain SANs, and troubleshooting ACME failures in production Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-cert-manager-acme-wildcard-dns01-automation/"
---

Wildcard TLS certificates solve a fundamental challenge in large Kubernetes deployments: managing individual certificates for dozens or hundreds of subdomains becomes operationally unsustainable. The ACME DNS-01 challenge protocol enables automated wildcard certificate issuance from Let's Encrypt and other ACME providers, but getting the configuration right requires understanding the interaction between cert-manager, DNS providers, and certificate lifecycle management. This guide covers everything you need to deploy production-grade wildcard certificate automation.

<!--more-->

# Kubernetes Cert-Manager ACME: Wildcard Certificates and DNS-01 Challenge Automation

## Understanding DNS-01 vs HTTP-01 Challenges

Before diving into configuration, it is essential to understand why wildcard certificates require DNS-01 and when each challenge type is appropriate.

### HTTP-01 Challenge Mechanics

The HTTP-01 challenge works by placing a file at a well-known URL path (`/.well-known/acme-challenge/<token>`) and having the ACME server verify it over HTTP. This approach has several limitations:

- Requires port 80 to be publicly accessible
- Cannot issue wildcard certificates (`*.example.com`)
- Requires individual challenges per subdomain
- Does not work for internal-only services without public HTTP endpoints
- Fails behind certain CDN configurations

### DNS-01 Challenge Mechanics

The DNS-01 challenge works by creating a TXT record (`_acme-challenge.example.com`) with a specific value and having the ACME server perform a DNS lookup to verify ownership. This approach:

- Works for wildcard certificates
- Works for internal services with no public HTTP access
- Requires DNS provider API access
- Has a higher propagation delay (DNS TTL dependent)
- Requires careful handling of DNS propagation timing

For enterprise Kubernetes deployments, DNS-01 is almost always the correct choice because it enables wildcard certificates and works regardless of network topology.

## Installing and Configuring Cert-Manager

### Installation via Helm

```bash
# Add the cert-manager Helm repository
helm repo add jetstack https://charts.jetstack.io
helm repo update

# Create the cert-manager namespace
kubectl create namespace cert-manager

# Install cert-manager with CRDs
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --version v1.14.5 \
  --set installCRDs=true \
  --set prometheus.enabled=true \
  --set prometheus.servicemonitor.enabled=true \
  --set webhook.timeoutSeconds=30 \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=128Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=256Mi \
  --set cainjector.resources.requests.cpu=100m \
  --set cainjector.resources.requests.memory=128Mi \
  --set cainjector.resources.limits.cpu=500m \
  --set cainjector.resources.limits.memory=256Mi
```

### Verifying the Installation

```bash
# Check that all cert-manager pods are running
kubectl get pods -n cert-manager

# Verify CRDs are installed
kubectl get crd | grep cert-manager

# Run the cert-manager verification tool
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.5/cert-manager.crds.yaml
```

Expected output:
```
NAME                                       READY   STATUS    RESTARTS   AGE
cert-manager-5c7b7f5c6b-xk9j2             1/1     Running   0          2m
cert-manager-cainjector-7b64d9b6c-p9kl8   1/1     Running   0          2m
cert-manager-webhook-7f9d8b7c4-m2np1      1/1     Running   0          2m
```

## Route53 DNS-01 Solver Configuration

AWS Route53 is the most common DNS provider in enterprise environments. Cert-manager supports Route53 through IAM credentials or IRSA (IAM Roles for Service Accounts).

### IAM Policy for Route53

Create the minimum-privilege IAM policy for cert-manager:

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

### IRSA Configuration for EKS

For EKS clusters, IRSA is the preferred approach as it avoids storing long-term credentials:

```bash
# Create the IAM role with OIDC trust
eksctl create iamserviceaccount \
  --cluster=my-cluster \
  --namespace=cert-manager \
  --name=cert-manager \
  --attach-policy-arn=arn:aws:iam::123456789012:policy/CertManagerRoute53Policy \
  --override-existing-serviceaccounts \
  --approve
```

Then configure cert-manager to use the annotated service account:

```yaml
# values.yaml for cert-manager Helm chart
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/cert-manager-route53"

securityContext:
  fsGroup: 1001

extraArgs:
  - --issuer-ambient-credentials=true
```

### ClusterIssuer with Route53

```yaml
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
          hostedZoneID: Z1PA6795UKMFR9
          # For IRSA, omit accessKeyID and secretAccessKeySecretRef
          # For static credentials, use:
          # accessKeyID: <aws-access-key-id>
          # secretAccessKeySecretRef:
          #   name: route53-credentials
          #   key: secret-access-key
      selector:
        dnsZones:
        - "example.com"
```

For static credential scenarios (non-EKS or on-premises):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: route53-credentials
  namespace: cert-manager
type: Opaque
stringData:
  secret-access-key: "<aws-secret-access-key>"
```

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-route53-static
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
          hostedZoneID: Z1PA6795UKMFR9
          accessKeyID: <aws-access-key-id>
          secretAccessKeySecretRef:
            name: route53-credentials
            key: secret-access-key
```

## Cloudflare DNS-01 Solver Configuration

Cloudflare is widely used in organizations that rely on its CDN and DDoS protection. Cert-manager supports both API Token and Global API Key authentication, with API Tokens being the recommended approach.

### Creating a Cloudflare API Token

In the Cloudflare dashboard, create an API token with the following permissions:
- Zone: Zone: Read
- Zone: DNS: Edit
- Zone Resources: Include - Specific zone - example.com

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: "<cloudflare-api-token>"
```

### ClusterIssuer with Cloudflare

```yaml
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
            name: cloudflare-api-token
            key: api-token
      selector:
        dnsZones:
        - "example.com"
        - "example.net"
```

### Using a Staging Issuer for Testing

Always test with the Let's Encrypt staging environment before production to avoid rate limits:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging-cloudflare
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-staging-cloudflare-account-key
    solvers:
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
```

## Wildcard Certificate Issuance

### Single Wildcard Certificate

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: default
spec:
  secretName: wildcard-example-com-tls
  issuerRef:
    name: letsencrypt-prod-route53
    kind: ClusterIssuer
  commonName: "*.example.com"
  dnsNames:
  - "*.example.com"
  - "example.com"
  duration: 2160h   # 90 days
  renewBefore: 720h  # Renew 30 days before expiry
  privateKey:
    algorithm: RSA
    encoding: PKCS1
    size: 2048
  usages:
  - digital signature
  - key encipherment
  - server auth
```

### Multi-Domain Wildcard with SANs

For organizations with multiple domains or complex subdomain structures:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: multi-domain-wildcard
  namespace: ingress-nginx
spec:
  secretName: multi-domain-wildcard-tls
  issuerRef:
    name: letsencrypt-prod-cloudflare
    kind: ClusterIssuer
  commonName: "*.example.com"
  dnsNames:
  # Primary wildcard
  - "*.example.com"
  - "example.com"
  # Secondary domain wildcards
  - "*.api.example.com"
  - "*.internal.example.com"
  - "*.staging.example.com"
  # Additional top-level domains
  - "*.example.net"
  - "example.net"
  - "*.example.org"
  - "example.org"
  duration: 2160h
  renewBefore: 720h
  privateKey:
    algorithm: ECDSA
    size: 256
```

Note: Let's Encrypt limits certificates to 100 SANs maximum. ECDSA P-256 is recommended for modern deployments as it provides equivalent security to RSA-2048 with smaller key sizes and faster TLS handshakes.

### Cross-Namespace Certificate Sharing with Reflector

Wildcard certificates are often needed across multiple namespaces. The `reflector` controller or cert-manager's own `secretTemplate` can help:

```bash
# Install kubernetes-reflector
helm repo add emberstack https://emberstack.github.io/helm-charts
helm install reflector emberstack/reflector \
  --namespace kube-system
```

Then annotate the certificate secret to be reflected:

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
      reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "default,production,staging,ingress-nginx"
      reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
  issuerRef:
    name: letsencrypt-prod-route53
    kind: ClusterIssuer
  dnsNames:
  - "*.example.com"
  - "example.com"
  duration: 2160h
  renewBefore: 720h
```

## Certificate Rotation Without Downtime

### Understanding Cert-Manager's Renewal Process

Cert-manager uses a controller-based approach that continuously reconciles the desired state:

1. Certificate controller monitors certificate objects
2. When `renewBefore` threshold is reached, a new `CertificateRequest` is created
3. The ACME challenge is completed
4. New certificate is stored in the secret
5. Kubernetes automatically serves the new certificate at the next TLS handshake

### Configuring Pre-Rotation Hooks

For stateful applications that cache TLS certificates in memory, you may need to trigger pod restarts after rotation:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cert-rotation-notifier
  namespace: cert-manager
spec:
  schedule: "0 */12 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: cert-rotation-notifier
          restartPolicy: OnFailure
          containers:
          - name: notifier
            image: bitnami/kubectl:latest
            command:
            - /bin/sh
            - -c
            - |
              # Check if certificate was renewed in the last 24 hours
              CERT_CREATED=$(kubectl get secret wildcard-example-com-tls \
                -n default \
                -o jsonpath='{.metadata.creationTimestamp}')

              CERT_AGE_SECONDS=$(( $(date +%s) - $(date -d "${CERT_CREATED}" +%s) ))

              if [ "$CERT_AGE_SECONDS" -lt 86400 ]; then
                echo "Certificate was recently renewed, triggering rolling restart"
                kubectl rollout restart deployment/nginx-app -n production
                kubectl rollout restart deployment/api-server -n production
              fi
```

### Zero-Downtime Verification with PodDisruptionBudgets

Ensure rolling restarts do not cause downtime:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: nginx-app-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: nginx-app
```

### Using cert-manager-csi-driver for Ephemeral Certificates

For the most seamless certificate management, use the cert-manager CSI driver to mount certificates directly into pods:

```bash
helm install cert-manager-csi-driver jetstack/cert-manager-csi-driver \
  --namespace cert-manager
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-application
  namespace: production
spec:
  template:
    spec:
      containers:
      - name: app
        image: my-app:latest
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
            csi.cert-manager.io/issuer-name: letsencrypt-prod-cloudflare
            csi.cert-manager.io/issuer-kind: ClusterIssuer
            csi.cert-manager.io/dns-names: "${POD_NAME}.${POD_NAMESPACE}.svc.cluster.local"
            csi.cert-manager.io/certificate-file: tls.crt
            csi.cert-manager.io/privatekey-file: tls.key
```

## Advanced DNS Solver Configuration

### Handling Multiple Hosted Zones

When managing certificates across multiple DNS zones, use solver selectors:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-multi-zone
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certs@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    # Production domains - Route53
    - dns01:
        route53:
          region: us-east-1
          hostedZoneID: Z1PA6795UKMFR9
      selector:
        dnsZones:
        - "example.com"
    # CDN domains - Cloudflare
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
      selector:
        dnsZones:
        - "cdn.example.com"
        - "static.example.com"
    # Catch-all solver for other domains
    - dns01:
        route53:
          region: us-west-2
          hostedZoneID: Z2UKMFR9PA6795
      selector:
        matchLabels:
          use-secondary-zone: "true"
```

### DNS Propagation Timing Configuration

A common issue with DNS-01 challenges is propagation timing. Configure appropriate wait times:

```bash
# Add to cert-manager deployment args
--dns01-recursive-nameservers-only=true
--dns01-recursive-nameservers=8.8.8.8:53,1.1.1.1:53
```

Or via Helm values:

```yaml
extraArgs:
  - --dns01-recursive-nameservers-only=true
  - --dns01-recursive-nameservers=8.8.8.8:53,1.1.1.1:53
```

For Route53, you can also configure the propagation timeout at the issuer level:

```yaml
solvers:
- dns01:
    route53:
      region: us-east-1
      hostedZoneID: Z1PA6795UKMFR9
    cnameStrategy: Follow
```

## Certificate Ingress Automation

### Annotating Ingress Resources

Rather than creating Certificate resources manually, annotate Ingress resources and let cert-manager create the certificates automatically:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-application
  namespace: production
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod-route53"
    cert-manager.io/common-name: "app.example.com"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - app.example.com
    secretName: app-example-com-tls
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-application
            port:
              number: 8080
```

### Using the Wildcard Certificate with Ingress

To use a pre-issued wildcard certificate with Ingress resources:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-service
  namespace: production
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - api.example.com
    secretName: wildcard-example-com-tls  # Pre-issued wildcard
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

## Troubleshooting ACME Failures

### Diagnostic Workflow

When a certificate fails to issue, follow this systematic diagnostic process:

```bash
# Step 1: Check certificate status
kubectl describe certificate wildcard-example-com -n default

# Step 2: Check certificate requests
kubectl get certificaterequests -n default
kubectl describe certificaterequest wildcard-example-com-XXXXX -n default

# Step 3: Check ACME orders
kubectl get orders -n default
kubectl describe order wildcard-example-com-XXXXX-YYYYY -n default

# Step 4: Check challenges
kubectl get challenges -n default
kubectl describe challenge wildcard-example-com-XXXXX-YYYYY-ZZZZZ -n default

# Step 5: Check cert-manager logs
kubectl logs -n cert-manager deployment/cert-manager -f
kubectl logs -n cert-manager deployment/cert-manager --previous
```

### Common Error: DNS Record Not Propagated

```
Error: Failed to perform self check GET request ... NXDOMAIN
```

This typically means DNS propagation has not completed. Solutions:

```bash
# Manually verify the DNS challenge record exists
dig TXT _acme-challenge.example.com @8.8.8.8

# If record is missing, check Route53/Cloudflare for the record
# Check cert-manager logs for API errors

# Increase DNS propagation check interval
kubectl edit deployment cert-manager -n cert-manager
# Add: --dns01-check-retry-period=10s (default is 10s, try 60s)
```

### Common Error: Rate Limiting

Let's Encrypt enforces strict rate limits:
- 50 certificates per registered domain per week
- 5 failed validation attempts per account per hour per domain

```bash
# Check current rate limit status (staging has no rate limits)
# Switch to staging issuer for testing:
kubectl patch ingress my-application -n production \
  --type='json' \
  -p='[{"op": "replace", "path": "/metadata/annotations/cert-manager.io~1cluster-issuer", "value":"letsencrypt-staging-cloudflare"}]'
```

### Common Error: ACME Account Key Issues

```
Error: acme: urn:ietf:params:acme:error:accountDoesNotExist
```

The ACME account key secret was likely deleted or corrupted:

```bash
# Delete the account key to force re-registration
kubectl delete secret letsencrypt-prod-account-key -n cert-manager

# Cert-manager will automatically create a new account key
# and re-register with the ACME server
```

### Common Error: DNS Solver Permission Issues

```
Error: unable to list Route53 resource record sets: AccessDenied
```

Verify IAM permissions:

```bash
# Test Route53 access from a pod
kubectl run -it --rm --restart=Never dns-test \
  --image=amazon/aws-cli \
  --serviceaccount=cert-manager \
  -n cert-manager \
  -- route53 list-resource-record-sets \
     --hosted-zone-id Z1PA6795UKMFR9 \
     --query "ResourceRecordSets[?Name=='_acme-challenge.example.com.']"
```

### Debugging Certificate State Machine

Cert-manager uses a state machine with these states:

```
Certificate -> CertificateRequest -> Order -> Challenge(s) -> DNS record -> Verification -> Issued
```

Each transition can fail. Use this script to get a complete diagnostic dump:

```bash
#!/bin/bash
CERT_NAME="${1:-wildcard-example-com}"
NAMESPACE="${2:-default}"

echo "=== Certificate Status ==="
kubectl get certificate "$CERT_NAME" -n "$NAMESPACE" -o yaml

echo ""
echo "=== Certificate Request Status ==="
CR_NAME=$(kubectl get certificaterequest -n "$NAMESPACE" \
  -l cert-manager.io/certificate-name="$CERT_NAME" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

if [ -n "$CR_NAME" ]; then
  kubectl describe certificaterequest "$CR_NAME" -n "$NAMESPACE"
fi

echo ""
echo "=== Order Status ==="
ORDER_NAME=$(kubectl get order -n "$NAMESPACE" \
  -l cert-manager.io/certificate-name="$CERT_NAME" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

if [ -n "$ORDER_NAME" ]; then
  kubectl describe order "$ORDER_NAME" -n "$NAMESPACE"
fi

echo ""
echo "=== Challenge Status ==="
kubectl get challenges -n "$NAMESPACE" \
  -l cert-manager.io/certificate-name="$CERT_NAME" \
  -o wide

echo ""
echo "=== Recent Cert-Manager Events ==="
kubectl get events -n cert-manager --sort-by='.lastTimestamp' | tail -20

echo ""
echo "=== Cert-Manager Controller Logs (last 100 lines) ==="
kubectl logs -n cert-manager deployment/cert-manager --tail=100
```

## Monitoring and Alerting

### Prometheus Metrics

Cert-manager exposes Prometheus metrics for certificate monitoring:

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
    interval: 1m
    rules:
    - alert: CertificateExpiringSoon
      expr: |
        certmanager_certificate_expiration_timestamp_seconds
        - time() < 30 * 24 * 3600
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} expires in less than 30 days"
        description: "Certificate expires at {{ $value | humanizeTimestamp }}"

    - alert: CertificateExpiryCritical
      expr: |
        certmanager_certificate_expiration_timestamp_seconds
        - time() < 7 * 24 * 3600
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Certificate {{ $labels.name }} expires in less than 7 days"

    - alert: CertificateNotReady
      expr: |
        certmanager_certificate_ready_status{condition="False"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} is not ready"

    - alert: ACMEAccountNotRegistered
      expr: |
        certmanager_acme_client_request_count{status="error"} > 5
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "High ACME error rate detected"
```

### Grafana Dashboard for Certificate Lifecycle

```bash
# Install the cert-manager Grafana dashboard
kubectl apply -f https://raw.githubusercontent.com/cert-manager/cert-manager/main/deploy/grafana/dashboards/cert-manager.json
```

Key metrics to monitor:
- `certmanager_certificate_expiration_timestamp_seconds`: When each certificate expires
- `certmanager_certificate_ready_status`: Certificate readiness (True/False/Unknown)
- `certmanager_acme_client_request_count`: ACME API request counts by status
- `certmanager_controller_sync_call_count`: Controller reconciliation frequency

## Production Best Practices

### Certificate Resource Organization

```yaml
# Use a dedicated namespace for shared certificates
apiVersion: v1
kind: Namespace
metadata:
  name: tls-secrets
  labels:
    cert-manager-control: enabled
```

### Backup and Recovery

```bash
# Backup all certificate secrets
kubectl get secrets -A -l 'cert-manager.io/certificate-name' \
  -o yaml > cert-secrets-backup.yaml

# Backup all cert-manager CRD objects
for crd in certificates certificaterequests orders challenges; do
  kubectl get "$crd" -A -o yaml > "cert-manager-${crd}-backup.yaml"
done

# Restore certificates after cluster recreation
kubectl apply -f cert-secrets-backup.yaml
```

### High Availability Cert-Manager Configuration

```yaml
# cert-manager HA configuration
replicaCount: 2

podDisruptionBudget:
  enabled: true
  minAvailable: 1

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchExpressions:
          - key: app.kubernetes.io/name
            operator: In
            values:
            - cert-manager
        topologyKey: kubernetes.io/hostname
```

### Certificate Audit Trail

```bash
# Generate a report of all certificates and their expiry dates
kubectl get certificates -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[0].status,EXPIRY:.status.notAfter,ISSUER:.spec.issuerRef.name' \
  | sort -k4
```

## Summary

Production wildcard certificate automation with cert-manager and DNS-01 challenges provides a robust, self-managing TLS infrastructure. The key operational considerations are:

- Use IRSA or workload identity instead of static credentials where possible
- Always test with staging issuers before production to avoid rate limits
- Configure appropriate DNS propagation timeouts for your DNS provider
- Monitor certificate expiry with Prometheus alerts at 30 days and 7 days
- Implement cross-namespace certificate sharing using reflector for shared wildcard certificates
- Maintain certificate backups separate from cluster state
- Use the cert-manager CSI driver for applications that require automatic certificate rotation without pod restarts

The combination of wildcard certificates, automated renewal, and proper monitoring eliminates the manual certificate management burden that traditionally consumed significant operational overhead in large Kubernetes deployments.
