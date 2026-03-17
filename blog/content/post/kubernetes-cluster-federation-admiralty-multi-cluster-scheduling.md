---
title: "Kubernetes Cluster Federation with Admiralty: Multi-Cluster Scheduling, Cross-Cluster Service Discovery, and Workload Placement"
date: 2031-10-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Federation", "Admiralty", "Multi-Cluster", "Service Discovery", "Scheduling"]
categories:
- Kubernetes
- Multi-Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes cluster federation using Admiralty: configuring the multi-cluster scheduler, cross-cluster proxy pods, service account token exchange, cross-cluster service discovery with Submariner, and workload placement policies for geo-distributed environments."
more_link: "yes"
url: "/kubernetes-cluster-federation-admiralty-multi-cluster-scheduling/"
---

Single-cluster Kubernetes deployments hit hard limits: a region-level cloud outage takes down the entire application, regulatory requirements force data residency across jurisdictions, or a single cluster's node count reaches provider limits. Cluster federation addresses all of these. Admiralty is the CNCF sandbox project that implements a multi-cluster scheduler using standard Kubernetes primitives—no cluster mesh API changes, no custom networking overlays required for the scheduler itself. This guide covers the complete Admiralty setup from kubeconfig exchange through multi-cluster pod placement policies and cross-cluster service discovery.

<!--more-->

# Kubernetes Cluster Federation with Admiralty

## Section 1: Admiralty Architecture

Admiralty implements multi-cluster scheduling through a two-level architecture:

**Management Cluster (Source)**: Runs the Admiralty scheduler. Application teams deploy pods here. The scheduler intercepts pod creation, evaluates placement policies, and creates "proxy pods" in the source cluster that mirror the actual pods running in target clusters.

**Target Clusters**: Run the Admiralty agent. When the source cluster creates a `PodChaperon` (the actual pod spec) in the target cluster, the agent creates a real pod on target cluster nodes.

```
Source Cluster                    Target Cluster A        Target Cluster B
┌──────────────────────┐          ┌──────────────┐        ┌──────────────┐
│  User creates Pod    │          │              │        │              │
│  ↓                   │          │  PodChaperon │        │  PodChaperon │
│  Admiralty Scheduler │─────────▶│  → Real Pod  │   or   │  → Real Pod  │
│  ↓                   │          │              │        │              │
│  Proxy Pod (source)  │          └──────────────┘        └──────────────┘
│  (represents remote) │
└──────────────────────┘
```

This design means `kubectl get pods` in the source cluster shows proxy pods whose status mirrors the real pods in target clusters. Application teams work against a single API surface.

## Section 2: Installation

### Prerequisites

```bash
# Required: cert-manager in all clusters (Admiralty uses webhooks with TLS)
# Required: clusters must be able to reach each other's API servers

# Cluster inventory for this guide:
# management  -> kubecontext: management-cluster
# us-east-1   -> kubecontext: target-us-east-1
# eu-west-1   -> kubecontext: target-eu-west-1
```

### Install Admiralty in All Clusters

```bash
helm repo add admiralty https://charts.admiralty.io
helm repo update

# Install in source/management cluster
helm install admiralty admiralty/multicluster-scheduler \
  --kube-context management-cluster \
  --namespace admiralty \
  --create-namespace \
  --version 0.16.0 \
  --set controllerManager.resources.requests.cpu=100m \
  --set controllerManager.resources.requests.memory=128Mi

# Install in target cluster us-east-1
helm install admiralty admiralty/multicluster-scheduler \
  --kube-context target-us-east-1 \
  --namespace admiralty \
  --create-namespace \
  --version 0.16.0

# Install in target cluster eu-west-1
helm install admiralty admiralty/multicluster-scheduler \
  --kube-context target-eu-west-1 \
  --namespace admiralty \
  --create-namespace \
  --version 0.16.0

# Verify all installations
for ctx in management-cluster target-us-east-1 target-eu-west-1; do
  echo "=== ${ctx} ==="
  kubectl --context "${ctx}" get pods -n admiralty
done
```

## Section 3: Cross-Cluster Authentication

