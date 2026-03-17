---
title: "Kubernetes External DNS Operator: Route53, Cloudflare, GCP Cloud DNS, Ownership Annotations, and Sync Policies"
date: 2032-01-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ExternalDNS", "DNS", "Route53", "Cloudflare", "GCP", "Networking", "GitOps"]
categories:
- Kubernetes
- Networking
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-ready enterprise guide to deploying and configuring the ExternalDNS operator for automatic DNS record management across AWS Route53, Cloudflare, and GCP Cloud DNS with proper ownership isolation."
more_link: "yes"
url: "/kubernetes-external-dns-operator-route53-cloudflare-gcp-enterprise-guide/"
---

Manual DNS record management at scale is an operational liability. Every service deployment, load balancer recreation, or ingress controller update that requires a human to update DNS introduces delay, errors, and drift between the desired and actual state. ExternalDNS, a Kubernetes operator maintained by the kubernetes-sigs community, solves this by watching Kubernetes resources (Services, Ingresses, and custom sources) and automatically reconciling DNS records in your authoritative provider. This guide covers production deployment patterns across AWS Route53, Cloudflare, and GCP Cloud DNS, with deep attention to the ownership model, RBAC, and multi-tenant isolation.

<!--more-->

# Kubernetes ExternalDNS Operator: Enterprise Production Guide

## Architecture Overview

ExternalDNS operates as a single-binary controller that:

1. **Watches** Kubernetes resources (Services with `type: LoadBalancer`, Ingress, Gateway API, CRD sources)
2. **Extracts** desired DNS endpoints from resource annotations and spec fields
3. **Queries** the configured DNS provider for the current state
4. **Reconciles** differences, creating/updating/deleting records
5. **Records ownership** via TXT records to prevent accidental deletion of records owned by other systems

```
┌─────────────────────────────────────────┐
│  Kubernetes API                         │
│  - Ingress (kubernetes.io/ingress.class)│
│  - Service (type: LoadBalancer)         │
│  - HTTPRoute (Gateway API)              │
│  - CRDSource (DNSEndpoint)              │
└─────────────────────┬───────────────────┘
                      │ Watch + List
                      ▼
         ┌────────────────────────┐
         │  ExternalDNS Controller│
         │  - Source plugins      │
         │  - Registry (TXT)      │
         │  - Plan (diff engine)  │
         └─────────────┬──────────┘
                       │ CRUD DNS records
           ┌───────────┼────────────────┐
           ▼           ▼                ▼
     AWS Route53   Cloudflare      GCP Cloud DNS
```

## Deployment Options

### Helm Chart Installation (Recommended)

```bash
# Add the bitnami chart repository (includes ExternalDNS)
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Or use the kubernetes-sigs maintained chart
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm repo update
```

### Namespace and RBAC Setup

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: external-dns
  labels:
    app.kubernetes.io/name: external-dns
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

```yaml
# rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-dns
  namespace: external-dns
  annotations:
    # For AWS IRSA (IAM Roles for Service Accounts)
    eks.amazonaws.com/role-arn: arn:aws:iam::<account-id>:role/external-dns
    # For GCP Workload Identity
    iam.gke.io/gcp-service-account: external-dns@<project-id>.iam.gserviceaccount.com
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: external-dns
rules:
  - apiGroups: [""]
    resources: ["services", "endpoints", "pods", "nodes"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["extensions", "networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways", "httproutes", "grpcroutes", "tlsroutes", "tcproutes", "udproutes"]
    verbs: ["get", "watch", "list"]
  # For CRDSource (DNSEndpoint)
  - apiGroups: ["externaldns.k8s.io"]
    resources: ["dnsendpoints"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["externaldns.k8s.io"]
    resources: ["dnsendpoints/status"]
    verbs: ["update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: external-dns
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: external-dns
subjects:
  - kind: ServiceAccount
    name: external-dns
    namespace: external-dns
```

## Part 1: AWS Route53 Integration

### IAM Policy for ExternalDNS

