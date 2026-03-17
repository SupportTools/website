---
title: "Kubernetes External DNS: Automated DNS Management for Services and Ingresses"
date: 2030-09-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ExternalDNS", "DNS", "Route53", "Cloudflare", "GCP DNS", "Networking"]
categories:
- Kubernetes
- Networking
- DNS
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise ExternalDNS guide covering provider configuration for Route53, Cloudflare, and GCP DNS, annotation-based DNS record management, TXT ownership records, multi-cluster DNS, split-horizon DNS, and debugging DNS propagation issues."
more_link: "yes"
url: "/kubernetes-external-dns-automated-dns-management-enterprise-guide/"
---

Managing DNS records manually for Kubernetes services and ingresses at enterprise scale creates operational debt that compounds quickly. Every new service, every ingress host, every LoadBalancer provisioned demands a corresponding DNS record update — and that update often lives outside the Kubernetes workflow in a separate ticketing system or DNS console. ExternalDNS closes that gap by watching Kubernetes resources and reconciling DNS provider state automatically, treating DNS as just another API.

<!--more-->

## What ExternalDNS Does and Why It Matters

ExternalDNS is a Kubernetes controller that watches Services, Ingresses, and other resources for hostname annotations or spec fields, then creates, updates, and deletes DNS records in external providers to match. It supports over 30 DNS providers including AWS Route53, Cloudflare, Google Cloud DNS, Azure DNS, and many others.

The operational benefit is significant: teams no longer need out-of-band DNS changes to deploy a new endpoint. The Kubernetes manifest is the single source of truth. ExternalDNS reconciles external state to match it.

Key behaviors to understand before deployment:

- **Ownership via TXT records**: ExternalDNS creates TXT records alongside A/CNAME records to track which records it owns. This prevents it from modifying records created by other tools or humans.
- **No deletion without ownership**: ExternalDNS will not delete a DNS record it did not create (as evidenced by TXT ownership records).
- **Eventually consistent**: DNS propagation delays are external to ExternalDNS. The controller creates the record in the provider API; TTL and resolver caching determine when clients see the change.

## Installation and Provider Configuration

### Namespace and RBAC Setup

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: external-dns
  labels:
    app.kubernetes.io/managed-by: helm
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-dns
  namespace: external-dns
  annotations:
    # For AWS IRSA - replace with actual role ARN
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/external-dns-role"
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
  - apiGroups: ["networking.istio.io"]
    resources: ["gateways", "virtualservices"]
    verbs: ["get", "watch", "list"]
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

### Helm-Based Deployment

The official ExternalDNS Helm chart is maintained by the ExternalDNS project. All provider-specific configuration passes through `values.yaml`.

```bash
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm repo update

helm upgrade --install external-dns external-dns/external-dns \
  --namespace external-dns \
  --create-namespace \
  --values external-dns-values.yaml \
  --version 1.14.4
```

## AWS Route53 Provider Configuration

Route53 is the most common provider in enterprise AWS deployments. Authentication uses either IRSA (recommended) or static credentials.

### IAM Policy for ExternalDNS

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
        "arn:aws:route53:::hostedzone/*"
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

For tighter scoping, restrict `ChangeResourceRecordSets` to specific hosted zone ARNs rather than the wildcard.

### Route53 Helm Values

