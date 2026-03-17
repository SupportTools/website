---
title: "Kubernetes Cluster Federation: Admiralty, Liqo, and Submariner for Multi-Cluster Service Discovery"
date: 2028-08-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Federation", "Admiralty", "Liqo", "Submariner", "Multi-Cluster"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes cluster federation using Admiralty for workload scheduling, Liqo for resource sharing, and Submariner for cross-cluster networking and service discovery in production multi-cluster environments."
more_link: "yes"
url: "/kubernetes-cluster-federation-admiralty-liqo-guide/"
---

Multi-cluster Kubernetes is no longer optional for organizations running at scale. Regulatory requirements mandate data residency, disaster recovery requires geographic distribution, and teams running hundreds of microservices exceed what a single cluster can practically manage. The challenge is that Kubernetes was designed for single-cluster operation. Federating clusters requires solving networking, service discovery, workload scheduling, and identity across cluster boundaries.

This guide covers three complementary tools: Admiralty for intelligent multi-cluster workload scheduling, Liqo for transparent resource sharing between clusters, and Submariner for cross-cluster L3 connectivity and service discovery.

<!--more-->

# [Kubernetes Cluster Federation: Admiralty, Liqo, and Submariner](#kubernetes-cluster-federation)

## Section 1: Multi-Cluster Architecture Patterns

### Pattern 1: Single Control Plane (KubeFed v2 / Fleet)
One control plane manages multiple clusters. Workloads are defined once and distributed. High complexity, single point of failure in the control plane.

### Pattern 2: Loosely Coupled Clusters (Submariner + Admiralty)
Each cluster operates independently. Networking is bridged (Submariner). Workload scheduling across clusters is optional (Admiralty). Service discovery is federated (Lighthouse).

### Pattern 3: Resource Sharing (Liqo)
Clusters appear to share their resource pools. Pods scheduled on one cluster can run transparently on another. Liqo virtualizes remote cluster nodes as local Kubernetes nodes.

### Choosing the Right Approach

| Requirement | Recommended Tool |
|-------------|-----------------|
| Cross-cluster pod-to-pod networking | Submariner |
| Cross-cluster service DNS | Submariner Lighthouse |
| Overflow workloads to another cluster | Admiralty |
| Burst capacity from remote cluster | Liqo |
| Central multi-cluster scheduling policy | Admiralty + Admiralty Scheduler |

## Section 2: Cluster Setup for This Guide

We'll use three clusters:
- `hub` — management cluster (runs Admiralty scheduler, Liqo broker)
- `us-east` — primary workload cluster
- `eu-west` — secondary workload cluster (overflow, DR)

```bash
# Set up kubeconfig contexts
export HUB_CTX=hub
export US_EAST_CTX=us-east
export EU_WEST_CTX=eu-west

# Verify cluster access
kubectl --context=$HUB_CTX get nodes
kubectl --context=$US_EAST_CTX get nodes
kubectl --context=$EU_WEST_CTX get nodes
```

## Section 3: Submariner — Cross-Cluster Networking

Submariner provides:
1. **L3 connectivity** — pod and service CIDRs routed between clusters
2. **Lighthouse** — cross-cluster CoreDNS integration for service DNS
3. **Globalnet** — handles overlapping CIDR ranges

### Installing subctl

```bash
# Install subctl CLI
curl -Ls https://get.submariner.io | bash
export PATH=$PATH:~/.local/bin
subctl version
```

### Deploying Submariner Broker

The broker coordinates cluster registrations (runs in hub cluster):

```bash
# Deploy the broker on the hub cluster
subctl deploy-broker \
  --kubeconfig ~/.kube/config \
  --kubecontext $HUB_CTX \
  --globalnet \
  --components service-discovery,connectivity

# This creates a broker-info.subm file with join credentials
ls -la broker-info.subm
```

### Joining Clusters to the Broker

```bash
# Join us-east cluster
subctl join broker-info.subm \
  --kubecontext $US_EAST_CTX \
  --clusterid us-east \
  --natt=false \
  --cable-driver libreswan

# Join eu-west cluster
subctl join broker-info.subm \
  --kubecontext $EU_WEST_CTX \
  --clusterid eu-west \
  --natt=false \
  --cable-driver libreswan

# Verify connectivity
subctl show connections --kubecontext $US_EAST_CTX
# GATEWAY     CLUSTER   REMOTE IP    NAT  CABLE DRIVER  SUBNETS                    STATUS
# gw-node-1   eu-west   10.1.2.100   no   libreswan     10.128.0.0/14,10.2.0.0/24  connected
```

