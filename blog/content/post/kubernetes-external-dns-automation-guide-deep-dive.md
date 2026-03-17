---
title: "ExternalDNS: Automating DNS Record Management for Kubernetes Services"
date: 2028-06-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ExternalDNS", "DNS", "Route53", "CloudFlare", "GCP", "Automation"]
categories: ["Kubernetes", "Networking", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to ExternalDNS for Kubernetes: automating DNS record lifecycle across Route53, CloudFlare, and GCP Cloud DNS with annotation-based configuration, filtering, RBAC, and security hardening."
more_link: "yes"
url: "/kubernetes-external-dns-automation-deep-dive/"
---

Managing DNS records manually in a dynamic Kubernetes environment is a recipe for drift, outages, and operational toil. ExternalDNS solves this by watching Kubernetes resources and synchronizing DNS records automatically across cloud provider DNS services. This guide covers production deployment patterns for Route53, CloudFlare, and GCP Cloud DNS, annotation-based customization, ownership models, and the security considerations that matter in regulated environments.

<!--more-->

## What ExternalDNS Does and Why It Matters

ExternalDNS is a Kubernetes controller that bridges Service and Ingress resources to external DNS providers. When a LoadBalancer Service receives an external IP or when an Ingress is created with a hostname, ExternalDNS translates those events into DNS record create/update/delete operations against the configured provider.

The core workflow:

1. A Service of type LoadBalancer is created with `external-dns.alpha.kubernetes.io/hostname: api.example.com`
2. The cloud load balancer assigns an IP or hostname
3. ExternalDNS detects the change and creates an A or CNAME record in the DNS zone
4. When the Service is deleted, ExternalDNS removes the record

Without ExternalDNS, teams maintain manual runbooks or custom automation scripts that inevitably fall out of sync with cluster state. At scale — dozens of services across multiple clusters — the problem becomes unmanageable.

## Architecture Overview

ExternalDNS runs as a Deployment (not a DaemonSet) within the cluster. A single replica is sufficient because DNS propagation does not benefit from horizontal scaling, and multiple instances would race to write records. High availability concerns are handled at the provider level.

The controller polls Kubernetes resources on a configurable interval (default 1 minute) and computes the desired DNS state. It compares this to what it owns in the DNS zone (tracked via TXT ownership records) and reconciles differences.

Key design decisions:

- **Ownership model**: ExternalDNS uses TXT records as ownership markers. It will only modify records it created, preventing accidental deletion of manually managed records.
- **Source types**: Services, Ingresses, and CRDs (Gateway API HTTPRoute, etc.) are supported sources.
- **Provider plugins**: AWS Route53, CloudFlare, GCP Cloud DNS, Azure DNS, and many others are supported.

## Installation

### Helm-Based Deployment

The Bitnami chart is the recommended installation method for production:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm install external-dns bitnami/external-dns \
  --namespace external-dns \
  --create-namespace \
  --version 7.5.4 \
  -f values.yaml
```

A minimal values file for Route53:

```yaml
# values.yaml
provider: aws

aws:
  region: us-east-1
  zoneType: public

# Only manage records in specific zones
domainFilters:
  - example.com
  - internal.example.com

# Ownership: use TXT records to track managed records
txtOwnerId: "prod-cluster-01"
txtPrefix: "externaldns-"

# Do not delete records, only create/update (safe default for migration)
policy: sync  # Options: sync, upsert-only, create-only

# Sources to watch
sources:
  - service
  - ingress

# Filter by annotation
annotationFilter: "external-dns.alpha.kubernetes.io/managed=true"

# Logging
logLevel: info
logFormat: json

# Resource requests
resources:
  requests:
    cpu: 50m
    memory: 50Mi
  limits:
    cpu: 100m
    memory: 100Mi

# RBAC
rbac:
  create: true

serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/ExternalDNSRole

# Metrics
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring
```

## AWS Route53 Configuration

### IAM Policy

ExternalDNS requires specific Route53 permissions. The principle of least privilege limits access to only the hosted zones it manages:

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
        "arn:aws:route53:::hostedzone/Z1234567890ABC",
        "arn:aws:route53:::hostedzone/Z0987654321XYZ"
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

### IRSA (IAM Roles for Service Accounts) Setup

For EKS clusters, IRSA is the recommended authentication method:

```bash
# Create the OIDC provider for the cluster
eksctl utils associate-iam-oidc-provider \
  --cluster prod-cluster-01 \
  --region us-east-1 \
  --approve

# Create the IAM role
eksctl create iamserviceaccount \
  --name external-dns \
  --namespace external-dns \
  --cluster prod-cluster-01 \
  --region us-east-1 \
  --attach-policy-arn arn:aws:iam::123456789012:policy/ExternalDNSPolicy \
  --approve \
  --override-existing-serviceaccounts
```

### Route53 Zone Discovery

ExternalDNS can discover zones automatically or be restricted to specific zone IDs:

```yaml
# Restrict to specific hosted zone IDs (recommended for production)
aws:
  region: us-east-1
  zoneType: public
  preferCNAME: false  # Use A records with alias for AWS resources

# Zone ID filtering via annotation on the Service
# external-dns.alpha.kubernetes.io/aws-zone-id: Z1234567890ABC
```

For internal (private) hosted zones:

```yaml
aws:
  region: us-east-1
  zoneType: private
  vpc:
    id: vpc-0abc123def456789
    region: us-east-1
```

### Route53 Alias Records

For AWS Load Balancers (ALB/NLB/CLB), ExternalDNS automatically creates alias records instead of CNAME records, which is critical for apex domains:

```yaml
# Service annotation to force alias record behavior
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: api.example.com
    # ExternalDNS auto-detects AWS LB hostnames and creates ALIAS records
```

Alias records are free (no DNS query charges) and have lower latency than CNAME records for AWS-hosted resources.

## CloudFlare Configuration

### API Token Setup

CloudFlare requires an API token with zone-level permissions:

```bash
# Required permissions for the token:
# Zone - DNS - Edit
# Zone - Zone - Read
```

Store the token as a Kubernetes Secret:

```bash
kubectl create secret generic cloudflare-api-token \
  --from-literal=apiToken=<token> \
  --namespace external-dns
```

### Helm Values for CloudFlare

```yaml
provider: cloudflare

cloudflare:
  apiToken: ""  # Set via secretKeyRef
  proxied: false  # Set true to enable CloudFlare proxy (orange cloud)
  apiTokenSecretRef:
    name: cloudflare-api-token
    key: apiToken

domainFilters:
  - example.com

txtOwnerId: "prod-cluster-01"
txtPrefix: "externaldns-"

policy: sync
sources:
  - service
  - ingress

extraEnvVars:
  - name: CF_API_TOKEN
    valueFrom:
      secretKeyRef:
        name: cloudflare-api-token
        key: apiToken
```

### CloudFlare Proxy Considerations

When `proxied: true`, CloudFlare sits in front of the origin and provides DDoS protection, WAF, and caching. However, this changes the DNS resolution behavior — clients resolve to CloudFlare IPs, not the actual load balancer IPs. This has implications for:

- **TLS termination**: CloudFlare terminates TLS, requiring compatible certificate configuration between CloudFlare and the origin
- **IP allow-listing**: Source IPs at the origin will be CloudFlare IPs; use CF-Connecting-IP header for real client IPs
- **WebSockets**: Require Enterprise plan for full support with proxied mode

For internal services or when direct IP access is required, set `proxied: false`.

## GCP Cloud DNS Configuration

### Workload Identity Setup

For GKE clusters, Workload Identity is the recommended authentication method:

```bash
# Create a GCP service account
gcloud iam service-accounts create external-dns-sa \
  --display-name "ExternalDNS Service Account"

# Grant DNS admin permissions on specific zones
gcloud projects add-iam-policy-binding my-project-id \
  --member "serviceAccount:external-dns-sa@my-project-id.iam.gserviceaccount.com" \
  --role "roles/dns.admin"

# Bind the Kubernetes service account to the GCP service account
gcloud iam service-accounts add-iam-policy-binding \
  external-dns-sa@my-project-id.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project-id.svc.id.goog[external-dns/external-dns]"
```

Annotate the Kubernetes ServiceAccount:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-dns
  namespace: external-dns
  annotations:
    iam.gke.io/gcp-service-account: external-dns-sa@my-project-id.iam.gserviceaccount.com
```

### Helm Values for GCP

```yaml
provider: google

google:
  project: my-project-id
  batchChangeSize: 1000
  batchChangeInterval: 1s

domainFilters:
  - example.com

txtOwnerId: "gke-prod-cluster-01"
policy: sync
sources:
  - service
  - ingress
  - gateway-httproute  # For Gateway API
```

## Annotation-Based Configuration

ExternalDNS supports extensive annotation-based customization on Services and Ingresses:

### Core Annotations

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    # Primary hostname
    external-dns.alpha.kubernetes.io/hostname: api.example.com

    # Multiple hostnames (comma-separated)
    # external-dns.alpha.kubernetes.io/hostname: api.example.com,api-v2.example.com

    # TTL override (seconds)
    external-dns.alpha.kubernetes.io/ttl: "60"

    # Target override (useful for internal services pointing to a specific IP)
    external-dns.alpha.kubernetes.io/target: "10.0.1.100"

    # Access control: internal only
    external-dns.alpha.kubernetes.io/access: public  # or: private

    # CloudFlare-specific: enable/disable proxy
    external-dns.alpha.kubernetes.io/cloudflare-proxied: "false"

    # AWS-specific: set routing policy
    external-dns.alpha.kubernetes.io/aws-weight: "100"
    external-dns.alpha.kubernetes.io/set-identifier: "prod-us-east-1"
spec:
  type: LoadBalancer
  selector:
    app: api
  ports:
    - port: 443
      targetPort: 8443
      protocol: TCP
```

### Ingress Annotations

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
  namespace: production
  annotations:
    # ExternalDNS uses spec.rules[].host by default
    # Override the target (useful when using CDN in front)
    external-dns.alpha.kubernetes.io/target: "cdn.example.net"

    # Explicitly opt in (when using annotationFilter)
    external-dns.alpha.kubernetes.io/managed: "true"

    # Set TTL for all records created from this Ingress
    external-dns.alpha.kubernetes.io/ttl: "300"
spec:
  ingressClassName: nginx
  rules:
    - host: www.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-frontend
                port:
                  number: 80
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 80
```

### AWS Weighted Routing

For blue-green deployments or canary rollouts, AWS Route53 supports weighted routing policies:

```yaml
# Blue deployment
apiVersion: v1
kind: Service
metadata:
  name: app-blue
  annotations:
    external-dns.alpha.kubernetes.io/hostname: app.example.com
    external-dns.alpha.kubernetes.io/aws-weight: "90"
    external-dns.alpha.kubernetes.io/set-identifier: "blue"
spec:
  type: LoadBalancer
  # ...

---
# Green deployment (canary)
apiVersion: v1
kind: Service
metadata:
  name: app-green
  annotations:
    external-dns.alpha.kubernetes.io/hostname: app.example.com
    external-dns.alpha.kubernetes.io/aws-weight: "10"
    external-dns.alpha.kubernetes.io/set-identifier: "green"
spec:
  type: LoadBalancer
  # ...
```

ExternalDNS creates two weighted Route53 records for the same hostname, enabling traffic splitting at the DNS level.

### AWS Geolocation Routing

```yaml
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: global-api.example.com
    external-dns.alpha.kubernetes.io/aws-geolocation-continent-code: "NA"
    external-dns.alpha.kubernetes.io/set-identifier: "north-america"
```

## Filtering and Scoping

In large clusters, ExternalDNS should be scoped carefully to avoid interfering with other systems.

### Label Filtering

Restrict ExternalDNS to only process resources with specific labels:

```yaml
# In ExternalDNS deployment values
labelFilter: "team=platform"
```

Resources without `team=platform` label will be ignored.

### Annotation Filtering

```yaml
# Only process resources explicitly opted in
annotationFilter: "external-dns.alpha.kubernetes.io/managed=true"
```

This is the safest approach during migration — existing Services are unaffected until the annotation is added.

### Namespace Filtering

Restrict ExternalDNS to specific namespaces using RBAC:

```yaml
# Restrict ClusterRole to specific namespaces by creating Role + RoleBinding
# instead of ClusterRole + ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: external-dns
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["services", "endpoints", "pods"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["extensions", "networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "watch", "list"]
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["list", "watch"]
```

### Zone Filtering

Limit ExternalDNS to specific DNS zones to prevent accidental record creation in root zones:

```yaml
# Domain-based filtering
domainFilters:
  - prod.example.com
  - staging.example.com
  # NOT example.com (too broad)

# Zone ID filtering (most precise)
zoneIdFilters:
  - Z1234567890ABC
  - Z0987654321XYZ

# Exclude specific zones
excludeDomains:
  - legacy.example.com
```

## Multi-Cluster DNS Management

### Per-Cluster Ownership with TXT Records

In multi-cluster environments, each ExternalDNS instance must have a unique `txtOwnerId`. This prevents clusters from overwriting each other's records:

```yaml
# Cluster 1 (us-east-1)
txtOwnerId: "prod-us-east-1"
txtPrefix: "externaldns-"

# Cluster 2 (us-west-2)
txtOwnerId: "prod-us-west-2"
txtPrefix: "externaldns-"
```

ExternalDNS creates TXT records alongside each DNS record it manages:

```
# DNS record
api.example.com. A 203.0.113.10

# Ownership TXT record
externaldns-api.example.com. TXT "heritage=external-dns,external-dns/owner=prod-us-east-1,external-dns/resource=service/production/api-service"
```

Cluster 2's ExternalDNS sees the TXT record owned by `prod-us-east-1` and skips it, preventing conflicts.

### Active-Active Multi-Region

For active-active deployments where both clusters serve the same hostname:

```yaml
# Use AWS Route53 latency-based routing
# Cluster 1 (us-east-1)
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: api.example.com
    external-dns.alpha.kubernetes.io/aws-routing-policy: latency
    external-dns.alpha.kubernetes.io/set-identifier: "us-east-1"

# Cluster 2 (us-west-2)
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: api.example.com
    external-dns.alpha.kubernetes.io/aws-routing-policy: latency
    external-dns.alpha.kubernetes.io/set-identifier: "us-west-2"
```

### Cross-Account Route53 with AssumeRole

When the EKS cluster is in a different AWS account from the Route53 hosted zone:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::DNS-ACCOUNT-ID:role/ExternalDNSCrossAccountRole"
    }
  ]
}
```

Configure ExternalDNS with the assume-role ARN:

```yaml
aws:
  region: us-east-1
  assumeRoleArn: "arn:aws:iam::DNS-ACCOUNT-ID:role/ExternalDNSCrossAccountRole"
  zoneType: public
