---
title: "ExternalDNS on Kubernetes: Automated DNS Record Management for Cloud and On-Prem"
date: 2027-06-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ExternalDNS", "DNS", "Automation", "Cloud Native"]
categories:
- Kubernetes
- Networking
- Automation
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to ExternalDNS on Kubernetes: DNS provider integrations (Route53, Cloud DNS, Cloudflare, CoreDNS), annotation-driven record creation, sync policies, TXT ownership records, split-horizon DNS, RBAC, monitoring DNS propagation, and integration with LoadBalancer and Ingress resources."
more_link: "yes"
url: "/kubernetes-external-dns-automation-guide/"
---

Managing DNS records by hand for Kubernetes services does not scale. Every LoadBalancer service, every Ingress resource, and every migration between clusters requires DNS updates — and manual updates are slow, error-prone, and invisible to the deployment pipeline. ExternalDNS solves this by acting as a Kubernetes controller that watches Service and Ingress resources and automatically synchronizes DNS records with external DNS providers. This guide covers the full production deployment of ExternalDNS: provider integrations, ownership models, sync strategies, RBAC, monitoring, and operational patterns for both cloud and on-premises environments.

<!--more-->

## Section 1: ExternalDNS Architecture

ExternalDNS operates as a Kubernetes controller with a three-stage reconciliation loop:

1. **Source discovery**: Reads DNS endpoint information from Kubernetes resources (Services, Ingresses, Gateway API routes, CRD sources).
2. **Registry lookup**: Queries the DNS provider for existing records and compares against desired state.
3. **Plan and apply**: Calculates create, update, and delete operations, then applies changes to the DNS provider.

### Supported Sources

| Source | Resource | DNS Extracted From |
|--------|----------|--------------------|
| `service` | Service (LoadBalancer) | `.status.loadBalancer.ingress[].hostname` or `.ip` |
| `ingress` | Ingress | `.spec.rules[].host` |
| `gateway-httproute` | HTTPRoute (Gateway API) | `.spec.hostnames[]` |
| `crd` | DNSEndpoint (ExternalDNS CRD) | Custom records |
| `node` | Node | Node ExternalIP |
| `pod` | Pod (annotated) | Pod IP |
| `connector` | Headless service | Pod IPs |

### Supported DNS Providers (Selection)

| Provider | Authentication | Notes |
|----------|---------------|-------|
| AWS Route 53 | IAM role/IRSA | Most commonly used in AWS environments |
| Google Cloud DNS | Workload Identity | Native GKE integration |
| Azure DNS | Managed Identity | AKS native support |
| Cloudflare | API token | Proxied and non-proxied records |
| CoreDNS | etcd backend | On-premises/air-gapped deployments |
| RFC2136 (BIND) | TSIG key | Traditional DNS infrastructure |
| PowerDNS | HTTP API | On-premises self-hosted DNS |
| Infoblox | HTTP API | Enterprise IPAM/DNS integration |

## Section 2: Installation with Helm

```bash
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm repo update

# Route 53 installation example
helm install external-dns external-dns/external-dns \
  --namespace external-dns \
  --create-namespace \
  --set provider.name=aws \
  --set env[0].name=AWS_DEFAULT_REGION \
  --set env[0].value=us-east-1 \
  --set policy=sync \
  --set registry=txt \
  --set txtOwnerId=my-cluster-prod \
  --set txtPrefix=externaldns- \
  --set sources[0]=service \
  --set sources[1]=ingress \
  --set domainFilters[0]=example.com \
  --set deploymentStrategy.type=Recreate \
  --set metrics.enabled=true \
  --set serviceMonitor.enabled=true \
  --set interval=1m \
  --set triggerLoopOnEvent=true \
  --set logLevel=info \
  --set logFormat=json
```

### Full Helm Values File