### Verifying Cross-Cluster Pod Connectivity

```bash
# Deploy test pods in both clusters
kubectl --context=$US_EAST_CTX run nettest \
  --image=nicolaka/netshoot --command -- sleep 3600

kubectl --context=$EU_WEST_CTX run nettest \
  --image=nicolaka/netshoot --command -- sleep 3600

# Get IP of eu-west pod
EU_POD_IP=$(kubectl --context=$EU_WEST_CTX get pod nettest \
  -o jsonpath='{.status.podIP}')

# Test connectivity from us-east to eu-west pod
kubectl --context=$US_EAST_CTX exec nettest -- ping -c 3 $EU_POD_IP
```

### Submariner ServiceExport for Cross-Cluster DNS

Submariner Lighthouse allows services to be discovered across clusters via DNS:

```yaml
# Deploy a service in us-east
apiVersion: v1
kind: Service
metadata:
  name: payment-service
  namespace: production
spec:
  selector:
    app: payment-service
  ports:
  - port: 8080
    targetPort: 8080
---
# Export the service to other clusters via Submariner
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: payment-service
  namespace: production
```

```bash
# Apply in us-east
kubectl --context=$US_EAST_CTX apply -f service-export.yaml

# In eu-west, the service is now discoverable as:
# payment-service.production.svc.clusterset.local

# Test cross-cluster DNS from eu-west
kubectl --context=$EU_WEST_CTX exec nettest -- \
  nslookup payment-service.production.svc.clusterset.local

# Test HTTP connectivity
kubectl --context=$EU_WEST_CTX exec nettest -- \
  curl http://payment-service.production.svc.clusterset.local:8080/healthz
```

### ServiceImport — What Gets Created Automatically

When a service is exported, Submariner creates a `ServiceImport` in all other clusters:

```bash
# View auto-created ServiceImport in eu-west
kubectl --context=$EU_WEST_CTX get serviceimport \
  -n production payment-service -o yaml
```

```yaml
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: payment-service
  namespace: production
spec:
  type: ClusterSetIP
  ports:
  - port: 8080
    protocol: TCP
status:
  clusters:
  - cluster: us-east
```

## Section 4: Admiralty — Multi-Cluster Workload Scheduling

Admiralty extends Kubernetes scheduling to span multiple clusters. It uses a "proxy pod" model: a pod exists in the source cluster but actually runs on a target cluster.

### How Admiralty Works

1. A pod is annotated with `multicluster.admiralty.io/elect: ""`
2. Admiralty's scheduler selects a target cluster based on capacity, labels, and constraints
3. The pod becomes a "proxy pod" in the source cluster
4. A "delegate pod" is created in the target cluster
5. The delegate's status is reflected back to the proxy

### Installing Admiralty

```bash
# Add Helm repository
helm repo add admiralty https://charts.admiralty.io
helm repo update

# Install on hub cluster (scheduler)
helm install admiralty admiralty/multicluster-scheduler \
  --kube-context $HUB_CTX \
  --namespace admiralty \
  --create-namespace \
  --set scheduler.enabled=true

# Install agent on each cluster
for CTX in $US_EAST_CTX $EU_WEST_CTX; do
  helm install admiralty admiralty/multicluster-scheduler \
    --kube-context $CTX \
    --namespace admiralty \
    --create-namespace \
    --set agent.enabled=true \
    --set scheduler.enabled=false
done
```

### Creating Cluster Sources and Targets

```yaml
# In us-east: register itself as a Source (can send work)
# and eu-west as a Target (can receive work)
---
apiVersion: multicluster.admiralty.io/v1alpha1
kind: Source
metadata:
  name: self
  namespace: production
spec:
  serviceAccountName: us-east-agent
  clusterName: us-east
---
apiVersion: multicluster.admiralty.io/v1alpha1
kind: Target
metadata:
  name: eu-west
  namespace: production
spec:
  # Reference to the kubeconfig secret for eu-west
  kubeconfigSecret:
    name: eu-west-kubeconfig
  clusterName: eu-west
```

