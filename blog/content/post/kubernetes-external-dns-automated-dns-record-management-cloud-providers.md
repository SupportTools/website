---
title: "Kubernetes External DNS: Automated DNS Record Management Across Cloud Providers"
date: 2030-12-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ExternalDNS", "DNS", "AWS Route53", "Cloudflare", "GCP", "Multi-Cluster", "Networking"]
categories:
- Kubernetes
- Networking
- Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to ExternalDNS: deploying with AWS Route53, GCP Cloud DNS, and Cloudflare; annotation-based and source-based DNS management; TXT record ownership model; split-horizon DNS; and multi-cluster DNS management patterns for enterprise Kubernetes environments."
more_link: "yes"
url: "/kubernetes-external-dns-automated-dns-record-management-cloud-providers/"
---

ExternalDNS bridges the gap between Kubernetes service discovery and external DNS infrastructure. Without it, every new Ingress or LoadBalancer service requires manual DNS record creation — a toil-heavy process prone to errors and delays. This guide covers production deployment patterns for the three most common DNS providers and advanced multi-cluster scenarios.

<!--more-->

# Kubernetes External DNS: Automated DNS Record Management Across Cloud Providers

## Section 1: ExternalDNS Architecture

ExternalDNS watches Kubernetes resources and synchronizes DNS records with external DNS providers. The core workflow:

1. ExternalDNS watches Services (type LoadBalancer), Ingress resources, and optionally CRDs
2. For each resource with appropriate annotations or hostname configuration, it computes desired DNS records
3. It calls the DNS provider API to create, update, or delete records
4. It uses TXT records for ownership tracking — it will never modify records it didn't create

### Source Types

ExternalDNS can derive DNS records from multiple Kubernetes sources:

| Source | Triggers on | DNS target |
|--------|-------------|-----------|
| `service` | Service type=LoadBalancer | Service external IP |
| `ingress` | Ingress rules | Ingress load balancer IP |
| `istio-gateway` | Istio Gateway | Istio ingress gateway IP |
| `contour-httpproxy` | Contour HTTPProxy | Envoy proxy IP |
| `crd` | DNSEndpoint CRD | Custom IP/hostname |
| `traefik-proxy` | Traefik IngressRoute | Traefik IP |
| `gateway-httproute` | Gateway API HTTPRoute | Gateway IP |

### TXT Record Ownership

ExternalDNS creates companion TXT records alongside every A/CNAME record it manages:

```
# DNS record created by ExternalDNS
app.example.com.   300  IN  A     203.0.113.10

# Companion ownership TXT record
externaldns-app.example.com.  300  IN  TXT  "heritage=external-dns,external-dns/owner=prod-cluster,external-dns/resource=ingress/production/app"
```

The `--txt-owner-id` must be unique per cluster to prevent ExternalDNS instances from different clusters from managing each other's records.

## Section 2: AWS Route53 Deployment

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

### IRSA (IAM Roles for Service Accounts) Setup

```bash
# Get cluster OIDC provider
OIDC_PROVIDER=$(aws eks describe-cluster \
    --name prod-cluster \
    --region us-east-1 \
    --query "cluster.identity.oidc.issuer" \
    --output text | sed -e "s/^https:\/\///")

echo "OIDC Provider: $OIDC_PROVIDER"

# Create IAM role for ExternalDNS
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

cat > /tmp/externaldns-trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:external-dns:external-dns",
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
    --role-name eks-external-dns-prod \
    --assume-role-policy-document file:///tmp/externaldns-trust-policy.json

aws iam put-role-policy \
    --role-name eks-external-dns-prod \
    --policy-name ExternalDNSPolicy \
    --policy-document file:///tmp/externaldns-route53-policy.json

ROLE_ARN=$(aws iam get-role \
    --role-name eks-external-dns-prod \
    --query Role.Arn \
    --output text)

echo "Role ARN: $ROLE_ARN"
```

### ExternalDNS Deployment for AWS Route53