```

## Security Hardening

### Pod Security Context

```yaml
# In Helm values
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65534
  fsGroup: 65534
  seccompProfile:
    type: RuntimeDefault

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL
```

### Network Policies

Restrict ExternalDNS to only the traffic it needs:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: external-dns
  namespace: external-dns
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: external-dns
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Metrics scraping from Prometheus
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 7979
          protocol: TCP
  egress:
    # Kubernetes API server
    - ports:
        - port: 443
          protocol: TCP
        - port: 6443
          protocol: TCP
    # DNS (for provider API resolution)
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # HTTPS for provider APIs (Route53, CloudFlare, etc.)
    - ports:
        - port: 443
          protocol: TCP
```

### Minimal RBAC

The default ExternalDNS ClusterRole is broader than necessary. Restrict it:

```yaml
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
  # Only needed if using Gateway API
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways", "httproutes", "grpcroutes", "tlsroutes", "tcproutes", "udproutes"]
    verbs: ["get", "watch", "list"]
  # NOT including: nodes/status, secrets, configmaps (not needed)
```

### Audit Logging

Route53 API calls are logged via CloudTrail. Configure an alarm for unexpected record changes:

```bash
# CloudWatch metric filter for ExternalDNS-originated changes
aws logs put-metric-filter \
  --log-group-name CloudTrail/DefaultLogGroup \
  --filter-name ExternalDNSChanges \
  --filter-pattern '{ $.eventSource = "route53.amazonaws.com" && $.userAgent = "ExternalDNS*" }' \
  --metric-transformations \
    metricName=ExternalDNSAPIcalls,metricNamespace=Security/DNS,metricValue=1
```

