---
title: "Cluster API: Declarative Kubernetes Cluster Management at Scale"
date: 2028-03-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "CAPA", "CAPD", "Platform Engineering", "Multi-Cloud", "GitOps"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Cluster API (CAPI) for declarative Kubernetes cluster lifecycle management, covering management clusters, CAPD local development, CAPA on AWS, ClusterClass templates, GitOps-driven operations, and multi-cloud fleet management."
more_link: "yes"
url: "/kubernetes-cluster-api-management-guide/"
---

Cluster API (CAPI) applies the Kubernetes operator pattern to cluster lifecycle management itself. Instead of imperative scripts and cloud console clicks, entire clusters—their control planes, node groups, and infrastructure—are described as Kubernetes custom resources. The same reconciliation loop that keeps Deployments healthy applies to cluster infrastructure: drift is corrected, machine failures are remediated, and upgrades happen through a rolling replacement strategy.

This guide covers the CAPI architecture, local development with CAPD (Docker provider), production deployment on AWS with CAPA, ClusterClass for standardized fleet templates, GitOps-driven cluster lifecycle, and multi-cloud patterns.

<!--more-->

## CAPI Architecture

```
Management Cluster (permanent control plane cluster)
  ├── CAPI Core — reconciles Cluster, Machine, MachineSet, MachineDeployment
  ├── Bootstrap Provider (CABPK/CABPA) — generates cloud-init for node bootstrap
  ├── Infrastructure Provider — creates cloud VMs, VPCs, security groups
  │   ├── CAPA — AWS
  │   ├── CAPG — GCP
  │   ├── CAPM — Azure
  │   ├── CAPV — VMware vSphere
  │   └── CAPD — Docker (local dev)
  └── Control Plane Provider (KCP) — manages etcd/kube-apiserver lifecycle

Workload Clusters (created and managed by CAPI)
  ├── Control plane nodes (managed by KubeadmControlPlane)
  └── Worker nodes (managed by MachineDeployments)
```

### Core CRD Hierarchy

```
Cluster
  ├── InfrastructureCluster (AWSCluster, GCPCluster, etc.)
  ├── ControlPlane (KubeadmControlPlane)
  │   └── Machine → InfrastructureMachine → AWSMachine
  └── MachineDeployment
      └── MachineSet
          └── Machine → InfrastructureMachine → AWSMachine
```

## Local Development with CAPD

CAPD runs Kubernetes clusters inside Docker containers, useful for CAPI development and CI validation:

```bash
# Prerequisites
# - Docker Desktop or Docker Engine
# - kubectl, kind, clusterctl

# Install clusterctl CLI
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.7.0/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Create management cluster using kind
cat > kind-management-cluster.yaml <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: /var/run/docker.sock
        containerPath: /var/run/docker.sock
EOF

kind create cluster --name capi-management --config kind-management-cluster.yaml
export KUBECONFIG=$(kind get kubeconfig-path --name capi-management)

# Initialize management cluster with Docker provider
export CLUSTER_TOPOLOGY=true
clusterctl init --infrastructure docker

# Verify providers installed
clusterctl describe cluster
kubectl get pods -n capi-system
kubectl get pods -n capd-system
```

### CAPD Workload Cluster Definition