Admiralty uses Kubernetes service account tokens for cross-cluster API access. The source cluster needs credentials to create `PodChaperons` in target clusters, and target clusters need credentials to update pod status in the source cluster.

### Source Cluster -> Target Cluster Trust

```bash
#!/bin/bash
# setup-trust.sh — configure trust from management to a target cluster

SOURCE_CTX="management-cluster"
TARGET_CTX="$1"
TARGET_NAME="$2"  # e.g., "us-east-1"

# Step 1: Create a ServiceAccount in the target cluster for the source cluster to use
kubectl --context "${TARGET_CTX}" apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: admiralty
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: admiralty-source-${SOURCE_CTX}
  namespace: admiralty
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: admiralty-source
rules:
  - apiGroups: ["multicluster.admiralty.io"]
    resources: ["podchaperons"]
    verbs: ["*"]
  - apiGroups: [""]
    resources: ["pods", "nodes"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: admiralty-source-${SOURCE_CTX}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admiralty-source
subjects:
  - kind: ServiceAccount
    name: admiralty-source-${SOURCE_CTX}
    namespace: admiralty
EOF

# Step 2: Create a long-lived token for the service account
kubectl --context "${TARGET_CTX}" apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: admiralty-source-${SOURCE_CTX}-token
  namespace: admiralty
  annotations:
    kubernetes.io/service-account.name: admiralty-source-${SOURCE_CTX}
type: kubernetes.io/service-account-token
EOF

# Step 3: Extract the token and CA cert
TOKEN=$(kubectl --context "${TARGET_CTX}" get secret \
  admiralty-source-${SOURCE_CTX}-token \
  -n admiralty \
  -o jsonpath='{.data.token}' | base64 -d)

CA_CERT=$(kubectl --context "${TARGET_CTX}" get secret \
  admiralty-source-${SOURCE_CTX}-token \
  -n admiralty \
  -o jsonpath='{.data.ca\.crt}')

TARGET_API=$(kubectl --context "${TARGET_CTX}" config view \
  --minify -o jsonpath='{.clusters[0].cluster.server}')

# Step 4: Create a kubeconfig secret in the source cluster
kubectl --context "${SOURCE_CTX}" apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${TARGET_NAME}
  namespace: admiralty
stringData:
  config: |
    apiVersion: v1
    kind: Config
    clusters:
      - cluster:
          certificate-authority-data: ${CA_CERT}
          server: ${TARGET_API}
        name: ${TARGET_NAME}
    contexts:
      - context:
          cluster: ${TARGET_NAME}
          user: admiralty-source
        name: ${TARGET_NAME}
    current-context: ${TARGET_NAME}
    users:
      - name: admiralty-source
        user:
          token: ${TOKEN}
EOF

echo "Trust configured: ${SOURCE_CTX} -> ${TARGET_CTX} (${TARGET_NAME})"
```

```bash
# Run for each target
./setup-trust.sh target-us-east-1 us-east-1
./setup-trust.sh target-eu-west-1 eu-west-1
```

## Section 4: Cluster Targets and Sources

Register the relationship between clusters using Admiralty CRDs.

### In the Source Cluster: Register Targets

```yaml
# targets.yaml — apply in source (management) cluster
apiVersion: multicluster.admiralty.io/v1alpha1
kind: Target
metadata:
  name: us-east-1
  namespace: production  # namespace-scoped: targets per namespace
spec:
  kubeconfigSecret:
    name: us-east-1     # references the secret created above
  # Health checking
  self: false
---
apiVersion: multicluster.admiralty.io/v1alpha1
kind: Target
metadata:
  name: eu-west-1
  namespace: production
spec:
  kubeconfigSecret:
    name: eu-west-1
  self: false
```

```bash
kubectl --context management-cluster apply -f targets.yaml

# Verify targets are ready
kubectl --context management-cluster get targets -n production
# NAME        READY   AGE
# us-east-1   True    2m
# eu-west-1   True    2m
```

### In Target Clusters: Register Sources