```yaml
# external-dns-route53-values.yaml
provider:
  name: aws

env:
  - name: AWS_DEFAULT_REGION
    value: us-east-1

# Use IRSA - no explicit credentials needed when running on EKS with IRSA
serviceAccount:
  create: true
  name: external-dns
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/external-dns-role"

# Limit to specific hosted zones
domainFilters:
  - example.com
  - internal.example.com

# Only process resources with this annotation
annotationFilter: "external-dns.alpha.kubernetes.io/managed=true"

# TXT record ownership identifier - must be unique per cluster
txtOwnerId: "prod-cluster-us-east-1"

# TXT record prefix to avoid conflicts with other records
txtPrefix: "_edns."

# Interval between full reconciliations
interval: "1m"

# Log level for troubleshooting
logLevel: info
logFormat: json

# Policy controls behavior on conflict
# sync: create and delete records (default)
# upsert-only: only create or update, never delete
# create-only: only create records, never update or delete
policy: sync

sources:
  - service
  - ingress
  - istio-gateway
  - istio-virtualservice

# Resource filtering by namespace
namespaceFilter: ""

# Publish internal load balancers (not just external)
publishInternalServices: false

resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 100m
    memory: 128Mi

metrics:
  enabled: true
  port: 7979
  serviceMonitor:
    enabled: true
    namespace: monitoring
    interval: 30s
```

### Route53 Private Hosted Zones

For internal services that should resolve only within a VPC, use private hosted zones with the `aws-prefer-cname` or zone filtering options:

```yaml
# Additional values for private zone handling
extraArgs:
  - --aws-zone-type=private
  - --aws-prefer-cname
  # Explicitly list private zone IDs
  - --zone-id-filter=Z1234567890ABCDEF
```

## Cloudflare Provider Configuration

Cloudflare requires an API token with DNS edit permissions. Use API tokens rather than the legacy global API key for scope control.

### Cloudflare API Token Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: external-dns
type: Opaque
stringData:
  cloudflare_api_token: "<cloudflare-api-token>"
```

### Cloudflare Helm Values

```yaml
# external-dns-cloudflare-values.yaml
provider:
  name: cloudflare

env:
  - name: CF_API_TOKEN
    valueFrom:
      secretKeyRef:
        name: cloudflare-api-token
        key: cloudflare_api_token

domainFilters:
  - example.com

txtOwnerId: "prod-cluster-us-east-1"
txtPrefix: "_edns."

# Cloudflare-specific: enable proxy mode for CDN fronting
extraArgs:
  - --cloudflare-proxied
  # Or disable proxying per record with annotation:
  # external-dns.alpha.kubernetes.io/cloudflare-proxied: "false"

sources:
  - service
  - ingress

policy: sync
interval: "1m"
logLevel: info
logFormat: json
```

Cloudflare's proxy mode (`--cloudflare-proxied`) routes traffic through Cloudflare's CDN and DDoS protection. This works well for HTTP/HTTPS but breaks non-HTTP protocols. Use the per-record annotation to disable proxying selectively:

```yaml
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/cloudflare-proxied: "false"
```

## GCP Cloud DNS Provider Configuration

GCP Cloud DNS authentication uses Workload Identity (preferred) or a service account key.

### Workload Identity Configuration

```bash
# Create GCP service account
gcloud iam service-accounts create external-dns \
  --display-name "ExternalDNS Service Account" \
  --project my-project

# Grant DNS admin role
gcloud projects add-iam-policy-binding my-project \
  --member "serviceAccount:external-dns@my-project.iam.gserviceaccount.com" \
  --role "roles/dns.admin"

# Bind GCP SA to Kubernetes SA via Workload Identity
gcloud iam service-accounts add-iam-policy-binding \
  external-dns@my-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project.svc.id.goog[external-dns/external-dns]"
```

### GCP Helm Values

```yaml
# external-dns-gcp-values.yaml
provider:
  name: google

serviceAccount:
  create: true
  name: external-dns
  annotations:
    iam.gke.io/gcp-service-account: "external-dns@my-project.iam.gserviceaccount.com"

extraArgs:
  - --google-project=my-project
  - --google-zone-visibility=public
  # For private zones: --google-zone-visibility=private

domainFilters:
  - example.com

txtOwnerId: "prod-cluster-us-central1"
txtPrefix: "_edns."

sources:
  - service
  - ingress

