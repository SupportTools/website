---
title: "Kubernetes Cluster API: Declarative Cluster Lifecycle Management"
date: 2031-02-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "Infrastructure as Code", "GitOps", "Multi-Cluster"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes Cluster API covering management cluster architecture, provider implementations for AWS and vSphere, MachineDeployment rolling upgrades, cluster templates, and managing fleets of hundreds of clusters with GitOps."
more_link: "yes"
url: "/kubernetes-cluster-api-declarative-cluster-lifecycle-management/"
---

Cluster API (CAPI) brings the Kubernetes API model to the problem of managing Kubernetes clusters themselves. Instead of provisioning clusters with imperative scripts or proprietary tooling, CAPI lets you declare cluster topology as Kubernetes objects — and a management cluster reconciles those objects into running infrastructure.

This guide covers the complete CAPI operational model: standing up a management cluster, deploying workload clusters on AWS, performing rolling upgrades, and managing hundreds of clusters at scale with GitOps.

<!--more-->

# Kubernetes Cluster API: Declarative Cluster Lifecycle Management

## Section 1: Architecture Overview

CAPI introduces a two-tier model: the **management cluster** runs the CAPI controllers and manages **workload clusters** (the clusters that run your actual workloads).

### Core Objects

| Object | Purpose |
|---|---|
| `Cluster` | Top-level cluster spec (network config, control plane reference, infrastructure reference) |
| `Machine` | Represents one node (control plane or worker) |
| `MachineDeployment` | Rolling upgrade controller for a group of worker machines |
| `MachineSet` | Ensures N replicas of a Machine template (similar to ReplicaSet) |
| `KubeadmControlPlane` | Manages control plane nodes with kubeadm |
| `KubeadmConfigTemplate` | kubeadm bootstrap configuration for worker nodes |

### Provider Architecture

CAPI uses a provider plugin model:

- **Infrastructure providers**: `AWSCluster`, `AWSMachine`, `vSphereCluster`, `DockerCluster`, etc. Handle VM/instance creation.
- **Bootstrap providers**: `KubeadmConfig` generates cloud-init/user data to initialize nodes.
- **Control plane providers**: `KubeadmControlPlane` manages the control plane lifecycle.

```
Management Cluster
├── CAPI core controllers
├── Infrastructure Provider (CAPA for AWS)
├── Bootstrap Provider (CABPK for kubeadm)
└── Control Plane Provider (KCP)

                 reconciles
                    ↓
Workload Cluster
├── control plane nodes
└── worker nodes
```

## Section 2: Standing Up the Management Cluster

### Prerequisites

```bash
# Install clusterctl — the CAPI CLI
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.9.0/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

clusterctl version
# clusterctl version: &version.Info{Major:"1", Minor:"9"}

# Install kubectl if not present
# Install kind for the bootstrap cluster (or use an existing cluster)
curl -Lo /usr/local/bin/kind \
  https://kind.sigs.k8s.io/dl/v0.24.0/kind-linux-amd64
chmod +x /usr/local/bin/kind
```

### Create the Bootstrap Cluster (for initial management cluster)

```bash
# Use kind for the bootstrap cluster
kind create cluster --name capi-management --config - <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
      - containerPort: 443
        hostPort: 443
EOF

# Set kubeconfig context
kubectl config use-context kind-capi-management
```

### Initialize CAPI with AWS Provider

```bash
# Set AWS credentials (these will be stored in the management cluster as a Secret)
export AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="<aws-access-key-id>"
export AWS_SECRET_ACCESS_KEY="<aws-secret-access-key>"

# Encode credentials for CAPA
export AWS_B64ENCODED_CREDENTIALS=$(clusterctl generate credentials aws)

# Initialize CAPI with providers
clusterctl init \
  --infrastructure aws \
  --bootstrap kubeadm \
  --control-plane kubeadm

# Verify all providers are installed
clusterctl describe provider --all

# Check that controllers are running
kubectl get pods -n capi-system
kubectl get pods -n capa-system
kubectl get pods -n capi-kubeadm-bootstrap-system
kubectl get pods -n capi-kubeadm-control-plane-system
```

### Initialize for vSphere

