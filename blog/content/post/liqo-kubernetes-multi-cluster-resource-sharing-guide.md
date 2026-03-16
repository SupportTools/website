---
title: "Liqo: Transparent Multi-Cluster Resource Sharing for Kubernetes"
date: 2027-01-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Liqo", "Multi-Cluster", "Federation", "Resource Sharing"]
categories: ["Kubernetes", "Networking", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Liqo multi-cluster resource sharing: peering workflow, namespace offloading, virtual nodes, WireGuard WAN fabric, service discovery, storage offloading, and comparison with Admiralty and Submariner."
more_link: "yes"
url: "/liqo-kubernetes-multi-cluster-resource-sharing-guide/"
---

Running workloads across multiple Kubernetes clusters typically demands one of two compromises: a heavyweight federation control plane that becomes a single point of failure, or per-cluster manual scheduling that defeats the purpose of having multiple clusters. **Liqo** takes a different approach — it makes remote cluster capacity appear as virtual nodes in the local cluster, allowing the standard Kubernetes scheduler to place workloads across cluster boundaries without application changes.

<!--more-->

## Liqo Architecture

Liqo decomposes into three logical planes that operate independently and recover from each other's failures.

### Control Plane

The **Liqo controller manager** runs in the `liqo` namespace and manages the lifecycle of peering relationships. It implements the following controllers:

- **Discovery controller** — scans for available remote clusters via DNS-SD, multicast, or manual configuration
- **Peering controller** — negotiates and maintains bidirectional or unidirectional peering relationships
- **Namespace offloading controller** — creates remote namespace representations and tracks their status
- **Virtual node controller** — synthesizes virtual `Node` objects that represent remote cluster capacity

### Network Fabric

The **Liqo gateway** handles WAN tunneling between peered clusters. By default it uses **WireGuard** over UDP, establishing an encrypted overlay network that connects pod CIDRs across cluster boundaries. The gateway translates between each cluster's internal addressing, allowing pods in cluster A to reach pods in cluster B using their native pod IPs.

```
Cluster A                              Cluster B
─────────────────────────────────────────────────────────
 Pod CIDR: 10.0.0.0/16                 Pod CIDR: 10.1.0.0/16
 Service CIDR: 10.96.0.0/12           Service CIDR: 10.97.0.0/12

 liqo-gateway-a ──── WireGuard UDP ──── liqo-gateway-b
      │                                       │
   NAT/IPAM                               NAT/IPAM
      │                                       │
 10.0.x.x pods                          10.1.x.x pods
```

IPAM (IP Address Management) is handled per-cluster by Liqo's IPAM module, which remaps overlapping CIDRs to avoid routing conflicts. This allows peering clusters whose pod or service CIDRs overlap — a common situation when pairing a cloud-managed cluster (EKS, GKE) with an on-premises cluster.

### Data Plane Reflection

The **Liqo virtual kubelet** (one per remote cluster) appears as a standard kubelet to the Kubernetes API server. When the scheduler places a Pod onto a virtual node, the virtual kubelet intercepts the binding and reflects the Pod definition to the remote cluster for execution. Status updates flow back to the local cluster, maintaining the standard Pod lifecycle observable from the local cluster.

```
Local Cluster API Server
        │
        │  Pod assigned to virtual-node-cluster-b
        │
        ▼
 Liqo Virtual Kubelet (cluster-b)
        │
        │  Reflect Pod to remote cluster
        │
        ▼
 Remote Cluster API Server (cluster-b)
        │
        ▼
 Actual Pod running on cluster-b nodes
```

## Installation with liqoctl

`liqoctl` is the primary management interface for Liqo operations.

```bash
# Install liqoctl
LIQO_VERSION=v0.10.3
curl -L "https://github.com/liqotech/liqo/releases/download/${LIQO_VERSION}/liqoctl-linux-amd64.tar.gz" \
  | tar xz -C /usr/local/bin

liqoctl version
```

### Install Liqo on Each Cluster

Install Liqo on every cluster that will participate in the mesh. The `--cluster-id` flag sets a stable identity used in peering:

```bash
# On cluster A (home cluster / consumer)
kubectl config use-context cluster-a
liqoctl install kubernetes \
  --cluster-id cluster-a \
  --cluster-labels region=us-east-1,tier=home \
  --timeout 5m

# On cluster B (remote cluster / provider)
kubectl config use-context cluster-b
liqoctl install kubernetes \
  --cluster-id cluster-b \
  --cluster-labels region=eu-west-1,tier=remote \
  --timeout 5m
```

For cloud-managed clusters, use the provider-specific sub-command to auto-configure IAM permissions and endpoint discovery:

```bash
# EKS cluster
liqoctl install eks \
  --cluster-name production-eks \
  --region us-east-1 \
  --eks-cluster-name my-eks-cluster

# GKE cluster
liqotech install gke \
  --project-id my-gcp-project \
  --cluster-name my-gke-cluster \
  --zone us-central1-a
```

### Verify Installation

```bash
kubectl -n liqo get pods
# Expected: gateway, controller-manager, auth, webhook, ipam all Running

liqoctl status
```

## Peer Discovery and Peering Workflow

### Manual Peering

For production environments, manual peering with explicit configuration is recommended over automatic discovery:

```bash
# Step 1: Generate peer token from cluster B (the provider)
kubectl config use-context cluster-b
liqoctl generate peer-info \
  --cluster-id cluster-b \
  --output cluster-b-peer-info.yaml

# Step 2: Apply the peer info to cluster A (the consumer)
kubectl config use-context cluster-a
liqotech peer out-of-band cluster-b \
  --file cluster-b-peer-info.yaml
```

### Peering Modes

**Bidirectional peering** — both clusters can offload workloads to each other. Appropriate for active-active multi-region configurations:

```bash
liqotech peer out-of-band cluster-b \
  --file cluster-b-peer-info.yaml \
  --bidirectional
```

**Unidirectional peering** — only the consumer cluster can offload to the provider. Appropriate for burst-to-cloud patterns where a private cluster offloads overflow to a cloud cluster but not vice versa:

```bash
# Default: unidirectional (cluster-a offloads to cluster-b)
liqotech peer out-of-band cluster-b \
  --file cluster-b-peer-info.yaml
```

### ForeignCluster Resource

After peering, Liqo creates a `ForeignCluster` object in each cluster representing the remote peer:

```yaml
apiVersion: discovery.liqo.io/v1alpha1
kind: ForeignCluster
metadata:
  name: cluster-b
spec:
  clusterIdentity:
    clusterID: cluster-b
    clusterName: cluster-b
  peeringType: OutOfBand
  outgoingPeeringEnabled: Yes
  incomingPeeringEnabled: No
  insecureSkipTLSVerify: false
status:
  peeringConditions:
    - type: OutgoingPeering
      status: "True"
      reason: PeeringEstablished
    - type: NetworkStatus
      status: "True"
      reason: NetworkReady
  foreignAuthUrl: https://cluster-b-auth.example.com:6443
  foreignProxyUrl: https://cluster-b-proxy.example.com:443
```

### Virtual Node Appearance

After successful peering, cluster A shows a virtual node representing cluster B's capacity:

```bash
kubectl get nodes
# NAME                       STATUS   ROLES    AGE
# node-a-1                   Ready    <none>   45d
# node-a-2                   Ready    <none>   45d
# liqo-cluster-b             Ready    agent    2h

kubectl describe node liqo-cluster-b
# Labels:
#   liqo.io/remote-cluster-id=cluster-b
#   liqo.io/type=virtual-node
#   region=eu-west-1
#   tier=remote
# Capacity:
#   cpu: 32          (aggregate capacity shared by cluster-b)
#   memory: 128Gi
```

The scheduler treats this virtual node identically to physical nodes. Standard node affinity, taint, and toleration rules apply.

## Namespace Offloading

**Namespace offloading** is the mechanism by which workloads in a local namespace are allowed to schedule onto remote clusters. Without offloading, pods will not be scheduled to virtual nodes.

### NamespaceOffloading Resource

```yaml
apiVersion: offloading.liqo.io/v1alpha1
kind: NamespaceOffloading
metadata:
  name: offloading
  namespace: batch-processing
spec:
  # How the namespace is named in the remote cluster
  # Generator adds a hash suffix to avoid conflicts: batch-processing-a1b2c3
  namespaceMappingStrategy: DefaultName

  # Which remote clusters may receive workloads from this namespace
  clusterSelector:
    matchLabels:
      liqo.io/remote-cluster-id: cluster-b

  # Pod offloading strategy
  podOffloadingStrategy: LocalAndRemote
  # Options:
  # Local:          schedule only on local nodes
  # Remote:         schedule ONLY on virtual nodes (force offload)
  # LocalAndRemote: scheduler decides based on resources (default)
```

Apply and verify:

```bash
kubectl apply -f namespace-offloading.yaml
kubectl -n batch-processing get namespaceoffloading offloading
# STATUS should show: Ready
```

### Checking Remote Namespace

```bash
# Verify the remote namespace was created
kubectl config use-context cluster-b
kubectl get namespaces | grep batch-processing
# batch-processing-a1b2c3   Active   5m

# Pods reflected to cluster-b appear here
kubectl -n batch-processing-a1b2c3 get pods
```

## Pod Scheduling Across Clusters

With namespace offloading enabled, the standard scheduler places pods on virtual nodes when:

- Local nodes lack capacity (resource pressure)
- Node affinity matches virtual node labels
- A `Remote` offloading strategy is configured

### Forcing Workloads to Remote Clusters

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: ml-training-job
  namespace: batch-processing
spec:
  parallelism: 10
  template:
    spec:
      # Force scheduling to remote cluster via node affinity
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: liqo.io/type
                    operator: In
                    values:
                      - virtual-node
                  - key: region
                    operator: In
                    values:
                      - eu-west-1
      # Add toleration for Liqo virtual node taint
      tolerations:
        - key: liqo.io/remote-cluster
          operator: Exists
          effect: NoSchedule
      containers:
        - name: trainer
          image: registry.example.com/ml/trainer:v2.1.0
          resources:
            requests:
              cpu: "2"
              memory: 8Gi
```

### Observing Remote Pod Status

From the local cluster, remote pods are fully observable:

```bash
# List all pods including remote ones
kubectl -n batch-processing get pods -o wide
# NAME                     READY   STATUS    NODE
# ml-training-job-abc12    1/1     Running   liqo-cluster-b
# ml-training-job-def34    1/1     Running   liqo-cluster-b
# ml-training-job-ghi56    1/1     Running   node-a-1

# Stream logs from a remote pod — works transparently
kubectl -n batch-processing logs ml-training-job-abc12 -f

# Exec into a remote pod
kubectl -n batch-processing exec -it ml-training-job-abc12 -- /bin/sh
```

## WAN Network Fabric

The WireGuard gateway establishes the inter-cluster overlay. Production deployments require the gateway to be reachable from the remote cluster.

### Gateway Configuration

```yaml
apiVersion: networking.liqo.io/v1alpha1
kind: WireGuardEndpoint
metadata:
  name: cluster-a-gateway
  namespace: liqo
spec:
  endpointIP: "203.0.113.45"   # External IP of the gateway LoadBalancer
  backendType: wireguard
  backendConfig:
    mtu: "1340"   # Lower MTU to account for WireGuard header overhead
    persistentKeepalive: "25"
```

### Custom Backend

For environments where WireGuard is not available (some managed Kubernetes services restrict kernel module loading), Liqo supports alternative backends:

```bash
liqotech install kubernetes \
  --cluster-id cluster-a \
  --network-backend geneve   # or: wireguard (default), none
```

`geneve` uses GENEVE tunneling (software implementation, works without kernel module). `none` disables the network fabric entirely — appropriate when clusters already have direct connectivity via VPC peering or ExpressConnect.

## Service Discovery Across Clusters

Services defined in offloaded namespaces are reflected to remote clusters, enabling cross-cluster service discovery using standard Kubernetes DNS.

```bash
# Service defined in cluster-a, namespace batch-processing
kubectl -n batch-processing get svc database-proxy
# NAME             TYPE        CLUSTER-IP     PORT(S)
# database-proxy   ClusterIP   10.96.10.42    5432/TCP

# In cluster-b, the reflected service is accessible at the same DNS name
# within the mapped namespace batch-processing-a1b2c3
# Pods in cluster-b can reach: database-proxy.batch-processing-a1b2c3.svc.cluster.local
```

For services that need to be reachable cluster-wide (not just from mapped namespaces), annotate the service to trigger global reflection:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: batch-processing
  annotations:
    liqo.io/remote-service-reflection-type: Global
spec:
  selector:
    app: api-gateway
  ports:
    - port: 8080
      targetPort: 8080
```

## Resource Reflection

Beyond Pods and Services, Liqo reflects other resource types to remote clusters. The reflection list is configurable:

```yaml
# liqo-values.yaml
virtualKubelet:
  reflectors:
    pod:
      workers: 10
    service:
      workers: 5
    endpoints:
      workers: 5
    endpointSlice:
      workers: 5
    configmap:
      workers: 5
    secret:
      workers: 5    # Requires careful RBAC — secrets cross cluster boundaries
    serviceaccount:
      workers: 3
    persistentvolumeclaim:
      workers: 3
    event:
      workers: 3
```

Disable reflection for sensitive resource types by setting `workers: 0`.

## Storage Offloading

Liqo supports PVC offloading — a PVC bound in the local cluster can have its backing volume provisioned in the remote cluster. This enables stateful workloads to follow compute offloading.

```yaml
apiVersion: offloading.liqo.io/v1alpha1
kind: NamespaceOffloading
metadata:
  name: offloading
  namespace: batch-processing
spec:
  storageEnabled: true
  podOffloadingStrategy: Remote
```

When `storageEnabled: true`, PVCs in the namespace are provisioned using the remote cluster's default StorageClass. The local cluster sees the PVC as bound; the actual volume exists on the remote cluster.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: training-data
  namespace: batch-processing
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ""   # Empty = use remote cluster default
  resources:
    requests:
      storage: 100Gi
```

## liqoctl Reference

Common operations with `liqoctl`:

```bash
# View peering status for all clusters
liqotech status

# View detailed peer information
liqotech status peers

# View resource usage on virtual nodes
liqotech status consumers

# Unpeer from a remote cluster
liqotech unpeer out-of-band cluster-b

# Move a namespace back to local-only
liqotech unoffload namespace batch-processing

# Generate diagnostic report
liqotech debug info --output liqo-debug.tar.gz

# Check network connectivity between clusters
liqotech debug network cluster-b
```

## Production Use Cases

### Burst-to-Cloud Pattern

An on-premises cluster runs baseline workloads within its fixed node pool. When batch jobs or seasonal traffic spikes exceed on-premises capacity, Liqo offloads the overflow to a cloud cluster:

```yaml
# HPA-scaled deployment — spills to cloud when on-prem nodes are full
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
  namespace: production
spec:
  replicas: 5
  template:
    spec:
      # No affinity — scheduler places freely on local or virtual nodes
      tolerations:
        - key: liqo.io/remote-cluster
          operator: Exists
          effect: NoSchedule
      containers:
        - name: api
          image: registry.example.com/web/api:v3.0.0
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
```

As the HPA scales up and local nodes fill, the scheduler begins placing pods on the virtual node representing the cloud cluster.

### Multi-Region Disaster Recovery

Active cluster in `us-east-1` peers with a standby cluster in `eu-west-1`. Under normal operation, all traffic runs in `us-east-1`. During a regional failure, namespace offloading strategy shifts to `Remote`, draining workloads to `eu-west-1`:

```bash
# Normal operation
kubectl patch namespaceoffloading offloading -n production \
  --type merge \
  -p '{"spec":{"podOffloadingStrategy":"Local"}}'

# DR activation
kubectl patch namespaceoffloading offloading -n production \
  --type merge \
  -p '{"spec":{"podOffloadingStrategy":"Remote"}}'
```

## Monitoring

### Prometheus Integration

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: liqo-controller-manager
  namespace: liqo
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: controller-manager
      app.kubernetes.io/name: liqo
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Metrics

| Metric | Description |
|--------|-------------|
| `liqo_peering_established_total` | Number of established peerings |
| `liqo_offloaded_pods_total` | Pods currently running on remote clusters |
| `liqo_reflected_resources_total` | Total reflected resource objects |
| `liqo_network_latency_ms` | WireGuard tunnel latency between peers |
| `liqo_gateway_bytes_sent_total` | Bytes sent through the WAN fabric |
| `liqo_gateway_bytes_received_total` | Bytes received through the WAN fabric |

### Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: liqo-alerts
  namespace: liqo
spec:
  groups:
    - name: liqo.peering
      rules:
        - alert: LiqoPeeringDown
          expr: liqo_peering_established_total == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "No Liqo peerings are established — remote scheduling unavailable"

        - alert: LiqoNetworkHighLatency
          expr: liqo_network_latency_ms > 100
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "WAN fabric latency to {{ $labels.remote_cluster }} is {{ $value }}ms"

        - alert: LiqoVirtualNodeNotReady
          expr: kube_node_status_condition{node=~"liqo-.*",condition="Ready",status="true"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Liqo virtual node {{ $labels.node }} is not Ready"
```

## Comparison with Admiralty and Submariner

| Feature | Liqo | Admiralty | Submariner |
|---------|------|-----------|------------|
| **Primary goal** | Resource sharing via virtual nodes | Pod scheduling across clusters | Network connectivity only |
| **Virtual nodes** | Yes — full virtual kubelet | Yes — via `RemoteCluster` | No |
| **Network fabric** | WireGuard built-in | External (Submariner/Cilium) | WireGuard/IPSec |
| **Service discovery** | Reflected Services | Lighthouse DNS | Lighthouse DNS |
| **Namespace offloading** | Yes — `NamespaceOffloading` | Yes — `Target` CRD | No |
| **Storage offloading** | Yes | No | No |
| **Overlapping CIDR support** | Yes — IPAM remapping | Requires non-overlapping | Yes — NATTED |
| **Installation complexity** | Medium | Medium | Medium |
| **Maturity (2027)** | Stable, CNCF Sandbox | Stable, CNCF Sandbox | Stable, CNCF Incubating |
| **Best for** | Full workload federation | Scheduling-focused federation | Adding network fabric only |

**When to choose Liqo over Admiralty:** Liqo's built-in network fabric eliminates the need to deploy Submariner separately. For teams starting from scratch, Liqo provides a more complete out-of-box experience.

**When to choose Admiralty over Liqo:** Admiralty's scheduling model gives finer-grained control over cross-cluster pod placement via `MultiClusterScheduler` and delegated Pod policies. Teams that need precise scheduling semantics may prefer Admiralty.

**When to choose Submariner alone:** When clusters already share compute capacity via a different mechanism (e.g., workload federation or GitOps-based multi-cluster deployment) and the only missing piece is network connectivity.

## Troubleshooting

### Peering Not Establishing

```bash
# Check ForeignCluster status
kubectl get foreigncluster cluster-b -o yaml
# Look for conditions with status: "False"

# Check auth server accessibility
kubectl -n liqo logs -l app.kubernetes.io/component=auth --tail=50

# Verify gateway is reachable
kubectl -n liqo logs -l app.kubernetes.io/component=gateway --tail=50
```

### Pods Stuck in Pending on Virtual Node

```bash
# Check virtual node conditions
kubectl describe node liqo-cluster-b

# Check virtual kubelet logs
kubectl -n liqo logs -l app.kubernetes.io/component=virtual-kubelet --tail=100

# Verify namespace offloading is ready
kubectl get namespaceoffloading -n batch-processing offloading
```

### Network Connectivity Issues

```bash
# Run built-in network test
liqotech debug network cluster-b

# Check WireGuard tunnel status
kubectl -n liqo exec -it \
  $(kubectl -n liqo get pod -l app.kubernetes.io/component=gateway -o name | head -1) \
  -- wg show

# Check IPAM mapping
kubectl -n liqo get ipamstorages
```

## Resource Quota Enforcement Across Clusters

By default, resource quotas applied in the local cluster do not account for resources running on virtual nodes. Pods scheduled to remote clusters consume quota from the local namespace's ResourceQuota (the virtual kubelet reports the resource request back to the local API server), but the actual enforcement of limits happens in the remote cluster.

To prevent a single namespace from consuming unbounded remote capacity, apply resource quotas normally — the virtual node's reported capacity is bounded by what Liqo negotiates during peering:

```yaml
# During peering, limit how much capacity cluster-b shares with cluster-a
# Edit the ForeignCluster spec on cluster-b to limit offered resources
apiVersion: discovery.liqo.io/v1alpha1
kind: ForeignCluster
metadata:
  name: cluster-a
spec:
  # Restrict shared capacity to prevent cluster-a from consuming all of cluster-b
  resourceShare:
    cpu: "16"
    memory: 64Gi
```

The virtual node in cluster-a then reports only 16 CPUs and 64Gi memory, capping scheduler placement.

## Liqo with Helm-Based Multi-Cluster Deployments

For teams using Helm to deploy applications across clusters, Liqo's virtual nodes enable a single `helm install` to span multiple clusters:

```bash
# Deploy an application that will span local and remote nodes
helm install analytics-pipeline ./analytics \
  --namespace batch-processing \
  --set replicaCount=20 \
  --set tolerations[0].key=liqo.io/remote-cluster \
  --set tolerations[0].operator=Exists \
  --set tolerations[0].effect=NoSchedule

# Kubernetes scheduler places some replicas locally, overflow goes to liqo-cluster-b
kubectl -n batch-processing get pods -o wide \
  | awk '{print $7}' | sort | uniq -c
#  12 node-a-1
#   8 liqo-cluster-b
```

## Security Considerations

### Network Encryption

The WireGuard fabric encrypts all inter-cluster pod traffic. Verify the WireGuard session is active before trusting cross-cluster communication:

```bash
kubectl -n liqo exec -it \
  $(kubectl -n liqo get pod -l app.kubernetes.io/component=gateway -o name | head -1) \
  -- wg show all
# Verify: latest-handshake should be within the last 3 minutes for an active session
```

### RBAC for Virtual Kubelet

The virtual kubelet runs with a dedicated service account. Its permissions should be audited — it needs access to create/update/delete Pods and mirror resource types in the remote cluster:

```bash
# Review virtual kubelet RBAC on the remote cluster
kubectl config use-context cluster-b
kubectl get clusterrolebinding -l app.kubernetes.io/component=virtual-kubelet
kubectl describe clusterrole -l app.kubernetes.io/component=virtual-kubelet
```

Rotate the kubeconfig used by the virtual kubelet annually or whenever a cluster is re-created. The peering handshake generates the kubeconfig — a `liqotech unpeer` followed by `liqotech peer` regenerates it.

### Secret Reflection Scope

Secrets reflected to remote clusters cross a trust boundary. Disable secret reflection unless explicitly needed:

```yaml
# liqo-values.yaml
virtualKubelet:
  reflectors:
    secret:
      workers: 0    # Disable secret reflection
```

When secret reflection is needed (e.g., image pull secrets for remote pods), scope it tightly and document the data flow in your threat model.

Liqo provides a path to multi-cluster architectures that requires no application code changes. By presenting remote capacity as virtual nodes, it integrates with existing scheduling, RBAC, and monitoring tooling with minimal friction. For teams managing burst-to-cloud scenarios, multi-region DR, or federated batch compute, Liqo delivers transparency and operational simplicity that manual multi-cluster management cannot match.