```yaml
# values-external-dns.yaml
image:
  repository: registry.k8s.io/external-dns/external-dns
  tag: v0.14.2

provider:
  name: aws

env:
- name: AWS_DEFAULT_REGION
  value: us-east-1

policy: sync
registry: txt
txtOwnerId: my-cluster-prod
txtPrefix: "externaldns-"

sources:
- service
- ingress

domainFilters:
- example.com
- internal.example.com

# Exclude system namespaces
namespaceFilter: "!kube-system,!kube-public,!cert-manager,!ingress-nginx"

# Process only annotated resources (safer for shared clusters)
annotationFilter: "external-dns.alpha.kubernetes.io/hostname"

interval: 1m
triggerLoopOnEvent: true

# Batch changes to reduce API calls
batchChangeSize: 1000
batchChangeInterval: 10s

# DNS record TTL
txtTTL: 300

deploymentStrategy:
  type: Recreate

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
    additionalLabels:
      release: kube-prometheus-stack

podSecurityContext:
  fsGroup: 65534
  runAsNonRoot: true
  runAsUser: 65534
  seccompProfile:
    type: RuntimeDefault

securityContext:
  allowPrivilegeEscalation: false
  capabilities:
    drop:
    - ALL
  readOnlyRootFilesystem: true

serviceAccount:
  create: true
  name: external-dns
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/external-dns-role"
```

## Section 3: DNS Provider Integrations

### AWS Route 53

#### IAM Policy

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
      "Resource": [
        "*"
      ]
    }
  ]
}
```

#### IRSA Configuration

```bash
eksctl create iamserviceaccount \
  --name external-dns \
  --namespace external-dns \
  --cluster my-cluster \
  --role-name external-dns-role \
  --attach-policy-arn arn:aws:iam::123456789012:policy/ExternalDNSPolicy \
  --approve \
  --override-existing-serviceaccounts
```

#### Route 53 Helm Configuration

```yaml
provider:
  name: aws

extraArgs:
  aws-zone-type: public          # "public", "private", or "" for both
  aws-zones-cache-duration: 1h
  aws-batch-change-size: 1000
  aws-batch-change-interval: 2s
  aws-evaluate-target-health: true  # Set Route53 health check evaluate flag

serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/external-dns-role"
```

### Google Cloud DNS

```yaml
provider:
  name: google

extraArgs:
  google-project: my-gcp-project
  google-zone-visibility: public   # "public" or "private"

serviceAccount:
  annotations:
    iam.gke.io/gcp-service-account: external-dns@my-gcp-project.iam.gserviceaccount.com
```

Grant required permissions:

```bash
gcloud iam service-accounts create external-dns \
  --display-name="ExternalDNS service account"

gcloud projects add-iam-policy-binding my-gcp-project \
  --member="serviceAccount:external-dns@my-gcp-project.iam.gserviceaccount.com" \
  --role="roles/dns.admin"

gcloud iam service-accounts add-iam-policy-binding \
  external-dns@my-gcp-project.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:my-gcp-project.svc.id.goog[external-dns/external-dns]"
```

### Cloudflare

```yaml
provider:
  name: cloudflare

env:
- name: CF_API_TOKEN
  valueFrom:
    secretKeyRef:
      name: cloudflare-api-credentials
      key: api-token

extraArgs:
  cloudflare-proxied: false     # Set to true to enable Cloudflare proxying (orange cloud)
  cloudflare-dns-records-per-page: 5000
```

Create the API token secret:

```bash
kubectl create secret generic cloudflare-api-credentials \
  --from-literal=api-token="YOUR_CLOUDFLARE_API_TOKEN" \
  -n external-dns
```

The Cloudflare API token requires `Zone:DNS:Edit` and `Zone:Zone:Read` permissions scoped to the target zones.

### CoreDNS with etcd Backend (On-Premises)

CoreDNS with the etcd plugin provides DNS for on-premises or air-gapped environments:

```yaml
# CoreDNS configuration for etcd-backed zones
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    example.internal:53 {
      errors
      log
      etcd {
        path /skydns
        endpoint http://etcd-cluster.kube-system.svc.cluster.local:2379
        upstream 8.8.8.8:53
        fallthrough
      }
      prometheus :9153
      cache 30
      loop
      reload
      loadbalance
    }
    .:53 {
      errors
      health
      ready
      kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
      }
      forward . /etc/resolv.conf
      cache 30
      loop
      reload
      loadbalance
    }