```bash
# vSphere credentials
export VSPHERE_SERVER="vcenter.example.com"
export VSPHERE_USERNAME="administrator@vsphere.local"
export VSPHERE_PASSWORD="<vsphere-password>"
export VSPHERE_TLS_THUMBPRINT="AA:BB:CC:..."  # From vcenter cert

clusterctl init \
  --infrastructure vsphere \
  --bootstrap kubeadm \
  --control-plane kubeadm
```

## Section 3: Creating a Workload Cluster on AWS

### Generate Cluster YAML with clusterctl

```bash
# Set cluster configuration variables
export CLUSTER_NAME="production-us-east-1"
export KUBERNETES_VERSION="v1.31.0"
export AWS_REGION="us-east-1"

# Control plane configuration
export AWS_CONTROL_PLANE_MACHINE_TYPE="m5.xlarge"
export CONTROL_PLANE_MACHINE_COUNT=3

# Worker node configuration
export AWS_NODE_MACHINE_TYPE="m5.2xlarge"
export WORKER_MACHINE_COUNT=3

# Network configuration
export AWS_SSH_KEY_NAME="capi-cluster-key"
export AWS_VPC_CIDR="10.10.0.0/16"

# Generate the cluster manifest
clusterctl generate cluster "${CLUSTER_NAME}" \
  --kubernetes-version "${KUBERNETES_VERSION}" \
  --control-plane-machine-count "${CONTROL_PLANE_MACHINE_COUNT}" \
  --worker-machine-count "${WORKER_MACHINE_COUNT}" \
  --infrastructure aws \
  > "${CLUSTER_NAME}.yaml"
```

### Understanding the Generated Manifest

The generated YAML contains multiple objects. Here are the key ones with production annotations:

```yaml
# 1. AWSCluster — AWS-specific cluster configuration
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: production-us-east-1
  namespace: default
spec:
  region: us-east-1
  sshKeyName: capi-cluster-key

  # Network configuration
  network:
    vpc:
      cidrBlock: "10.10.0.0/16"
    subnets:
      - availabilityZone: us-east-1a
        cidrBlock: "10.10.0.0/24"
        isPublic: false
      - availabilityZone: us-east-1b
        cidrBlock: "10.10.1.0/24"
        isPublic: false
      - availabilityZone: us-east-1c
        cidrBlock: "10.10.2.0/24"
        isPublic: false
      - availabilityZone: us-east-1a
        cidrBlock: "10.10.10.0/24"
        isPublic: true
      - availabilityZone: us-east-1b
        cidrBlock: "10.10.11.0/24"
        isPublic: true
      - availabilityZone: us-east-1c
        cidrBlock: "10.10.12.0/24"
        isPublic: true

  # IAM configuration
  identityRef:
    kind: AWSClusterRoleIdentity
    name: capi-role-identity

  # Load balancer configuration for API server
  controlPlaneLoadBalancer:
    loadBalancerType: nlb
    scheme: internet-facing
---
# 2. Cluster — the core CAPI cluster object
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: production-us-east-1
  namespace: default
  labels:
    environment: production
    region: us-east-1
    team: platform
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
        - "192.168.0.0/16"
    services:
      cidrBlocks:
        - "10.96.0.0/12"
    serviceDomain: cluster.local

  # Reference to the AWSCluster object
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: production-us-east-1
    namespace: default

  # Reference to the control plane object
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: production-us-east-1-control-plane
    namespace: default
---
# 3. KubeadmControlPlane — manages the 3 control plane nodes
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: production-us-east-1-control-plane
  namespace: default
spec:
  # Exact Kubernetes version for this cluster
  version: v1.31.0

  # Number of control plane replicas (use 3 or 5)
  replicas: 3

  # Reference to the AWS machine template for control plane nodes
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSMachineTemplate
      name: production-us-east-1-control-plane
      namespace: default

  # kubeadm configuration for control plane nodes
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external

    clusterConfiguration:
      apiServer:
        extraArgs:
          cloud-provider: external
          audit-log-path: /var/log/audit.log
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "100"
        extraVolumes:
          - name: audit-log
            hostPath: /var/log
            mountPath: /var/log
            readOnly: false
            pathType: DirectoryOrCreate
      etcd:
        local:
          dataDir: /var/lib/etcddisk/etcd
      controllerManager:
        extraArgs:
          cloud-provider: external

    joinConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external

    # Additional files to place on the node
    files:
      - path: /etc/kubernetes/audit-policy.yaml
        owner: root:root
        permissions: "0600"
        content: |
          apiVersion: audit.k8s.io/v1
          kind: Policy
          rules:
            - level: Metadata
              resources:
                - group: ""
                  resources: ["secrets", "configmaps"]
            - level: RequestResponse
              users: ["system:serviceaccount:kube-system:*"]
            - level: None
              resources:
                - group: ""
                  resources: ["events"]
            - level: Metadata

  # Rollout strategy for upgrades
  rolloutStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
---
# 4. AWSMachineTemplate for control plane
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-us-east-1-control-plane
  namespace: default
spec:
  template:
    spec:
      instanceType: m5.xlarge
      iamInstanceProfile: control-plane.cluster-api-provider-aws.sigs.k8s.io

      rootVolume:
        size: 100
        type: gp3
        iops: 3000

      additionalTags:
        Environment: production
        ManagedBy: cluster-api

      # Spot configuration (not recommended for control plane)
      # spotMarketOptions:
      #   maxPrice: "0.20"
---
# 5. MachineDeployment — manages worker nodes
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: production-us-east-1-workers
  namespace: default
  labels:
    cluster.x-k8s.io/cluster-name: production-us-east-1
spec:
  clusterName: production-us-east-1
  replicas: 3

  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: production-us-east-1

  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: production-us-east-1

    spec:
      version: v1.31.0

      clusterName: production-us-east-1

      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: production-us-east-1-workers
          namespace: default

      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-us-east-1-workers
        namespace: default

  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
---
# 6. AWSMachineTemplate for worker nodes
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-us-east-1-workers
  namespace: default
spec:
  template:
    spec:
      instanceType: m5.2xlarge
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io

      rootVolume:
        size: 100
        type: gp3
        iops: 3000
        throughput: 125

      additionalTags:
        Environment: production
        ManagedBy: cluster-api
        NodeRole: worker

      # Use spot instances for workers
      spotMarketOptions: {}  # Use default spot pricing
---
# 7. KubeadmConfigTemplate for workers
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: production-us-east-1-workers
  namespace: default
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          name: "{{ ds.meta_data.local_hostname }}"
          kubeletExtraArgs:
            cloud-provider: external
            node-labels: "environment=production,node-role=worker"
      preKubeadmCommands:
        - systemctl enable containerd
        - systemctl start containerd
```