Create a least-privilege IAM policy. Never use `AdministratorAccess` or broad Route53 permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "route53:ChangeResourceRecordSets"
      ],
      "Resource": [
        "arn:aws:route53:::hostedzone/<hosted-zone-id>"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "route53:ListHostedZones",
        "route53:ListResourceRecordSets",
        "route53:ListTagsForResource"
      ],
      "Resource": ["*"]
    }
  ]
}
```

### IRSA Setup (Recommended Over Static Keys)

```bash
# Create OIDC provider for your EKS cluster (if not already done)
eksctl utils associate-iam-oidc-provider \
    --cluster my-cluster \
    --region us-east-1 \
    --approve

# Get OIDC issuer URL
OIDC_ISSUER=$(aws eks describe-cluster \
    --name my-cluster \
    --region us-east-1 \
    --query "cluster.identity.oidc.issuer" \
    --output text | sed 's|https://||')

echo "OIDC Issuer: $OIDC_ISSUER"

# Create IAM role with trust policy
cat > trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/${OIDC_ISSUER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_ISSUER}:sub": "system:serviceaccount:external-dns:external-dns",
          "${OIDC_ISSUER}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
    --role-name external-dns \
    --assume-role-policy-document file://trust-policy.json

aws iam put-role-policy \
    --role-name external-dns \
    --policy-name external-dns-policy \
    --policy-document file://external-dns-policy.json
```

### Route53 Helm Values

```yaml
# values-route53.yaml
image:
  repository: registry.k8s.io/external-dns/external-dns
  tag: v0.14.2
  pullPolicy: IfNotPresent

serviceAccount:
  create: false
  name: external-dns

rbac:
  create: false

resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 256Mi

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring

# Core ExternalDNS arguments
extraArgs:
  # DNS provider
  - --provider=aws
  # Only manage records in specific hosted zones
  - --aws-zone-id=<hosted-zone-id>
  # OR filter by zone type
  - --aws-zone-type=public
  # OR filter by domain name (supports wildcards)
  - --domain-filter=example.com
  - --domain-filter=internal.example.com
  # Ownership tracking - CRITICAL for multi-system safety
  - --txt-owner-id=my-cluster-prod
  - --txt-prefix=edns-
  # Sync policy: sync (default), upsert-only, create-only
  - --policy=upsert-only
  # Sources to watch
  - --source=ingress
  - --source=service
  - --source=gateway-httproute
  # Annotation filter: only manage resources with this annotation
  - --annotation-filter=external-dns.alpha.kubernetes.io/managed=true
  # Log level
  - --log-level=info
  - --log-format=json
  # Interval between full synchronizations
  - --interval=1m
  # AWS-specific
  - --aws-batch-change-size=4000
  - --aws-evaluate-target-health=true
  # Registry type (txt = default, dynamodb for high-scale)
  - --registry=txt

env:
  - name: AWS_DEFAULT_REGION
    value: us-east-1

podSecurityContext:
  runAsNonRoot: true
  seccompProfile:
    type: RuntimeDefault

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  capabilities:
    drop: ["ALL"]

tolerations:
  - key: "kubernetes.io/arch"
    operator: "Equal"
    value: "amd64"
    effect: "NoSchedule"

priorityClassName: system-cluster-critical

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "7979"
  prometheus.io/path: "/metrics"
```

```bash
helm install external-dns external-dns/external-dns \
    --namespace external-dns \
    --create-namespace \
    --values values-route53.yaml \
    --version 1.14.3
```

### Route53 Annotations on Kubernetes Resources

```yaml
# Ingress with full Route53 control
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp
  namespace: production
  annotations:
    # Required: mark for ExternalDNS management
    external-dns.alpha.kubernetes.io/managed: "true"
    # Optional: override hostname (defaults to spec.rules[].host)
    external-dns.alpha.kubernetes.io/hostname: "myapp.example.com,www.myapp.example.com"
    # Set TTL (seconds)
    external-dns.alpha.kubernetes.io/ttl: "300"
    # Route53 routing policy: simple (default), weighted, latency, failover, geolocation
    external-dns.alpha.kubernetes.io/aws-weight: "100"
    # AWS alias record (maps to ELB/CloudFront)
    external-dns.alpha.kubernetes.io/aws-alias: "true"
    # Health check integration
    external-dns.alpha.kubernetes.io/aws-health-check-id: "<health-check-id>"