```bash
# Create the kubeconfig secret for eu-west in us-east
kubectl --context=$US_EAST_CTX create secret generic eu-west-kubeconfig \
  -n production \
  --from-file=config=/path/to/eu-west-kubeconfig

kubectl --context=$US_EAST_CTX apply -f cluster-targets.yaml
```

### Deploying a Multi-Cluster Workload

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  namespace: production
  annotations:
    # Enable multi-cluster scheduling for this deployment
    multicluster.admiralty.io/elect: ""
spec:
  replicas: 6    # Admiralty will distribute across clusters
  selector:
    matchLabels:
      app: web-app
  template:
    metadata:
      labels:
        app: web-app
      annotations:
        # Admiralty annotation: allow scheduling to any target
        multicluster.admiralty.io/elect: ""
    spec:
      # Admiralty injects a topology spread constraint automatically
      # but you can add custom constraints:
      topologySpreadConstraints:
      - maxSkew: 2
        topologyKey: multicluster.admiralty.io/cluster-name
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: web-app
      containers:
      - name: web-app
        image: web-app:v2.3.1
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
```

```bash
# Deploy the multi-cluster workload
kubectl --context=$US_EAST_CTX apply -f web-app.yaml

# Watch proxy pods in us-east
kubectl --context=$US_EAST_CTX get pods -n production -w

# Watch delegate pods in eu-west (these are the real pods)
kubectl --context=$EU_WEST_CTX get pods -n production

# Check which cluster each pod ran on
kubectl --context=$US_EAST_CTX get pods -n production \
  -o jsonpath='{range .items[*]}{.metadata.name}: {.metadata.annotations.multicluster\.admiralty\.io/cluster-name}{"\n"}{end}'
```

### Capacity-Based Scheduling with Admiralty

```yaml
# Add capacity annotations to the Target to influence scheduling
apiVersion: multicluster.admiralty.io/v1alpha1
kind: Target
metadata:
  name: eu-west
  namespace: production
spec:
  clusterName: eu-west
  kubeconfigSecret:
    name: eu-west-kubeconfig
  # Relative capacity weight (us-east is 100, eu-west is 50 = 2:1 ratio)
  capacityWeight: 50
```

### Cluster Selector for Pod Placement

```yaml
# Route specific workloads to specific clusters via node affinity
spec:
  template:
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: multicluster.admiralty.io/cluster-name
                operator: In
                values: ["eu-west"]  # Force to eu-west only
```

## Section 5: Liqo — Transparent Resource Sharing

Liqo takes a different approach: it creates virtual nodes in your cluster that represent capacity from remote clusters. Pods scheduled on a virtual node run transparently in the remote cluster.

### How Liqo Works

1. Liqo "peering" is established between two clusters
2. A virtual node appears in each cluster representing the other cluster's capacity
3. Pods scheduled on the virtual node are offloaded to the remote cluster
4. The remote cluster handles all pod lifecycle management
5. Service discovery works via Liqo's in-cluster DNS extension

### Installing Liqo

```bash
# Install liqoctl
curl --fail -LS "https://github.com/liqotech/liqo/releases/latest/download/liqoctl-linux-amd64.tar.gz" \
  | tar -xz
sudo mv liqoctl /usr/local/bin/

liqoctl version

# Install Liqo on us-east
liqoctl install kubernetes \
  --cluster-id us-east \
  --kubecontext $US_EAST_CTX \
  --cluster-name us-east

# Install Liqo on eu-west
liqoctl install kubernetes \
  --cluster-id eu-west \
  --kubecontext $EU_WEST_CTX \
  --cluster-name eu-west
```

### Peering Clusters with Liqo

```bash
# Generate peering invitation from eu-west
liqoctl generate peer-info \
  --kubecontext $EU_WEST_CTX > eu-west-peer-info.yaml

# Peer us-east with eu-west (bidirectional)
liqoctl peer out-of-band eu-west \
  --kubecontext $US_EAST_CTX \
  --file eu-west-peer-info.yaml