```yaml
# external-dns-aws.yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: external-dns
  labels:
    app.kubernetes.io/name: external-dns

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-dns
  namespace: external-dns
  annotations:
    # IRSA annotation — links SA to IAM role
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/eks-external-dns-prod"
  labels:
    app.kubernetes.io/name: external-dns

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
  - apiGroups: ["externaldns.k8s.io"]
    resources: ["dnsendpoints"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["externaldns.k8s.io"]
    resources: ["dnsendpoints/status"]
    verbs: ["*"]

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

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
  namespace: external-dns
  labels:
    app.kubernetes.io/name: external-dns
spec:
  strategy:
    type: Recreate  # Only one instance should run at a time
  selector:
    matchLabels:
      app.kubernetes.io/name: external-dns
  template:
    metadata:
      labels:
        app.kubernetes.io/name: external-dns
      annotations:
        # Force pod restart when config changes
        checksum/config: "placeholder"
    spec:
      serviceAccountName: external-dns
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
      containers:
        - name: external-dns
          image: registry.k8s.io/external-dns/external-dns:v0.14.2
          args:
            - --source=service
            - --source=ingress
            - --source=istio-gateway
            # Only manage zones matching these patterns
            - --domain-filter=example.com
            - --domain-filter=internal.example.com
            # AWS Route53
            - --provider=aws
            - --aws-zone-type=public
            # Ownership ID — MUST be unique per cluster
            - --txt-owner-id=prod-cluster-us-east-1
            # TXT registry for ownership tracking
            - --registry=txt
            # Interval between full syncs
            - --interval=1m
            # Log level: info, debug, warning, error
            - --log-level=info
            - --log-format=json
            # Metrics
            - --metrics-address=:7979
            # Policy: sync = create/update/delete, upsert-only = create/update only
            - --policy=sync
            # Filter by annotation
            - --annotation-filter=external-dns.alpha.kubernetes.io/exclude!=true
          env:
            - name: AWS_DEFAULT_REGION
              value: us-east-1
          ports:
            - name: metrics
              containerPort: 7979
          livenessProbe:
            httpGet:
              path: /healthz
              port: 7979
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /healthz
              port: 7979
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
```

## Section 3: GCP Cloud DNS Deployment

### Workload Identity for GCP

```bash
# Create GCP service account
gcloud iam service-accounts create external-dns \
    --project=my-project \
    --display-name="External DNS Service Account"

# Grant DNS admin role
gcloud projects add-iam-policy-binding my-project \
    --member="serviceAccount:external-dns@my-project.iam.gserviceaccount.com" \
    --role="roles/dns.admin"

# Allow the Kubernetes SA to impersonate the GCP SA
gcloud iam service-accounts add-iam-policy-binding \
    external-dns@my-project.iam.gserviceaccount.com \
    --project=my-project \
    --role="roles/iam.workloadIdentityUser" \
    --member="serviceAccount:my-project.svc.id.goog[external-dns/external-dns]"
```

```yaml
# external-dns-gcp.yaml (ServiceAccount portion)
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-dns
  namespace: external-dns
  annotations:
    # Workload Identity annotation
    iam.gke.io/gcp-service-account: external-dns@my-project.iam.gserviceaccount.com

---
# Deployment args for GCP
# args:
#   - --provider=google
#   - --google-project=my-project
#   - --google-zone-visibility=public  # or private
#   - --source=ingress
#   - --domain-filter=example.com
#   - --txt-owner-id=gke-prod-cluster
#   - --registry=txt
```

## Section 4: Cloudflare Deployment

```yaml
# external-dns-cloudflare.yaml
---
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: external-dns
type: Opaque
stringData:
  # Create a Cloudflare API token with Zone:DNS:Edit permissions
  # Never use the Global API Key
  cloudflare-api-token: <cloudflare-api-token>

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
  namespace: external-dns
spec:
  template:
    spec:
      containers:
        - name: external-dns
          image: registry.k8s.io/external-dns/external-dns:v0.14.2
          args:
            - --source=ingress
            - --source=service
            - --provider=cloudflare
            # Don't proxy by default (disabling the orange cloud)
            - --cloudflare-proxied=false
            - --domain-filter=example.com
            - --txt-owner-id=k8s-prod
            - --registry=txt
            - --interval=2m
            - --log-level=info
          env:
            - name: CF_API_TOKEN
              valueFrom:
                secretKeyRef:
                  name: cloudflare-api-token
                  key: cloudflare-api-token
```