policy: sync
interval: "1m"
```

## Annotation-Based DNS Record Management

ExternalDNS reads annotations on Services and Ingresses to determine what DNS records to create.

### Service Annotations

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-api
  namespace: production
  annotations:
    # Primary hostname annotation
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"

    # Multiple hostnames (comma-separated)
    # external-dns.alpha.kubernetes.io/hostname: "api.example.com,api-v2.example.com"

    # Override TTL (seconds)
    external-dns.alpha.kubernetes.io/ttl: "60"

    # Force CNAME instead of A record (for internal ALB)
    external-dns.alpha.kubernetes.io/alias: "true"

    # Custom target override (useful for CNAMEs to external endpoints)
    external-dns.alpha.kubernetes.io/target: "my-alb.us-east-1.elb.amazonaws.com"

    # Cloudflare-specific proxy control
    external-dns.alpha.kubernetes.io/cloudflare-proxied: "true"
spec:
  type: LoadBalancer
  selector:
    app: my-api
  ports:
    - name: https
      port: 443
      targetPort: 8443
```

### Ingress Hostname Management

For Ingress resources, ExternalDNS reads `spec.rules[].host` fields automatically (no annotation needed) and creates records pointing to the Ingress controller's LoadBalancer IP or hostname:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app-ingress
  namespace: production
  annotations:
    # Optional: override TTL
    external-dns.alpha.kubernetes.io/ttl: "120"

    # Optional: use specific target instead of ingress LB
    external-dns.alpha.kubernetes.io/target: "ingress.example.com"

    # Opt out of ExternalDNS management for this ingress
    # external-dns.alpha.kubernetes.io/ignore: "true"
spec:
  ingressClassName: nginx
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
                  number: 80
    - host: api.example.com
      http:
        paths:
          - path: /v1
            pathType: Prefix
            backend:
              service:
                name: my-api
                port:
                  number: 80
  tls:
    - hosts:
        - app.example.com
        - api.example.com
      secretName: app-tls-cert
```

### Istio Gateway and VirtualService Integration

When using Istio, ExternalDNS can read Gateway and VirtualService resources:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: my-gateway
  namespace: istio-system
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "gateway.example.com"
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 443
        name: https
        protocol: HTTPS
      tls:
        mode: SIMPLE
        credentialName: gateway-cert
      hosts:
        - "app.example.com"
        - "api.example.com"
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-app
  namespace: production
spec:
  hosts:
    - "app.example.com"
  gateways:
    - istio-system/my-gateway
  http:
    - match:
        - uri:
            prefix: "/"
      route:
        - destination:
            host: my-app
            port:
              number: 80
```

## TXT Ownership Records Deep Dive

Understanding TXT ownership records is critical for operating ExternalDNS safely in multi-team environments.

### How Ownership Works

When ExternalDNS creates an A record for `app.example.com`, it also creates a TXT record:

```
# Standard TXT record (when txtPrefix is not set)
app.example.com  TXT  "heritage=external-dns,external-dns/owner=prod-cluster,external-dns/resource=ingress/production/my-app"

# With txtPrefix="_edns."
_edns.app.example.com  TXT  "heritage=external-dns,external-dns/owner=prod-cluster,external-dns/resource=ingress/production/my-app"
```

The `external-dns/owner` field matches the `txtOwnerId` in the ExternalDNS configuration. This prevents one ExternalDNS instance from deleting records created by another.

### Multi-Cluster TXT Ownership

In multi-cluster deployments, each cluster must have a unique `txtOwnerId`:

```yaml
# Cluster 1 (us-east-1)
txtOwnerId: "prod-cluster-us-east-1"
txtPrefix: "_edns."

# Cluster 2 (eu-west-1)
txtOwnerId: "prod-cluster-eu-west-1"
txtPrefix: "_edns."
```

With this configuration, both clusters can manage DNS for the same zone without conflict. If both clusters try to create a record for the same hostname, the last writer wins for the A record, but each maintains its own TXT ownership record.

### Ownership Conflict Resolution

If TXT records are lost or corrupted:

```bash
# List all TXT records for a domain to see ownership state
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890ABCDEF \
  --query "ResourceRecordSets[?Type=='TXT']" \
  --output json | jq '.[] | select(.Name | contains("_edns"))'
```

To force ExternalDNS to re-adopt orphaned records, temporarily set the `txtOwnerId` to match the owner field in the existing TXT records.

## Multi-Cluster DNS Architecture

### Active-Active Multi-Region DNS

For active-active deployments where multiple clusters serve the same hostname, use weighted routing policies:

```yaml
# Cluster 1 deployment
apiVersion: v1
kind: Service
metadata:
  name: my-api
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    # Route53 weighted routing
    external-dns.alpha.kubernetes.io/set-identifier: "us-east-1"
    external-dns.alpha.kubernetes.io/aws-weight: "50"
    external-dns.alpha.kubernetes.io/ttl: "60"
spec:
  type: LoadBalancer
  selector:
    app: my-api
  ports:
    - port: 443
      targetPort: 8443
```

```yaml
# Cluster 2 deployment (eu-west-1)
apiVersion: v1
kind: Service
metadata:
  name: my-api
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    external-dns.alpha.kubernetes.io/set-identifier: "eu-west-1"
    external-dns.alpha.kubernetes.io/aws-weight: "50"
    external-dns.alpha.kubernetes.io/ttl: "60"
spec:
  type: LoadBalancer
  selector:
    app: my-api
  ports:
    - port: 443
      targetPort: 8443
```

### Route53 Latency-Based Routing

```yaml
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    external-dns.alpha.kubernetes.io/set-identifier: "us-east-1-latency"
    external-dns.alpha.kubernetes.io/aws-region: "us-east-1"
    # Routing policy: latency, weighted, failover, geolocation
    external-dns.alpha.kubernetes.io/aws-routing-policy: "latency"
```

### Failover Configuration

```yaml
# Primary (active) cluster
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    external-dns.alpha.kubernetes.io/set-identifier: "primary"
    external-dns.alpha.kubernetes.io/aws-failover: "PRIMARY"
    external-dns.alpha.kubernetes.io/aws-health-check-id: "abc12345-1234-1234-1234-abc123456789"

# Secondary (standby) cluster
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    external-dns.alpha.kubernetes.io/set-identifier: "secondary"
    external-dns.alpha.kubernetes.io/aws-failover: "SECONDARY"
```

## Split-Horizon DNS Configuration

Split-horizon DNS serves different records for the same hostname depending on the query origin — internal queries get private IPs, external queries get public IPs.

### Separate ExternalDNS Deployments

The cleanest pattern deploys two ExternalDNS instances with separate zone filters:

```yaml
# Public ExternalDNS - manages public Route53 zones
# external-dns-public-values.yaml
extraArgs:
  - --aws-zone-type=public
domainFilters:
  - example.com
txtOwnerId: "prod-public"
txtPrefix: "_edns-pub."

annotationFilter: "external-dns.alpha.kubernetes.io/public=true"
```

```yaml
# Private ExternalDNS - manages private Route53 zones
# external-dns-private-values.yaml
extraArgs:
  - --aws-zone-type=private
  - --zone-id-filter=Z9876543210PRIVATE
domainFilters:
  - example.com
  - svc.cluster.local
txtOwnerId: "prod-private"
txtPrefix: "_edns-prv."

annotationFilter: "external-dns.alpha.kubernetes.io/private=true"
```

### Service Annotations for Split-Horizon

```yaml
# Internal service - private DNS only
apiVersion: v1
kind: Service
metadata:
  name: internal-api
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "internal-api.example.com"
    external-dns.alpha.kubernetes.io/private: "true"
    external-dns.alpha.kubernetes.io/ttl: "300"

# Public service - both DNS zones
---
apiVersion: v1
kind: Service
metadata:
  name: public-api
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    external-dns.alpha.kubernetes.io/public: "true"
    external-dns.alpha.kubernetes.io/ttl: "60"
```