spec:
  ingressClassName: nginx
  rules:
    - host: myapp.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: myapp
                port:
                  number: 80
```

```yaml
# LoadBalancer Service with DNS annotation
apiVersion: v1
kind: Service
metadata:
  name: myapp-lb
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/managed: "true"
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    external-dns.alpha.kubernetes.io/ttl: "60"
spec:
  type: LoadBalancer
  selector:
    app: myapp
  ports:
    - port: 443
      targetPort: 8443
```

## Part 2: Cloudflare Integration

### Cloudflare API Token (Least Privilege)

Never use the global API key. Create a scoped API token:

1. Go to Cloudflare Dashboard → Profile → API Tokens → Create Token
2. Use the "Edit zone DNS" template
3. Scope to specific zones (your domains only)
4. Set IP allowlist if possible

Required permissions:
- Zone → DNS → Edit
- Zone → Zone → Read

```bash
# Create Kubernetes secret for Cloudflare token
kubectl create secret generic cloudflare-api-token \
    --from-literal=cloudflare_api_token=<your-api-token> \
    --namespace external-dns
```

### Cloudflare Helm Values

```yaml
# values-cloudflare.yaml
extraArgs:
  - --provider=cloudflare
  # Filter by specific zone (Cloudflare zone ID or domain name)
  - --zone-id-filter=<cloudflare-zone-id>
  - --domain-filter=example.com
  # Ownership tracking
  - --txt-owner-id=my-cluster-prod
  - --txt-prefix=edns-
  # Cloudflare proxying: set to true to enable CDN/DDoS protection
  - --cloudflare-proxied=false
  # Sync policy
  - --policy=sync
  # Sources
  - --source=ingress
  - --source=service
  - --source=crd
  - --log-level=info
  - --log-format=json

env:
  - name: CF_API_TOKEN
    valueFrom:
      secretKeyRef:
        name: cloudflare-api-token
        key: cloudflare_api_token
```

### Proxied vs Unproxied Records

```yaml
# Enable Cloudflare proxy (orange cloud) for a specific ingress
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-frontend
  annotations:
    external-dns.alpha.kubernetes.io/managed: "true"
    # Override global --cloudflare-proxied=false for this resource
    external-dns.alpha.kubernetes.io/cloudflare-proxied: "true"
    external-dns.alpha.kubernetes.io/ttl: "1"  # Auto TTL when proxied
```

## Part 3: GCP Cloud DNS Integration

### Workload Identity Setup

```bash
# Enable required APIs
gcloud services enable dns.googleapis.com
gcloud services enable iamcredentials.googleapis.com

# Create GCP service account
gcloud iam service-accounts create external-dns \
    --display-name="ExternalDNS for GKE cluster" \
    --project=<project-id>

# Grant DNS admin permission on specific managed zone(s)
gcloud dns managed-zones list --project=<project-id>

# Option A: Grant on specific zone only (recommended)
gcloud dns managed-zones add-iam-policy-binding example-com-zone \
    --member="serviceAccount:external-dns@<project-id>.iam.gserviceaccount.com" \
    --role="roles/dns.admin" \
    --project=<project-id>

# Option B: Grant project-level (less secure)
gcloud projects add-iam-policy-binding <project-id> \
    --member="serviceAccount:external-dns@<project-id>.iam.gserviceaccount.com" \
    --role="roles/dns.admin"

# Bind GCP SA to Kubernetes SA via Workload Identity
gcloud iam service-accounts add-iam-policy-binding \
    external-dns@<project-id>.iam.gserviceaccount.com \
    --role="roles/iam.workloadIdentityUser" \
    --member="serviceAccount:<project-id>.svc.id.goog[external-dns/external-dns]" \
    --project=<project-id>