### Enabling Cloudflare Proxy per Service

```yaml
# Service with Cloudflare proxy enabled
apiVersion: v1
kind: Service
metadata:
  name: my-webapp
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "app.example.com"
    # Enable Cloudflare orange-cloud proxy for this specific service
    external-dns.alpha.kubernetes.io/cloudflare-proxied: "true"
spec:
  type: LoadBalancer
  selector:
    app: my-webapp
  ports:
    - port: 80
      targetPort: 8080
```

## Section 5: Annotation-Based vs Source-Based DNS

### Annotation-Based DNS (Explicit Control)

Annotation-based DNS gives teams direct control over which hostnames get created:

```yaml
# Service with explicit hostname
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    # Create this specific DNS record
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    # Optional: set TTL
    external-dns.alpha.kubernetes.io/ttl: "300"
    # Optional: specify target if different from default
    # external-dns.alpha.kubernetes.io/target: "203.0.113.10"
spec:
  type: LoadBalancer
  selector:
    app: api
  ports:
    - port: 443
      targetPort: 8443
```

```yaml
# Ingress with annotation-based DNS
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
  namespace: production
  annotations:
    # Multiple hostnames
    external-dns.alpha.kubernetes.io/hostname: "www.example.com,example.com"
    external-dns.alpha.kubernetes.io/ttl: "120"
    kubernetes.io/ingress.class: nginx
spec:
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
    - host: example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-frontend
                port:
                  number: 80
  tls:
    - hosts:
        - www.example.com
        - example.com
      secretName: web-tls
```

### Source-Based DNS (Automatic from Ingress hosts)

When `--source=ingress` is configured, ExternalDNS automatically creates records for all hosts defined in Ingress rules — no annotations needed:

```yaml
# ExternalDNS automatically creates A records for both hosts
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: auto-dns-ingress
  namespace: production
  # No external-dns annotation needed
spec:
  rules:
    - host: service-a.example.com     # → A record created automatically
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: service-a
                port:
                  number: 80
    - host: service-b.example.com     # → A record created automatically
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: service-b
                port:
                  number: 80
```

## Section 6: Split-Horizon DNS

Split-horizon DNS serves different responses for internal and external clients. In Kubernetes, this typically means:
- External DNS: public IP via Route53/Cloudflare
- Internal DNS: cluster-internal service IP via CoreDNS or private hosted zone

### Pattern 1: Two ExternalDNS Instances

```yaml
# external-dns-public.yaml — manages public Route53 zone
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns-public
  namespace: external-dns
spec:
  template:
    spec:
      containers:
        - name: external-dns
          args:
            - --source=ingress
            - --provider=aws
            - --aws-zone-type=public
            - --domain-filter=example.com
            - --txt-owner-id=prod-cluster-public
            - --registry=txt
            - --annotation-filter=external-dns.alpha.kubernetes.io/scope=public

---
# external-dns-private.yaml — manages private Route53 zone (VPC)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns-private
  namespace: external-dns
spec:
  template:
    spec:
      containers:
        - name: external-dns
          args:
            - --source=service
            - --source=ingress
            - --provider=aws
            - --aws-zone-type=private
            - --domain-filter=internal.example.com
            - --txt-owner-id=prod-cluster-private
            - --registry=txt
            - --annotation-filter=external-dns.alpha.kubernetes.io/scope=private
```