## Ownership Model and Record Protection

### TXT Record Ownership

ExternalDNS will never modify records it did not create. The ownership system works as follows:

```
# Managed record
api.example.com. 300 IN A 203.0.113.10

# Ownership record (always created alongside)
externaldns-api.example.com. 300 IN TXT "heritage=external-dns,external-dns/owner=prod-cluster-01,external-dns/resource=service/production/api-service"
```

If a DNS record exists without a corresponding TXT ownership record, ExternalDNS will not touch it. This is the safest behavior for migrating existing DNS infrastructure.

### Handling Ownership Record Conflicts

When migrating from one ExternalDNS instance to another (e.g., replacing an old cluster), the TXT records from the old instance will block the new one:

```bash
# Option 1: Update txtOwnerId to match old instance
# Allows new instance to take ownership of existing records

# Option 2: Manually delete old TXT records
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "DELETE",
      "ResourceRecordSet": {
        "Name": "externaldns-api.example.com.",
        "Type": "TXT",
        "TTL": 300,
        "ResourceRecords": [{"Value": "\"heritage=external-dns,...\""}]
      }
    }]
  }'
```

### Dry Run Mode

Before enabling `sync` policy in production, validate what ExternalDNS would do:

```yaml
# Enable dry-run mode
extraArgs:
  - --dry-run=true
```