## Debugging DNS Propagation Issues

### ExternalDNS Log Analysis

```bash
# Stream ExternalDNS logs
kubectl logs -n external-dns deployment/external-dns -f --tail=100

# Filter for specific hostname
kubectl logs -n external-dns deployment/external-dns | grep "app.example.com"

# Filter for errors only
kubectl logs -n external-dns deployment/external-dns | grep -E '"level":"error"|"level":"warning"'
```

Sample log output showing successful record creation:

```json
{"level":"info","ts":"2030-09-22T10:15:32Z","msg":"Applying provider changes","create":1,"updateOld":0,"updateNew":0,"delete":0}
{"level":"info","ts":"2030-09-22T10:15:33Z","msg":"Add records","records":[{"dnsName":"app.example.com","recordTTL":60,"recordType":"A","targets":["203.0.113.10"]}]}
{"level":"info","ts":"2030-09-22T10:15:33Z","msg":"Add records","records":[{"dnsName":"_edns.app.example.com","recordTTL":300,"recordType":"TXT","targets":["\"heritage=external-dns,external-dns/owner=prod-cluster,external-dns/resource=ingress/production/my-app\""]}]}
```

### Dry-Run Mode for Verification

ExternalDNS supports a dry-run flag to preview changes without applying them:

```bash
kubectl set env deployment/external-dns \
  -n external-dns \
  DRY_RUN=true

# Watch logs to see what would be changed
kubectl logs -n external-dns deployment/external-dns -f

# Re-enable live mode
kubectl set env deployment/external-dns \
  -n external-dns \
  DRY_RUN-
```

### DNS Record Verification

```bash
# Check if record exists in Route53
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890ABCDEF \
  --query "ResourceRecordSets[?Name=='app.example.com.']"

# Check TXT ownership record
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890ABCDEF \
  --query "ResourceRecordSets[?Name=='_edns.app.example.com.']"

# Test DNS resolution from within cluster
kubectl run dns-test --image=busybox:1.36 --rm -it --restart=Never \
  -- nslookup app.example.com

# Test DNS resolution with specific resolver
dig @8.8.8.8 app.example.com A +short

# Check propagation with multiple resolvers
for resolver in 8.8.8.8 1.1.1.1 9.9.9.9; do
  echo "Resolver $resolver:"
  dig @$resolver app.example.com A +short
done
```

### Common Issues and Resolutions

**Issue: Records not created after service/ingress deployment**

```bash
# Check ExternalDNS has necessary permissions
kubectl auth can-i list ingresses --as=system:serviceaccount:external-dns:external-dns -A

# Verify annotation filter matches
kubectl get ingress my-app-ingress -n production -o jsonpath='{.metadata.annotations}'

# Check ExternalDNS is discovering the resource
kubectl logs -n external-dns deployment/external-dns | grep "my-app-ingress"
```

**Issue: Records created but pointing to wrong IP**

```bash
# Verify LoadBalancer has received an external IP
kubectl get service my-api -n production -o jsonpath='{.status.loadBalancer.ingress}'

# If using AWS ALB, check the hostname field (not IP)
kubectl get service my-api -n production \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

**Issue: Old records not deleted after service removal**

```bash
# Verify policy is set to "sync" not "upsert-only"
kubectl get configmap -n external-dns -o yaml | grep policy

# Check TXT ownership record exists for the orphaned record
dig @8.8.8.8 _edns.app.example.com TXT +short

# If TXT record is gone, ExternalDNS won't delete the A record
# Manually delete the A record and recreate the service
```

**Issue: Rate limiting from DNS provider**

```bash
# Increase reconciliation interval to reduce API calls
helm upgrade external-dns external-dns/external-dns \
  --namespace external-dns \
  --reuse-values \
  --set interval=5m
