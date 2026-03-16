---
title: "Cluster API: Declarative Kubernetes Cluster Lifecycle Management"
date: 2027-04-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "Infrastructure", "GitOps"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to using Cluster API for declarative management of Kubernetes cluster lifecycle including provisioning, upgrades, scaling, and multi-cloud cluster fleet management."
more_link: "yes"
url: "/cluster-api-kubernetes-lifecycle-management-guide/"
---

Cluster API (CAPI) transforms Kubernetes cluster lifecycle management by applying the same declarative, controller-driven model used for application workloads to cluster infrastructure itself. Platform engineering teams managing dozens or hundreds of clusters across multiple clouds gain a consistent, auditable, and GitOps-compatible interface for provisioning, upgrading, scaling, and decommissioning clusters. This guide covers CAPI architecture, provider selection, ClusterClass topology, rolling upgrades, and integration with ArgoCD for a production-grade cluster fleet management platform.

<!--more-->

## Cluster API Architecture and Core Concepts

Cluster API introduces a set of Kubernetes custom resources that describe the desired state of a cluster and a set of controllers that reconcile actual infrastructure to match that state. This section walks through the conceptual model before moving into hands-on configuration.

### Management Cluster vs Workload Clusters

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Management Cluster                              │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  CAPI Core   │  │  Bootstrap   │  │  Infrastructure Provider │  │
│  │  Controllers │  │  Provider    │  │  (CAPA/CAPV/CAPZ/CAPT)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Cluster API Objects                                         │   │
│  │  Cluster → KubeadmControlPlane → AWSMachineTemplate          │   │
│  │  MachineDeployment → MachineSet → Machine                    │   │
│  │  ClusterClass → ClusterTopology                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  Workload    │   │  Workload        │   │  Workload        │
│  Cluster A   │   │  Cluster B       │   │  Cluster C       │
│  (AWS us-east│   │  (vSphere DC1)   │   │  (AWS eu-west)   │
└──────────────┘   └──────────────────┘   └──────────────────┘
```

The management cluster hosts all CAPI controllers and stores the authoritative state of every workload cluster. The management cluster itself is typically a long-lived, heavily guarded cluster. Workload clusters are created, scaled, upgraded, and deleted through CAPI resources applied to the management cluster.

### Core CRD Hierarchy

```
Cluster
  ├── spec.controlPlaneRef → KubeadmControlPlane (or TalosControlPlane)
  └── spec.infrastructureRef → AWSCluster / VSphereCluster / ...

KubeadmControlPlane
  └── spec.machineTemplate.infrastructureRef → AWSMachineTemplate

MachineDeployment
  └── spec.template.spec.bootstrap.configRef → KubeadmConfigTemplate
  └── spec.template.spec.infrastructureRef → AWSMachineTemplate
```

### Installing CAPI with clusterctl

`clusterctl` is the official CLI for initializing a management cluster and installing providers.

```bash
# Install clusterctl
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.7.3/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Verify installation
clusterctl version

# Initialize management cluster with AWS provider
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=EXAMPLE_AWS_ACCESS_KEY_REPLACE_ME
export AWS_SECRET_ACCESS_KEY=EXAMPLE_TOKEN_REPLACE_ME
export AWS_SESSION_TOKEN=EXAMPLE_TOKEN_REPLACE_ME

# Encode credentials for CAPA
export AWS_B64ENCODED_CREDENTIALS=$(clusterctl generate credentials aws)

# Initialize the management cluster
clusterctl init \
  --infrastructure aws \
  --bootstrap kubeadm \
  --control-plane kubeadm \
  --config ~/.cluster-api/clusterctl.yaml
```

```yaml
# ~/.cluster-api/clusterctl.yaml
providers:
  - name: "aws"
    url: "https://github.com/kubernetes-sigs/cluster-api-provider-aws/releases/latest/infrastructure-components.yaml"
    type: "InfrastructureProvider"
  - name: "vsphere"
    url: "https://github.com/kubernetes-sigs/cluster-api-provider-vsphere/releases/latest/infrastructure-components.yaml"
    type: "InfrastructureProvider"
  - name: "talos"
    url: "https://github.com/siderolabs/cluster-api-bootstrap-provider-talos/releases/latest/bootstrap-components.yaml"
    type: "BootstrapProvider"
  - name: "talos"
    url: "https://github.com/siderolabs/cluster-api-control-plane-provider-talos/releases/latest/control-plane-components.yaml"
    type: "ControlPlaneProvider"
```

## Provisioning an AWS Cluster with CAPA

The AWS provider (CAPA) creates and manages EC2 instances, VPCs, security groups, load balancers, and IAM roles required for a functional Kubernetes cluster.

### Prerequisite IAM Resources

```bash
# Create IAM resources using clusterawsadm
clusterawsadm bootstrap iam create-cloudformation-stack \
  --config bootstrap-config.yaml

# bootstrap-config.yaml
cat <<'EOF' > bootstrap-config.yaml
apiVersion: bootstrap.aws.infrastructure.cluster.x-k8s.io/v1beta1
kind: AWSIAMConfiguration
spec:
  bootstrapUser:
    enable: true
  controlPlane:
    enableCSIPolicy: true
  nodes:
    extraPolicyAttachments:
      - arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
  eks:
    enable: false
EOF
```

### Complete AWS Cluster Manifest

```yaml
# aws-cluster.yaml
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: prod-us-east-1
  namespace: clusters
  labels:
    environment: production
    region: us-east-1
    managed-by: cluster-api
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
        - 192.168.0.0/16
    services:
      cidrBlocks:
        - 10.96.0.0/12
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: prod-us-east-1-control-plane
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: prod-us-east-1
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: prod-us-east-1
  namespace: clusters
spec:
  region: us-east-1
  sshKeyName: cluster-admin
  network:
    vpc:
      cidrBlock: "10.0.0.0/16"
    subnets:
      - availabilityZone: us-east-1a
        cidrBlock: "10.0.1.0/24"
        isPublic: false
      - availabilityZone: us-east-1b
        cidrBlock: "10.0.2.0/24"
        isPublic: false
      - availabilityZone: us-east-1c
        cidrBlock: "10.0.3.0/24"
        isPublic: false
      - availabilityZone: us-east-1a
        cidrBlock: "10.0.101.0/24"
        isPublic: true
      - availabilityZone: us-east-1b
        cidrBlock: "10.0.102.0/24"
        isPublic: true
      - availabilityZone: us-east-1c
        cidrBlock: "10.0.103.0/24"
        isPublic: true
  controlPlaneLoadBalancer:
    loadBalancerType: nlb
    scheme: internet-facing
  bastion:
    enabled: false
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: prod-us-east-1-control-plane
  namespace: clusters
spec:
  replicas: 3
  version: v1.30.2
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSMachineTemplate
      name: prod-us-east-1-control-plane
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        kubeletExtraArgs:
          cloud-provider: external
          node-labels: "node-role.kubernetes.io/control-plane="
    clusterConfiguration:
      apiServer:
        extraArgs:
          cloud-provider: external
          audit-log-path: /var/log/kubernetes/audit.log
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "100"
          enable-admission-plugins: "NodeRestriction,PodSecurity"
        extraVolumes:
          - name: audit-log
            hostPath: /var/log/kubernetes
            mountPath: /var/log/kubernetes
            readOnly: false
            pathType: DirectoryOrCreate
      controllerManager:
        extraArgs:
          cloud-provider: external
      etcd:
        local:
          dataDir: /var/lib/etcddisk/etcd
          extraArgs:
            quota-backend-bytes: "8589934592"
            heartbeat-interval: "250"
            election-timeout: "1250"
    joinConfiguration:
      nodeRegistration:
        kubeletExtraArgs:
          cloud-provider: external
    preKubeadmCommands:
      - bash -c "echo 'kernel.pid_max=4194304' >> /etc/sysctl.conf && sysctl -p"
      - bash -c "echo 'fs.inotify.max_user_watches=524288' >> /etc/sysctl.conf && sysctl -p"
    postKubeadmCommands:
      - kubectl --kubeconfig /etc/kubernetes/admin.conf apply -f https://raw.githubusercontent.com/kubernetes-sigs/cluster-api-provider-aws/main/templates/eks/ccm/aws-cloud-controller-manager.yaml
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: prod-us-east-1-control-plane
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m6i.xlarge
      iamInstanceProfile: control-plane.cluster-api-provider-aws.sigs.k8s.io
      ami:
        lookupType: ID
        id: ami-0123456789abcdef0   # Replace with appropriate AMI
      rootVolume:
        size: 100
        type: gp3
        iops: 3000
        throughput: 125
      nonRootVolumes:
        - deviceName: /dev/xvdb
          size: 100
          type: gp3
          encrypted: true
      sshKeyName: cluster-admin
      additionalSecurityGroups:
        - id: sg-control-plane-extra
      publicIP: false
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: prod-us-east-1-workers
  namespace: clusters
spec:
  clusterName: prod-us-east-1
  replicas: 3
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: prod-us-east-1
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: prod-us-east-1
        node-role: worker
    spec:
      version: v1.30.2
      clusterName: prod-us-east-1
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: prod-us-east-1-workers
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: prod-us-east-1-workers
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
    type: RollingUpdate
---
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: prod-us-east-1-workers
  namespace: clusters
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          kubeletExtraArgs:
            cloud-provider: external
            node-labels: "node-role.kubernetes.io/worker="
      preKubeadmCommands:
        - bash -c "echo 'kernel.pid_max=4194304' >> /etc/sysctl.conf && sysctl -p"
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: prod-us-east-1-workers
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m6i.2xlarge
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
      ami:
        lookupType: ID
        id: ami-0123456789abcdef0
      rootVolume:
        size: 100
        type: gp3
        iops: 3000
      spotMarketOptions: {}
      publicIP: false
```

### Applying and Monitoring Cluster Creation

```bash
# Apply the cluster manifest
kubectl apply -f aws-cluster.yaml

# Watch cluster provisioning status
kubectl get cluster,kubeadmcontrolplane,machinedeployment,machineset,machine \
  -n clusters

# Detailed status from clusterctl
clusterctl describe cluster prod-us-east-1 -n clusters

# Get kubeconfig for the workload cluster
clusterctl get kubeconfig prod-us-east-1 -n clusters > prod-us-east-1.kubeconfig

# Verify cluster health
kubectl --kubeconfig prod-us-east-1.kubeconfig get nodes
```

## ClusterClass: Topology-Based Cluster Templates

ClusterClass is the highest-level abstraction in CAPI, enabling platform teams to define a reusable cluster topology that encodes organizational standards. Teams request clusters by specifying the class name plus a handful of variables, dramatically reducing the YAML surface area.

### Defining a ClusterClass

```yaml
# clusterclass-aws-standard.yaml
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: aws-standard
  namespace: clusters
spec:
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: aws-standard-control-plane
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: aws-standard-control-plane-machine
    nodeDrainTimeout: 2m
    nodeVolumeDetachTimeout: 5m
    nodeDeletionTimeout: 30s
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: aws-standard
  workers:
    machineDeployments:
      - class: default-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: aws-standard-default-worker
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: aws-standard-default-worker
        nodeDrainTimeout: 2m
      - class: gpu-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: aws-standard-gpu-worker
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: aws-standard-gpu-worker
  variables:
    - name: kubernetesVersion
      required: true
      schema:
        openAPIV3Schema:
          type: string
          pattern: "^v[0-9]+\\.[0-9]+\\.[0-9]+$"
          example: "v1.30.2"
    - name: controlPlaneInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: m6i.xlarge
          enum:
            - m6i.large
            - m6i.xlarge
            - m6i.2xlarge
            - m6i.4xlarge
    - name: workerInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: m6i.2xlarge
    - name: awsRegion
      required: true
      schema:
        openAPIV3Schema:
          type: string
    - name: sshKeyName
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: cluster-admin
    - name: enableAuditLogging
      required: false
      schema:
        openAPIV3Schema:
          type: boolean
          default: true
    - name: podCIDR
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: "192.168.0.0/16"
  patches:
    - name: kubernetesVersion
      description: "Set Kubernetes version across all templates"
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
    - name: controlPlaneInstanceType
      description: "Set control plane EC2 instance type"
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
    - name: awsRegion
      description: "Set AWS region for cluster infrastructure"
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
                variable: awsRegion
```

### Consuming the ClusterClass

```yaml
# team-a-cluster.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: team-a-production
  namespace: clusters
  labels:
    team: team-a
    environment: production
    tier: standard
spec:
  topology:
    class: aws-standard
    version: v1.30.2
    controlPlane:
      replicas: 3
      metadata:
        labels:
          node-type: control-plane
    workers:
      machineDeployments:
        - class: default-worker
          name: workers
          replicas: 5
          metadata:
            labels:
              node-type: worker
          variables:
            overrides:
              - name: workerInstanceType
                value: m6i.4xlarge
        - class: gpu-worker
          name: gpu-workers
          replicas: 2
          metadata:
            labels:
              node-type: gpu-worker
              accelerator: nvidia
    variables:
      - name: kubernetesVersion
        value: v1.30.2
      - name: awsRegion
        value: us-east-1
      - name: controlPlaneInstanceType
        value: m6i.xlarge
      - name: sshKeyName
        value: cluster-admin
      - name: enableAuditLogging
        value: true
      - name: podCIDR
        value: "10.244.0.0/16"
```

## vSphere Provider (CAPV) Configuration

Many enterprises run on-premises clusters on vSphere. CAPV manages vSphere VMs, templates, and network configuration.

```bash
# Initialize vSphere provider
export VSPHERE_SERVER=vcenter.company.com
export VSPHERE_USERNAME=administrator@vsphere.local
export VSPHERE_PASSWORD=EXAMPLE_TOKEN_REPLACE_ME
export VSPHERE_TLS_THUMBPRINT=$(openssl s_client -connect vcenter.company.com:443 </dev/null 2>/dev/null | openssl x509 -fingerprint -sha1 -noout | awk -F= '{print $2}')

clusterctl init --infrastructure vsphere
```

```yaml
# vsphere-cluster.yaml
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: vsphere-prod-01
  namespace: clusters
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
        - 192.168.0.0/16
    services:
      cidrBlocks:
        - 10.96.0.0/12
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: vsphere-prod-01-control-plane
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta3
    kind: VSphereCluster
    name: vsphere-prod-01
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta3
kind: VSphereCluster
metadata:
  name: vsphere-prod-01
  namespace: clusters
spec:
  server: vcenter.company.com
  thumbprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD"
  identityRef:
    kind: Secret
    name: vsphere-credentials
  controlPlaneEndpoint:
    host: 10.10.10.50   # VIP for control plane
    port: 6443
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta3
kind: VSphereMachineTemplate
metadata:
  name: vsphere-prod-01-control-plane
  namespace: clusters
spec:
  template:
    spec:
      server: vcenter.company.com
      thumbprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD"
      datacenter: DC1
      datastore: vsanDatastore
      folder: /DC1/vm/k8s-clusters
      resourcePool: /DC1/host/Cluster/Resources/k8s
      network:
        devices:
          - networkName: k8s-vlan-100
            dhcp4: false
            ipAddrs:
              - 10.10.10.10/24
            gateway4: 10.10.10.1
            nameservers:
              - 8.8.8.8
              - 8.8.4.4
      numCPUs: 4
      memoryMiB: 8192
      diskGiB: 80
      template: /DC1/vm/templates/ubuntu-2204-kube-v1.30.2
      cloneMode: linkedClone
      storagePolicyName: ""
```

## Talos Linux Provider (CAPT) for Immutable Nodes

Talos Linux is a purpose-built, immutable OS for Kubernetes nodes. The CAPT provider integrates Talos with CAPI for a minimal-attack-surface node OS.

```bash
# Install Talos provider alongside kubeadm
clusterctl init \
  --bootstrap talos \
  --control-plane talos \
  --infrastructure aws
```

```yaml
# talos-cluster.yaml
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: talos-prod
  namespace: clusters
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
        - 10.244.0.0/16
    services:
      cidrBlocks:
        - 10.96.0.0/12
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1alpha3
    kind: TalosControlPlane
    name: talos-prod-control-plane
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: talos-prod
---
apiVersion: controlplane.cluster.x-k8s.io/v1alpha3
kind: TalosControlPlane
metadata:
  name: talos-prod-control-plane
  namespace: clusters
spec:
  version: v1.30.2
  replicas: 3
  infrastructureTemplate:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSMachineTemplate
    name: talos-prod-control-plane
  controlPlaneConfig:
    controlplane:
      generateType: controlplane
      talosVersion: v1.7.5
      configPatches:
        - op: add
          path: /machine/sysctls
          value:
            net.ipv4.ip_forward: "1"
            kernel.pid_max: "4194304"
        - op: add
          path: /machine/kubelet/extraArgs
          value:
            rotate-certificates: "true"
        - op: add
          path: /cluster/apiServer/extraArgs
          value:
            audit-log-path: /var/log/kubernetes/audit.log
            audit-log-maxage: "30"
---
apiVersion: bootstrap.cluster.x-k8s.io/v1alpha3
kind: TalosConfigTemplate
metadata:
  name: talos-prod-workers
  namespace: clusters
spec:
  template:
    spec:
      generateType: worker
      talosVersion: v1.7.5
      configPatches:
        - op: add
          path: /machine/sysctls
          value:
            net.ipv4.ip_forward: "1"
```

## Rolling Kubernetes Version Upgrades

CAPI handles rolling upgrades by creating new Machines with the updated version while draining and deleting old ones, respecting the MachineDeployment rolling update strategy.

### Control Plane Upgrade

```bash
# Patch the Kubernetes version on the KubeadmControlPlane
kubectl -n clusters patch kubeadmcontrolplane prod-us-east-1-control-plane \
  --type merge \
  -p '{"spec":{"version":"v1.31.1"}}'

# Watch control plane nodes cycle
kubectl -n clusters get machines -w \
  -l cluster.x-k8s.io/cluster-name=prod-us-east-1

# Monitor upgrade events
kubectl -n clusters describe kubeadmcontrolplane prod-us-east-1-control-plane | \
  grep -A 20 Events
```

### Worker Node Upgrade

```bash
# Patch the MachineDeployment version
kubectl -n clusters patch machinedeployment prod-us-east-1-workers \
  --type merge \
  -p '{"spec":{"template":{"spec":{"version":"v1.31.1"}}}}'

# Scale the MachineDeployment for faster upgrades (optional)
kubectl -n clusters patch machinedeployment prod-us-east-1-workers \
  --type merge \
  -p '{"spec":{"strategy":{"rollingUpdate":{"maxSurge":2,"maxUnavailable":0}}}}'

# Monitor progress
clusterctl describe cluster prod-us-east-1 -n clusters
```

### Automated Upgrade Script

```bash
#!/usr/bin/env bash
# upgrade-cluster.sh - Orchestrate a full cluster upgrade via CAPI

set -euo pipefail

CLUSTER_NAME="${1:?Usage: $0 <cluster-name> <new-version> <namespace>}"
NEW_VERSION="${2:?}"
NAMESPACE="${3:-clusters}"

echo "==> Upgrading cluster ${CLUSTER_NAME} to ${NEW_VERSION}"

# Verify cluster is healthy before starting
CLUSTER_PHASE=$(kubectl -n "${NAMESPACE}" get cluster "${CLUSTER_NAME}" \
  -o jsonpath='{.status.phase}')
if [[ "${CLUSTER_PHASE}" != "Provisioned" ]]; then
  echo "ERROR: Cluster phase is '${CLUSTER_PHASE}', must be 'Provisioned'"
  exit 1
fi

# Upgrade control plane
KCP_NAME=$(kubectl -n "${NAMESPACE}" get kubeadmcontrolplane \
  -l cluster.x-k8s.io/cluster-name="${CLUSTER_NAME}" \
  -o jsonpath='{.items[0].metadata.name}')

echo "==> Patching KubeadmControlPlane ${KCP_NAME}"
kubectl -n "${NAMESPACE}" patch kubeadmcontrolplane "${KCP_NAME}" \
  --type merge \
  -p "{\"spec\":{\"version\":\"${NEW_VERSION}\"}}"

# Wait for control plane to finish upgrading
echo "==> Waiting for control plane rollout..."
timeout 30m bash -c "
  while true; do
    READY=\$(kubectl -n ${NAMESPACE} get kubeadmcontrolplane ${KCP_NAME} \
      -o jsonpath='{.status.ready}')
    REPLICAS=\$(kubectl -n ${NAMESPACE} get kubeadmcontrolplane ${KCP_NAME} \
      -o jsonpath='{.status.replicas}')
    UPDATED=\$(kubectl -n ${NAMESPACE} get kubeadmcontrolplane ${KCP_NAME} \
      -o jsonpath='{.status.updatedReplicas}')
    echo \"  Control plane: ready=\${READY} replicas=\${REPLICAS} updated=\${UPDATED}\"
    if [[ \"\${READY}\" == 'true' && \"\${REPLICAS}\" == \"\${UPDATED}\" ]]; then
      break
    fi
    sleep 30
  done
"

# Upgrade worker MachineDeployments
echo "==> Upgrading worker MachineDeployments..."
kubectl -n "${NAMESPACE}" get machinedeployments \
  -l cluster.x-k8s.io/cluster-name="${CLUSTER_NAME}" \
  -o name | while read -r MD; do
    echo "  Patching ${MD}"
    kubectl -n "${NAMESPACE}" patch "${MD}" \
      --type merge \
      -p "{\"spec\":{\"template\":{\"spec\":{\"version\":\"${NEW_VERSION}\"}}}}"
  done

echo "==> Cluster ${CLUSTER_NAME} upgrade to ${NEW_VERSION} complete"
```

## ClusterResourceSets: Automated Workload Installation

ClusterResourceSets (CRS) apply ConfigMaps and Secrets to matching workload clusters automatically. This is the CAPI-native way to install CNI plugins, cloud-controller-managers, and other cluster-level add-ons.

```yaml
# cluster-resource-set-cni.yaml
---
apiVersion: addons.cluster.x-k8s.io/v1beta1
kind: ClusterResourceSet
metadata:
  name: cilium-cni
  namespace: clusters
spec:
  clusterSelector:
    matchLabels:
      cni: cilium
  resources:
    - name: cilium-cni-config
      kind: ConfigMap
  strategy: ApplyOnce
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-cni-config
  namespace: clusters
data:
  cilium-helm-chart.yaml: |
    apiVersion: helm.cattle.io/v1
    kind: HelmChart
    metadata:
      name: cilium
      namespace: kube-system
    spec:
      chart: cilium
      repo: https://helm.cilium.io/
      version: 1.15.5
      targetNamespace: kube-system
      valuesContent: |-
        kubeProxyReplacement: true
        k8sServiceHost: "auto"
        k8sServicePort: "6443"
        ipam:
          mode: kubernetes
        tunnel: disabled
        autoDirectNodeRoutes: true
        loadBalancer:
          algorithm: maglev
        bandwidthManager:
          enabled: true
        bpf:
          masquerade: true
        hubble:
          enabled: true
          relay:
            enabled: true
          ui:
            enabled: true
---
apiVersion: addons.cluster.x-k8s.io/v1beta1
kind: ClusterResourceSet
metadata:
  name: aws-ccm
  namespace: clusters
spec:
  clusterSelector:
    matchLabels:
      cloud-provider: aws
  resources:
    - name: aws-ccm-config
      kind: ConfigMap
  strategy: Reconcile
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-ccm-config
  namespace: clusters
data:
  aws-ccm.yaml: |
    apiVersion: apps/v1
    kind: DaemonSet
    metadata:
      name: aws-cloud-controller-manager
      namespace: kube-system
    spec:
      selector:
        matchLabels:
          app: aws-cloud-controller-manager
      template:
        metadata:
          labels:
            app: aws-cloud-controller-manager
        spec:
          serviceAccountName: cloud-controller-manager
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          tolerations:
            - key: node-role.kubernetes.io/control-plane
              effect: NoSchedule
          containers:
            - name: aws-cloud-controller-manager
              image: registry.k8s.io/provider-aws/cloud-controller-manager:v1.30.2
              args:
                - --v=2
                - --cloud-provider=aws
                - --use-service-account-credentials=true
```

## GitOps Integration with ArgoCD

Managing a fleet of workload clusters declaratively through ArgoCD requires organizing cluster manifests in a structured Git repository.

### Repository Structure

```
cluster-fleet/
├── management/
│   └── apps.yaml              # ArgoCD ApplicationSet for all clusters
├── clusters/
│   ├── production/
│   │   ├── us-east-1/
│   │   │   ├── cluster.yaml
│   │   │   └── cluster-addons.yaml
│   │   └── eu-west-1/
│   │       ├── cluster.yaml
│   │       └── cluster-addons.yaml
│   ├── staging/
│   │   └── us-east-1/
│   │       └── cluster.yaml
│   └── development/
│       └── us-east-1/
│           └── cluster.yaml
├── clusterclasses/
│   ├── aws-standard.yaml
│   └── vsphere-standard.yaml
└── templates/
    ├── aws-machine-templates/
    └── kubeadmconfig-templates/
```

### ArgoCD ApplicationSet for Cluster Fleet

```yaml
# management/apps.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-fleet
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/company/cluster-fleet.git
        revision: main
        directories:
          - path: "clusters/*/*"
  template:
    metadata:
      name: "cluster-{{path.basenameNormalized}}-{{path[1]}}"
      labels:
        managed-by: cluster-api-argocd
        environment: "{{path[1]}}"
    spec:
      project: cluster-fleet
      source:
        repoURL: https://github.com/company/cluster-fleet.git
        targetRevision: main
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: clusters
      syncPolicy:
        automated:
          prune: false          # Never auto-delete clusters
          selfHeal: true
          allowEmpty: false
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
          - RespectIgnoreDifferences=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
      ignoreDifferences:
        - group: cluster.x-k8s.io
          kind: Cluster
          jsonPointers:
            - /metadata/annotations/cluster.x-k8s.io~1cluster-cache-sync-period
        - group: infrastructure.cluster.x-k8s.io
          kind: AWSCluster
          jsonPointers:
            - /spec/network/subnets
```

### CAPI Operator for Management Cluster Bootstrap

The Cluster API Operator simplifies provider installation and upgrades using declarative Kubernetes objects.

```yaml
# capi-operator-providers.yaml
---
apiVersion: operator.cluster.x-k8s.io/v1alpha2
kind: CoreProvider
metadata:
  name: cluster-api
  namespace: capi-system
spec:
  version: v1.7.3
  configSecret:
    name: capi-variables
  manager:
    featureGates:
      ClusterTopology: true
      MachinePool: true
      ClusterResourceSet: true
---
apiVersion: operator.cluster.x-k8s.io/v1alpha2
kind: BootstrapProvider
metadata:
  name: kubeadm
  namespace: capi-kubeadm-bootstrap-system
spec:
  version: v1.7.3
---
apiVersion: operator.cluster.x-k8s.io/v1alpha2
kind: ControlPlaneProvider
metadata:
  name: kubeadm
  namespace: capi-kubeadm-control-plane-system
spec:
  version: v1.7.3
---
apiVersion: operator.cluster.x-k8s.io/v1alpha2
kind: InfrastructureProvider
metadata:
  name: aws
  namespace: capa-system
spec:
  version: v2.5.2
  configSecret:
    name: capa-variables
  manager:
    featureGates:
      EKS: false
      EKSFargate: false
      MachinePool: true
      EventBridgeInstanceState: false
      AutoControllerIdentityCreator: true
      BootstrapFormatIgnition: false
      ExternalResourceGC: true
```

## MachineHealthCheck: Automatic Node Remediation

```yaml
# machine-health-check.yaml
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: prod-us-east-1-worker-health
  namespace: clusters
spec:
  clusterName: prod-us-east-1
  selector:
    matchLabels:
      node-role: worker
  unhealthyConditions:
    - type: Ready
      status: Unknown
      timeout: 300s
    - type: Ready
      status: "False"
      timeout: 300s
  maxUnhealthy: "33%"
  nodeStartupTimeout: 10m
  remediationTemplate:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSRemediationTemplate
    name: prod-us-east-1-remediation
    namespace: clusters
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSRemediationTemplate
metadata:
  name: prod-us-east-1-remediation
  namespace: clusters
spec:
  template:
    spec:
      strategy: Terminate   # Terminate and replace unhealthy instances
```

## Multi-Cloud Cluster Fleet Management

Platform teams often need to manage clusters across AWS, GCP, Azure, and vSphere from a single management cluster.

```bash
# Initialize multiple infrastructure providers
clusterctl init \
  --infrastructure aws,azure,vsphere \
  --bootstrap kubeadm \
  --control-plane kubeadm

# List all clusters across providers
kubectl get clusters -A --show-labels

# Get summary of all clusters
clusterctl describe cluster -A

# Export kubeconfig for a specific cluster
clusterctl get kubeconfig -n clusters team-b-azure-eastus > team-b-azure.kubeconfig
```

### Fleet Status Dashboard Script

```bash
#!/usr/bin/env bash
# fleet-status.sh - Print a status table of all CAPI-managed clusters

set -euo pipefail

echo "========================================================"
echo " Cluster Fleet Status - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================================"
printf "%-30s %-12s %-12s %-10s %-10s\n" \
  "CLUSTER" "NAMESPACE" "PHASE" "CP-READY" "WORKERS"
echo "--------------------------------------------------------"

kubectl get clusters -A -o json | jq -r '
  .items[] |
  [
    .metadata.name,
    .metadata.namespace,
    (.status.phase // "Unknown"),
    ((.status.controlPlaneReady // false) | tostring),
    (.status.conditions[] | select(.type=="WorkersReady") | .status // "Unknown")
  ] | @tsv
' | while IFS=$'\t' read -r name ns phase cp_ready workers_ready; do
  printf "%-30s %-12s %-12s %-10s %-10s\n" \
    "${name}" "${ns}" "${phase}" "${cp_ready}" "${workers_ready}"
done
```

## Monitoring CAPI with Prometheus

```yaml
# capi-servicemonitor.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: capi-controller-manager
  namespace: capi-system
  labels:
    app: capi-controller-manager
spec:
  selector:
    matchLabels:
      cluster.x-k8s.io/provider: cluster-api
  endpoints:
    - port: metrics
      interval: 30s
      scheme: https
      tlsConfig:
        caFile: /etc/prometheus/secrets/capi-metrics-tls/ca.crt
        certFile: /etc/prometheus/secrets/capi-metrics-tls/tls.crt
        keyFile: /etc/prometheus/secrets/capi-metrics-tls/tls.key
        insecureSkipVerify: true
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: capi-alerts
  namespace: capi-system
spec:
  groups:
    - name: cluster-api.rules
      rules:
        - alert: CAPIClusterNotProvisioned
          expr: |
            capi_cluster_status_phase{phase!="Provisioned"} > 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "CAPI cluster {{ $labels.cluster }} is not in Provisioned phase"
            description: "Cluster {{ $labels.cluster }} in namespace {{ $labels.namespace }} has been in phase {{ $labels.phase }} for more than 15 minutes."
        - alert: CAPIControlPlaneNotReady
          expr: |
            capi_kubeadmcontrolplane_status_replicas_ready
              / capi_kubeadmcontrolplane_status_replicas != 1
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "CAPI control plane replicas not fully ready"
            description: "KubeadmControlPlane {{ $labels.name }} has {{ $value | humanizePercentage }} of replicas ready."
        - alert: CAPIUnhealthyMachines
          expr: |
            capi_machine_status_phase{phase=~"Deleting|Failed|Unknown"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CAPI machines in unhealthy state"
            description: "Machine {{ $labels.machine }} is in phase {{ $labels.phase }}."
        - alert: CAPIMachineHealthCheckRemediating
          expr: |
            capi_machinehealthcheck_status_remediations_allowed < 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "MachineHealthCheck has exhausted remediation budget"
            description: "MachineHealthCheck {{ $labels.name }} has no remaining remediation budget."
```

## Troubleshooting Common Issues

### Cluster Stuck in Provisioning Phase

```bash
# Check controller logs for reconciliation errors
kubectl -n capi-system logs deploy/capi-controller-manager -c manager --tail=100

# Check infrastructure provider logs (AWS)
kubectl -n capa-system logs deploy/capa-controller-manager -c manager --tail=100

# Describe the stuck Cluster object
kubectl -n clusters describe cluster prod-us-east-1

# Check Machine objects for individual node errors
kubectl -n clusters describe machines \
  -l cluster.x-k8s.io/cluster-name=prod-us-east-1 | \
  grep -A 5 "Status\|Events\|Message"

# Check bootstrap logs (runs on the node via user-data)
# For AWS: check EC2 instance system logs in AWS Console
aws ec2 get-console-output \
  --instance-id i-0abcdef1234567890 \
  --region us-east-1 \
  --output text
```

### Control Plane Certificate Rotation

```bash
# Force certificate rotation on a KubeadmControlPlane
kubectl -n clusters annotate kubeadmcontrolplane prod-us-east-1-control-plane \
  controlplane.cluster.x-k8s.io/skip-kube-proxy=false

# Trigger a rollout by updating a non-critical annotation
kubectl -n clusters patch kubeadmcontrolplane prod-us-east-1-control-plane \
  --type merge \
  -p '{"metadata":{"annotations":{"cluster-api.capi.io/cert-rotation-trigger":"'$(date +%s)'"}}}'
```

### Provider Version Mismatch

```bash
# Check installed provider versions
clusterctl upgrade plan

# Upgrade providers to latest compatible versions
clusterctl upgrade apply \
  --management-group capi-system/cluster-api \
  --contract v1beta1

# After upgrade, verify all providers are running
kubectl get providers -A
```

## Production Hardening Checklist

```bash
# 1. Enable audit logging on the management cluster API server
# Add to kube-apiserver manifest:
# --audit-log-path=/var/log/kubernetes/audit.log
# --audit-policy-file=/etc/kubernetes/audit-policy.yaml

# 2. Restrict management cluster network access
kubectl apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict-capi-egress
  namespace: capi-system
spec:
  podSelector:
    matchLabels:
      cluster.x-k8s.io/provider: cluster-api
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: TCP
          port: 443
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 169.254.0.0/16
              - 100.64.0.0/10
      ports:
        - protocol: TCP
          port: 443
        - protocol: TCP
          port: 6443
EOF

# 3. Set resource limits on CAPI controllers
kubectl -n capi-system patch deployment capi-controller-manager \
  --type json \
  -p '[
    {"op":"add","path":"/spec/template/spec/containers/0/resources","value":{
      "requests":{"cpu":"100m","memory":"256Mi"},
      "limits":{"cpu":"500m","memory":"512Mi"}
    }}
  ]'

# 4. Enable leader election and high availability
kubectl -n capi-system scale deployment capi-controller-manager --replicas=2

# 5. Configure etcd encryption at rest for sensitive CAPI secrets
# Add to kube-apiserver: --encryption-provider-config=/etc/kubernetes/encryption-config.yaml
```

## Summary

Cluster API delivers a Kubernetes-native, declarative model for managing the full lifecycle of Kubernetes clusters across any infrastructure. Key takeaways for production adoption include: starting with a dedicated, hardened management cluster; adopting ClusterClass early to enforce organizational standards and reduce YAML sprawl; using ClusterResourceSets to automate CNI and add-on installation; integrating with ArgoCD for GitOps-driven cluster fleet management; and deploying MachineHealthChecks to automate node remediation. The provider ecosystem (CAPA for AWS, CAPV for vSphere, CAPT for Talos) covers the majority of enterprise infrastructure needs, and the CAPI Operator simplifies provider lifecycle management within the management cluster itself.