# Verify peering
liqoctl info --kubecontext $US_EAST_CTX
```

```bash
# The virtual node for eu-west now appears in us-east
kubectl --context=$US_EAST_CTX get nodes
# NAME                  STATUS   ROLES           AGE   VERSION
# us-east-worker-1      Ready    <none>          10d   v1.29.0
# us-east-worker-2      Ready    <none>          10d   v1.29.0
# liqo-eu-west          Ready    agent           5m    Liqo-v0.10
```

### Namespace Offloading

Liqo offloads entire namespaces, not individual pods. Annotate a namespace to enable offloading:

```bash
# Enable namespace offloading (creates namespace on eu-west automatically)
liqoctl offload namespace production \
  --kubecontext $US_EAST_CTX \
  --namespace-mapping-strategy EnforceSameName \
  --pod-offloading-strategy LocalAndRemote

# NamespaceOffloading resource is created automatically
kubectl --context=$US_EAST_CTX get namespaceoffloading \
  -n production -o yaml
```

```yaml
apiVersion: offloading.liqo.io/v1alpha1
kind: NamespaceOffloading
metadata:
  name: offloading
  namespace: production
spec:
  namespaceMappingStrategy: EnforceSameName
  podOffloadingStrategy: LocalAndRemote  # Pods can run locally or remotely
  clusterSelector:
    matchExpressions:
    - key: liqo.io/remote-cluster-id
      operator: In
      values: ["eu-west"]
```

### Workload Offloading Control

```yaml
# Force a deployment to run only on remote cluster
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
  namespace: production
spec:
  replicas: 10
  template:
    spec:
      # Schedule on the Liqo virtual node (eu-west)
      nodeSelector:
        liqo.io/remote-cluster-id: eu-west
      tolerations:
      - key: virtual-node.liqo.io/not-allowed
        operator: Exists
        effect: NoExecute
      containers:
      - name: batch
        image: batch-processor:v1.0
        resources:
          requests:
            cpu: "2"
            memory: "4Gi"
```

### Cross-Cluster Service Discovery with Liqo

Liqo automatically replicates services to remote clusters when namespaces are offloaded:

```bash
# Services in 'production' on us-east are visible in eu-west
kubectl --context=$EU_WEST_CTX get services -n production

# Cross-cluster DNS works automatically:
# payment-service.production.svc.cluster.local resolves in both clusters
# because Liqo synchronizes the service resource

# Check Liqo's shadow pod (remote pod representation)
kubectl --context=$US_EAST_CTX get pods -n production \
  -l liqo.io/shadow=true
```

## Section 6: Combined Architecture — Submariner + Admiralty + Liqo

In practice, these tools are complementary:

| Layer | Tool | Purpose |
|-------|------|---------|
| L3 Network | Submariner | Pod IP routing between clusters |
| DNS | Submariner Lighthouse | Cross-cluster service DNS |
| Scheduling | Admiralty | Multi-cluster pod placement |
| Capacity sharing | Liqo | Virtual nodes from remote clusters |

### Architecture Diagram Components

```
┌─────────────── us-east cluster ───────────────┐
│  ┌──────────────────────────────────────────┐  │
│  │           production namespace           │  │
│  │  [web-pod-1] [web-pod-2] [proxy-pod-3]  │  │
│  │                             │ Admiralty  │  │
│  └─────────────────────────────│────────────┘  │
│                                │               │
│  ┌──────────┐   Submariner IPsec tunnel         │
│  │ liqo-vnode├──────────────────────────────┐  │
│  │(eu-west) │                              │  │
│  └──────────┘                              │  │
└──────────────────────────────────────────────┘
                                             │
              Submariner tunnel              │
                                             ▼
┌─────────────── eu-west cluster ───────────────┐
│  ┌──────────────────────────────────────────┐  │
│  │           production namespace           │  │
│  │  [web-pod-3 delegate] [offloaded-pod-1] │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

## Section 7: ClusterAPI for Homogeneous Cluster Management

When managing many clusters, ClusterAPI provides a declarative API for provisioning:

```yaml
# cluster.yaml — provision a new cluster with ClusterAPI
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: eu-west-prod
  namespace: clusters
spec:
  clusterNetwork:
    pods:
      cidrBlocks: ["10.128.0.0/14"]
    services:
      cidrBlocks: ["10.2.0.0/20"]
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: eu-west-prod-control-plane
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: eu-west-prod
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: eu-west-prod
  namespace: clusters
spec:
  region: eu-west-1
  sshKeyName: cluster-ssh-key
  network:
    vpc:
      cidrBlock: "10.0.0.0/16"
    subnets:
    - availabilityZone: eu-west-1a
      cidrBlock: "10.0.1.0/24"
      isPublic: false
    - availabilityZone: eu-west-1b
      cidrBlock: "10.0.2.0/24"
      isPublic: false
```