```yaml
# Service that gets both public and private DNS records
apiVersion: v1
kind: Service
metadata:
  name: internal-api
  annotations:
    # Public record
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    external-dns.alpha.kubernetes.io/scope: "public"
spec:
  type: LoadBalancer
  selector:
    app: api
---
apiVersion: v1
kind: Service
metadata:
  name: internal-api-private
  annotations:
    # Private record for VPC-internal access
    external-dns.alpha.kubernetes.io/hostname: "api.internal.example.com"
    external-dns.alpha.kubernetes.io/scope: "private"
spec:
  type: ClusterIP  # No external LB needed for private
  selector:
    app: api
```

### Pattern 2: DNSEndpoint CRD for Advanced Control

The `DNSEndpoint` CRD gives full control over DNS records:

```yaml
# dns-endpoint.yaml
apiVersion: externaldns.k8s.io/v1alpha1
kind: DNSEndpoint
metadata:
  name: my-service-dns
  namespace: production
spec:
  endpoints:
    # Public A record
    - dnsName: "api.example.com"
      recordTTL: 300
      recordType: A
      targets:
        - "203.0.113.10"
      # Labels for ownership and filtering
      labels:
        owner: prod-cluster
        environment: production

    # Internal CNAME
    - dnsName: "api-internal.example.com"
      recordTTL: 60
      recordType: CNAME
      targets:
        - "api-service.production.svc.cluster.local"

    # Health-check weighted routing (Route53 specific)
    - dnsName: "api.example.com"
      recordTTL: 60
      recordType: A
      targets:
        - "203.0.113.11"
      providerSpecific:
        - name: "aws/weight"
          value: "10"
        - name: "aws/health-check-id"
          value: "abc123"
```

## Section 7: Multi-Cluster DNS Management

### Pattern 1: Global Load Balancing with Route53 Weighted Records

Multiple clusters in different regions, each with its own ExternalDNS instance, contribute weighted DNS records:

```yaml
# Cluster 1 (us-east-1) ExternalDNS args:
# --txt-owner-id=prod-cluster-us-east-1
# --provider=aws

# Cluster 2 (eu-west-1) ExternalDNS args:
# --txt-owner-id=prod-cluster-eu-west-1
# --provider=aws

# Service in Cluster 1 (us-east-1)
apiVersion: v1
kind: Service
metadata:
  name: global-api
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    external-dns.alpha.kubernetes.io/aws-weight: "50"
    # Set record identifier — must be unique per cluster for weighted routing
    external-dns.alpha.kubernetes.io/set-identifier: "us-east-1"
    external-dns.alpha.kubernetes.io/aws-health-check-id: "hc-us-east-1-abc"
spec:
  type: LoadBalancer
```

```yaml
# Service in Cluster 2 (eu-west-1)
apiVersion: v1
kind: Service
metadata:
  name: global-api
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.example.com"
    external-dns.alpha.kubernetes.io/aws-weight: "50"
    external-dns.alpha.kubernetes.io/set-identifier: "eu-west-1"
    external-dns.alpha.kubernetes.io/aws-health-check-id: "hc-eu-west-1-def"
spec:
  type: LoadBalancer
```

### Pattern 2: Centralized DNS Management with Remote Cluster Access

```yaml
# external-dns-multi-cluster.yaml
# One ExternalDNS instance that manages DNS for multiple clusters
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns-central
  namespace: external-dns
spec:
  template:
    spec:
      serviceAccountName: external-dns
      volumes:
        - name: kubeconfigs
          secret:
            secretName: cluster-kubeconfigs
      containers:
        - name: external-dns-cluster1
          image: registry.k8s.io/external-dns/external-dns:v0.14.2
          args:
            - --kubeconfig=/etc/kubeconfigs/cluster1.yaml
            - --source=ingress
            - --provider=aws
            - --domain-filter=cluster1.example.com
            - --txt-owner-id=cluster1
            - --registry=txt
          volumeMounts:
            - name: kubeconfigs
              mountPath: /etc/kubeconfigs
              readOnly: true

        - name: external-dns-cluster2
          image: registry.k8s.io/external-dns/external-dns:v0.14.2
          args:
            - --kubeconfig=/etc/kubeconfigs/cluster2.yaml
            - --source=ingress
            - --provider=aws
            - --domain-filter=cluster2.example.com
            - --txt-owner-id=cluster2
            - --registry=txt
          volumeMounts:
            - name: kubeconfigs
              mountPath: /etc/kubeconfigs
              readOnly: true
```