```

```yaml
# ExternalDNS for CoreDNS/etcd
provider:
  name: coredns

env:
- name: ETCD_URLS
  value: http://etcd-cluster.kube-system.svc.cluster.local:2379

extraArgs:
  coredns-prefix: /skydns

domainFilters:
- example.internal
```

### RFC2136 (BIND/Traditional DNS)

```yaml
provider:
  name: rfc2136

extraArgs:
  rfc2136-host: 192.168.1.10
  rfc2136-port: "53"
  rfc2136-zone: example.com
  rfc2136-tsig-secret-alg: hmac-sha512
  rfc2136-tsig-keyname: externaldns-key

env:
- name: EXTERNAL_DNS_RFC2136_TSIG_SECRET
  valueFrom:
    secretKeyRef:
      name: rfc2136-tsig-secret
      key: tsig-secret
```

Generate TSIG key for BIND:

```bash
tsig-keygen -a hmac-sha512 externaldns-key

# Add to named.conf
key "externaldns-key" {
  algorithm hmac-sha512;
  secret "BASE64_SECRET_HERE";
};

zone "example.com" {
  type master;
  file "/etc/bind/zones/example.com.zone";
  allow-update { key "externaldns-key"; };
};
```

## Section 4: Annotation-Driven Record Creation

### Service Annotations

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-api
  namespace: production
  annotations:
    # Required: hostname to create
    external-dns.alpha.kubernetes.io/hostname: api.example.com

    # Optional: TTL override (seconds)
    external-dns.alpha.kubernetes.io/ttl: "60"

    # Optional: alias record (Route 53 only)
    external-dns.alpha.kubernetes.io/alias: "true"

    # Optional: target override (use this IP/hostname instead of LB address)
    external-dns.alpha.kubernetes.io/target: "10.0.0.100"

    # Optional: multiple hostnames
    # external-dns.alpha.kubernetes.io/hostname: api.example.com,api-v2.example.com

    # Optional: Cloudflare proxied
    external-dns.alpha.kubernetes.io/cloudflare-proxied: "false"
spec:
  type: LoadBalancer
  selector:
    app: web-api
  ports:
  - port: 443
    targetPort: 8443
```

### Ingress Annotations

For Ingress resources, ExternalDNS automatically extracts hostnames from `spec.rules[].host`. Annotations provide overrides:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
  namespace: production
  annotations:
    # ExternalDNS reads hostnames from spec.rules automatically
    # Use annotation to override TTL
    external-dns.alpha.kubernetes.io/ttl: "120"

    # Specify a different target than the ingress LB IP
    external-dns.alpha.kubernetes.io/target: "203.0.113.10"

    # Set record type hint (A or CNAME)
    # external-dns.alpha.kubernetes.io/type: "A"
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
            name: app-service
            port:
              number: 8080
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

Both `app.example.com` and `api.example.com` records are created pointing to the ingress controller's external IP or hostname.

### DNSEndpoint CRD (Manual Records)

For DNS records that do not correspond to a Service or Ingress:

```yaml
apiVersion: externaldns.k8s.io/v1alpha1
kind: DNSEndpoint
metadata:
  name: custom-records
  namespace: production
spec:
  endpoints:
  - dnsName: mail.example.com
    recordTTL: 300
    recordType: MX
    targets:
    - "10 mail1.example.com"
    - "20 mail2.example.com"

  - dnsName: vpn.example.com
    recordTTL: 60
    recordType: A
    targets:
    - "203.0.113.50"

  - dnsName: service.example.com
    recordTTL: 300
    recordType: CNAME
    targets:
    - "alb-abc123.us-east-1.elb.amazonaws.com"

  - dnsName: _dmarc.example.com
    recordTTL: 300
    recordType: TXT
    targets:
    - "v=DMARC1; p=reject; rua=mailto:dmarc@example.com"
```