```bash
# Bootstrap a new cluster
kubectl apply -f cluster.yaml

# Wait for cluster to be ready
kubectl wait cluster eu-west-prod -n clusters \
  --for=condition=Ready \
  --timeout=20m

# Get kubeconfig for new cluster
clusterctl get kubeconfig eu-west-prod -n clusters > eu-west-prod.kubeconfig

# Automatically register with Submariner and Liqo
subctl join broker-info.subm --kubeconfig eu-west-prod.kubeconfig \
  --clusterid eu-west-prod

liqoctl peer out-of-band eu-west-prod \
  --kubecontext $HUB_CTX \
  --file eu-west-prod-peer-info.yaml
```

## Section 8: Multi-Cluster Policy Enforcement with Kyverno

Apply consistent policies across all clusters:

```yaml
# ClusterPolicy applied to all clusters via GitOps
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-resource-limits
spec:
  validationFailureAction: enforce
  rules:
  - name: check-container-resources
    match:
      any:
      - resources:
          kinds: ["Pod"]
    validate:
      message: "CPU and memory limits are required"
      pattern:
        spec:
          containers:
          - (name): "*"
            resources:
              limits:
                memory: "?*"
                cpu: "?*"
---
# Multi-cluster policy via Fleet (Rancher Fleet or ArgoCD ApplicationSets)
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: policies
  namespace: fleet-default
spec:
  repo: https://github.com/myorg/cluster-policies
  branch: main
  paths:
  - kyverno/
  targets:
  - name: all-production
    clusterSelector:
      matchLabels:
        env: production
```

## Section 9: Observability Across Clusters

### Thanos for Multi-Cluster Metrics

```yaml
# Prometheus in each cluster with Thanos Sidecar
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
  namespace: monitoring
spec:
  thanos:
    image: quay.io/thanos/thanos:v0.33.0
    version: v0.33.0
    objectStorageConfig:
      key: objstore.yml
      name: thanos-objstore-secret
  externalLabels:
    cluster: us-east    # Label with cluster name for Thanos querier
    region: us-east-1
  replicas: 2
```

```bash
# Thanos Query in hub cluster: aggregates metrics from all clusters
helm install thanos bitnami/thanos \
  --kube-context $HUB_CTX \
  --namespace monitoring \
  --set query.enabled=true \
  --set query.stores[0]=us-east-thanos:10901 \
  --set query.stores[1]=eu-west-thanos:10901

# Now query all clusters from one endpoint
# http://thanos-query.monitoring.svc:9090/graph
```

### Loki for Multi-Cluster Logs

```yaml
# In each cluster: Promtail ships to central Loki
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: promtail
  namespace: monitoring
spec:
  template:
    spec:
      containers:
      - name: promtail
        image: grafana/promtail:3.0.0
        args:
        - -config.file=/etc/promtail/config.yaml
        volumeMounts:
        - name: config
          mountPath: /etc/promtail
      volumes:
      - name: config
        configMap:
          name: promtail-config
```

```yaml
# promtail-config.yaml
server:
  http_listen_port: 9080

clients:
- url: http://loki.monitoring.hub.svc:3100/loki/api/v1/push

scrape_configs:
- job_name: kubernetes-pods
  pipeline_stages:
  - cri: {}
  - labeldrop:
    - filename
  kubernetes_sd_configs:
  - role: pod
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_node_name]
    target_label: node
  - source_labels: [__meta_kubernetes_namespace]
    target_label: namespace
  - source_labels: [__meta_kubernetes_pod_name]
    target_label: pod
  - source_labels: []
    target_label: cluster
    replacement: us-east      # Static label per cluster
```

## Section 10: Disaster Recovery with Multi-Cluster

### Failover with Submariner ServiceExport

```bash
# Normal operation: payment-service exported from us-east
# On failure, export the service from eu-west as well

# Simulate us-east failure
kubectl --context=$US_EAST_CTX delete serviceexport payment-service -n production

# Export from eu-west as fallback
kubectl --context=$EU_WEST_CTX apply -f - << 'EOF'
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: payment-service
  namespace: production
EOF

# DNS resolution now routes to eu-west endpoints
# payment-service.production.svc.clusterset.local -> eu-west pods
```