```

### GCP Helm Values

```yaml
# values-gcp.yaml
serviceAccount:
  create: false
  name: external-dns
  annotations:
    iam.gke.io/gcp-service-account: external-dns@<project-id>.iam.gserviceaccount.com

extraArgs:
  - --provider=google
  - --google-project=<project-id>
  # Filter by specific managed zone names
  - --google-zone-visibility=public
  # OR filter by domain
  - --domain-filter=example.com
  # Ownership
  - --txt-owner-id=gke-cluster-prod
  - --txt-prefix=edns-
  # Policy
  - --policy=upsert-only
  # Sources
  - --source=ingress
  - --source=service
  - --log-level=info
  - --log-format=json
```

## Part 4: Ownership Model and TXT Records

### How TXT Record Ownership Works

ExternalDNS uses TXT records as an ownership registry to track which DNS records it manages. This prevents:
- Accidental deletion of records created by other systems
- Conflicting management when multiple ExternalDNS instances or controllers manage overlapping zones

For each managed DNS record, ExternalDNS creates a corresponding TXT record:

```
# Managed A record:
myapp.example.com.  300  IN  A  203.0.113.10

# Ownership TXT record (with --txt-prefix=edns-):
edns-myapp.example.com.  300  IN  TXT  "heritage=external-dns,external-dns/owner=my-cluster-prod,external-dns/resource=ingress/production/myapp"

# For CNAME records, TXT is at the apex:
edns-api.example.com.  300  IN  TXT  "heritage=external-dns,external-dns/owner=my-cluster-prod,external-dns/resource=service/production/myapp-lb"
```

### Owner ID Strategy for Multi-Cluster

Each ExternalDNS instance must have a unique `--txt-owner-id`. Use a cluster identifier:

```bash
# Format: <environment>-<region>-<cluster-name>
# Examples:
--txt-owner-id=prod-us-east-1-cluster-a
--txt-owner-id=prod-eu-west-1-cluster-b
--txt-owner-id=staging-us-east-1-cluster-c
```

### DynamoDB Registry for High-Scale

When you have thousands of DNS records, TXT registry lookups become slow. Use the DynamoDB registry:

```yaml
extraArgs:
  - --registry=dynamodb
  - --dynamodb-table=external-dns-registry
  - --dynamodb-region=us-east-1
  - --txt-owner-id=my-cluster-prod
```

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:DescribeTable",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:Scan"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:<account-id>:table/external-dns-registry"
    }
  ]
}
```

## Part 5: Sync Policies

ExternalDNS supports three sync policy modes:

### upsert-only (Safest for Production)

ExternalDNS creates and updates records but **never deletes** them. Records remain when Kubernetes resources are deleted:

```yaml
extraArgs:
  - --policy=upsert-only
```

Use this when:
- You are initially migrating to ExternalDNS
- DNS records may be created by other systems in the same zone
- You want human review before deletion

### sync (Full Reconciliation)

ExternalDNS creates, updates, AND deletes records that it owns (based on TXT registry):

```yaml
extraArgs:
  - --policy=sync
```

Use this when:
- ExternalDNS is the sole manager of DNS records
- You want automatic cleanup when services are removed
- Ownership tracking is correctly configured

### create-only (Most Conservative)

Records are created but never modified or deleted:

```yaml
extraArgs:
  - --policy=create-only
```

Use for bootstrapping environments where you want ExternalDNS to seed records but not maintain them.

### Progressive Migration Strategy

```bash
# Phase 1: Install with create-only + annotation-filter
# Only manages explicitly annotated resources
helm install external-dns ... \
    --set "extraArgs[0]=--policy=create-only" \
    --set "extraArgs[1]=--annotation-filter=external-dns.alpha.kubernetes.io/migrate=true"

# Phase 2: Annotate new services, validate records created correctly
kubectl annotate ingress myapp \
    external-dns.alpha.kubernetes.io/migrate=true

# Phase 3: Switch to upsert-only, expand annotation filter
helm upgrade external-dns ... \
    --set "extraArgs[0]=--policy=upsert-only"

# Phase 4: Full sync after validation
helm upgrade external-dns ... \
    --set "extraArgs[0]=--policy=sync"
```