```yaml
# source.yaml — apply in EACH target cluster
apiVersion: multicluster.admiralty.io/v1alpha1
kind: Source
metadata:
  name: management
  namespace: admiralty
spec:
  serviceAccountName: admiralty-source-management-cluster
```

```bash
kubectl --context target-us-east-1 apply -f source.yaml
kubectl --context target-eu-west-1 apply -f source.yaml
```

## Section 5: Multi-Cluster Scheduling Policies

Admiralty uses the standard pod scheduler annotation `multicluster.admiralty.io/elect` to trigger multi-cluster scheduling. Additional annotations control placement.

### Basic Multi-Cluster Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
  namespace: production
spec:
  replicas: 6
  selector:
    matchLabels:
      app: payment-api
  template:
    metadata:
      labels:
        app: payment-api
      annotations:
        # Enable multi-cluster scheduling for these pods
        multicluster.admiralty.io/elect: ""
    spec:
      # Topology spread ensures even distribution across clusters
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: multicluster.admiralty.io/cluster
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-api
      containers:
        - name: payment-api
          image: registry.example.com/payment-api:v2.3.1
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
```

With 6 replicas and 2 target clusters, Admiralty schedules 3 pods to each cluster. In the source cluster, you see 6 proxy pods.

```bash
kubectl --context management-cluster get pods -n production
# NAME                          READY   STATUS    RESTARTS
# payment-api-xxx-aaa           1/1     Running   0   ← proxy (us-east-1)
# payment-api-xxx-bbb           1/1     Running   0   ← proxy (us-east-1)
# payment-api-xxx-ccc           1/1     Running   0   ← proxy (us-east-1)
# payment-api-xxx-ddd           1/1     Running   0   ← proxy (eu-west-1)
# payment-api-xxx-eee           1/1     Running   0   ← proxy (eu-west-1)
# payment-api-xxx-fff           1/1     Running   0   ← proxy (eu-west-1)

# See the actual pods in each target
kubectl --context target-us-east-1 get pods -n production
kubectl --context target-eu-west-1 get pods -n production
```

## Section 6: Placement Policies

### Affinity-Based Placement

```yaml
# Force pods to a specific cluster using node selectors
# (Admiralty propagates these to the target cluster's node selector context)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: eu-gdpr-service
  namespace: production
spec:
  replicas: 3
  template:
    metadata:
      annotations:
        multicluster.admiralty.io/elect: ""
    spec:
      # Target specific cluster using virtual node labels
      nodeSelector:
        multicluster.admiralty.io/cluster: eu-west-1
      containers:
        - name: gdpr-service
          image: registry.example.com/gdpr-service:v1.0.0
```

### Pod Anti-Affinity Across Clusters

```yaml
spec:
  template:
    metadata:
      annotations:
        multicluster.admiralty.io/elect: ""
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            # No two replicas on the same cluster
            - labelSelector:
                matchLabels:
                  app: payment-api
              topologyKey: multicluster.admiralty.io/cluster
```

### Target Selection via SchedulingConstraints

```yaml
apiVersion: multicluster.admiralty.io/v1alpha1
kind: SchedulingConstraints
metadata:
  name: payment-api-constraints
  namespace: production
spec:
  # Apply to pods matching this selector
  podSelector:
    matchLabels:
      app: payment-api
  targets:
    # Only allow scheduling to clusters with sufficient GPU
    - name: us-east-1
      weight: 2    # prefer us-east-1 (2x weight)
    - name: eu-west-1
      weight: 1
  # Forbidden targets (e.g., for compliance)
  forbiddenTargets: []
```

## Section 7: Cross-Cluster Service Discovery with Submariner

Admiralty handles pod scheduling but not network connectivity between clusters. Submariner provides the cross-cluster network overlay.

### Installing Submariner

```bash
# Install subctl CLI
curl -Ls https://get.submariner.io | VERSION=0.17.0 bash

# Deploy broker in management cluster
subctl deploy-broker \
  --kubeconfig ~/.kube/management-cluster.yaml \
  --service-discovery

# Join target clusters to the broker
subctl join \
  --kubeconfig ~/.kube/management-cluster.yaml \
  broker-info.subm \
  --clusterid us-east-1 \
  --natt=false