```yaml
# docker-workload-cluster.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: dev-cluster-01
  namespace: default
spec:
  clusterNetwork:
    services:
      cidrBlocks: ["10.128.0.0/12"]
    pods:
      cidrBlocks: ["192.168.0.0/16"]
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: DockerCluster
    name: dev-cluster-01
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: dev-cluster-01-control-plane

---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DockerCluster
metadata:
  name: dev-cluster-01
  namespace: default

---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: dev-cluster-01-control-plane
  namespace: default
spec:
  replicas: 1
  version: v1.29.2
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
      kind: DockerMachineTemplate
      name: dev-cluster-01-control-plane
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        criSocket: unix:///var/run/containerd/containerd.sock
        kubeletExtraArgs:
          eviction-hard: gcePersistentDisk.resource.storage=0%,imagefs.available=0%,memory.available=0%,nodefs.available=0%,nodefs.inodesFree=0%
          fail-swap-on: "false"
    clusterConfiguration:
      controllerManager:
        extraArgs:
          enable-hostpath-provisioner: "true"
    joinConfiguration:
      nodeRegistration:
        criSocket: unix:///var/run/containerd/containerd.sock
        kubeletExtraArgs:
          eviction-hard: gcePersistentDisk.resource.storage=0%,imagefs.available=0%,memory.available=0%,nodefs.available=0%,nodefs.inodesFree=0%
          fail-swap-on: "false"

---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DockerMachineTemplate
metadata:
  name: dev-cluster-01-control-plane
  namespace: default
spec:
  template:
    spec:
      extraMounts:
        - hostPath: /var/run/docker.sock
          containerPath: /var/run/docker.sock

---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: dev-cluster-01-workers
  namespace: default
spec:
  clusterName: dev-cluster-01
  replicas: 2
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: dev-cluster-01
      cluster.x-k8s.io/deployment-name: dev-cluster-01-workers
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: dev-cluster-01
        cluster.x-k8s.io/deployment-name: dev-cluster-01-workers
    spec:
      clusterName: dev-cluster-01
      version: v1.29.2
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: dev-cluster-01-workers
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: DockerMachineTemplate
        name: dev-cluster-01-workers
```

```bash
# Apply and watch cluster creation
kubectl apply -f docker-workload-cluster.yaml
clusterctl describe cluster dev-cluster-01 -n default

# Get workload cluster kubeconfig
clusterctl get kubeconfig dev-cluster-01 -n default > dev-cluster-01.kubeconfig
kubectl --kubeconfig dev-cluster-01.kubeconfig get nodes

# Install CNI (required before nodes become Ready)
kubectl --kubeconfig dev-cluster-01.kubeconfig apply \
  -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/calico.yaml
```

## Production AWS Cluster with CAPA

```bash
# Initialize CAPA provider
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=<from-vault>
export AWS_SECRET_ACCESS_KEY=<from-vault>

# Bootstrap IAM resources (creates ClusterAPI IAM user/role/policies)
clusterawsadm bootstrap iam create-cloudformation-stack

# Encode credentials for CAPA
export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)

# Initialize management cluster with AWS provider
clusterctl init --infrastructure aws \
  --config ~/.cluster-api/clusterctl.yaml
```

### AWSCluster Definition

```yaml
# aws-production-cluster.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: prod-us-east-1
  namespace: clusters
  labels:
    environment: production
    region: us-east-1
    cluster.x-k8s.io/cluster-name: prod-us-east-1
spec:
  clusterNetwork:
    pods:
      cidrBlocks: ["10.244.0.0/16"]
    services:
      cidrBlocks: ["10.96.0.0/12"]
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: prod-us-east-1
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: prod-us-east-1-control-plane

---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: prod-us-east-1
  namespace: clusters
spec:
  region: us-east-1
  sshKeyName: production-keypair
  # VPC configuration
  network:
    vpc:
      cidrBlock: "10.0.0.0/16"
      availabilityZoneUsageLimit: 3
      availabilityZoneSelection: Ordered
    subnets:
      - availabilityZone: us-east-1a
        cidrBlock: "10.0.0.0/24"
        isPublic: false
        tags:
          Name: prod-private-1a
      - availabilityZone: us-east-1b
        cidrBlock: "10.0.1.0/24"
        isPublic: false
        tags:
          Name: prod-private-1b
      - availabilityZone: us-east-1c
        cidrBlock: "10.0.2.0/24"
        isPublic: false
        tags:
          Name: prod-private-1c
    cni:
      cniIngressRules:
        - description: bgp
          protocol: tcp
          fromPort: 179
          toPort: 179
  # Control plane load balancer
  controlPlaneLoadBalancer:
    loadBalancerType: nlb
    scheme: internet-facing
  # IRSA configuration
  identityRef:
    kind: AWSClusterRoleIdentity
    name: production-identity

---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: prod-us-east-1-control-plane
  namespace: clusters
spec:
  replicas: 3
  version: v1.29.2
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSMachineTemplate
      name: prod-us-east-1-control-plane
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external
          node-ip: "{{ ds.meta_data.local_ipv4 }}"
    clusterConfiguration:
      apiServer:
        extraArgs:
          cloud-provider: external
          enable-admission-plugins: "NodeRestriction,PodSecurity"
          audit-log-path: /var/log/audit.log
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "100"
      controllerManager:
        extraArgs:
          cloud-provider: external
      etcd:
        local:
          dataDir: /var/lib/etcddisk/etcd
          extraArgs:
            quota-backend-bytes: "8589934592"  # 8GB etcd quota
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
                  resources: ["secrets"]
            - level: RequestResponse
              resources:
                - group: "rbac.authorization.k8s.io"
                  resources: ["clusterroles", "clusterrolebindings"]
            - level: None
              users: ["system:kube-proxy"]
              verbs: ["watch"]
              resources:
                - group: ""
                  resources: ["endpoints", "services"]
    joinConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external
          node-ip: "{{ ds.meta_data.local_ipv4 }}"

---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: prod-us-east-1-control-plane
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m6i.2xlarge
      iamInstanceProfile: control-plane.cluster-api-provider-aws.sigs.k8s.io
      ami:
        lookupType: Query
        os: ubuntu-20.04
        version: 1.29.2
      rootVolume:
        size: 80
        type: gp3
        iops: 3000
        throughput: 125
      nonRootVolumes:
        - deviceName: /dev/sdb
          size: 100
          type: gp3
          iops: 3000
      additionalSecurityGroups:
        - id: sg-control-plane-additional
      publicIP: false
```