Enable the DNSEndpoint source:

```yaml
sources:
- service
- ingress
- crd
crdSourceApiVersion: externaldns.k8s.io/v1alpha1
crdSourceKind: DNSEndpoint
```

## Section 5: Sync Policies

ExternalDNS supports three sync policies, configured via the `--policy` flag:

### sync (Bidirectional Sync)

```yaml
policy: sync
```

ExternalDNS creates, updates, AND deletes DNS records to match the current desired state. Records no longer referenced by Kubernetes resources are deleted. This is the recommended policy for single-cluster environments where ExternalDNS owns all DNS records in the zone.

**Risk**: If the Kubernetes API is briefly unavailable, ExternalDNS may delete records that are still valid. Use ownership records (TXT registry) to mitigate.

### upsert-only (No Deletion)

```yaml
policy: upsert-only
```

ExternalDNS creates and updates records but never deletes them. Records must be removed manually or by an out-of-band process. This policy is safer for multi-cluster environments or when ExternalDNS shares a DNS zone with manually managed records.

### create-only (No Updates or Deletion)

```yaml
policy: create-only
```

ExternalDNS only creates records that do not already exist. Existing records (including ExternalDNS-owned records) are never modified. Useful for blue-green cluster migrations where the new cluster should not overwrite the old cluster's records.

### Policy Selection Matrix

| Scenario | Recommended Policy |
|----------|-------------------|
| Single cluster, ExternalDNS owns the zone | `sync` |
| Multi-cluster, shared zone | `upsert-only` |
| Blue-green cluster migration (new cluster) | `create-only` |
| Shared zone with manual records | `upsert-only` |
| Air-gapped, no deletion risk | `sync` |

## Section 6: TXT Ownership Records

ExternalDNS uses TXT records as ownership markers to identify which DNS records it created and owns. Without ownership records, `sync` policy would delete all records in the zone that are not referenced by Kubernetes resources — including records created by other means.

### TXT Registry Configuration

```yaml
registry: txt
txtOwnerId: my-cluster-prod       # Unique identifier per cluster
txtPrefix: "externaldns-"         # Prefix for TXT ownership records
txtSuffix: ""                     # Alternative: suffix instead of prefix
```

For a record `api.example.com A 203.0.113.10`, ExternalDNS creates:

```
api.example.com                  A     203.0.113.10
externaldns-api.example.com      TXT   "heritage=external-dns,external-dns/owner=my-cluster-prod,external-dns/resource=service/production/web-api"
```

The TXT record contains:
- `heritage=external-dns`: Identifies the record as ExternalDNS-managed
- `external-dns/owner=my-cluster-prod`: Identifies the owning cluster instance
- `external-dns/resource=service/production/web-api`: References the Kubernetes resource

### Multi-Cluster TXT Ownership

In multi-cluster deployments, each ExternalDNS instance must have a unique `txtOwnerId`. ExternalDNS only deletes records it owns (matching `txtOwnerId`):

```yaml
# Cluster 1
txtOwnerId: prod-us-east-1

# Cluster 2
txtOwnerId: prod-us-west-2
```

Both clusters can write to the same zone. Each only manages its own records. A record created by cluster 1 is not deleted by cluster 2's sync cycle.

### Checking TXT Ownership Records

```bash
# List all ExternalDNS TXT records in Route 53
aws route53 list-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --query "ResourceRecordSets[?Type=='TXT' && contains(Name, 'externaldns')]" \
  --output table

# Or via dig
dig TXT externaldns-api.example.com +short
```

### Cleaning Up Orphaned TXT Records