## Part 6: DNSEndpoint CRD for Advanced Use Cases

The `DNSEndpoint` CRD allows explicit DNS record management without relying on Service/Ingress annotations—useful for custom applications that need multi-record sets or exotic record types:

```yaml
# Install CRD (if using crd source)
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/external-dns/master/docs/contributing/crd-source/crd-manifest.yaml
```

```yaml
# dnsendpoint.yaml — explicit DNS record management
apiVersion: externaldns.k8s.io/v1alpha1
kind: DNSEndpoint
metadata:
  name: myapp-dns
  namespace: production
spec:
  endpoints:
    # A record with health check
    - dnsName: "api.example.com"
      recordTTL: 60
      recordType: A
      targets:
        - "203.0.113.10"
        - "203.0.113.11"
      providerSpecific:
        - name: "aws/weight"
          value: "100"
        - name: "aws/health-check-id"
          value: "<health-check-id>"

    # CNAME for CDN endpoint
    - dnsName: "static.example.com"
      recordTTL: 300
      recordType: CNAME
      targets:
        - "d1234567890.cloudfront.net"

    # TXT record for domain verification
    - dnsName: "_acme-challenge.example.com"
      recordTTL: 60
      recordType: TXT
      targets:
        - "acme-verification-token-12345"

    # SRV record for service discovery
    - dnsName: "_sip._tcp.example.com"
      recordTTL: 300
      recordType: SRV
      targets:
        - "10 20 5060 sip.example.com"
```

## Multi-Tenant Isolation

### Namespace-Scoped ExternalDNS Instances

For multi-tenant clusters where different teams own different domains:

```yaml
# Team A owns example-a.com — their own ExternalDNS instance
# values-team-a.yaml
extraArgs:
  - --domain-filter=example-a.com
  - --txt-owner-id=cluster-prod-team-a
  - --namespace=team-a          # Only watch resources in team-a namespace
  - --source=ingress
  - --policy=sync
  - --provider=cloudflare
  - --zone-id-filter=<team-a-zone-id>
```

```yaml
# Team B owns example-b.com — separate instance
# values-team-b.yaml
extraArgs:
  - --domain-filter=example-b.com
  - --txt-owner-id=cluster-prod-team-b
  - --namespace=team-b
  - --source=ingress
  - --policy=sync
  - --provider=aws
  - --aws-zone-id=<team-b-zone-id>
```

### Annotation-Based Filtering for Multi-Tenant Safety

```yaml
# ExternalDNS for production team — only manages resources annotated with team=platform
extraArgs:
  - --annotation-filter=team=platform
  - --label-filter=environment=production
```

## Monitoring and Alerting

### Prometheus Metrics

ExternalDNS exposes metrics on `:7979/metrics`:

```
# Key metrics to monitor:
externaldns_controller_verified_endpoints_total    # Currently managed records
externaldns_controller_last_sync_timestamp_seconds # Last successful sync
externaldns_source_errors_total                    # Errors reading from K8s sources
externaldns_registry_errors_total                  # Errors writing to registry
externaldns_provider_errors_total                  # Errors communicating with DNS provider
```

```yaml
# PrometheusRule for ExternalDNS alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-dns-alerts
  namespace: external-dns
spec:
  groups:
    - name: external-dns
      interval: 60s
      rules:
        - alert: ExternalDNSSyncFailure
          expr: |
            time() - externaldns_controller_last_sync_timestamp_seconds > 300
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "ExternalDNS has not synced successfully for 5 minutes"
            description: "Last sync was {{ $value | humanizeDuration }} ago"

        - alert: ExternalDNSProviderErrors
          expr: |
            increase(externaldns_provider_errors_total[5m]) > 5
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "ExternalDNS is experiencing DNS provider errors"

        - alert: ExternalDNSSourceErrors
          expr: |
            increase(externaldns_source_errors_total[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ExternalDNS cannot read from Kubernetes sources"
```