subctl join \
  --kubeconfig ~/.kube/eu-west-1.yaml \
  broker-info.subm \
  --clusterid eu-west-1 \
  --natt=false

# Verify connectivity
subctl show connections
# GATEWAY              CLUSTER     REMOTE IP       NAT STATUS
# node-1.us-east-1     us-east-1   10.0.1.5        no  connected
# node-1.eu-west-1     eu-west-1   10.0.2.5        no  connected
```

### ServiceExport for Cross-Cluster Service Discovery

```yaml
# Export a service from us-east-1 to other clusters
# Apply in us-east-1 target cluster
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: payment-api
  namespace: production
```

```bash
# After ServiceExport, the service is accessible from other clusters via:
# payment-api.production.svc.clusterset.local

# Test from eu-west-1
kubectl --context target-eu-west-1 run test --image=curlimages/curl \
  --restart=Never -n production -- \
  curl -s http://payment-api.production.svc.clusterset.local/v1/health
```

### Multi-Cluster Service for Load Balancing

```yaml
# ServiceImport is automatically created by Submariner
# You can also use it explicitly to customize DNS behavior

apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: payment-api
  namespace: production
spec:
  type: ClusterSetIP
  ports:
    - port: 80
      protocol: TCP
```

## Section 8: Failure Handling and Cluster Failover

### Detecting Cluster Failure

Admiralty marks proxy pods as Failed when the target cluster is unreachable. Combine with a controller that re-schedules:

```bash
# Check for failed proxy pods (indicates cluster connectivity issues)
kubectl --context management-cluster get pods -n production \
  --field-selector status.phase=Failed \
  -l "multicluster.admiralty.io/pod-chaperon!="

# Monitor target health
kubectl --context management-cluster get targets -n production -w
```

### Automatic Failover with PodDisruptionBudget

```yaml
# Ensure minimum availability during cluster failure
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
  namespace: production
spec:
  minAvailable: 3  # at least 3 pods must remain available
  selector:
    matchLabels:
      app: payment-api
```

### Failover Runbook

```bash
#!/bin/bash
# failover-from-cluster.sh — remove a cluster from rotation

FAILING_CLUSTER="${1:-us-east-1}"
SOURCE_CTX="management-cluster"

echo "Initiating failover from ${FAILING_CLUSTER}..."

# Step 1: Cordon the failing cluster (mark as unschedulable)
kubectl --context "${SOURCE_CTX}" annotate target "${FAILING_CLUSTER}" \
  -n production \
  multicluster.admiralty.io/unschedulable=true

# Step 2: Wait for pods to be rescheduled
echo "Waiting for pods to migrate..."
kubectl --context "${SOURCE_CTX}" wait pods \
  -n production \
  --for=condition=Ready \
  -l app=payment-api \
  --timeout=300s

# Step 3: Verify all replicas are on healthy clusters
HEALTHY=$(kubectl --context "${SOURCE_CTX}" get pods -n production \
  -l app=payment-api \
  -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | \
  wc -w)

echo "Healthy pods after failover: ${HEALTHY}"

# Step 4: Update DNS (if using external-dns with cluster-weighted routing)
# external-dns will detect the change and update Route53/Cloud DNS automatically
# based on the remaining healthy pods' service endpoints
```

## Section 9: Observability Across Clusters

### Centralized Metrics Collection

```yaml
# prometheus-federation.yaml
# Run in management cluster: federate metrics from all target clusters
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: federated
  namespace: monitoring
spec:
  replicas: 1
  remoteWrite:
    - url: "http://thanos-receive.monitoring.svc.cluster.local:19291/api/v1/receive"
  additionalScrapeConfigs:
    name: additional-scrape-configs
    key: prometheus-additional.yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: additional-scrape-configs-map
  namespace: monitoring