```bash
#!/usr/bin/env bash
# cleanup-externaldns-txt.sh — remove TXT records for deleted Kubernetes resources

HOSTED_ZONE_ID="Z1234567890ABC"
OWNER_ID="my-cluster-prod"
REGION="us-east-1"

# List all ExternalDNS TXT records
aws route53 list-resource-record-sets \
  --hosted-zone-id "${HOSTED_ZONE_ID}" \
  --region "${REGION}" \
  --query "ResourceRecordSets[?Type=='TXT']" \
  --output json | \
  jq -r '.[] | select(.ResourceRecords[].Value | contains("'"${OWNER_ID}"'")) | .Name' | \
  while read -r record; do
    base_name="${record#externaldns-}"
    # Check if corresponding A/CNAME record still exists
    if ! aws route53 list-resource-record-sets \
        --hosted-zone-id "${HOSTED_ZONE_ID}" \
        --query "ResourceRecordSets[?Name=='${base_name}' && Type!='TXT']" \
        --output text | grep -q "${base_name}"; then
      echo "Orphaned TXT record: ${record}"
      # Uncomment to delete:
      # aws route53 change-resource-record-sets ...
    fi
  done
```

## Section 7: Split-Horizon DNS

Split-horizon DNS provides different DNS responses for internal vs external queries — internal clients resolve to private IPs, external clients to public IPs. ExternalDNS supports this through separate instances targeting different zones.

### Split-Horizon Architecture

```
External clients → Public DNS zone (example.com) → Public IP 203.0.113.10
Internal clients → Private DNS zone (example.com) → Private IP 10.0.0.100
```

### Dual ExternalDNS Deployment

Deploy two ExternalDNS instances with different zone targets:

```yaml
# values-external-dns-public.yaml
nameOverride: external-dns-public
provider:
  name: aws
policy: sync
registry: txt
txtOwnerId: my-cluster-public
txtPrefix: "extdns-pub-"
domainFilters:
- example.com
extraArgs:
  aws-zone-type: public
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/external-dns-public"
---
# values-external-dns-private.yaml
nameOverride: external-dns-private
provider:
  name: aws
policy: sync
registry: txt
txtOwnerId: my-cluster-private
txtPrefix: "extdns-priv-"
domainFilters:
- example.com
extraArgs:
  aws-zone-type: private
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/external-dns-private"
```

### Annotation-Based Target Selection

```yaml
# Service exposed both internally and externally
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    # Public DNS points to external LoadBalancer
    external-dns.alpha.kubernetes.io/hostname: api.example.com
    external-dns.alpha.kubernetes.io/target: "203.0.113.10"
spec:
  type: LoadBalancer
---
# Additional internal Service or use separate annotation controller
apiVersion: v1
kind: Service
metadata:
  name: api-service-internal
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: api.internal.example.com
    external-dns.alpha.kubernetes.io/target: "10.0.0.100"
spec:
  type: ClusterIP
```

### Private Zone with Namespace Filtering

```yaml
# Separate ExternalDNS instance for production namespace only
annotationFilter: "environment=production"
namespaceFilter: production
domainFilters:
- production.internal.example.com
txtOwnerId: my-cluster-prod-private
```

## Section 8: RBAC Requirements

### ClusterRole for ExternalDNS

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: external-dns
rules:
# Required for source=service
- apiGroups: [""]
  resources: ["services", "endpoints", "pods", "nodes"]
  verbs: ["get", "watch", "list"]