## ClusterClass: Standardized Cluster Templates

ClusterClass enables defining a cluster topology once and instantiating it multiple times with variable substitution:

```yaml
# cluster-class-production.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: production-aws
  namespace: clusters
spec:
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: production-aws-cp-template
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-aws-cp-machine

  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: production-aws-cluster

  workers:
    machineDeployments:
      - class: general
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: production-aws-worker-bootstrap
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: production-aws-worker-machine
      - class: gpu
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: production-aws-gpu-bootstrap
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: production-aws-gpu-machine

  # Variables allow per-cluster customization
  variables:
    - name: region
      required: true
      schema:
        openAPIV3Schema:
          type: string
          enum: ["us-east-1", "eu-west-1", "ap-southeast-1"]
    - name: kubernetesVersion
      required: true
      schema:
        openAPIV3Schema:
          type: string
          example: "v1.29.2"
    - name: controlPlaneInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: "m6i.2xlarge"
    - name: workerInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: "m6i.4xlarge"

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
    - name: kubernetesVersion
      definitions:
        - selector:
            apiVersion: controlplane.cluster.x-k8s.io/v1beta1
            kind: KubeadmControlPlaneTemplate
            matchResources:
              controlPlane: true
          jsonPatches:
            - op: replace
              path: /spec/template/spec/version
              valueFrom:
                variable: kubernetesVersion
```

### Instantiating from ClusterClass

```yaml
# production-cluster-us-east-1.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: prod-us-east-1
  namespace: clusters
spec:
  topology:
    class: production-aws
    version: v1.29.2
    variables:
      - name: region
        value: "us-east-1"
      - name: kubernetesVersion
        value: "v1.29.2"
      - name: controlPlaneInstanceType
        value: "m6i.4xlarge"
    controlPlane:
      replicas: 3
      metadata:
        labels:
          cluster-role: control-plane
    workers:
      machineDeployments:
        - class: general
          name: general-workers
          replicas: 6
          metadata:
            labels:
              node-pool: general
        - class: gpu
          name: gpu-workers
          replicas: 2
          metadata:
            labels:
              node-pool: gpu
```

## GitOps-Driven Cluster Lifecycle

```
git/clusters/
  ├── base/
  │   └── clusterclass-production-aws.yaml
  ├── prod-us-east-1/
  │   ├── cluster.yaml
  │   ├── addons/
  │   │   ├── calico.yaml
  │   │   ├── cert-manager.yaml
  │   │   └── metrics-server.yaml
  │   └── kustomization.yaml
  └── prod-eu-west-1/
      ├── cluster.yaml
      ├── addons/
      └── kustomization.yaml
```