```

## Prometheus Monitoring and Alerting

### ServiceMonitor Configuration

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: external-dns
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: external-dns
  namespaceSelector:
    matchNames:
      - external-dns
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Metrics

```promql
# Rate of DNS record synchronizations
rate(external_dns_controller_reconcile_requests_total[5m])

# Registry errors (ownership record failures)
rate(external_dns_registry_errors_total[5m])

# Source errors (failures reading Kubernetes resources)
rate(external_dns_source_errors_total[5m])

# Verify sync is completing
external_dns_controller_last_reconcile_timestamp_seconds
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-dns-alerts
  namespace: monitoring
spec:
  groups:
    - name: external-dns
      interval: 1m
      rules:
        - alert: ExternalDNSSyncErrors
          expr: rate(external_dns_registry_errors_total[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ExternalDNS registry errors detected"
            description: "ExternalDNS is experiencing errors writing TXT ownership records. DNS records may not be managed correctly."

        - alert: ExternalDNSSourceErrors
          expr: rate(external_dns_source_errors_total[5m]) > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "ExternalDNS source errors detected"
            description: "ExternalDNS cannot read Kubernetes resources. DNS synchronization may be stalled."

        - alert: ExternalDNSNotReconciling
          expr: time() - external_dns_controller_last_reconcile_timestamp_seconds > 600
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "ExternalDNS has not reconciled in 10 minutes"
            description: "ExternalDNS controller may be stuck. DNS records will drift from desired state."
```

## Security Hardening

### Restricting ExternalDNS to Specific Zones

Always use zone ID filtering rather than relying solely on domain filters. Zone IDs are immutable; domain names can be reused:

```yaml
extraArgs:
  - --zone-id-filter=Z1234567890ABCDEF
  - --zone-id-filter=Z9876543210GHIJKL
```

### Namespace-Scoped ExternalDNS

For multi-tenant clusters where different teams own different DNS zones, deploy separate ExternalDNS instances with namespace-scoped RBAC:

```yaml
# Namespace-scoped Role (not ClusterRole)
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: external-dns-team-a
  namespace: team-a
rules:
  - apiGroups: [""]
    resources: ["services", "endpoints", "pods"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["extensions", "networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "watch", "list"]
```

```yaml
# Helm values for namespace-scoped deployment
extraArgs:
  - --namespace=team-a
domainFilters:
  - team-a.example.com
txtOwnerId: "prod-team-a"
```

### Audit Logging with CloudTrail

For Route53, all ExternalDNS API calls appear in CloudTrail under the IAM role used by IRSA. Set up CloudTrail alerts for unexpected DNS changes:

```bash
# Query CloudTrail for Route53 changes by ExternalDNS role
aws logs filter-log-events \
  --log-group-name CloudTrail/Route53 \
  --filter-pattern '{ $.userIdentity.sessionContext.sessionIssuer.arn = "arn:aws:iam::123456789012:role/external-dns-role" }' \
  --start-time $(date -d '1 hour ago' +%s)000
```

## Production Deployment Checklist

Before enabling ExternalDNS in production:

- Set a unique `txtOwnerId` per cluster — this is the most important setting for preventing cross-cluster conflicts
- Configure `txtPrefix` to avoid TXT record collisions with other DNS tooling
- Start with `policy: upsert-only` in production until you have confidence in the configuration, then move to `policy: sync`
- Apply `annotationFilter` to require explicit opt-in from service owners rather than managing all services by default
- Set `domainFilters` to restrict ExternalDNS to managed zones only
- Configure Prometheus alerting on registry and source errors
- Test record cleanup by deleting a test service and verifying DNS record removal
- Document the `txtOwnerId` values for each cluster in a central registry to prevent accidental reuse

ExternalDNS transforms DNS management from a manual operational burden into a self-service capability driven by Kubernetes native workflows. Combined with cert-manager for certificate automation, it creates a fully automated service publication pipeline where deploying a new endpoint requires only a Kubernetes manifest change.