## Section 8: Monitoring and Troubleshooting

### Prometheus Metrics

ExternalDNS exposes metrics on `--metrics-address` (default `:7979`):

```yaml
# ServiceMonitor for Prometheus Operator
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: external-dns
  namespace: external-dns
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: external-dns
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

```yaml
# Alert rules for ExternalDNS
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-dns-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: external-dns.alerts
      rules:
        - alert: ExternalDNSNotSyncing
          expr: |
            time() - external_dns_registry_last_change_timestamp_seconds > 600
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "ExternalDNS has not synced for 10 minutes"
            description: "ExternalDNS last synced {{ $value | humanizeDuration }} ago"

        - alert: ExternalDNSErrors
          expr: |
            rate(external_dns_registry_errors_total[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ExternalDNS is encountering errors"
            description: "ExternalDNS has {{ $value | humanize }} errors/s in the last 5 minutes"
```

### Debugging Common Issues

```bash
# Check ExternalDNS logs
kubectl -n external-dns logs -l app.kubernetes.io/name=external-dns --tail=100 -f

# Check what sources ExternalDNS is watching
kubectl -n external-dns logs -l app.kubernetes.io/name=external-dns | grep "Loaded sources"

# Check which endpoints were found
kubectl -n external-dns logs -l app.kubernetes.io/name=external-dns | grep "found"

# Dry run to see what ExternalDNS would do without making changes
kubectl -n external-dns exec deploy/external-dns -- \
    external-dns \
    --source=ingress \
    --provider=aws \
    --domain-filter=example.com \
    --txt-owner-id=prod-cluster \
    --registry=txt \
    --dry-run \
    --log-level=debug

# Check Route53 TXT ownership records
aws route53 list-resource-record-sets \
    --hosted-zone-id Z1234567890 \
    --query "ResourceRecordSets[?Type=='TXT']" \
    | python3 -m json.tool

# Verify DNS records were created
dig +short api.example.com
dig +short TXT externaldns-api.example.com

# Check for conflicting ownership (multiple clusters managing same record)
aws route53 list-resource-record-sets \
    --hosted-zone-id Z1234567890 \
    --query "ResourceRecordSets[?Name=='api.example.com.']"
```

### ExternalDNS Helm Chart for Production

```yaml
# values-external-dns.yaml
image:
  repository: registry.k8s.io/external-dns/external-dns
  tag: v0.14.2

nameOverride: external-dns
fullnameOverride: external-dns

serviceAccount:
  create: true
  name: external-dns
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/eks-external-dns-prod"

extraArgs:
  - --source=service
  - --source=ingress
  - --domain-filter=example.com
  - --provider=aws
  - --aws-zone-type=public
  - --txt-owner-id=prod-cluster-us-east-1
  - --registry=txt
  - --interval=2m
  - --log-level=info
  - --log-format=json
  - --policy=sync
  - --metrics-address=:7979

env:
  - name: AWS_DEFAULT_REGION
    value: us-east-1

resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    memory: 256Mi

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65534
  fsGroup: 65534

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "7979"

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: external-dns
          topologyKey: kubernetes.io/hostname
```

```bash
# Install with Helm
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm repo update

helm upgrade --install external-dns external-dns/external-dns \
    --namespace external-dns \
    --create-namespace \
    --values values-external-dns.yaml \
    --wait
```

ExternalDNS fundamentally changes DNS management in Kubernetes from a manual operational task into automated infrastructure-as-code. With proper TXT ownership records, namespace filtering, and provider-specific annotations, it supports complex multi-cluster and multi-region DNS architectures while maintaining clear ownership semantics that prevent conflicts between instances.
