---
title: "Kubernetes Cluster Federation: KubeFed and Multicluster API"
date: 2029-10-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Federation", "KubeFed", "Multi-Cluster", "sig-multicluster", "Platform Engineering"]
categories: ["Kubernetes", "Multi-Cluster", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth guide to KubeFed architecture, FederatedDeployment, placement and override policies, the sig-multicluster Multicluster API, and when to use federation versus alternatives."
more_link: "yes"
url: "/kubernetes-cluster-federation-kubefed-multicluster-api/"
---

Running workloads across multiple Kubernetes clusters requires a way to express "deploy this to these clusters with these variations." Kubernetes Federation attempts to provide that declarative interface above the cluster boundary. The story has evolved significantly: the original Federation v1 was deprecated, KubeFed (v2) addressed its architectural problems, and the SIG Multicluster working group is now producing a new set of APIs that will eventually supersede KubeFed. Understanding all three stages tells you where the community is going and how to build systems that age well.

<!--more-->

# Kubernetes Cluster Federation: KubeFed and Multicluster API

## Section 1: Why Federation Is Hard

Kubernetes itself solved the problem of scheduling workloads across many nodes in a single cluster. The control plane has full visibility into every node, every pod, and every resource. When you scale to multiple clusters, you lose that unified view.

The fundamental problems federation must solve:

1. **Distribution**: How does a workload described once get applied to N clusters?
2. **Differentiation**: Cluster A runs in us-east with 5 replicas; cluster B runs in eu-west with 3 replicas. How are these differences expressed?
3. **Consistency**: If cluster A's deployment drifts from the federated spec, who wins?
4. **Status aggregation**: How do you know the total number of running replicas across all clusters?
5. **Failure isolation**: A control plane failure must not cascade to workloads already running in member clusters.

## Section 2: KubeFed Architecture

KubeFed runs as a set of controllers in a designated "host" cluster. Member clusters are registered with the federation control plane. The host cluster holds the federated resource definitions; the member clusters receive the resultant single-cluster resources.

### Core Components

```
Host Cluster
├── kubefed-controller-manager (Deployment)
│   ├── FederatedTypeConfig controller
│   ├── Sync controller (per federated type)
│   └── Status controller (per federated type)
├── Federated CRDs (installed by kubefedctl init)
│   ├── FederatedDeployment
│   ├── FederatedService
│   ├── FederatedConfigMap
│   └── ... (one per federatable type)
└── KubeFed API resources
    ├── KubeFedCluster (member cluster registrations)
    ├── FederatedTypeConfig (which types to federate)
    └── ReplicaSchedulingPreference

Member Cluster A          Member Cluster B
└── Deployment (synced)   └── Deployment (synced)
    Service (synced)          Service (synced)
```

### Installing KubeFed

```bash
# Add the KubeFed Helm repository
helm repo add kubefed-charts https://raw.githubusercontent.com/kubernetes-sigs/kubefed/master/charts
helm repo update

# Install KubeFed in the host cluster
kubectl config use-context host-cluster
helm install kubefed kubefed-charts/kubefed \
    --namespace kube-federation-system \
    --create-namespace \
    --set controllermanager.replicaCount=2

# Verify controller is running
kubectl -n kube-federation-system get pods
# NAME                                          READY   STATUS
# kubefed-controller-manager-84c5d69fb5-xxx    1/1     Running
```

### Joining Member Clusters

```bash
# Join cluster-a
kubefedctl join cluster-a \
    --cluster-context=cluster-a \
    --host-cluster-context=host-cluster \
    --v=2

# Join cluster-b
kubefedctl join cluster-b \
    --cluster-context=cluster-b \
    --host-cluster-context=host-cluster \
    --v=2

# Verify cluster membership
kubectl -n kube-federation-system get kubefedclusters
# NAME        AGE    READY
# cluster-a   10s    True
# cluster-b   8s     True
```

The `kubefedctl join` command creates a `KubeFedCluster` resource in the host cluster and a service account + RBAC configuration in the member cluster. The controller manager uses this service account's token to connect to the member cluster's API server.

## Section 3: Federated Types and FederatedTypeConfig

Not every Kubernetes resource type is automatically federated. You enable federation for a type by creating a `FederatedTypeConfig`.

```bash
# List currently enabled federated types
kubectl get federatedtypeconfigs -n kube-federation-system

# Enable federation for Deployments (usually already enabled)
kubefedctl enable deployments.apps --host-cluster-context=host-cluster

# This creates both the FederatedTypeConfig and the CRD for FederatedDeployment
kubectl get crd | grep federated
# federateddeployments.types.kubefed.io
# federatedservices.types.kubefed.io
# federatedconfigmaps.types.kubefed.io
```

### FederatedTypeConfig Structure

```yaml
apiVersion: core.kubefed.io/v1beta1
kind: FederatedTypeConfig
metadata:
  name: deployments.apps
  namespace: kube-federation-system
spec:
  federatedType:
    group: types.kubefed.io
    kind: FederatedDeployment
    pluralName: federateddeployments
    scope: Namespaced
    version: v1beta1
  propagation: Enabled
  statusCollection: Enabled    # Aggregate status from member clusters
  statusType:
    group: types.kubefed.io
    kind: FederatedDeploymentStatus
    pluralName: federateddeploymentstatuses
    scope: Namespaced
    version: v1beta1
  targetType:
    group: apps
    kind: Deployment
    pluralName: deployments
    scope: Namespaced
    version: v1
```

## Section 4: FederatedDeployment with Placement Policies

A `FederatedDeployment` has three sections: `template` (the base spec), `placement` (which clusters), and `overrides` (per-cluster differences).

### Basic FederatedDeployment

```yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedDeployment
metadata:
  name: frontend
  namespace: production
spec:
  template:
    metadata:
      labels:
        app: frontend
        version: "1.24.0"
    spec:
      replicas: 3
      selector:
        matchLabels:
          app: frontend
      template:
        metadata:
          labels:
            app: frontend
        spec:
          containers:
            - name: frontend
              image: myregistry.example.com/frontend:1.24.0
              ports:
                - containerPort: 8080
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                limits:
                  cpu: 500m
                  memory: 512Mi
              readinessProbe:
                httpGet:
                  path: /health
                  port: 8080
                initialDelaySeconds: 5
                periodSeconds: 10
  placement:
    clusters:
      - name: cluster-a
      - name: cluster-b
```

### Cluster Selector Placement

Instead of listing clusters by name, use label selectors to target clusters dynamically:

```yaml
spec:
  placement:
    clusterSelector:
      matchLabels:
        region: us-east
        tier: production
```

Label your clusters:

```bash
kubectl label kubefedcluster cluster-a region=us-east tier=production \
    -n kube-federation-system
kubectl label kubefedcluster cluster-b region=eu-west tier=production \
    -n kube-federation-system
kubectl label kubefedcluster cluster-dev region=us-east tier=development \
    -n kube-federation-system
```

With `matchLabels: {region: us-east, tier: production}`, only `cluster-a` receives the deployment. `cluster-dev` is excluded because it has `tier=development`.

## Section 5: Override Policies

Overrides allow per-cluster customization of the template. Common uses include different replica counts, different resource limits, different image registries, and environment-specific environment variables.

### Simple Override (Replica Count)

```yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedDeployment
metadata:
  name: frontend
  namespace: production
spec:
  template:
    spec:
      replicas: 3  # Default
  placement:
    clusters:
      - name: cluster-a
      - name: cluster-b
  overrides:
    - clusterName: cluster-a
      clusterOverrides:
        - path: "/spec/replicas"
          value: 5     # cluster-a gets more capacity
    - clusterName: cluster-b
      clusterOverrides:
        - path: "/spec/replicas"
          value: 2     # cluster-b is smaller
```

### Multi-Field Override

```yaml
overrides:
  - clusterName: cluster-b
    clusterOverrides:
      # Different replica count
      - path: "/spec/replicas"
        value: 2
      # Different image registry (eu mirror)
      - path: "/spec/template/spec/containers/0/image"
        value: "eu.myregistry.example.com/frontend:1.24.0"
      # Add a cluster-specific env var
      - path: "/spec/template/spec/containers/0/env"
        op: add
        value:
          - name: REGION
            value: "eu-west-1"
          - name: LOG_LEVEL
            value: "warn"
      # Different resource limits for a smaller cluster
      - path: "/spec/template/spec/containers/0/resources/limits/memory"
        value: "256Mi"
```

Override paths use JSON Pointer syntax (RFC 6901). The `op` field supports `add`, `remove`, and `replace` (default is replace).

## Section 6: ReplicaSchedulingPreference

`ReplicaSchedulingPreference` (RSP) enables dynamic replica distribution based on cluster weights and capacity. The KubeFed scheduler watches cluster health and redistributes replicas automatically.

```yaml
apiVersion: scheduling.kubefed.io/v1alpha1
kind: ReplicaSchedulingPreference
metadata:
  name: frontend
  namespace: production
spec:
  targetKind: FederatedDeployment
  totalReplicas: 10
  clusters:
    cluster-a:
      weight: 3         # cluster-a gets 3/5 = 60% of replicas
      minReplicas: 2    # Never scale below 2 in this cluster
      maxReplicas: 8    # Never scale above 8 in this cluster
    cluster-b:
      weight: 2         # cluster-b gets 2/5 = 40% of replicas
      minReplicas: 1
      maxReplicas: 6
```

With `totalReplicas: 10` and the weights above:
- cluster-a: 10 × (3/5) = 6 replicas
- cluster-b: 10 × (2/5) = 4 replicas

If cluster-b becomes unhealthy and KubeFed detects it, it redistributes the 4 replicas to cluster-a (up to `maxReplicas: 8`).

### RSP with Overflow to Backup Cluster

```yaml
spec:
  totalReplicas: 20
  rebalance: true   # Rebalance when cluster health changes
  clusters:
    cluster-primary:
      weight: 1
      minReplicas: 10
      maxReplicas: 20
    cluster-secondary:
      weight: 0        # Normally receives no traffic
      minReplicas: 0
      maxReplicas: 10  # Can absorb up to 10 overflow replicas
```

## Section 7: Status Aggregation

KubeFed aggregates status from all member clusters back into the federated resource. This gives you a single pane of glass for cross-cluster resource status.

```bash
# Check aggregated status of a FederatedDeployment
kubectl get federateddeployment frontend -n production -o yaml
```

```yaml
status:
  conditions:
    - lastTransitionTime: "2029-10-19T10:00:00Z"
      lastUpdateTime: "2029-10-19T10:00:00Z"
      status: "True"
      type: Propagation
  clusters:
    - cluster: cluster-a
      status:
        availableReplicas: 5
        observedGeneration: 3
        readyReplicas: 5
        replicas: 5
        updatedReplicas: 5
    - cluster: cluster-b
      status:
        availableReplicas: 2
        observedGeneration: 3
        readyReplicas: 2
        replicas: 2
        updatedReplicas: 2
  observedGeneration: 3
```

## Section 8: The SIG Multicluster API (Next Generation)

The SIG Multicluster working group has been developing a new set of APIs that are more opinionated and production-hardened than KubeFed. The key APIs are:

### ClusterSet and ServiceExport/ServiceImport

These APIs (part of the MCS — Multi-Cluster Services — specification, KEP-1645) provide service discovery across clusters without requiring a full federation control plane.

```yaml
# In cluster-a: export the checkout service
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: checkout
  namespace: store
```

```yaml
# In cluster-b: import the checkout service
# This object is created automatically by the MCS controller
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: checkout
  namespace: store
spec:
  type: ClusterSetIP     # Virtual IP accessible within the ClusterSet
  ports:
    - port: 8080
      protocol: TCP
  ips:
    - "10.96.100.50"     # Assigned by MCS controller
```

The DNS name for a `ServiceImport` is `<service>.<namespace>.svc.clusterset.local`, allowing applications to use a consistent hostname regardless of which cluster they run in.

### WorkloadEntry and WorkloadGroup

```yaml
# Register a non-Kubernetes workload (VM, bare metal) with the mesh
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: WorkloadEntry
metadata:
  name: legacy-payments-vm-1
  namespace: payments
spec:
  address: "10.5.0.100"
  labels:
    app: payments
    instance-id: vm-prod-01
  serviceAccountName: payments
```

### About Policy

```yaml
# ClusterSet-wide policy that applies across all member clusters
apiVersion: policy.multicluster.x-k8s.io/v1alpha1
kind: ClusterSetNetworkPolicy
metadata:
  name: restrict-cross-cluster-egress
spec:
  clusterSetSelector:
    matchLabels:
      environment: production
  rules:
    - from:
        - namespaceSelector:
            matchLabels:
              purpose: frontend
      to:
        - namespaceSelector:
            matchLabels:
              purpose: api
```

## Section 9: KubeFed vs Multicluster API vs Alternatives

### Decision Matrix

| Factor | KubeFed | MCS API | ArgoCD | Crossplane |
|---|---|---|---|---|
| Maturity | Stable (maintained) | Alpha/Beta | Stable | Stable |
| Scope | Full resource federation | Service discovery | GitOps deployment | Infrastructure provisioning |
| Central control plane | Required | Optional | Required | Optional |
| Override complexity | High (JSON Patch) | N/A | Kustomize/Helm | Compositions |
| Status aggregation | Yes | No (per-cluster) | Yes (App of Apps) | Limited |
| Replica balancing | RSP | No | No | No |
| Community momentum | Declining | Growing | Very active | Active |

### When to Use KubeFed

KubeFed is appropriate when you need:
- Dynamic replica distribution based on cluster capacity
- A single resource representation for N-cluster deployments
- Status aggregation back to a central control plane
- Complex override logic that cannot be expressed in Helm/Kustomize

### When to Use the MCS API

MCS (ServiceExport/ServiceImport) is appropriate when you need:
- Cross-cluster service discovery without federating all resources
- A lightweight approach that works alongside GitOps tools
- Eventual compatibility with the official Kubernetes API

### When to Avoid Federation

For most teams managing fewer than 10 clusters, GitOps with ArgoCD or Flux using an "App of Apps" or `ApplicationSet` pattern is simpler, more debuggable, and better supported. Federation adds a centralized control plane that can become a single point of failure or a source of surprising behavior.

## Section 10: Operational Considerations

### Controller Health Monitoring

```bash
# Check controller manager health
kubectl -n kube-federation-system get pods -o wide
kubectl -n kube-federation-system logs -l control-plane=controller-manager

# Watch for propagation errors
kubectl -n kube-federation-system get events --field-selector reason=PropagationError

# Check cluster connectivity
kubectl describe kubefedcluster cluster-a -n kube-federation-system
# Status.Conditions should show Ready=True

# Check reconciliation queue depth (via metrics)
kubectl port-forward -n kube-federation-system svc/kubefed-controller-manager-metrics 8080
curl http://localhost:8080/metrics | grep kubefed_controller_
```

### Handling Member Cluster Unavailability

When a member cluster becomes unreachable, KubeFed's default behavior is to stop propagating changes to that cluster but not to remove resources that were already propagated. This is the safe default — removing resources because the control plane lost connectivity would cause an outage.

```yaml
# Configure retention policy per FederatedTypeConfig
apiVersion: core.kubefed.io/v1beta1
kind: FederatedTypeConfig
metadata:
  name: deployments.apps
spec:
  propagation: Enabled
  # Optional: controls what happens when cluster is unreachable
  retainReplicasOnClusterChange: true
```

### Migrating Off KubeFed

Given KubeFed's declining community momentum, plan your migration path:

1. Adopt `ServiceExport/ServiceImport` for cross-cluster service discovery.
2. Move workload distribution to ArgoCD `ApplicationSet` with cluster generators.
3. Use Kustomize overlays for per-cluster customization rather than KubeFed override JSON patches.
4. Keep KubeFed only for the `ReplicaSchedulingPreference` functionality until a replacement emerges.

Federation remains one of the harder problems in the Kubernetes ecosystem. The architecture has matured significantly from v1 to KubeFed to the SIG Multicluster APIs, but the right answer for most organizations is a composition of simpler tools rather than a monolithic federation control plane.