### Applying the Cluster

```bash
# Apply all objects
kubectl apply -f production-us-east-1.yaml

# Watch the cluster come up
clusterctl describe cluster production-us-east-1

# Get the kubeconfig for the workload cluster
clusterctl get kubeconfig production-us-east-1 > ~/.kube/production-us-east-1.kubeconfig

# Access the workload cluster
kubectl --kubeconfig ~/.kube/production-us-east-1.kubeconfig get nodes
```

## Section 4: MachineDeployment Rolling Upgrades

When you update the `version` field in a `MachineDeployment`, CAPI performs a rolling replacement of nodes:

1. Creates a new `MachineSet` with the new configuration.
2. Scales up the new `MachineSet` by `maxSurge`.
3. Scales down the old `MachineSet` by `maxUnavailable`.
4. Repeats until all old machines are replaced.

### Performing a Kubernetes Minor Version Upgrade

```bash
# Current state
kubectl get cluster production-us-east-1 -o jsonpath='{.spec.topology.version}'
# v1.30.0

# Step 1: Upgrade the control plane
kubectl patch kubeadmcontrolplane production-us-east-1-control-plane \
  --type=merge \
  -p '{"spec":{"version":"v1.31.0"}}'

# Watch the control plane upgrade progress
watch -n 5 "kubectl get kubeadmcontrolplane production-us-east-1-control-plane -o jsonpath='{.status}' | jq ."

# The KubeadmControlPlane controller will:
# 1. Scale up by one (maxSurge=1), launching a new control plane node with v1.31.0
# 2. Wait for the new node to become Ready
# 3. Remove one old control plane node
# 4. Repeat until all 3 control plane nodes are upgraded

# Step 2: Upgrade workers (after control plane upgrade is complete)
kubectl patch machinedeployment production-us-east-1-workers \
  --type=merge \
  -p '{"spec":{"template":{"spec":{"version":"v1.31.0"}}}}'

# Monitor worker upgrade
kubectl get machinedeployment production-us-east-1-workers -w
```

### Upgrading Node AMI/Image

To update the base AMI without changing the Kubernetes version, update the `AWSMachineTemplate`:

```bash
# IMPORTANT: AWSMachineTemplate is immutable — create a new one with a new name
cat > workers-v2.yaml <<'EOF'
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-us-east-1-workers-v2
  namespace: default
spec:
  template:
    spec:
      instanceType: m5.2xlarge
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
      ami:
        id: ami-0987654321fedcba  # New AMI ID
      rootVolume:
        size: 100
        type: gp3
        iops: 3000
EOF

kubectl apply -f workers-v2.yaml

# Update the MachineDeployment to reference the new template
kubectl patch machinedeployment production-us-east-1-workers \
  --type=merge \
  -p '{"spec":{"template":{"spec":{"infrastructureRef":{"name":"production-us-east-1-workers-v2"}}}}}'
```

## Section 5: ClusterClass — Templated Cluster Definitions

`ClusterClass` (topology API) defines a cluster template that can be instantiated multiple times with different parameters. This is the CAPI feature that enables fleet management at scale.

### Defining a ClusterClass

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: enterprise-standard
  namespace: default
spec:
  # Control plane template
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: enterprise-standard-control-plane
      namespace: default
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: enterprise-standard-control-plane
        namespace: default

  # Infrastructure template
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: enterprise-standard
      namespace: default

  # Worker node topologies
  workers:
    machineDeployments:
      - class: default-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: enterprise-standard-worker
              namespace: default
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: enterprise-standard-worker
              namespace: default

      - class: spot-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: enterprise-standard-worker-spot
              namespace: default
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: enterprise-standard-worker-spot
              namespace: default

  # Variables that can be customized per cluster
  variables:
    - name: region
      required: true
      schema:
        openAPIV3Schema:
          type: string
          enum: ["us-east-1", "us-west-2", "eu-west-1"]

    - name: controlPlaneInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: m5.xlarge

    - name: workerInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: m5.2xlarge

    - name: additionalTags
      required: false
      schema:
        openAPIV3Schema:
          type: object
          additionalProperties:
            type: string

  # Patches apply variable values to templates
  patches:
    - name: region
      definitions:
        - selector:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
            kind: AWSClusterTemplate
            matchResources:
              infrastructureCluster: true
          jsonPatches:
            - op: replace
              path: /spec/template/spec/region
              valueFrom:
                variable: region

    - name: controlPlaneInstanceType
      definitions:
        - selector:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
            kind: AWSMachineTemplate
            matchResources:
              controlPlane: true
          jsonPatches:
            - op: replace
              path: /spec/template/spec/instanceType
              valueFrom:
                variable: controlPlaneInstanceType
```

### Instantiating a Cluster from ClusterClass

```yaml
# Simple cluster definition using the ClusterClass
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: team-alpha-production
  namespace: default
  labels:
    team: alpha
    environment: production
spec:
  topology:
    class: enterprise-standard
    version: v1.31.0

    # Variable overrides
    variables:
      - name: region
        value: us-east-1
      - name: controlPlaneInstanceType
        value: m5.2xlarge
      - name: workerInstanceType
        value: m5.4xlarge

    controlPlane:
      replicas: 3

    workers:
      machineDeployments:
        - name: workers
          class: default-worker
          replicas: 5

        - name: spot-workers
          class: spot-worker
          replicas: 10
```

## Section 6: Multi-Cluster Management with GitOps

### Repository Structure

```
gitops-clusters/
├── clusters/
│   ├── production/
│   │   ├── us-east-1/
│   │   │   ├── cluster.yaml
│   │   │   └── addons/
│   │   │       ├── cilium.yaml
│   │   │       ├── cert-manager.yaml
│   │   │       └── prometheus-stack.yaml
│   │   └── us-west-2/
│   │       ├── cluster.yaml
│   │       └── addons/
│   └── staging/
│       └── us-east-1/
│           ├── cluster.yaml
│           └── addons/
├── cluster-classes/
│   ├── enterprise-standard.yaml
│   └── ml-workloads.yaml
└── templates/
    └── aws-machine-templates/
        ├── control-plane-m5-xlarge.yaml
        └── worker-m5-2xlarge.yaml