# Required for source=ingress
- apiGroups: ["extensions", "networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "watch", "list"]
# Required for source=crd (DNSEndpoint)
- apiGroups: ["externaldns.k8s.io"]
  resources: ["dnsendpoints"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["externaldns.k8s.io"]
  resources: ["dnsendpoints/status"]
  verbs: ["*"]
# Required for source=gateway-httproute
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["gateways", "httproutes", "grpcroutes", "tlsroutes", "tcproutes", "udproutes"]
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

### Namespace-Scoped Role (Multi-Tenant)

For namespace-scoped ExternalDNS deployments:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: external-dns
  namespace: production
rules:
- apiGroups: [""]
  resources: ["services", "endpoints", "pods"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["externaldns.k8s.io"]
  resources: ["dnsendpoints"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["externaldns.k8s.io"]
  resources: ["dnsendpoints/status"]
  verbs: ["update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: external-dns
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: external-dns
subjects:
- kind: ServiceAccount
  name: external-dns
  namespace: external-dns
```

## Section 9: Monitoring DNS Propagation

### ExternalDNS Prometheus Metrics

ExternalDNS exposes metrics at `/metrics` on port 7979 (configurable):

Key metrics:

| Metric | Description |
|--------|-------------|
| `external_dns_controller_last_sync_timestamp_seconds` | Timestamp of last successful sync |
| `external_dns_registry_endpoints_total` | Total endpoints in the registry |
| `external_dns_source_endpoints_total` | Total endpoints discovered from sources |
| `external_dns_controller_verified_a_records_total` | Total verified A records |
| `external_dns_registry_errors_total` | Total registry errors |
| `external_dns_source_errors_total` | Total source errors |

### PrometheusRule Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-dns-alerts
  namespace: monitoring
spec:
  groups:
  - name: external-dns
    rules:
    - alert: ExternalDNSSyncFailure
      expr: |
        time() - external_dns_controller_last_sync_timestamp_seconds > 300
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "ExternalDNS has not synced successfully in 5 minutes"
        description: "ExternalDNS last successful sync was {{ $value | humanizeDuration }} ago"

    - alert: ExternalDNSRegistryErrors
      expr: |
        increase(external_dns_registry_errors_total[5m]) > 5
      labels:
        severity: warning
      annotations:
        summary: "ExternalDNS registry errors detected"
        description: "ExternalDNS has {{ $value }} registry errors in the last 5 minutes for provider {{ $labels.provider }}"

    - alert: ExternalDNSSourceErrors
      expr: |
        increase(external_dns_source_errors_total[5m]) > 5
      labels:
        severity: warning
      annotations:
        summary: "ExternalDNS source errors detected"
        description: "ExternalDNS has {{ $value }} source errors in the last 5 minutes"

    - alert: ExternalDNSEndpointDrift
      expr: |
        abs(external_dns_registry_endpoints_total - external_dns_source_endpoints_total) > 10
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "ExternalDNS endpoint count mismatch"
        description: "Registry has {{ $labels.registry_count }} endpoints, source has {{ $labels.source_count }}"
```

### DNS Propagation Verification Script

```bash
#!/usr/bin/env bash
# verify-dns-propagation.sh — confirm DNS record matches expected value

set -euo pipefail

HOSTNAME="${1:?Usage: $0 <hostname> <expected-ip-or-cname>}"
EXPECTED="${2:?Usage: $0 <hostname> <expected-ip-or-cname>}"
MAX_WAIT="${3:-300}"
INTERVAL=10

echo "Waiting for DNS: ${HOSTNAME} -> ${EXPECTED}"
echo "Max wait: ${MAX_WAIT}s, check interval: ${INTERVAL}s"

elapsed=0
while [ "${elapsed}" -lt "${MAX_WAIT}" ]; do
  resolved=$(dig +short "${HOSTNAME}" 2>/dev/null | head -1)

  if [ "${resolved}" = "${EXPECTED}" ]; then
    echo "SUCCESS: ${HOSTNAME} resolved to ${resolved} after ${elapsed}s"
    exit 0
  fi

  echo "[${elapsed}s] ${HOSTNAME} -> ${resolved:-<no record>} (expected: ${EXPECTED})"
  sleep "${INTERVAL}"
  elapsed=$((elapsed + INTERVAL))
done

echo "TIMEOUT: ${HOSTNAME} did not resolve to ${EXPECTED} within ${MAX_WAIT}s"
echo "Current value: $(dig +short "${HOSTNAME}" 2>/dev/null | head -1 || echo '<no record>')"
exit 1
```

### Testing DNS from Within the Cluster

```bash
# Deploy a DNS debug pod
kubectl run dns-debug \
  --image=busybox:1.36 \
  --restart=Never \
  -- sleep 600

# Test external DNS resolution
kubectl exec dns-debug -- nslookup api.example.com 8.8.8.8
kubectl exec dns-debug -- dig api.example.com @8.8.8.8 +short

# Test internal DNS resolution
kubectl exec dns-debug -- nslookup api.example.com
kubectl exec dns-debug -- dig api.example.com +short

# Check TTL of records
kubectl exec dns-debug -- dig api.example.com +ttl | grep -A1 "ANSWER SECTION"

# Cleanup
kubectl delete pod dns-debug
```

## Section 10: Filtering Namespaces and Sources

### Namespace Filtering

```yaml
# Process only specific namespaces
namespaceFilter: production,staging

# Exclude system namespaces (note the NOT syntax)
namespaceFilter: "!kube-system,!kube-public,!cert-manager,!monitoring"

# Via Helm values
extraArgs:
  namespace: production
```

### Source Filtering by Annotation

Process only resources that have the ExternalDNS hostname annotation:

```yaml
annotationFilter: "external-dns.alpha.kubernetes.io/hostname"
```

This prevents ExternalDNS from auto-creating records for every LoadBalancer Service. Teams must explicitly opt-in by adding the annotation.

### Label-Based Filtering

```yaml
labelFilter: "managed-by=external-dns"
```

Only process resources with the label `managed-by=external-dns`.

### Domain Filtering

```yaml
domainFilters:
- example.com
- staging.example.com

# Exclude specific subdomains
excludeDomains:
- legacy.example.com
- temp.example.com
```

### Combining Filters for Multi-Tenant Clusters

In a cluster shared by multiple teams, deploy separate ExternalDNS instances per team:

```yaml
# Team A: manages team-a.example.com
nameOverride: external-dns-team-a
domainFilters:
- team-a.example.com
namespaceFilter: team-a-prod,team-a-staging
txtOwnerId: cluster-prod-team-a
txtPrefix: "team-a-"

---
# Team B: manages team-b.example.com
nameOverride: external-dns-team-b
domainFilters:
- team-b.example.com
namespaceFilter: team-b-prod,team-b-staging
txtOwnerId: cluster-prod-team-b
txtPrefix: "team-b-"
```

## Section 11: Integration with LoadBalancer and Ingress Resources

### LoadBalancer Service Integration

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payment-api
  namespace: production
  annotations:
    # Primary hostname
    external-dns.alpha.kubernetes.io/hostname: "payments.example.com"
    # Additional hostnames (comma-separated)
    # external-dns.alpha.kubernetes.io/hostname: "payments.example.com,pay.example.com"
    # TTL in seconds
    external-dns.alpha.kubernetes.io/ttl: "60"
    # For Route 53: create alias record instead of A record
    external-dns.alpha.kubernetes.io/alias: "true"
spec:
  type: LoadBalancer
  loadBalancerClass: service.k8s.aws/nlb
  selector:
    app.kubernetes.io/name: payment-api
  ports:
  - name: https
    port: 443
    targetPort: 8443
```

### MetalLB Integration (On-Premises)

For bare-metal clusters using MetalLB:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: on-prem-api
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.internal.example.com"
    metallb.universe.tf/address-pool: production-pool
spec:
  type: LoadBalancer
  selector:
    app.kubernetes.io/name: on-prem-api
  ports:
  - port: 443
    targetPort: 8443
```

ExternalDNS uses the MetalLB-assigned IP from `.status.loadBalancer.ingress[0].ip` to create the DNS A record.

### Gateway API Integration

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: production
spec:
  parentRefs:
  - name: main-gateway
    namespace: gateway-system
  hostnames:
  - "api.example.com"
  - "v2-api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: api-service
      port: 8080
```

Enable Gateway API source in ExternalDNS:

```yaml
sources:
- gateway-httproute
- gateway-grpcroute
- gateway-tcproute
- gateway-tlsroute
```

ExternalDNS reads `spec.hostnames` from HTTPRoute and creates DNS records pointing to the Gateway's external IP.

## Section 12: Operational Best Practices

### Blue-Green Cluster Migration

When migrating from one cluster to another, use `create-only` policy on the new cluster to prevent it from deleting the old cluster's records:

```bash
# Phase 1: New cluster in create-only mode
helm install external-dns external-dns/external-dns \
  --set policy=create-only \
  --set txtOwnerId=new-cluster \
  --set txtPrefix="new-"

# Phase 2: After validation, switch to sync
helm upgrade external-dns external-dns/external-dns \
  --set policy=sync \
  --set txtOwnerId=new-cluster \
  --set txtPrefix="new-"

# Phase 3: Remove old cluster's ExternalDNS (or set to create-only)
# Old cluster's DNS records will be cleaned up by new cluster's sync policy
# only if txtOwnerId matches — they won't conflict with different txtOwnerId
```

### Disaster Recovery Runbook

```bash
#!/usr/bin/env bash
# externaldns-dr-restore.sh — restore DNS records from Kubernetes state

NAMESPACE="external-dns"
DEPLOYMENT="external-dns"

echo "=== ExternalDNS Disaster Recovery ==="

# Check current state
echo "--- ExternalDNS pod status ---"
kubectl get pods -n "${NAMESPACE}" -l app.kubernetes.io/name=external-dns

# Check last successful sync
echo "--- Last sync timestamp ---"
kubectl logs -n "${NAMESPACE}" deployment/"${DEPLOYMENT}" --since=5m | \
  grep "Instantiating new Kubernetes client\|All records are already up to date\|Applying provider changes"

# Check for error conditions
echo "--- Recent errors ---"
kubectl logs -n "${NAMESPACE}" deployment/"${DEPLOYMENT}" --since=10m | \
  grep -i "error\|failed\|unauthorized" || echo "No recent errors"

# Force a full sync by restarting the deployment
echo "--- Triggering full resync ---"
kubectl rollout restart deployment/"${DEPLOYMENT}" -n "${NAMESPACE}"
kubectl rollout status deployment/"${DEPLOYMENT}" -n "${NAMESPACE}"

echo "=== Recovery complete ==="
```

### Performance Tuning

For clusters with hundreds of Services and Ingresses, tune the sync interval and batch settings:

```yaml
# High-frequency sync for critical environments
interval: 30s
triggerLoopOnEvent: true

# Batch DNS changes to reduce API rate limiting
extraArgs:
  aws-batch-change-size: "5000"
  aws-batch-change-interval: "5s"

# Increase timeout for large zones
extraArgs:
  aws-api-retries: "5"
```

### Logging Configuration

```yaml
logLevel: info   # debug, info, warning, error
logFormat: json  # text or json

# For debugging, temporarily set to debug
extraArgs:
  log-level: debug
```

```bash
# Parse structured JSON logs
kubectl logs -n external-dns deployment/external-dns --since=5m | \
  jq -r 'select(.level == "error") | [.time, .msg, .error] | @csv'
# Monitor sync activity
kubectl logs -n external-dns deployment/external-dns -f | \
  jq -r 'select(.msg | contains("Desired change") or contains("All records")) | [.time, .msg] | @tsv'
```

---
ExternalDNS eliminates manual DNS record management by treating DNS as a derived artifact of Kubernetes state. The TXT ownership model ensures safe operation in multi-cluster and shared-zone environments. Combined with Prometheus monitoring and structured logging, ExternalDNS provides full operational visibility into the DNS lifecycle of every service in the cluster across AWS Route 53, on-premises CoreDNS/etcd, and hybrid provider environments.