```yaml
# Argo CD ApplicationSet targeting all cluster directories
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: clusters
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/support-tools/clusters.git
        revision: HEAD
        directories:
          - path: "prod-*"
  template:
    metadata:
      name: "cluster-{{path.basenameNormalized}}"
      namespace: argocd
    spec:
      project: platform-ops
      source:
        repoURL: https://github.com/support-tools/clusters.git
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: clusters
      syncPolicy:
        automated:
          prune: false  # Never auto-delete cluster objects
          selfHeal: true
```

## Cluster Upgrade Automation

```bash
# Upgrade control plane
kubectl patch kcp prod-us-east-1-control-plane \
  -n clusters \
  --type=merge \
  -p '{"spec": {"version": "v1.30.0"}}'

# Watch rolling upgrade
kubectl get machines -n clusters -w

# Upgrade worker nodes via MachineDeployment
kubectl patch machinedeployment prod-us-east-1-general-workers \
  -n clusters \
  --type=merge \
  -p '{"spec": {"template": {"spec": {"version": "v1.30.0"}}}}'

# Monitor upgrade status
clusterctl describe cluster prod-us-east-1 -n clusters
```

### Automated Upgrade via ClusterClass

```yaml
# Trigger cluster-wide upgrade by updating the topology version
kubectl patch cluster prod-us-east-1 -n clusters \
  --type=merge \
  -p '{"spec": {"topology": {"version": "v1.30.0"}}}'

# CAPI orchestrates:
# 1. Control plane KCP rolling upgrade (one node at a time)
# 2. Worker MachineDeployment rolling upgrade (respecting maxSurge/maxUnavailable)
# 3. Machine health checks throughout
```

## Machine Health Checks

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: prod-us-east-1-worker-health
  namespace: clusters
spec:
  clusterName: prod-us-east-1
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: prod-us-east-1
      node-pool: general
  # Remediate machines that are unhealthy for more than 5 minutes
  unhealthyConditions:
    - type: Ready
      status: Unknown
      timeout: 5m
    - type: Ready
      status: "False"
      timeout: 5m
    - type: MemoryPressure
      status: "True"
      timeout: 10m
    - type: DiskPressure
      status: "True"
      timeout: 10m
  # Maximum machines to remediate simultaneously
  maxUnhealthy: "33%"
  nodeStartupTimeout: 10m
```

## Production Checklist

```
Management Cluster
[ ] Management cluster runs on dedicated, highly available infrastructure
[ ] Management cluster etcd backed up regularly (Velero or snapshot)
[ ] clusterctl version pinned and upgrade tested in lower environment
[ ] CAPI component versions tested together before production upgrade

Cluster Provisioning
[ ] ClusterClass used for all production clusters (no ad-hoc cluster CRDs)
[ ] Variables validated via OpenAPI schema in ClusterClass spec
[ ] AWSCluster networking reviewed (VPC CIDR, subnet allocation)
[ ] IAM roles scoped to minimum required permissions

Lifecycle Management
[ ] MachineHealthChecks deployed for all MachineDeployments
[ ] Upgrade procedure documented and tested in staging
[ ] etcd quota-backend-bytes set to 8GB (default 2GB fills quickly)
[ ] Node draining tested during rolling upgrades

GitOps Integration
[ ] Cluster manifests version-controlled in Git
[ ] Argo CD or Flux configured for cluster manifest reconciliation
[ ] Cluster addon manifests (CNI, metrics-server) co-located with cluster spec
[ ] No cluster resources created outside GitOps flow

Multi-Cloud
[ ] Provider-specific IAM/RBAC documented per cloud
[ ] Cluster naming convention includes region and environment
[ ] Cross-cluster connectivity documented (VPN, transit gateway, peering)
```

Cluster API transforms cluster operations from an operational burden into a reliable, version-controlled workflow. The same GitOps practices that govern application deployments govern cluster infrastructure, and the same reconciliation mechanisms that maintain application state maintain cluster topology.