### Grafana Dashboard Queries

```promql
# Records currently managed
externaldns_controller_verified_endpoints_total

# Sync success rate (over last hour)
rate(externaldns_controller_last_sync_timestamp_seconds[1h])

# Provider errors by source
sum by (provider) (increase(externaldns_provider_errors_total[30m]))

# Time since last successful sync
time() - externaldns_controller_last_sync_timestamp_seconds
```

## Troubleshooting Guide

### Record Not Being Created

```bash
# Check ExternalDNS logs
kubectl logs -n external-dns deployment/external-dns -f

# Common causes and fixes:

# 1. Annotation filter mismatch
# Check: does the resource have the required annotation?
kubectl get ingress myapp -n production -o yaml | \
    grep external-dns

# 2. Domain not in filter
# Check: is the hostname in --domain-filter?
kubectl logs -n external-dns deployment/external-dns | \
    grep "Skipping record"

# 3. Ownership conflict (different owner ID)
# Check TXT records in DNS
dig TXT edns-myapp.example.com

# If owned by different ID, do NOT just delete the TXT record.
# Either update the owner ID in ExternalDNS or manually migrate.

# 4. Zone ID filter mismatch
# Verify zone IDs match exactly
aws route53 list-hosted-zones --query 'HostedZones[*].{Name:Name,Id:Id}'
```

### Stale Records After Service Deletion

```bash
# Check if ExternalDNS policy allows deletion
kubectl get deployment external-dns -n external-dns -o yaml | \
    grep -A1 "policy"

# If using upsert-only, manually delete stale records
# First, verify ExternalDNS owns the record
dig TXT edns-old-service.example.com
# Should show: "heritage=external-dns,external-dns/owner=my-cluster-prod,..."

# Switch to sync policy temporarily or delete manually via CLI
aws route53 change-resource-record-sets \
    --hosted-zone-id <zone-id> \
    --change-batch '{"Changes":[{"Action":"DELETE","ResourceRecordSet":{"Name":"old-service.example.com","Type":"A","TTL":300,"ResourceRecords":[{"Value":"x.x.x.x"}]}}]}'
```

### Diagnosing Route53 Throttling

AWS Route53 API calls are throttled at 5 requests/second per account. High-scale clusters can hit this limit:

```bash
# Check for throttling in logs
kubectl logs -n external-dns deployment/external-dns | grep -i throttl

# Mitigate by:
# 1. Increasing --interval (default 1m) to reduce sync frequency
# 2. Using --aws-batch-change-size to batch more changes per API call
# 3. Using DynamoDB registry to reduce TXT record lookups
# 4. Requesting Route53 API limit increase from AWS

# Also enable Route53 change batching:
# --aws-batch-change-size=4000 (max per API call)
# --aws-batch-change-interval=10s (delay between batches)
```

## GitOps Integration

### ArgoCD Application for ExternalDNS

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: external-dns
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://kubernetes-sigs.github.io/external-dns/
    chart: external-dns
    targetRevision: "1.14.3"
    helm:
      valuesFiles:
        - values-route53.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: external-dns
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

## Summary

ExternalDNS transforms DNS management from a manual, error-prone operational task into a declarative, Kubernetes-native process. Key production recommendations:

1. **Always set a unique `--txt-owner-id`** per ExternalDNS instance to prevent ownership conflicts in shared DNS zones.

2. **Start with `--policy=upsert-only`** during initial deployment, then migrate to `--policy=sync` after validating ownership is correctly tracked.

3. **Use IRSA/Workload Identity** instead of static credentials to minimize blast radius from credential exposure.

4. **Filter by domain and zone ID** to scope each ExternalDNS instance to only the DNS zones it should manage.

5. **Use `--annotation-filter`** in multi-tenant environments to prevent one team's ExternalDNS from managing another team's resources.

6. **Monitor sync timestamps and error metrics** to detect provider API issues before they become user-visible DNS outages.
