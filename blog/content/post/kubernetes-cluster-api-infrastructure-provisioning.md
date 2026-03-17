---
title: "Kubernetes Cluster API: Infrastructure Provisioning as Kubernetes Resources"
date: 2029-05-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "Infrastructure", "AWS", "Azure", "vSphere", "GitOps"]
categories: ["Kubernetes", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes Cluster API (CAPI): architecture overview, bootstrap and infrastructure providers, MachineDeployments, ClusterClass templating for standardized clusters, and production deployments on AWS, Azure, and vSphere using declarative infrastructure-as-Kubernetes-resources."
more_link: "yes"
url: "/kubernetes-cluster-api-infrastructure-provisioning/"
---

Cluster API (CAPI) represents a paradigm shift in how Kubernetes clusters are provisioned and managed: instead of custom scripts, Terraform modules, or cloud-specific CLIs, you use Kubernetes custom resources in a management cluster to declaratively define and reconcile workload clusters. The result is cluster lifecycle management that is GitOps-compatible, self-healing, and provider-agnostic. This post covers the complete CAPI architecture, provider ecosystem, MachineDeployment scaling, and ClusterClass templates that enable organizations to provision standardized clusters at scale.

<!--more-->

# Kubernetes Cluster API: Infrastructure Provisioning as Kubernetes Resources

## Section 1: CAPI Architecture

Cluster API introduces a hierarchical cluster model:

```
Management Cluster (runs CAPI controllers)
├── Cluster (workload cluster spec)
│   ├── KubeadmControlPlane (control plane config)
│   │   └── Machine (one per control plane node)
│   ├── MachineDeployment (worker node group)
│   │   └── MachineSet (scaling group)
│   │       └── Machine (one per worker node)
│   ├── [Infrastructure Provider] AWSCluster / AzureCluster / etc.
│   └── [Bootstrap Provider] KubeadmConfig
└── ClusterClass (template for standardized clusters)
```

### Core Resources

| Resource | Scope | Purpose |
|----------|-------|---------|
| Cluster | Namespaced | Top-level cluster spec |
| Machine | Namespaced | Individual node |
| MachineSet | Namespaced | Scaling group of identical machines |
| MachineDeployment | Namespaced | Rolling update for MachineSets |
| MachineHealthCheck | Namespaced | Automated unhealthy node remediation |
| ClusterClass | Namespaced | Template for cluster topology |

### Provider Types

- **Bootstrap Provider**: How nodes are bootstrapped (default: kubeadm)
- **Control Plane Provider**: Control plane lifecycle (default: KubeadmControlPlane)
- **Infrastructure Provider**: Cloud/hypervisor-specific resources (AWS, Azure, GCP, vSphere, etc.)
- **IPAM Provider**: IP address management

## Section 2: Installing the Management Cluster

### Prerequisites

```bash
# Install clusterctl
CLUSTERCTL_VERSION="v1.7.3"
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/${CLUSTERCTL_VERSION}/clusterctl-linux-amd64 \
  -o clusterctl
chmod +x clusterctl
sudo mv clusterctl /usr/local/bin/

clusterctl version

# Install kind for local management cluster
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.23.0/kind-linux-amd64
chmod +x kind
sudo mv kind /usr/local/bin/

# Create management cluster
kind create cluster --name capi-management \
  --config - <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  extraMounts:
  - hostPath: /var/run/docker.sock
    containerPath: /var/run/docker.sock
EOF

# Verify
kubectl cluster-info --context kind-capi-management
```

### Initialize CAPI with Providers

```bash
# Initialize management cluster with AWS provider
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID="<your-key-id>"
export AWS_SECRET_ACCESS_KEY="<your-secret-key>"
export AWS_SESSION_TOKEN=""  # If using temporary credentials

# EKS support (optional)
export EXP_EKS_IAM=true
export EXP_EKS_ADD_ROLES=true
export EXP_MACHINE_POOL=true

# Initialize
clusterctl init \
  --infrastructure aws \
  --bootstrap kubeadm \
  --control-plane kubeadm \
  --config ~/.cluster-api/clusterctl.yaml

# Or with multiple providers
clusterctl init \
  --infrastructure aws:v2.5.0,vsphere:v1.9.0 \
  --bootstrap kubeadm:v1.7.3 \
  --control-plane kubeadm:v1.7.3

# Verify installation
kubectl get pods -n capi-system
kubectl get pods -n capa-system  # AWS provider
kubectl get providers -A
```

### clusterctl Configuration File

```yaml
# ~/.cluster-api/clusterctl.yaml
providers:
  - name: "aws"
    url: "https://github.com/kubernetes-sigs/cluster-api-provider-aws/releases/latest/infrastructure-components.yaml"
    type: "InfrastructureProvider"
  - name: "azure"
    url: "https://github.com/kubernetes-sigs/cluster-api-provider-azure/releases/latest/infrastructure-components.yaml"
    type: "InfrastructureProvider"
  - name: "vsphere"
    url: "https://github.com/kubernetes-sigs/cluster-api-provider-vsphere/releases/latest/infrastructure-components.yaml"
    type: "InfrastructureProvider"

images:
  cluster-api:
    repository: "registry.k8s.io/cluster-api"
```

## Section 3: AWS Provider (CAPA) — Provisioning a Cluster

### IAM Setup

```bash
# Install clusterawsadm (manages IAM roles)
curl -L https://github.com/kubernetes-sigs/cluster-api-provider-aws/releases/latest/download/clusterawsadm-linux-amd64 \
  -o clusterawsadm
chmod +x clusterawsadm
sudo mv clusterawsadm /usr/local/bin/

# Bootstrap IAM (creates required roles/policies)
clusterawsadm bootstrap iam create-cloudformation-stack \
  --config bootstrap-config.yaml

# Export credentials as CAPA expects them
export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)
```

### AWS Cluster Manifest

```yaml
# aws-cluster.yaml — Complete cluster definition
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: production-cluster-1
  namespace: clusters
  labels:
    environment: production
    region: us-east-1
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
      - 192.168.0.0/16
    services:
      cidrBlocks:
      - 10.128.0.0/12
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: production-cluster-1
  controlPlaneRef:
    kind: KubeadmControlPlane
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    name: production-cluster-1-control-plane
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: production-cluster-1
  namespace: clusters
spec:
  region: us-east-1
  sshKeyName: my-ssh-key
  # Use existing VPC (recommended for production)
  network:
    vpc:
      id: vpc-0abc123
      cidrBlock: 10.0.0.0/16
    subnets:
    - id: subnet-0abc111
      availabilityZone: us-east-1a
      isPublic: false
    - id: subnet-0abc222
      availabilityZone: us-east-1b
      isPublic: false
    - id: subnet-0abc333
      availabilityZone: us-east-1c
      isPublic: false
  # Or let CAPA create the VPC:
  # network:
  #   vpc:
  #     cidrBlock: 10.0.0.0/16
  #   subnets:
  #   - availabilityZone: us-east-1a
  #     cidrBlock: 10.0.1.0/24
  #     isPublic: false
  bastion:
    enabled: false
  # AWS Load Balancer for API server
  controlPlaneLoadBalancer:
    loadBalancerType: nlb
    scheme: internet-facing  # or internal
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: production-cluster-1-control-plane
  namespace: clusters
spec:
  replicas: 3  # HA control plane
  version: v1.30.4
  machineTemplate:
    infrastructureRef:
      kind: AWSMachineTemplate
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      name: production-cluster-1-control-plane
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        name: '{{ ds.meta_data.local_hostname }}'
        kubeletExtraArgs:
          cloud-provider: aws
    clusterConfiguration:
      apiServer:
        extraArgs:
          cloud-provider: aws
          audit-log-path: /var/log/kubernetes/apiserver/audit.log
          audit-policy-file: /etc/kubernetes/audit-policy.yaml
          audit-log-maxage: "30"
          audit-log-maxbackup: "5"
          audit-log-maxsize: "100"
      controllerManager:
        extraArgs:
          cloud-provider: aws
    joinConfiguration:
      nodeRegistration:
        name: '{{ ds.meta_data.local_hostname }}'
        kubeletExtraArgs:
          cloud-provider: aws
    # Additional files to create on each node
    files:
    - path: /etc/kubernetes/audit-policy.yaml
      content: |
        apiVersion: audit.k8s.io/v1
        kind: Policy
        rules:
        - level: RequestResponse
          resources:
          - group: ""
            resources: ["secrets"]
        - level: Metadata
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-cluster-1-control-plane
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m5.xlarge
      iamInstanceProfile: control-plane.cluster-api-provider-aws.sigs.k8s.io
      ami:
        id: ami-0abc123456789  # CAPI-compatible AMI
      rootVolume:
        size: 100
        type: gp3
        iops: 3000
      additionalSecurityGroups:
      - id: sg-0abc123
      sshKeyName: my-ssh-key
      spotMarketOptions: null  # On-demand for control plane
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: production-cluster-1-workers
  namespace: clusters
  labels:
    cluster.x-k8s.io/cluster-name: production-cluster-1
spec:
  clusterName: production-cluster-1
  replicas: 5
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: production-cluster-1
      cluster.x-k8s.io/deployment-name: production-cluster-1-workers
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: production-cluster-1
        cluster.x-k8s.io/deployment-name: production-cluster-1-workers
    spec:
      clusterName: production-cluster-1
      version: v1.30.4
      bootstrap:
        configRef:
          name: production-cluster-1-worker-config
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
      infrastructureRef:
        name: production-cluster-1-worker
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
  # Rolling update strategy
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-cluster-1-worker
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m5.2xlarge
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
      ami:
        id: ami-0abc123456789
      rootVolume:
        size: 100
        type: gp3
      spotMarketOptions:
        maxPrice: ""  # Use spot instances for workers (empty = on-demand price)
---
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: production-cluster-1-worker-config
  namespace: clusters
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          name: '{{ ds.meta_data.local_hostname }}'
          kubeletExtraArgs:
            cloud-provider: aws
            node-labels: "topology.kubernetes.io/zone={{ ds.meta_data.placement.availability-zone }}"
```

### Deploying and Monitoring

```bash
# Create the namespace for clusters
kubectl create namespace clusters

# Apply the cluster manifest
kubectl apply -f aws-cluster.yaml

# Watch the cluster come up
watch kubectl get cluster,kubeadmcontrolplane,machinedeployment,machine -n clusters

# Detailed view
clusterctl describe cluster production-cluster-1 -n clusters

# Get kubeconfig for the new cluster
clusterctl get kubeconfig production-cluster-1 -n clusters > production-cluster-1.kubeconfig

# Verify the new cluster
kubectl --kubeconfig production-cluster-1.kubeconfig get nodes
```

## Section 4: MachineDeployments — Scaling and Rolling Updates

### Scaling Worker Nodes

```bash
# Scale up
kubectl scale machinedeployment production-cluster-1-workers \
  --replicas=10 -n clusters

# Scale down
kubectl scale machinedeployment production-cluster-1-workers \
  --replicas=3 -n clusters

# Annotate to pause reconciliation (for maintenance)
kubectl annotate machinedeployment production-cluster-1-workers \
  cluster.x-k8s.io/paused="" -n clusters

# Resume
kubectl annotate machinedeployment production-cluster-1-workers \
  cluster.x-k8s.io/paused- -n clusters
```

### Rolling Update for Kubernetes Version Upgrade

```bash
# Trigger rolling update by changing the version
# First update control plane
kubectl patch kubeadmcontrolplane production-cluster-1-control-plane \
  -n clusters \
  --type=merge \
  --patch='{"spec":{"version":"v1.31.0"}}'

# Wait for control plane upgrade
kubectl rollout status kubeadmcontrolplane/production-cluster-1-control-plane \
  -n clusters

# Then update workers
kubectl patch machinedeployment production-cluster-1-workers \
  -n clusters \
  --type=merge \
  --patch='{"spec":{"template":{"spec":{"version":"v1.31.0"}}}}'

# Watch the rolling update
watch kubectl get machine -n clusters -l cluster.x-k8s.io/cluster-name=production-cluster-1
```

### Multiple Machine Deployments for Node Pools

```yaml
# General purpose workers
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: workers-general
  namespace: clusters
spec:
  replicas: 5
  template:
    spec:
      bootstrap:
        configRef:
          name: worker-bootstrap-config
          kind: KubeadmConfigTemplate
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
      infrastructureRef:
        name: workers-general-template
        kind: AWSMachineTemplate
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
---
# GPU workers for ML workloads
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: workers-gpu
  namespace: clusters
spec:
  replicas: 2
  template:
    metadata:
      labels:
        node-type: gpu
    spec:
      bootstrap:
        configRef:
          name: worker-gpu-bootstrap-config
          kind: KubeadmConfigTemplate
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
      infrastructureRef:
        name: workers-gpu-template
        kind: AWSMachineTemplate
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: workers-gpu-template
  namespace: clusters
spec:
  template:
    spec:
      instanceType: p3.8xlarge  # GPU instance
      ami:
        id: ami-gpu-drivers-installed
```

### MachineHealthCheck for Automated Remediation

```yaml
# Automatically replace unhealthy nodes
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: production-cluster-1-mhc
  namespace: clusters
spec:
  clusterName: production-cluster-1
  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: production-cluster-1-workers
  # Unhealthy conditions
  unhealthyConditions:
  - type: Ready
    status: Unknown
    timeout: 300s  # Node not reporting for 5 minutes
  - type: Ready
    status: "False"
    timeout: 300s  # Node not ready for 5 minutes
  # Maximum number of machines allowed to be concurrently remediated
  maxUnhealthy: 33%  # Don't remediate if >1/3 are unhealthy (cluster-wide issue)
  # How long to wait between remediation attempts
  nodeStartupTimeout: 10m
```

## Section 5: ClusterClass — Templated Cluster Topology

ClusterClass allows defining a cluster template once and using it to stamp out multiple clusters. This is the recommended pattern for organizations managing many clusters.

### Defining a ClusterClass

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: production-aws-v1
  namespace: clusters
spec:
  # Control plane template
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: production-aws-v1-control-plane
    machineInfrastructure:
      ref:
        kind: AWSMachineTemplate
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        name: production-aws-v1-control-plane-machine
  # Infrastructure provider template
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: production-aws-v1
  # Worker node groups
  workers:
    machineDeployments:
    - class: default-worker
      template:
        bootstrap:
          ref:
            apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
            kind: KubeadmConfigTemplate
            name: production-aws-v1-worker
        infrastructure:
          ref:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
            kind: AWSMachineTemplate
            name: production-aws-v1-worker
    - class: gpu-worker
      template:
        bootstrap:
          ref:
            apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
            kind: KubeadmConfigTemplate
            name: production-aws-v1-worker
        infrastructure:
          ref:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
            kind: AWSMachineTemplate
            name: production-aws-v1-gpu-worker
  # Variables that can be overridden per cluster
  variables:
  - name: region
    required: true
    schema:
      openAPIV3Schema:
        type: string
        enum: ["us-east-1", "us-west-2", "eu-west-1"]
  - name: workerInstanceType
    required: false
    schema:
      openAPIV3Schema:
        type: string
        default: "m5.xlarge"
  - name: controlPlaneReplicas
    required: false
    schema:
      openAPIV3Schema:
        type: integer
        default: 3
        enum: [1, 3, 5]
  # Patches applied based on variables
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
  - name: workerInstanceType
    definitions:
    - selector:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        matchResources:
          machineDeploymentClass:
            names:
            - default-worker
      jsonPatches:
      - op: replace
        path: /spec/template/spec/instanceType
        valueFrom:
          variable: workerInstanceType
```

### Creating a Cluster from a ClusterClass

```yaml
# Topology-based cluster (uses ClusterClass)
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: team-alpha-cluster
  namespace: clusters
  labels:
    team: alpha
    environment: staging
spec:
  topology:
    class: production-aws-v1
    version: v1.30.4
    # Variable overrides
    variables:
    - name: region
      value: us-east-1
    - name: workerInstanceType
      value: m5.2xlarge
    - name: controlPlaneReplicas
      value: 3
    # Control plane configuration
    controlPlane:
      replicas: 3
      metadata:
        annotations:
          cluster.x-k8s.io/paused: ""  # Start paused
    # Worker group configuration
    workers:
      machineDeployments:
      - class: default-worker
        name: workers
        replicas: 5
        variables:
          overrides:
          - name: workerInstanceType
            value: m5.4xlarge  # Override just for this deployment
      - class: gpu-worker
        name: gpu-workers
        replicas: 2
```

```bash
# Create multiple clusters from the same class
for team in alpha beta gamma; do
  cat <<EOF | kubectl apply -f -
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: team-${team}-cluster
  namespace: clusters
spec:
  topology:
    class: production-aws-v1
    version: v1.30.4
    variables:
    - name: region
      value: us-east-1
    controlPlane:
      replicas: 1  # Single node for dev/staging
    workers:
      machineDeployments:
      - class: default-worker
        name: workers
        replicas: 3
EOF
done

# Watch all clusters
watch kubectl get clusters -n clusters
```

## Section 6: vSphere Provider (CAPV)

For on-premises deployments:

```yaml
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: VSphereCluster
metadata:
  name: vsphere-cluster-1
  namespace: clusters
spec:
  server: vcenter.corp.example.com
  thumbprint: "AA:BB:CC:DD:EE:FF:..."  # vCenter TLS thumbprint
  controlPlaneEndpoint:
    host: 192.168.1.100  # Virtual IP for control plane
    port: 6443
  identityRef:
    kind: Secret
    name: vsphere-credentials
---
apiVersion: v1
kind: Secret
metadata:
  name: vsphere-credentials
  namespace: clusters
type: Opaque
stringData:
  username: administrator@vsphere.local
  password: <vsphere-password>
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: VSphereMachineTemplate
metadata:
  name: vsphere-control-plane
  namespace: clusters
spec:
  template:
    spec:
      server: vcenter.corp.example.com
      thumbprint: "AA:BB:CC:DD:EE:FF:..."
      datacenter: DC1
      datastore: /DC1/datastore/SSD-Storage
      folder: /DC1/vm/kubernetes
      network:
        devices:
        - dhcp4: false
          ipAddrs:
          - 192.168.1.10/24  # Static IPs for control plane
          gateway4: 192.168.1.1
          nameservers:
          - 10.100.0.10
          networkName: VM-Network
      resourcePool: /DC1/host/Cluster1/Resources/kubernetes
      numCPUs: 4
      numCoresPerSocket: 2
      memoryMiB: 8192
      diskGiB: 80
      template: ubuntu-2204-kube-v1.30.4  # VM template
      cloneMode: linkedClone  # Full/LinkedClone
```

## Section 7: GitOps Integration with Fleet Management

### ArgoCD Application for Cluster Management

```yaml
# ArgoCD ApplicationSet to manage all CAPI clusters
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: capi-clusters
  namespace: argocd
spec:
  generators:
  - git:
      repoURL: https://github.com/myorg/cluster-definitions.git
      revision: HEAD
      directories:
      - path: clusters/production/*
  template:
    metadata:
      name: '{{path.basename}}'
      namespace: argocd
    spec:
      project: cluster-management
      source:
        repoURL: https://github.com/myorg/cluster-definitions.git
        targetRevision: HEAD
        path: '{{path}}'
      destination:
        server: https://kubernetes.default.svc
        namespace: clusters
      syncPolicy:
        automated:
          prune: false   # Don't auto-delete clusters
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
```

### Repository Structure

```
cluster-definitions/
├── clusters/
│   ├── production/
│   │   ├── us-east-1/
│   │   │   ├── cluster.yaml           # Cluster CR
│   │   │   ├── machine-deployments.yaml
│   │   │   └── health-checks.yaml
│   │   └── eu-west-1/
│   │       ├── cluster.yaml
│   │       └── machine-deployments.yaml
│   └── staging/
│       └── us-east-1/
│           └── cluster.yaml
├── cluster-classes/
│   ├── production-aws-v1.yaml
│   └── production-vsphere-v1.yaml
└── common/
    ├── aws-machine-templates.yaml
    └── kubeadm-configs.yaml
```

## Section 8: Day-2 Operations

### Monitoring Cluster Health

```bash
# Overall fleet status
clusterctl describe cluster --all-namespaces

# Check all clusters
kubectl get cluster -A
# NAME                    PHASE         AGE    VERSION
# production-cluster-1    Provisioned   7d     v1.30.4
# team-alpha-cluster      Provisioned   3d     v1.30.4
# team-beta-cluster       Provisioning  15m    v1.31.0

# Check machine health
kubectl get machine -A
# Shows individual node provisioning status

# Get events for a cluster
kubectl describe cluster production-cluster-1 -n clusters | grep -A20 Events:
```

### Cluster Deletion

```bash
# Delete a cluster (removes all machines and infrastructure)
kubectl delete cluster production-cluster-1 -n clusters

# Watch deletion
watch kubectl get cluster,machine,awscluster -n clusters

# Emergency: Force delete if controllers are stuck
# First remove finalizers on the infrastructure resources
kubectl patch awscluster production-cluster-1 -n clusters \
  --type=json \
  -p='[{"op":"remove","path":"/metadata/finalizers"}]'
```

### Backup the Management Cluster

```bash
# Backup all CAPI resources
kubectl get clusters,machinedeployments,machines,kubeadmcontrolplanes \
  -A -o yaml > capi-backup-$(date +%Y%m%d).yaml

# Export kubeconfigs for all workload clusters
for cluster in $(kubectl get cluster -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'); do
  ns=$(echo $cluster | cut -d/ -f1)
  name=$(echo $cluster | cut -d/ -f2)
  clusterctl get kubeconfig "$name" -n "$ns" > "${name}.kubeconfig"
  echo "Exported: ${name}.kubeconfig"
done
```

Cluster API transforms cluster lifecycle from an operational burden into a declarative system. The ClusterClass pattern is particularly powerful for organizations with multiple teams — each team can provision their own cluster with standardized configurations, while the platform team controls the ClusterClass definitions in Git. Combined with GitOps (ArgoCD/Flux), every cluster definition lives in version control with full audit history, rollback capability, and drift detection.
