---
title: "ExternalDNS: Automatic DNS Record Management for Kubernetes Services"
date: 2027-01-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ExternalDNS", "DNS", "Networking", "AWS Route53"]
categories: ["Kubernetes", "Networking", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to ExternalDNS: Route53 with IRSA, Cloudflare, multiple providers, txt-owner-id record ownership, split-horizon DNS, Gateway API, CRD source, monitoring, and conflict resolution."
more_link: "yes"
url: "/external-dns-kubernetes-automatic-dns-management-guide/"
---

DNS record management is the last manual step in many Kubernetes deployment pipelines. Engineers deploy a Service, watch the LoadBalancer receive an IP, then log into the DNS console to create an A record — an error-prone step that is easy to forget, hard to audit, and tedious to scale across dozens of services. **ExternalDNS** automates this by watching Kubernetes resources and synchronizing DNS records to your DNS provider, making DNS as declarative as the workloads that need it.

<!--more-->

## ExternalDNS Architecture

ExternalDNS operates as a reconciliation loop with three components:

**Source watchers** observe Kubernetes resources — Services, Ingresses, Gateway API HTTPRoutes, and custom `DNSEndpoint` CRDs — and extract the desired hostname-to-IP (or CNAME) mappings from annotations and spec fields.

**Registry** tracks which DNS records ExternalDNS owns using **TXT ownership records** stored alongside each managed DNS record. This prevents ExternalDNS from deleting records created by other systems.

**Provider plugins** implement the DNS API for each supported provider. Route53, Cloudflare, Azure DNS, GCP Cloud DNS, and 30+ others are shipped with ExternalDNS. The provider translates the desired endpoint list into create/update/delete API calls against the DNS provider.

```
Kubernetes API                   DNS Provider
─────────────────────────────────────────────────────────
 Service (LoadBalancer)          Route53 / Cloudflare / etc.
 Ingress                              │
 HTTPRoute                            │
 DNSEndpoint CRD                      │
         │                            │
         │ source watcher             │
         ▼                            │
  ExternalDNS Controller              │
  ┌──────────────────────┐            │
  │  Desired Endpoints   │            │
  │  api.example.com     │            │
  │  → 198.51.100.42     │            │
  └──────────────────────┘            │
         │                            │
         │ registry (TXT records)     │
         ▼                            │
  ┌──────────────────────┐            │
  │  Plan (diff)         │            │
  │  Create: api.A       ├───────────►│
  │  Create: api.TXT     │            │
  └──────────────────────┘            │
```

## Installation

### Helm Installation

```bash
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns
helm repo update

helm install external-dns external-dns/external-dns \
  --namespace external-dns \
  --create-namespace \
  --version 1.14.5 \
  --set provider=aws \
  --set txtOwnerId=cluster-production \
  --set domainFilters[0]=example.com \
  --set policy=sync \
  --set registry=txt \
  --set interval=1m
```

### Core Configuration Parameters

| Parameter | Description | Recommended Value |
|-----------|-------------|-------------------|
| `txtOwnerId` | Unique identifier embedded in TXT records | Cluster name or ID |
| `domainFilters` | Restrict ExternalDNS to specific zones | Your domain(s) |
| `policy` | `sync` (delete stale) or `upsert-only` (never delete) | `sync` in production |
| `registry` | `txt` (recommended) or `noop` | `txt` |
| `interval` | Reconciliation interval | `1m` |
| `sources` | Which resource types to watch | `["service","ingress"]` |

**`txtOwnerId` is critical** — it scopes ownership. In a multi-cluster setup, each cluster must have a unique `txtOwnerId` to prevent clusters from fighting over the same DNS records.

## Route53 Provider with IRSA

Using IAM Roles for Service Accounts (IRSA) eliminates the need for static AWS credentials in the cluster.

### IAM Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["route53:ChangeResourceRecordSets"],
      "Resource": ["arn:aws:route53:::hostedzone/*"]
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

### IRSA Configuration

```bash
# Create the IRSA role (assuming OIDC provider is configured for the cluster)
eksctl create iamserviceaccount \
  --cluster production-eks \
  --namespace external-dns \
  --name external-dns \
  --attach-policy-arn arn:aws:iam::123456789012:policy/ExternalDNSPolicy \
  --approve
```

```yaml
# external-dns-values.yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/external-dns

provider: aws
aws:
  region: us-east-1
  zoneType: public    # or: private

txtOwnerId: "production-eks-cluster"
domainFilters:
  - example.com
  - internal.example.com

policy: sync
registry: txt
txtPrefix: "extdns-"   # Prefix for TXT ownership records to avoid conflicts

# Limit to specific hosted zone IDs for additional safety
zoneIdFilters:
  - Z1234567890EXAMPLEPUBLIC
  - Z9876543210EXAMPLEPRIVATE

sources:
  - service
  - ingress

logLevel: info
interval: 1m
```

## Cloudflare Provider

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: external-dns
type: Opaque
stringData:
  cloudflare_api_token: "EXAMPLE_CF_TOKEN_REPLACE_ME"
```

```yaml
# external-dns-cloudflare-values.yaml
provider: cloudflare
env:
  - name: CF_API_TOKEN
    valueFrom:
      secretKeyRef:
        name: cloudflare-api-token
        key: cloudflare_api_token

cloudflare:
  proxied: false        # Set true to enable Cloudflare proxy (CDN/WAF)
  email: ""            # Not needed when using API token

txtOwnerId: "production-cluster"
domainFilters:
  - example.com

policy: sync
registry: txt
```

## Multiple Providers Simultaneously

A single ExternalDNS instance can only target one provider. For multi-provider setups (e.g., Route53 for public DNS and PowerDNS for internal DNS), deploy multiple ExternalDNS instances with different source selectors.

```yaml
# Instance 1: public DNS via Route53
# external-dns-public-values.yaml
fullnameOverride: external-dns-public
provider: aws
txtOwnerId: "production-cluster-public"
domainFilters:
  - example.com
annotationFilter: "external-dns.alpha.kubernetes.io/access=public"
sources:
  - service
  - ingress

---
# Instance 2: private DNS via PowerDNS
# external-dns-private-values.yaml
fullnameOverride: external-dns-private
provider: pdns
txtOwnerId: "production-cluster-private"
domainFilters:
  - internal.example.com
annotationFilter: "external-dns.alpha.kubernetes.io/access=private"
sources:
  - service
  - ingress
```

The `annotationFilter` ensures each instance only processes resources with the matching annotation, preventing both instances from trying to manage the same records.

## TXT Owner Record Ownership

When ExternalDNS creates a DNS record, it also creates a companion TXT record that encodes the owner identity:

```
# A record
api.example.com.   300   IN   A   198.51.100.42

# Ownership TXT record (with txtPrefix "extdns-")
extdns-api.example.com.   300   IN   TXT   "heritage=external-dns,owner=production-cluster,resource=service/production/api-gateway"
```

The `resource` field identifies the Kubernetes resource that requested the record. This enables:
- Safe deletion — ExternalDNS only deletes records it owns
- Conflict detection — if two ExternalDNS instances with different `txtOwnerId` values try to manage the same hostname, the second one detects the conflict and skips it
- Debugging — the TXT record reveals exactly which Kubernetes object caused a DNS record to be created

### Checking Ownership in Practice

```bash
# List all TXT ownership records for a domain
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890EXAMPLEPUBLIC \
  --query 'ResourceRecordSets[?Type==`TXT`]' \
  | grep heritage

# Or with dig
dig TXT extdns-api.example.com
```

## Annotation-Based Control

### Service Annotations

A `LoadBalancer` Service annotated with the hostname annotation is the primary trigger:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: production
  annotations:
    # Primary hostname annotation
    external-dns.alpha.kubernetes.io/hostname: api.example.com
    # Optional: override TTL (provider must support it)
    external-dns.alpha.kubernetes.io/ttl: "300"
    # Optional: create CNAME instead of A record
    # external-dns.alpha.kubernetes.io/target: "nlb-123456.us-east-1.elb.amazonaws.com"
spec:
  type: LoadBalancer
  selector:
    app: api-gateway
  ports:
    - port: 443
      targetPort: 8443
```

### Multiple Hostnames

```yaml
annotations:
  # Comma-separated list
  external-dns.alpha.kubernetes.io/hostname: api.example.com,api-v2.example.com,api-alias.example.com
```

### Ingress Annotations

For Ingress resources, ExternalDNS extracts hostnames from `spec.rules[*].host` automatically — no annotation needed. Add the annotation to override TTL or target:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-app
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/ttl: "120"
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
                name: web-app
                port:
                  number: 80
    - host: www.example.com    # Both hostnames managed automatically
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-app
                port:
                  number: 80
```

## Gateway API Source

ExternalDNS supports the Gateway API `HTTPRoute` resource, extracting hostnames from `spec.hostnames`:

```yaml
# external-dns-values.yaml
sources:
  - service
  - ingress
  - gateway-httproute
  - gateway-tlsroute
  - gateway-tcproute
  - gateway-udproute
```

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: checkout-route
  namespace: production
spec:
  parentRefs:
    - name: production-gateway
      namespace: ingress
  hostnames:
    - checkout.example.com      # ExternalDNS manages this record
    - checkout-api.example.com  # And this one
  rules:
    - backendRefs:
        - name: checkout-service
          port: 8080
```

## Split-Horizon DNS

Split-horizon DNS presents different records for the same hostname based on the query source — internal clients receive private IPs, external clients receive public IPs. ExternalDNS supports this with multiple instances and zone filters.

```yaml
# Instance 1: External (public hosted zone)
provider: aws
aws:
  zoneType: public
txtOwnerId: "cluster-prod-external"
annotationFilter: "external-dns.alpha.kubernetes.io/zone=public"
domainFilters:
  - example.com

# Instance 2: Internal (private hosted zone)
provider: aws
aws:
  zoneType: private
txtOwnerId: "cluster-prod-internal"
annotationFilter: "external-dns.alpha.kubernetes.io/zone=private"
domainFilters:
  - example.com
```

Services annotate which zone they target:

```yaml
annotations:
  external-dns.alpha.kubernetes.io/hostname: checkout.example.com
  external-dns.alpha.kubernetes.io/zone: private
```

## Private Hosted Zones

For internal services on AWS, ExternalDNS can manage records in private Route53 hosted zones that are only resolvable within VPCs:

```yaml
provider: aws
aws:
  region: us-east-1
  zoneType: private      # Only manage private zones
txtOwnerId: "cluster-prod-private"
domainFilters:
  - internal.example.com
zoneIdFilters:
  - Z9876543210EXAMPLEPRIVATE   # Explicit zone ID for private zone
```

Ensure the EKS nodes or pod network has the VPC association with the private hosted zone. Without this, DNS queries from pods will not resolve private zone records even if ExternalDNS creates them correctly.

## Wildcard Records

ExternalDNS supports wildcard DNS records when the source object requests them:

```yaml
annotations:
  external-dns.alpha.kubernetes.io/hostname: "*.apps.example.com"
```

Route53 supports wildcard A and CNAME records natively. The TXT ownership record for a wildcard is placed at the apex of the wildcard without the leading `*` to avoid DNS wildcard matching the TXT record itself.

```
# Wildcard A record
*.apps.example.com.   300   IN   A   198.51.100.100

# Ownership TXT — placed at apps.example.com (without *)
extdns-apps.example.com.   300   IN   TXT   "heritage=external-dns,owner=cluster-prod,resource=..."
```

## TTL Configuration

TTL can be configured globally or per-resource. Lower TTLs reduce DNS caching delay for record changes at the cost of higher query volume.

```yaml
# Global default TTL (seconds)
txtTTL: 300

# Per-resource override via annotation
# external-dns.alpha.kubernetes.io/ttl: "60"
```

Recommended TTLs by use case:
- External-facing production services: 300s (5 minutes)
- Internal cluster services: 60s
- Canary or frequently-changing endpoints: 30s
- Disaster recovery failover targets: 60s (lower than normal to speed failover)

## CRD Source for Custom Endpoints

The `DNSEndpoint` CRD allows any Kubernetes controller or GitOps workflow to create DNS records without using a Service or Ingress as the vehicle:

```bash
# Install the DNSEndpoint CRD
helm install external-dns external-dns/external-dns \
  --set sources[0]=crd \
  --set sources[1]=service \
  --set sources[2]=ingress \
  --set crd.create=true
```

```yaml
apiVersion: externaldns.k8s.io/v1alpha1
kind: DNSEndpoint
metadata:
  name: database-read-replica
  namespace: production
spec:
  endpoints:
    - dnsName: db-read.example.com
      recordTTL: 120
      recordType: A
      targets:
        - 198.51.100.200
    - dnsName: db-read.example.com
      recordTTL: 120
      recordType: A
      targets:
        - 198.51.100.201
    # SRV record for service discovery
    - dnsName: _postgres._tcp.db-read.example.com
      recordTTL: 120
      recordType: SRV
      targets:
        - "10 100 5432 db-read.example.com"
```

The CRD source is useful for:
- Database endpoints managed outside Kubernetes (RDS, CloudSQL)
- Batch job completion records
- Manual failover targets that need to be version-controlled in Git

## Dry-Run Mode

Before enabling ExternalDNS in a production cluster, validate the records it would create without making any changes:

```bash
# One-shot dry-run
kubectl run external-dns-dryrun \
  --image=registry.k8s.io/external-dns/external-dns:v0.14.2 \
  --restart=Never \
  --rm -it \
  -- \
  --provider=aws \
  --aws-zone-type=public \
  --source=service \
  --source=ingress \
  --domain-filter=example.com \
  --txt-owner-id=cluster-prod \
  --dry-run=true \
  --log-level=debug \
  --once
```

The output shows every DNS record ExternalDNS would create, update, or delete. Review this carefully before switching to `--dry-run=false`.

## Monitoring

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: external-dns
  namespace: external-dns
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: external-dns
  endpoints:
    - port: http
      interval: 30s
      path: /metrics
```

### Key Metrics

| Metric | Description |
|--------|-------------|
| `external_dns_controller_last_sync_timestamp_seconds` | Unix timestamp of the last successful sync |
| `external_dns_registry_endpoints_total` | DNS records managed by this instance |
| `external_dns_source_endpoints_total` | Desired endpoints extracted from sources |
| `external_dns_controller_verified_aaaa_records_total` | Successfully verified AAAA records |
| `external_dns_provider_errors_total` | API errors from the DNS provider |

### Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-dns-alerts
  namespace: external-dns
spec:
  groups:
    - name: external-dns.sync
      rules:
        - alert: ExternalDNSSyncStale
          expr: |
            time() - external_dns_controller_last_sync_timestamp_seconds > 300
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ExternalDNS has not synced successfully in 5 minutes"

        - alert: ExternalDNSProviderErrors
          expr: |
            increase(external_dns_provider_errors_total[10m]) > 3
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ExternalDNS provider API errors: {{ $value }} in last 10 minutes"

        - alert: ExternalDNSEndpointDrift
          expr: |
            abs(external_dns_registry_endpoints_total - external_dns_source_endpoints_total) > 5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "DNS registry and desired state differ by {{ $value }} records"
```

## Conflict Resolution Between Clusters

When multiple clusters manage DNS for the same domain, record conflicts are possible. ExternalDNS's TXT ownership model handles this, but requires careful `txtOwnerId` configuration.

### Scenario: Two Clusters, Same Domain

```
Cluster A (us-east-1):  txtOwnerId = "cluster-prod-east"
Cluster B (eu-west-1):  txtOwnerId = "cluster-prod-west"
```

Both clusters try to set `api.example.com`:

1. Cluster A creates: `api.example.com A 198.51.100.1` + `extdns-api.example.com TXT "owner=cluster-prod-east,..."`
2. Cluster B sees the TXT record and detects ownership by `cluster-prod-east`
3. Cluster B skips the record — it does not overwrite records it does not own
4. Log message: `"Skipping endpoint api.example.com — owned by cluster-prod-east"`

For active-active DNS with health-based failover, use Route53 weighted or latency-based routing with multiple records:

```yaml
# Cluster A Service annotation
annotations:
  external-dns.alpha.kubernetes.io/hostname: api.example.com
  external-dns.alpha.kubernetes.io/aws-weight: "50"
  external-dns.alpha.kubernetes.io/set-identifier: cluster-prod-east

# Cluster B Service annotation
annotations:
  external-dns.alpha.kubernetes.io/hostname: api.example.com
  external-dns.alpha.kubernetes.io/aws-weight: "50"
  external-dns.alpha.kubernetes.io/set-identifier: cluster-prod-west
```

ExternalDNS uses the `set-identifier` to distinguish the two weighted records, allowing both clusters to manage their own record independently.

## RBAC Requirements

ExternalDNS requires read access to Services, Ingresses, Nodes, and Pods to extract endpoint information:

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
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways", "httproutes", "tlsroutes", "tcproutes", "udproutes"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["externaldns.k8s.io"]
    resources: ["dnsendpoints"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["externaldns.k8s.io"]
    resources: ["dnsendpoints/status"]
    verbs: ["update", "patch"]
```

## Troubleshooting

### Records Not Being Created

```bash
# Check ExternalDNS logs
kubectl -n external-dns logs -l app.kubernetes.io/name=external-dns --tail=100

# Common log messages and meanings:
# "No endpoints could be generated" — Service has no external IP yet
# "Skipping..." — TXT ownership conflict
# "Considering 0 records" — domainFilters not matching

# Verify the service has a LoadBalancer IP
kubectl -n production get svc api-gateway -o jsonpath='{.status.loadBalancer.ingress}'

# Verify annotation is present and correctly spelled
kubectl -n production get svc api-gateway \
  -o jsonpath='{.metadata.annotations}' | python3 -m json.tool
```

### Route53 Permission Denied

```bash
# Test the IAM permissions from the ExternalDNS pod
kubectl -n external-dns exec -it \
  $(kubectl -n external-dns get pod -l app.kubernetes.io/name=external-dns -o name | head -1) \
  -- aws route53 list-hosted-zones

# Check IRSA annotation
kubectl -n external-dns get serviceaccount external-dns \
  -o jsonpath='{.metadata.annotations}'
```

### Records Accumulating and Not Being Cleaned Up

```bash
# Verify policy is set to "sync" not "upsert-only"
kubectl -n external-dns get deployment external-dns \
  -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n'

# Check that the source Kubernetes resource was actually deleted
kubectl -n production get svc api-gateway 2>&1
# If NotFound, the record should have been cleaned up

# Check TXT ownership record
dig TXT extdns-api.example.com
# Owner mismatch means another ExternalDNS instance "owns" the record
```

### Handling Stale TXT Records After txtOwnerId Change

If `txtOwnerId` is changed, existing TXT records reflect the old owner and will no longer be recognized. ExternalDNS will not delete records it does not own. Clean them manually:

```bash
# List all TXT records containing the old owner ID
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890EXAMPLEPUBLIC \
  --query 'ResourceRecordSets[?Type==`TXT`]' \
  | python3 -c "
import json, sys
records = json.load(sys.stdin)
for r in records:
    for v in r.get('ResourceRecords', []):
        if 'old-owner-id' in v.get('Value', ''):
            print(r['Name'])
"
# Then delete or update those records manually or via a migration script
```

ExternalDNS transforms DNS from a manual operational step into a natural consequence of deploying a Service or Ingress. Combined with cert-manager for TLS automation, it completes the loop: deploy a workload, get a hostname, get a certificate — all without leaving the Kubernetes API.