In dry-run mode, ExternalDNS logs what it would create/update/delete without making actual API calls. Monitor the logs for 24 hours before switching to live mode.

## Monitoring and Alerting

### Prometheus Metrics

ExternalDNS exposes metrics at `:7979/metrics`:

```
# Key metrics to monitor
external_dns_registry_endpoints_total          # Total endpoints managed
external_dns_source_endpoints_total            # Endpoints from sources
external_dns_controller_last_sync_timestamp_seconds  # Last successful sync
external_dns_registry_errors_total             # Registry errors
external_dns_source_errors_total               # Source (K8s API) errors
external_dns_controller_verified_aaaa_records  # IPv6 records verified
```

### PrometheusRule for Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-dns-alerts
  namespace: external-dns
spec:
  groups:
    - name: external-dns
      interval: 1m
      rules:
        - alert: ExternalDNSStale
          expr: |
            time() - external_dns_controller_last_sync_timestamp_seconds > 300
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ExternalDNS has not synced in 5 minutes"
            description: "Last sync was {{ $value | humanizeDuration }} ago"

        - alert: ExternalDNSErrors
          expr: |
            rate(external_dns_registry_errors_total[5m]) > 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "ExternalDNS is experiencing errors"
            description: "{{ $value }} errors/sec in DNS registry operations"

        - alert: ExternalDNSSourceErrors
          expr: |
            rate(external_dns_source_errors_total[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "ExternalDNS cannot read Kubernetes sources"
```

### Grafana Dashboard

Key panels for an ExternalDNS dashboard:

```
- Time since last sync (gauge, threshold at 5m/10m)
- Endpoints managed (time series)
- DNS record changes per minute (create/update/delete)
- Error rate (time series)
- Provider API latency (if using custom metrics)
```

## Gateway API Support

ExternalDNS supports the Kubernetes Gateway API for modern ingress patterns:

```yaml
# Enable Gateway API sources in values
sources:
  - gateway-httproute
  - gateway-grpcroute
  - gateway-tlsroute

# Example Gateway
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "*.example.com"
spec:
  gatewayClassName: cilium
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: "*.example.com"
```

```yaml
# HTTPRoute - ExternalDNS picks up hostnames automatically
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
spec:
  parentRefs:
    - name: prod-gateway
      namespace: production
  hostnames:
    - api.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: api-service
          port: 8080
```

## Troubleshooting

### Common Issues

**Records not being created:**

```bash
# Check ExternalDNS logs
kubectl logs -n external-dns -l app.kubernetes.io/name=external-dns --tail=100

# Verify the Service has the correct annotation
kubectl get svc api-service -o jsonpath='{.metadata.annotations}'

# Check if zone filtering is too restrictive
kubectl exec -n external-dns deploy/external-dns -- \
  env | grep -E 'DOMAIN|ZONE'
```

**"Not owner" errors:**

```bash
# TXT record from another owner is blocking this instance
# Check ownership TXT records in the zone
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --query 'ResourceRecordSets[?Type==`TXT`]' \
  | grep externaldns
```

**CloudFlare rate limiting:**

```yaml
# Increase interval to reduce API call frequency
interval: 5m  # Default is 1m

# Use batch operations (default behavior for CF provider)
```

**Stale records after Service deletion:**

```bash
# Verify policy is set to 'sync' not 'upsert-only'
# With upsert-only, records are never deleted
kubectl get configmap -n external-dns external-dns \
  -o jsonpath='{.data.policy}'
```

### Debug Mode

```yaml
extraArgs:
  - --log-level=debug
```

Debug mode logs every reconciliation loop, showing which records are being evaluated and what actions would be taken.

## Production Checklist

Before deploying ExternalDNS in production:

- Verify IAM/RBAC permissions are scoped to specific zones, not all zones
- Set `txtOwnerId` to a unique, descriptive value per cluster
- Start with `policy: upsert-only` and migrate to `sync` after validating behavior
- Configure `domainFilters` to restrict to expected zones
- Enable Prometheus metrics and create alerting rules for sync staleness and errors
- Test disaster recovery: what happens when ExternalDNS is unavailable? (DNS records persist; no new records are created/deleted)
- Document the TXT ownership record format for incident response runbooks
- Validate that `annotationFilter` is set to prevent accidental management of existing services
- Review CloudTrail/audit logs before and after enabling ExternalDNS
- Test deletion behavior in a staging environment before enabling `sync` in production

ExternalDNS dramatically reduces DNS management toil in dynamic Kubernetes environments. With proper ownership tracking, zone filtering, and monitoring, it can be trusted to manage production DNS infrastructure reliably.