data:
  prometheus-additional.yaml: |
    # Federate from us-east-1 Prometheus
    - job_name: 'federate-us-east-1'
      scrape_interval: 15s
      honor_labels: true
      metrics_path: '/federate'
      params:
        'match[]':
          - '{job="payment-api"}'
          - '{job="kube-state-metrics"}'
      static_configs:
        - targets:
          - 'prometheus.monitoring.us-east-1.example.com:9090'
      relabel_configs:
        - target_label: cluster
          replacement: us-east-1

    # Federate from eu-west-1 Prometheus
    - job_name: 'federate-eu-west-1'
      scrape_interval: 15s
      honor_labels: true
      metrics_path: '/federate'
      params:
        'match[]':
          - '{job="payment-api"}'
          - '{job="kube-state-metrics"}'
      static_configs:
        - targets:
          - 'prometheus.monitoring.eu-west-1.example.com:9090'
      relabel_configs:
        - target_label: cluster
          replacement: eu-west-1
```

### Cross-Cluster Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: multi-cluster-alerts
  namespace: monitoring
spec:
  groups:
    - name: federation.availability
      rules:
        - alert: ClusterDown
          expr: |
            absent(up{job="kube-apiserver", cluster="us-east-1"}) == 1
            or
            absent(up{job="kube-apiserver", cluster="eu-west-1"}) == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Cluster {{ $labels.cluster }} is unreachable"

        - alert: MultiClusterReplicaImbalance
          expr: |
            (
              max by (cluster, deployment) (kube_deployment_status_replicas_available)
              -
              min by (cluster, deployment) (kube_deployment_status_replicas_available)
            ) > 2
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Replica imbalance across clusters for {{ $labels.deployment }}"
```

## Section 10: GitOps with Multi-Cluster ArgoCD

```yaml
# applicationset.yaml — deploy to all member clusters via ArgoCD ApplicationSet
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payment-api
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - cluster: management-cluster
            url: https://api.management.example.com
            revision: HEAD
          - cluster: us-east-1
            url: https://api.us-east-1.example.com
            revision: HEAD
          - cluster: eu-west-1
            url: https://api.eu-west-1.example.com
            revision: HEAD
  template:
    metadata:
      name: "payment-api-{{cluster}}"
    spec:
      project: production
      source:
        repoURL: git@github.com:example/k8s-manifests.git
        targetRevision: "{{revision}}"
        path: apps/payment-api/overlays/{{cluster}}
      destination:
        server: "{{url}}"
        namespace: production
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## Section 11: Security Considerations

### Network Policy Across Clusters

```yaml
# Allow cross-cluster communication only from known cluster CIDRs
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-cross-cluster-ingress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: payment-api
  ingress:
    # Allow from same cluster
    - from:
        - podSelector:
            matchLabels:
              app: api-gateway

    # Allow from us-east-1 pod CIDR (via Submariner tunnel)
    - from:
        - ipBlock:
            cidr: 10.244.0.0/16  # us-east-1 pod CIDR
    # Allow from eu-west-1 pod CIDR
    - from:
        - ipBlock:
            cidr: 10.245.0.0/16  # eu-west-1 pod CIDR
  policyTypes:
    - Ingress
```

### Service Account Token Rotation

```bash
#!/bin/bash
# rotate-cross-cluster-tokens.sh

SOURCE_CTX="management-cluster"

for TARGET in us-east-1 eu-west-1; do
  echo "Rotating token for ${TARGET}..."

  # Delete old secret (Kubernetes auto-creates a new token)
  kubectl --context "${TARGET}" delete secret \
    "admiralty-source-${SOURCE_CTX}-token" \
    -n admiralty

  # Wait for new token
  sleep 5

  # Re-run trust setup
  ./setup-trust.sh "target-${TARGET}" "${TARGET}"

  echo "Token rotated for ${TARGET}"
done
```

## Summary

Admiralty provides a production-ready multi-cluster scheduler that works with standard Kubernetes deployments, requiring only webhook access between clusters for the scheduler plane and network connectivity (provided by Submariner) for data plane traffic. The source/target cluster architecture gives application teams a single API surface in the source cluster while transparently distributing workloads based on topology spread constraints, affinity rules, and placement policies. Combined with cross-cluster service discovery, centralized observability, and GitOps-driven deployment, the result is a federated Kubernetes platform that maintains high availability across regional failures while respecting data residency requirements through cluster-level placement policies.