```

### ArgoCD for Cluster Lifecycle Management

```yaml
# ArgoCD Application managing all CAPI cluster definitions
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: capi-clusters
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/company/gitops-clusters
    targetRevision: main
    path: clusters
    directory:
      recurse: true
      jsonnet: {}

  destination:
    server: https://kubernetes.default.svc  # Management cluster
    namespace: default

  syncPolicy:
    automated:
      prune: false   # Never auto-delete clusters
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true

  # Ignore differences in dynamic fields
  ignoreDifferences:
    - group: cluster.x-k8s.io
      kind: Cluster
      jsonPointers:
        - /status
    - group: infrastructure.cluster.x-k8s.io
      kind: AWSCluster
      jsonPointers:
        - /status
```

### Fleet Status Dashboard Script

```bash
#!/bin/bash
# fleet-status.sh — show status of all clusters managed by CAPI

echo "=== CAPI Fleet Status ==="
echo "Management Cluster: $(kubectl config current-context)"
echo "Generated: $(date)"
echo ""

# Header
printf "%-40s %-10s %-10s %-15s %-15s\n" \
  "CLUSTER" "PHASE" "CPREADY" "WORKERS" "AGE"
echo "$(printf '=%.0s' {1..95})"

# List all clusters
kubectl get clusters --all-namespaces -o json | jq -r '
  .items[] |
  [
    (.metadata.namespace + "/" + .metadata.name),
    (.status.phase // "Unknown"),
    ((.status.controlPlaneReady // false) | tostring),
    (
      (.status.conditions[]? |
        select(.type == "MachinesReady") |
        .message // "unknown"
      ) // "unknown"
    ),
    (
      now - (.metadata.creationTimestamp | fromdateiso8601) |
      if . < 3600 then "\(. | floor)s"
      elif . < 86400 then "\(. / 3600 | floor)h"
      else "\(. / 86400 | floor)d"
      end
    )
  ] | @tsv
' | while IFS=$'\t' read -r name phase cpready workers age; do
    # Color coding
    if [ "$phase" = "Provisioned" ]; then
        color="\033[0;32m"  # Green
    elif [ "$phase" = "Provisioning" ]; then
        color="\033[0;33m"  # Yellow
    else
        color="\033[0;31m"  # Red
    fi
    printf "${color}%-40s %-10s %-10s %-15s %-15s\033[0m\n" \
        "$name" "$phase" "$cpready" "$workers" "$age"
done

echo ""
echo "Machine summary:"
kubectl get machines --all-namespaces -o json | jq -r '
  group_by(.status.phase) |
  .[] |
  "\(.[0].status.phase // "Unknown"): \(length)"
'
```

## Section 7: Cluster Addons Management

After a workload cluster is provisioned, you need to install CNI, CSI, monitoring, and other addons. The standard approach is to use Cluster Addons or separate ArgoCD Applications per workload cluster.

### Bootstrapping Addons with ClusterResourceSet

```yaml
# ClusterResourceSet applies resources to all matching clusters
apiVersion: addons.cluster.x-k8s.io/v1beta1
kind: ClusterResourceSet
metadata:
  name: cilium-cni
  namespace: default
spec:
  # Apply to all production clusters
  clusterSelector:
    matchLabels:
      environment: production

  resources:
    - name: cilium-install
      kind: ConfigMap

  # Strategy: ApplyOnce or Reconcile
  strategy: Reconcile
---
# The ConfigMap contains the Helm values or manifests to apply
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-install
  namespace: default
data:
  cilium-helmrelease.yaml: |
    apiVersion: helm.toolkit.fluxcd.io/v2
    kind: HelmRelease
    metadata:
      name: cilium
      namespace: kube-system
    spec:
      interval: 1h
      chart:
        spec:
          chart: cilium
          version: "1.16.x"
          sourceRef:
            kind: HelmRepository
            name: cilium
            namespace: flux-system
      values:
        kubeProxyReplacement: true
        k8sServiceHost: "$(KUBERNETES_SERVICE_HOST)"
        k8sServicePort: "$(KUBERNETES_SERVICE_PORT)"
        hubble:
          relay:
            enabled: true
          ui:
            enabled: true
```

### Flux for Per-Cluster Addon Reconciliation

A common pattern uses Flux to manage addons for each workload cluster:

```yaml
# Template: creates a Flux GitOps stack in each workload cluster
apiVersion: v1
kind: Secret
metadata:
  name: production-us-east-1-kubeconfig
  namespace: flux-system
  labels:
    cluster: production-us-east-1
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: production-us-east-1-addons
  namespace: flux-system
spec:
  interval: 10m
  path: ./clusters/production/us-east-1/addons
  prune: true
  sourceRef:
    kind: GitRepository
    name: gitops-clusters
  kubeConfig:
    secretRef:
      name: production-us-east-1-kubeconfig
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: cilium-operator
      namespace: kube-system
    - apiVersion: apps/v1
      kind: Deployment
      name: cert-manager
      namespace: cert-manager
```

## Section 8: Machine Health Checks

CAPI can automatically replace unhealthy machines:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: production-us-east-1-worker-health
  namespace: default
spec:
  clusterName: production-us-east-1

  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: production-us-east-1-workers

  # Unhealthy conditions — trigger remediation when true for the specified duration
  unhealthyConditions:
    - type: Ready
      status: "False"
      timeout: 5m

    - type: Ready
      status: Unknown
      timeout: 10m

    # Node-specific conditions
    - type: MemoryPressure
      status: "True"
      timeout: 2m

    - type: DiskPressure
      status: "True"
      timeout: 2m

  # Maximum number of unhealthy machines to remediate simultaneously
  maxUnhealthy: "33%"

  # NodeStartupTimeout — if a node doesn't join within this time, remediate
  nodeStartupTimeout: 20m
```

## Section 9: Scaling and Cost Management

### Horizontal Scaling of Worker Nodes

```bash
# Scale a MachineDeployment
kubectl scale machinedeployment production-us-east-1-workers --replicas=10

# Or patch directly
kubectl patch machinedeployment production-us-east-1-workers \
  --type=merge \
  -p '{"spec":{"replicas":10}}'

# Watch machines provision
kubectl get machines -l cluster.x-k8s.io/cluster-name=production-us-east-1 -w
```

### Cluster Deletion

```bash
# Delete a workload cluster — this deletes all cloud resources
kubectl delete cluster production-us-east-1

# Watch teardown (takes 5-10 minutes for AWS)
kubectl get cluster production-us-east-1 -w

# Or delete all clusters in a namespace
kubectl delete clusters --all -n staging
```

## Section 10: Troubleshooting CAPI

### Debug Commands

```bash
# Check all CAPI objects for a cluster
clusterctl describe cluster production-us-east-1 --show-conditions all

# Check controller logs
kubectl logs -n capi-system -l control-plane=controller-manager \
  --since=30m | grep -E "ERROR|error|failed"

# Check AWS provider logs
kubectl logs -n capa-system -l control-plane=capa-controller-manager \
  --since=30m | grep -E "ERROR|error|failed"

# Check individual machine status
kubectl get machine -o json | jq '
  .items[] |
  select(.metadata.labels["cluster.x-k8s.io/cluster-name"] == "production-us-east-1") |
  {
    name: .metadata.name,
    phase: .status.phase,
    ready: .status.ready,
    instanceID: .spec.providerID,
    conditions: [.status.conditions[] | {type: .type, status: .status, reason: .reason}]
  }
'

# Check if the bootstrap secret was generated
kubectl get secret -l cluster.x-k8s.io/cluster-name=production-us-east-1 | grep bootstrap

# Check AWSCluster errors
kubectl describe awscluster production-us-east-1 | grep -A 10 Events

# Common errors and fixes:
# "failed to assume role" — IAM credentials or role trust policy issue
# "subnet not found" — VPC/subnet tags missing
# "EC2 capacity exceeded" — switch instance type or AZ
# "quota exceeded" — request AWS limit increase
```

## Summary

Cluster API transforms cluster lifecycle from an imperative, scripted process to a declarative, reconciliation-based system. Key operational principles:

- **ClusterClass** is the primary scaling primitive — define once, instantiate hundreds of times with variable overrides.
- **MachineDeployment** rolling updates are the safe way to upgrade Kubernetes versions or AMIs — never replace nodes manually.
- **MachineHealthCheck** provides automatic self-healing when nodes fail.
- **GitOps** (ArgoCD + Flux) is the natural complement to CAPI — cluster definitions in Git, addons in Git, changes via PR.
- The management cluster is critical infrastructure — run it on a dedicated, highly-available cluster separate from any workload clusters it manages.
- Namespace-per-cluster in the management cluster keeps objects organized at scale.

For organizations managing 50+ clusters, CAPI with ClusterClass eliminates the per-cluster operational burden and creates a consistent, auditable path for infrastructure changes across the entire fleet.
