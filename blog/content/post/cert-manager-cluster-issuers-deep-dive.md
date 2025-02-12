---
title: "Deep Dive into cert-manager and Cluster Issuers in Kubernetes"
date: 2025-02-11T08:21:00-06:00
draft: false
tags: ["Kubernetes", "Security", "cert-manager", "TLS", "ClusterIssuer"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to understanding and implementing cert-manager and Cluster Issuers in Kubernetes"
more_link: "yes"
url: "/cert-manager-deep-dive/"
---

Learn how cert-manager automates certificate management in Kubernetes and how to effectively use Cluster Issuers for TLS certificate automation.

<!--more-->

# [Introduction to cert-manager](#introduction)
cert-manager is a powerful Kubernetes add-on that automates the management and issuance of TLS certificates. It ensures your applications in Kubernetes clusters have up-to-date certificates, supporting various certificate authorities including Let's Encrypt, HashiCorp Vault, and Venafi.

## Why cert-manager?
- Automated certificate management
- Native Kubernetes integration
- Support for multiple certificate authorities
- Automatic renewal handling
- Kubernetes-native API resources

# [Architecture Overview](#architecture)
cert-manager operates through several custom resource definitions (CRDs) and controllers that work together to manage certificates in your cluster.

## Core Components
1. **Certificate Controller**: Watches Certificate resources and ensures they exist and are valid
2. **Issuer Controller**: Manages different certificate authorities
3. **ACME Controller**: Handles ACME challenge solving for Let's Encrypt
4. **Webhook**: Validates custom resources and converts between versions

## Control Flow
1. Certificate request creation
2. Issuer validation
3. Certificate issuance
4. Storage in Kubernetes secrets
5. Automatic renewal monitoring

# [Understanding Cluster Issuers](#cluster-issuers)
ClusterIssuers are cluster-wide resources that define how certificates are obtained.

## Types of Issuers
1. **ACME (Let's Encrypt)**
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - http01:
        ingress:
          class: nginx
```

## ACME Challenge Types

### HTTP01 Challenge
The HTTP01 challenge verifies domain ownership by making the certificate authority check a specific URL on your domain:

1. **How it Works**
   - cert-manager creates a temporary pod and service
   - Configures ingress rule to route challenge URL to the pod
   - Let's Encrypt validates by accessing `/.well-known/acme-challenge/<token>`
   - Challenge is cleaned up after validation

2. **Configuration Example**
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-http01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
    - http01:
        ingress:
          class: nginx
          podTemplate:
            spec:
              nodeSelector:
                kubernetes.io/os: linux
```

3. **Advantages**
   - Simpler setup
   - Works with any publicly accessible domain
   - No DNS provider configuration needed

4. **Limitations**
   - Requires port 80 to be accessible
   - Not suitable for internal/private domains
   - Cannot issue wildcard certificates

### DNS01 Challenge
The DNS01 challenge proves domain ownership by creating specific DNS records:

1. **How it Works**
   - cert-manager creates a TXT record in your DNS zone
   - Let's Encrypt verifies the record
   - Challenge is cleaned up after validation

2. **Advantages**
   - Can issue wildcard certificates
   - Works with internal domains
   - No need for HTTP access

3. **Limitations**
   - Requires DNS provider API access
   - More complex setup
   - DNS propagation delays

## CloudFlare Integration
cert-manager can integrate with CloudFlare for automated DNS management:

1. **API Token Setup**
First, create a CloudFlare API token with the following permissions:
- Zone:Read
- DNS:Edit

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: "your-cloudflare-api-token"
```

2. **ClusterIssuer Configuration**
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-cloudflare
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-cloudflare-key
    solvers:
    - dns01:
        cloudflare:
          email: your-cloudflare-email
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
      selector:
        dnsZones:
          - "example.com"
    - http01:
        ingress:
          class: nginx
```

3. **Wildcard Certificate Example**
```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-example-com
  namespace: default
spec:
  secretName: wildcard-example-com-tls
  commonName: "*.example.com"
  dnsNames:
    - "*.example.com"
    - "example.com"
  issuerRef:
    name: letsencrypt-cloudflare
    kind: ClusterIssuer
```

4. **Best Practices for CloudFlare Integration**
   - Use restricted API tokens instead of Global API keys
   - Implement proper RBAC for API token secrets
   - Consider using separate tokens for different domains
   - Monitor DNS propagation delays
   - Set up alerts for API rate limits

5. **Troubleshooting CloudFlare Integration**
   - Verify API token permissions
   - Check DNS propagation using `dig` or online tools
   - Monitor cert-manager logs for API errors
   - Ensure proper network access to CloudFlare API
   - Validate zone settings in CloudFlare dashboard

## Additional Issuer Types

1. **Self-Signed**
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
```

3. **CA Issuer**
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: ca-issuer
spec:
  ca:
    secretName: ca-key-pair
```

# [Certificate Resources](#certificate-resources)
Certificates in cert-manager are requested using the Certificate CRD.

## Example Certificate Request
```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: example-com
  namespace: default
spec:
  secretName: example-com-tls
  duration: 2160h # 90 days
  renewBefore: 360h # 15 days
  subject:
    organizations:
      - Example Inc.
  commonName: example.com
  dnsNames:
    - example.com
    - www.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

# [Troubleshooting and Best Practices](#troubleshooting)

## Common Issues
1. **ACME Challenge Failures**
   - DNS configuration issues
   - Ingress controller misconfiguration
   - Network connectivity problems

2. **Rate Limiting**
   - Let's Encrypt production rate limits
   - Staging environment for testing

3. **Certificate Renewal Issues**
   - Insufficient permissions
   - Resource constraints
   - DNS propagation delays

## Best Practices
1. **Use Staging Environments First**
   - Test with Let's Encrypt staging
   - Avoid production rate limits
   - Validate configurations safely

2. **Monitor Certificate Status**
   - Set up alerts for expiring certificates
   - Watch for failed renewals
   - Monitor cert-manager logs

3. **Resource Management**
   - Set appropriate CPU/memory limits
   - Configure proper retry intervals
   - Implement proper backup strategies

# [Real-world Use Cases](#use-cases)

## Ingress TLS
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example-ingress
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
  - hosts:
    - example.com
    secretName: example-tls
  rules:
  - host: example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: example-service
            port:
              number: 80
```

## Service Mesh Integration
cert-manager can integrate with service meshes like Istio for automatic sidecar certificate management:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: istio-ca
  namespace: istio-system
spec:
  secretName: istio-ca
  duration: 8760h # 1 year
  renewBefore: 720h # 30 days
  commonName: istio-ca
  isCA: true
  usages:
    - digital signature
    - key encipherment
    - cert sign
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
```

# [Advanced Configuration](#advanced-config)

## High Availability Setup
For production environments, consider running cert-manager in high availability mode:

1. **Multiple Replicas**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cert-manager
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
```

2. **Resource Requests and Limits**
```yaml
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

## Custom ACME Solvers
Configure custom ACME challenge solvers for complex scenarios:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-dns
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-dns-account-key
    solvers:
    - dns01:
        cloudflare:
          email: your-cloudflare-email
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
      selector:
        dnsZones:
          - "example.com"
```

# [Monitoring and Metrics](#monitoring)

## Prometheus Metrics
cert-manager exposes various Prometheus metrics that help monitor the health and performance of your certificate management system:

1. **Certificate Metrics**
```
# Certificate expiration timestamp in seconds since epoch
certmanager_certificate_expiration_timestamp_seconds

# Certificate ready status (1 for ready, 0 for not ready)
certmanager_certificate_ready_status

# Time until certificate renewal
certmanager_certificate_renewal_timestamp_seconds
```

2. **ACME Client Metrics**
```
# Total number of ACME HTTP01 challenges
certmanager_http01_challenges_total

# ACME DNS01 challenge processing time
certmanager_dns01_challenge_duration_seconds

# ACME order processing duration
certmanager_acme_order_processing_seconds
```

## Grafana Dashboard
Here's an example Grafana dashboard configuration for cert-manager monitoring:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cert-manager-dashboard
  namespace: monitoring
data:
  cert-manager-dashboard.json: |
    {
      "annotations": {
        "list": []
      },
      "panels": [
        {
          "title": "Certificates Expiring Soon",
          "type": "gauge",
          "datasource": "Prometheus",
          "targets": [
            {
              "expr": "sum(certmanager_certificate_expiration_timestamp_seconds - time()) < 604800"
            }
          ]
        },
        {
          "title": "Certificate Renewal Status",
          "type": "table",
          "datasource": "Prometheus",
          "targets": [
            {
              "expr": "certmanager_certificate_ready_status"
            }
          ]
        }
      ]
    }
```

## Alerting Rules
Implement these Prometheus alerting rules to proactively monitor certificate status:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cert-manager-alerts
  namespace: cert-manager
spec:
  groups:
  - name: cert-manager
    rules:
    - alert: CertificateExpiringSoon
      expr: |
        avg by (name, namespace) (
          certmanager_certificate_expiration_timestamp_seconds - time()
        ) < (21 * 24 * 60 * 60)
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} is expiring soon"
        description: "Certificate will expire in less than 21 days"

    - alert: CertificateRenewalFailure
      expr: |
        increase(certmanager_certificate_renewal_errors_total[2h]) > 0
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Certificate renewal failed for {{ $labels.name }}"
        description: "Certificate renewal has failed in the last 2 hours"

    - alert: CertManagerPodNotReady
      expr: |
        kube_pod_container_status_ready{namespace="cert-manager"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "cert-manager pod not ready"
        description: "cert-manager pod has not been ready for 5 minutes"
```

## Performance Monitoring
Monitor these key performance indicators:

1. **Resource Usage**
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: cert-manager
  namespace: cert-manager
spec:
  selector:
    matchLabels:
      app: cert-manager
  podMetricsEndpoints:
  - port: metrics
    interval: 30s
```

2. **Key Metrics to Watch**
- CPU and Memory usage
- Goroutine count
- Request latency
- Error rates
- Certificate processing time

## Logging Configuration
Enhanced logging configuration for better monitoring:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cert-manager-config
  namespace: cert-manager
data:
  config.yaml: |
    log-level: debug
    feature-gates: AdditionalCertificateOutputFormats=true
    metrics:
      enabled: true
      prometheus:
        enabled: true
        port: 9402
    webhook:
      metrics:
        enabled: true
        port: 9403
    controller:
      metrics:
        enabled: true
        port: 9404
```

# Conclusion
cert-manager is a crucial tool for managing certificates in Kubernetes environments. By understanding its architecture, properly configuring Cluster Issuers, and following best practices, you can ensure secure and automated certificate management for your applications.

Remember to:
- Start with staging environments
- Monitor certificate status and metrics
- Plan for high availability
- Keep up with cert-manager updates
- Implement proper backup strategies
- Set up comprehensive monitoring and alerting

These practices will help maintain a robust and secure certificate management system in your Kubernetes clusters.