### Automated Failover with External DNS and Submariner

```yaml
# External DNS annotation for global load balancing
apiVersion: v1
kind: Service
metadata:
  name: payment-service
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: payment.api.mycompany.com
    external-dns.alpha.kubernetes.io/aws-weight: "100"   # Primary
spec:
  type: LoadBalancer
  selector:
    app: payment-service
  ports:
  - port: 80
    targetPort: 8080
```

```yaml
# In eu-west DR cluster:
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: payment.api.mycompany.com
    external-dns.alpha.kubernetes.io/aws-weight: "0"   # 0 = standby
    # Set to non-zero to activate failover
```

## Section 11: Troubleshooting Multi-Cluster Issues

### Submariner Diagnostics

```bash
# Full connectivity diagnostics
subctl diagnose all --kubecontext $US_EAST_CTX

# Check cable driver status
kubectl --context=$US_EAST_CTX get submariners -n submariner-operator
kubectl --context=$US_EAST_CTX describe gateway -n submariner

# Test connection between specific clusters
subctl benchmark latency \
  --kubecontext $US_EAST_CTX \
  --tocontext $EU_WEST_CTX

# Check Lighthouse DNS
kubectl --context=$US_EAST_CTX run dns-test \
  --image=tutum/dnsutils \
  --rm -it --restart=Never -- \
  nslookup payment-service.production.svc.clusterset.local

# Check ClusterIP conflicts (Globalnet required if CIDRs overlap)
kubectl --context=$US_EAST_CTX get globalingressip -n production
```

### Admiralty Diagnostics

```bash
# Check Source and Target status
kubectl --context=$US_EAST_CTX get sources,targets -n production

# Check proxy pod annotations
kubectl --context=$US_EAST_CTX get pod web-app-xxx -n production \
  -o jsonpath='{.metadata.annotations}' | jq

# Check delegate pod in remote cluster
kubectl --context=$EU_WEST_CTX get pods -n production \
  -l multicluster.admiralty.io/is-delegate=true

# Check scheduling events
kubectl --context=$US_EAST_CTX describe pod web-app-xxx -n production | \
  grep -A 10 Events
```

### Liqo Diagnostics

```bash
# Check peering status
liqoctl info --kubecontext $US_EAST_CTX

# Check virtual node health
kubectl --context=$US_EAST_CTX get virtualnodes
kubectl --context=$US_EAST_CTX describe virtualnode liqo-eu-west

# Check namespace offloading status
kubectl --context=$US_EAST_CTX get namespaceoffloading -n production

# Check shadow pods (remote pod representations)
kubectl --context=$US_EAST_CTX get pods -n production \
  -l liqo.io/shadow=true -o wide

# View Liqo operator logs
kubectl --context=$US_EAST_CTX logs -n liqo \
  -l app.kubernetes.io/component=controller-manager -f
```

## Section 12: Summary and Design Decisions

### Tool Comparison

| Feature | Submariner | Admiralty | Liqo |
|---------|-----------|-----------|------|
| L3 Pod networking | Yes | No | No |
| Cross-cluster DNS | Yes (Lighthouse) | No | Yes (sync) |
| Multi-cluster scheduling | No | Yes | Yes (virtual nodes) |
| Transparent offloading | No | Proxy/delegate model | Transparent |
| Namespace sync | No | No | Yes |
| CIDR conflict resolution | Globalnet | N/A | N/A |
| Production maturity | High | Medium | Medium |

### Recommended Production Architecture

For most production deployments:

1. **Submariner** as the networking layer — mature, battle-tested, CNCF sandbox
2. **Submariner Lighthouse** for cross-cluster service DNS
3. **Admiralty** for multi-cluster scheduling when you want fine-grained control
4. **Liqo** for burst capacity scenarios where transparent offloading is preferred
5. **Thanos + Loki** for unified observability
6. **ArgoCD ApplicationSets** with cluster generators for uniform GitOps deployment

The key insight: don't try to make multiple clusters behave as one — build systems that handle the boundaries explicitly. Service exports, explicit scheduling annotations, and cross-cluster health checks are more reliable than transparent solutions that hide the complexity.
