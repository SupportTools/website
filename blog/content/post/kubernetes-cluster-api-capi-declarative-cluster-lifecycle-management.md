---
title: "Kubernetes Cluster API (CAPI) Deep Dive: Declarative Cluster Lifecycle Management and Custom Providers"
date: 2031-07-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "Infrastructure as Code", "GitOps", "Multi-cluster", "Operators"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into Kubernetes Cluster API (CAPI), covering the core resource model, bootstrap providers, infrastructure providers, multi-cluster fleet management, ClusterClass templating, and building custom CAPI providers."
more_link: "yes"
url: "/kubernetes-cluster-api-capi-declarative-cluster-lifecycle-management/"
---

The Cluster API (CAPI) project has transformed how organizations manage Kubernetes cluster fleets at scale. By expressing cluster creation, scaling, and lifecycle operations as Kubernetes resources managed by an operator pattern, CAPI enables true GitOps for infrastructure — every cluster configuration lives in Git, every change is a pull request, and the control plane continuously reconciles desired state with actual state. This guide covers the CAPI resource model in depth, examines the provider ecosystem, walks through ClusterClass-based templating for large fleet standardization, and introduces the patterns for building custom infrastructure providers.

<!--more-->

# Kubernetes Cluster API Deep Dive

## Section 1: CAPI Architecture and Resource Model

CAPI follows the same operator reconciliation pattern as Kubernetes itself. The Management Cluster runs CAPI controllers that watch custom resources and reconcile them against external infrastructure providers (AWS, Azure, GCP, vSphere, etc.).

### Core Resource Hierarchy

```
Management Cluster
├── Cluster (core CAPI resource)
│   ├── InfrastructureRef → AWSCluster / AzureCluster / VSphereCluster
│   ├── ControlPlaneRef → KubeadmControlPlane / RKE2ControlPlane
│   └── topology.workers[] → MachineDeployments
│
├── MachineDeployment
│   ├── spec.template.spec.infrastructureRef → AWSMachineTemplate
│   └── spec.template.spec.bootstrap.configRef → KubeadmConfigTemplate
│
├── Machine (created by MachineDeployment)
│   ├── spec.infrastructureRef → AWSMachine
│   └── spec.bootstrap.configRef → KubeadmConfig
│
└── MachineSet (intermediary between MachineDeployment and Machine)
```

### Provider Categories

**Bootstrap Providers** generate the cloud-init or ignition scripts that configure the OS and join nodes to the cluster:
- `kubeadm` (official, most common)
- `RKE2` (Rancher)
- `K3s`
- `Talos`

**Control Plane Providers** manage the control plane lifecycle (etcd, kube-apiserver, etc.):
- `kubeadm` (KubeadmControlPlane)
- `RKE2ControlPlane`
- `K3sControlPlane`

**Infrastructure Providers** provision and manage the underlying compute resources:
- AWS (CAPA)
- Azure (CAPZ)
- GCP (CAPG)
- vSphere (CAPV)
- Metal3 (bare metal)
- Nutanix
- OpenStack (CAPO)
- Hetzner

## Section 2: Setting Up the Management Cluster

### Installing clusterctl

```bash
# Download clusterctl
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.8.x/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Verify
clusterctl version

# Configure providers
cat > ~/.cluster-api/clusterctl.yaml <<EOF
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
EOF
```

### Initializing the Management Cluster (AWS Example)

```bash
# Set AWS credentials for CAPA
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=<aws-access-key-id>
export AWS_SECRET_ACCESS_KEY=<aws-secret-access-key>
export AWS_SESSION_TOKEN=<aws-session-token>   # if using assumed roles

# Prepare AWS (creates IAM roles, policies, S3 bucket for bootstrap data)
clusterawsadm bootstrap iam create-cloudformation-stack

# Export EKS-compatible credentials as base64
export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)

# Initialize management cluster
clusterctl init \
  --infrastructure aws \
  --bootstrap kubeadm \
  --control-plane kubeadm

# Verify controllers are running
kubectl get pods -n capi-system
kubectl get pods -n capa-system
kubectl get pods -n capi-kubeadm-bootstrap-system
kubectl get pods -n capi-kubeadm-control-plane-system
```

## Section 3: Provisioning a Workload Cluster

### Generating a Cluster Manifest

```bash
# Generate a cluster manifest for AWS
clusterctl generate cluster production-cluster \
  --infrastructure aws \
  --kubernetes-version v1.30.x \
  --control-plane-machine-count 3 \
  --worker-machine-count 5 \
  --from-file ./cluster-template.yaml \
  > production-cluster.yaml

# Or use the default template from the provider
export AWS_SSH_KEY_NAME=my-ssh-key
export AWS_CONTROL_PLANE_MACHINE_TYPE=m5.xlarge
export AWS_NODE_MACHINE_TYPE=m5.2xlarge
export AWS_REGION=us-east-1
export VPC_CIDR=10.0.0.0/16

clusterctl generate cluster production-cluster \
  --infrastructure aws \
  --kubernetes-version v1.30.x \
  --control-plane-machine-count 3 \
  --worker-machine-count 5 \
  > production-cluster.yaml
```

### Full Cluster Manifest (AWS)

```yaml
# production-cluster.yaml
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: production-cluster
  namespace: default
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
    name: production-cluster
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: production-cluster-control-plane
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: production-cluster
  namespace: default
spec:
  region: us-east-1
  sshKeyName: my-ssh-key
  network:
    vpc:
      cidrBlock: 10.0.0.0/16
      availabilityZoneUsageLimit: 3
      availabilityZoneSelection: Ordered
    subnets:
      - availabilityZone: us-east-1a
        cidrBlock: 10.0.0.0/20
        isPublic: false
      - availabilityZone: us-east-1b
        cidrBlock: 10.0.16.0/20
        isPublic: false
      - availabilityZone: us-east-1c
        cidrBlock: 10.0.32.0/20
        isPublic: false
      - availabilityZone: us-east-1a
        cidrBlock: 10.0.48.0/20
        isPublic: true
      - availabilityZone: us-east-1b
        cidrBlock: 10.0.64.0/20
        isPublic: true
      - availabilityZone: us-east-1c
        cidrBlock: 10.0.80.0/20
        isPublic: true
  controlPlaneLoadBalancer:
    loadBalancerType: nlb
    scheme: internal
  additionalTags:
    Owner: platform-team
    CostCenter: infrastructure
    ManagedBy: cluster-api
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: production-cluster-control-plane
  namespace: default
spec:
  replicas: 3
  version: v1.30.x
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSMachineTemplate
      name: production-cluster-control-plane
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external
          node-labels: "topology.kubernetes.io/zone={{ ds.meta_data.placement.availability-zone }}"
    clusterConfiguration:
      apiServer:
        extraArgs:
          cloud-provider: external
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "100"
          audit-log-path: /var/log/kubernetes/audit.log
          audit-policy-file: /etc/kubernetes/audit-policy.yaml
          encryption-provider-config: /etc/kubernetes/encryption-config.yaml
          enable-admission-plugins: NodeRestriction,PodSecurity
          profiling: "false"
        extraVolumes:
          - name: audit-policy
            hostPath: /etc/kubernetes/audit-policy.yaml
            mountPath: /etc/kubernetes/audit-policy.yaml
            readOnly: true
          - name: audit-log
            hostPath: /var/log/kubernetes
            mountPath: /var/log/kubernetes
      controllerManager:
        extraArgs:
          cloud-provider: external
          profiling: "false"
      scheduler:
        extraArgs:
          profiling: "false"
    joinConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external
    preKubeadmCommands:
      - hostnamectl set-hostname "{{ ds.meta_data.local_hostname }}"
      - mkdir -p /etc/kubernetes /var/log/kubernetes
    postKubeadmCommands:
      - kubectl --kubeconfig /etc/kubernetes/admin.conf apply -f https://raw.githubusercontent.com/aws/amazon-vpc-cni-k8s/master/config/master/aws-k8s-cni.yaml
    files:
      - path: /etc/kubernetes/audit-policy.yaml
        owner: root:root
        permissions: "0600"
        content: |
          apiVersion: audit.k8s.io/v1
          kind: Policy
          rules:
            - level: RequestResponse
              resources:
                - group: ""
                  resources: ["secrets", "configmaps"]
            - level: Metadata
              omitStages: ["RequestReceived"]
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-cluster-control-plane
  namespace: default
spec:
  template:
    spec:
      instanceType: m5.xlarge
      iamInstanceProfile: control-plane.cluster-api-provider-aws.sigs.k8s.io
      sshKeyName: my-ssh-key
      rootVolume:
        size: 100
        type: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        encryptionKey: arn:aws:kms:us-east-1:<account-id>:key/<key-id>
      nonRootVolumes:
        - deviceName: /dev/sdb
          size: 200
          type: gp3
          iops: 6000
          throughput: 250
          encrypted: true
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: production-cluster-workers
  namespace: default
  labels:
    cluster.x-k8s.io/cluster-name: production-cluster
    nodepool: general
spec:
  clusterName: production-cluster
  replicas: 5
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: production-cluster
      nodepool: general
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: production-cluster
        nodepool: general
    spec:
      clusterName: production-cluster
      version: v1.30.x
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: production-cluster-workers
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-cluster-workers
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-cluster-workers
  namespace: default
spec:
  template:
    spec:
      instanceType: m5.2xlarge
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
      sshKeyName: my-ssh-key
      rootVolume:
        size: 200
        type: gp3
        iops: 6000
        throughput: 250
        encrypted: true
      spotMarketOptions:
        maxPrice: "0.35"   # Use spot instances for worker nodes
---
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: production-cluster-workers
  namespace: default
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          name: "{{ ds.meta_data.local_hostname }}"
          kubeletExtraArgs:
            cloud-provider: external
            node-labels: "topology.kubernetes.io/zone={{ ds.meta_data.placement.availability-zone }}"
      preKubeadmCommands:
        - hostnamectl set-hostname "{{ ds.meta_data.local_hostname }}"
```

### Applying and Monitoring

```bash
# Apply the cluster manifest
kubectl apply -f production-cluster.yaml

# Watch cluster provisioning
watch kubectl get cluster,machinedeployment,machine -A

# Follow specific machine provisioning
kubectl describe machine production-cluster-control-plane-xxxxx

# Get kubeconfig for the workload cluster
clusterctl get kubeconfig production-cluster > ~/.kube/production-cluster.kubeconfig

# Verify workload cluster is accessible
kubectl --kubeconfig ~/.kube/production-cluster.kubeconfig get nodes

# Check cluster health
clusterctl describe cluster production-cluster
```

## Section 4: ClusterClass for Standardized Fleet Templates

`ClusterClass` is the CAPI feature that enables you to define a cluster topology template once and instantiate many clusters from it. It dramatically reduces the per-cluster YAML and enforces organizational standards.

### ClusterClass Definition

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: enterprise-aws-cluster
  namespace: capi-templates
spec:
  # Infrastructure template for the cluster itself (VPC, security groups, etc.)
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: enterprise-aws-cluster-template
      namespace: capi-templates

  # Control plane template
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: enterprise-control-plane-template
      namespace: capi-templates
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: enterprise-control-plane-machine-template
        namespace: capi-templates

  # Worker node pools
  workers:
    machineDeployments:
      - class: general-workers
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: enterprise-worker-bootstrap-template
              namespace: capi-templates
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: enterprise-worker-machine-template
              namespace: capi-templates
      - class: gpu-workers
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: enterprise-gpu-bootstrap-template
              namespace: capi-templates
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: enterprise-gpu-machine-template
              namespace: capi-templates

  # Variables that can be customized per cluster
  variables:
    - name: region
      required: true
      schema:
        openAPIV3Schema:
          type: string
          enum: ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"]
    - name: controlPlaneInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: "m5.xlarge"
    - name: workerInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: "m5.2xlarge"
    - name: workerReplicas
      required: false
      schema:
        openAPIV3Schema:
          type: integer
          minimum: 2
          maximum: 50
          default: 3
    - name: kubernetesVersion
      required: true
      schema:
        openAPIV3Schema:
          type: string
          pattern: "^v1\\.(2[789]|[3-9][0-9])\\.[0-9]+$"
    - name: enableGPUWorkers
      required: false
      schema:
        openAPIV3Schema:
          type: boolean
          default: false

  # Patches: apply variable values to templates
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

    - name: workerInstanceType
      definitions:
        - selector:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
            kind: AWSMachineTemplate
            matchResources:
              machineDeploymentClass:
                names: ["general-workers"]
          jsonPatches:
            - op: replace
              path: /spec/template/spec/instanceType
              valueFrom:
                variable: workerInstanceType

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

### Instantiating a Cluster from ClusterClass

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: team-alpha-production
  namespace: clusters
  labels:
    environment: production
    team: alpha
    cost-center: eng-platform
spec:
  topology:
    class: enterprise-aws-cluster
    version: v1.30.x
    variables:
      - name: region
        value: us-east-1
      - name: controlPlaneInstanceType
        value: m5.2xlarge
      - name: workerInstanceType
        value: m5.4xlarge
      - name: workerReplicas
        value: 10
      - name: kubernetesVersion
        value: v1.30.x
    workers:
      machineDeployments:
        - class: general-workers
          name: workers
          replicas: 10
        - class: gpu-workers
          name: gpu-workers
          replicas: 2
          variables:
            overrides:
              - name: workerInstanceType
                value: g4dn.12xlarge
```

## Section 5: Cluster Lifecycle Operations

### Rolling Kubernetes Version Upgrades

```bash
# Upgrade control plane
kubectl patch kubeadmcontrolplane production-cluster-control-plane \
  --type merge \
  -p '{"spec":{"version":"v1.31.x"}}'

# Watch control plane upgrade (rolling, one node at a time)
watch kubectl get kubeadmcontrolplane production-cluster-control-plane

# After control plane upgrade completes, upgrade worker nodes
kubectl patch machinedeployment production-cluster-workers \
  --type merge \
  -p '{"spec":{"template":{"spec":{"version":"v1.31.x"}}}}'

# Watch worker upgrade
watch kubectl get machinedeployment production-cluster-workers

# With ClusterClass topology, upgrade all in one operation:
kubectl patch cluster production-cluster \
  --type merge \
  -p '{"spec":{"topology":{"version":"v1.31.x"}}}'
```

### Scaling Worker Nodes

```bash
# Scale a MachineDeployment
kubectl scale machinedeployment production-cluster-workers --replicas=20

# Or via CAPI topology (ClusterClass-based)
kubectl patch cluster production-cluster \
  --type json \
  -p '[{"op":"replace","path":"/spec/topology/workers/machineDeployments/0/replicas","value":20}]'

# Add a new MachineDeployment (spot instances for burst capacity)
cat > burst-workers.yaml <<EOF
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: production-cluster-burst-workers
  namespace: default
spec:
  clusterName: production-cluster
  replicas: 0
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: production-cluster
      nodepool: burst
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: production-cluster
        nodepool: burst
        node.kubernetes.io/instance-lifecycle: spot
    spec:
      clusterName: production-cluster
      version: v1.30.x
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: production-cluster-workers
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-cluster-burst-workers
EOF
kubectl apply -f burst-workers.yaml
```

## Section 6: Multi-Cluster Fleet Management with GitOps

### Repository Structure for CAPI + ArgoCD

```
infrastructure/
├── management-cluster/
│   ├── capi-system/          # CAPI controller manifests
│   ├── cluster-addons/       # ArgoCD, cert-manager, etc.
│   └── clusterclasses/       # ClusterClass templates
│
└── workload-clusters/
    ├── production/
    │   ├── team-alpha/
    │   │   ├── cluster.yaml  # Uses ClusterClass
    │   │   └── addons/       # Apps to deploy to this cluster
    │   └── team-beta/
    │       ├── cluster.yaml
    │       └── addons/
    ├── staging/
    └── development/
```

### ArgoCD ApplicationSet for CAPI Cluster Provisioning

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: workload-clusters
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/your-org/infrastructure.git
        revision: HEAD
        directories:
          - path: workload-clusters/*/*/*
  template:
    metadata:
      name: "{{path.basenameNormalized}}"
    spec:
      project: clusters
      source:
        repoURL: https://github.com/your-org/infrastructure.git
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{path[1]}}-{{path[2]}}"
      syncPolicy:
        automated:
          prune: false      # Never auto-delete clusters
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## Section 7: Building a Custom CAPI Provider

CAPI providers follow a standard pattern: they watch Infrastructure resource objects and reconcile them with actual infrastructure. Here is a skeleton for a custom provider targeting a hypothetical bare-metal management API.

### Provider Structure

```
cluster-api-provider-baremetal/
├── api/
│   └── v1beta1/
│       ├── baremetalcluster_types.go
│       ├── baremetalmachine_types.go
│       └── groupversion_info.go
├── controllers/
│   ├── baremetalcluster_controller.go
│   └── baremetalmachine_controller.go
├── config/
│   ├── crd/
│   ├── default/
│   └── rbac/
└── main.go
```

### Infrastructure Machine Type

```go
// api/v1beta1/baremetalmachine_types.go
package v1beta1

import (
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
)

type BaremetalMachineSpec struct {
    // ProviderID is the unique identifier of the server in format "baremetal://server-id"
    // +optional
    ProviderID *string `json:"providerID,omitempty"`

    // ServerSelector selects which server from the pool to use
    ServerSelector *metav1.LabelSelector `json:"serverSelector,omitempty"`

    // Image is the OS image to provision on the server
    Image BaremetalImage `json:"image"`

    // NetworkInterfaces defines the network configuration
    NetworkInterfaces []BaremetalNetworkInterface `json:"networkInterfaces,omitempty"`
}

type BaremetalImage struct {
    URL      string `json:"url"`
    Checksum string `json:"checksum"`
    Format   string `json:"format"` // "raw", "qcow2"
}

type BaremetalNetworkInterface struct {
    Name    string `json:"name"`
    VLAN    int    `json:"vlan,omitempty"`
    MTU     int    `json:"mtu,omitempty"`
}

type BaremetalMachineStatus struct {
    // Ready indicates the machine is ready to receive workloads
    Ready bool `json:"ready"`

    // Addresses is the list of IP addresses for this machine
    Addresses []clusterv1.MachineAddress `json:"addresses,omitempty"`

    // Conditions defines current service state of the BaremetalMachine
    Conditions clusterv1.Conditions `json:"conditions,omitempty"`

    // ProvisioningState is the current state of the provisioning process
    ProvisioningState string `json:"provisioningState,omitempty"`

    // FailureReason is a short, machine-readable reason for the failure
    FailureReason *string `json:"failureReason,omitempty"`

    // FailureMessage is a human-readable description of the failure
    FailureMessage *string `json:"failureMessage,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type="boolean",JSONPath=".status.ready"
// +kubebuilder:printcolumn:name="Provisioning State",type="string",JSONPath=".status.provisioningState"

type BaremetalMachine struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec   BaremetalMachineSpec   `json:"spec,omitempty"`
    Status BaremetalMachineStatus `json:"status,omitempty"`
}
```

### Infrastructure Machine Controller

```go
// controllers/baremetalmachine_controller.go
package controllers

import (
    "context"
    "fmt"

    "github.com/go-logr/logr"
    corev1 "k8s.io/api/core/v1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/runtime"
    clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
    "sigs.k8s.io/cluster-api/util"
    "sigs.k8s.io/cluster-api/util/conditions"
    "sigs.k8s.io/cluster-api/util/patch"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

    infrav1 "github.com/your-org/cluster-api-provider-baremetal/api/v1beta1"
    "github.com/your-org/cluster-api-provider-baremetal/pkg/baremetal"
)

const (
    machineFinalizer = "baremetalmachine.infrastructure.cluster.x-k8s.io"
)

type BaremetalMachineReconciler struct {
    client.Client
    Scheme   *runtime.Scheme
    Logger   logr.Logger
    BMClient baremetal.Client
}

func (r *BaremetalMachineReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    log := r.Logger.WithValues("baremetalmachine", req.NamespacedName)

    // Fetch the BaremetalMachine
    baremetalMachine := &infrav1.BaremetalMachine{}
    if err := r.Get(ctx, req.NamespacedName, baremetalMachine); err != nil {
        if apierrors.IsNotFound(err) {
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, err
    }

    // Fetch the CAPI Machine that owns this BaremetalMachine
    machine, err := util.GetOwnerMachine(ctx, r.Client, baremetalMachine.ObjectMeta)
    if err != nil {
        return ctrl.Result{}, err
    }
    if machine == nil {
        log.Info("Machine controller has not yet set OwnerRef")
        return ctrl.Result{}, nil
    }

    // Fetch the CAPI Cluster
    cluster, err := util.GetClusterFromMetadata(ctx, r.Client, machine.ObjectMeta)
    if err != nil {
        return ctrl.Result{}, err
    }

    // Initialize the patch helper to emit status updates
    patchHelper, err := patch.NewHelper(baremetalMachine, r.Client)
    if err != nil {
        return ctrl.Result{}, err
    }
    defer func() {
        if err := patchHelper.Patch(ctx, baremetalMachine,
            patch.WithOwnedConditions{Conditions: []clusterv1.ConditionType{
                clusterv1.ReadyCondition,
                infrav1.InstanceProvisionedCondition,
            }},
        ); err != nil {
            log.Error(err, "failed to patch BaremetalMachine")
        }
    }()

    // Handle deletion
    if !baremetalMachine.ObjectMeta.DeletionTimestamp.IsZero() {
        return r.reconcileDelete(ctx, log, baremetalMachine)
    }

    // Add finalizer if not present
    if !controllerutil.ContainsFinalizer(baremetalMachine, machineFinalizer) {
        controllerutil.AddFinalizer(baremetalMachine, machineFinalizer)
        return ctrl.Result{}, nil
    }

    // Normal reconcile
    return r.reconcileNormal(ctx, log, cluster, machine, baremetalMachine)
}

func (r *BaremetalMachineReconciler) reconcileNormal(
    ctx context.Context,
    log logr.Logger,
    cluster *clusterv1.Cluster,
    machine *clusterv1.Machine,
    baremetalMachine *infrav1.BaremetalMachine,
) (ctrl.Result, error) {

    // Check if bootstrap data is ready
    if machine.Spec.Bootstrap.DataSecretName == nil {
        log.Info("Bootstrap data not yet available, requeuing")
        return ctrl.Result{RequeueAfter: 10}, nil
    }

    // Get bootstrap data
    bootstrapSecret := &corev1.Secret{}
    if err := r.Get(ctx, client.ObjectKey{
        Namespace: machine.Namespace,
        Name:      *machine.Spec.Bootstrap.DataSecretName,
    }, bootstrapSecret); err != nil {
        return ctrl.Result{}, fmt.Errorf("failed to get bootstrap secret: %w", err)
    }
    bootstrapData := bootstrapSecret.Data["value"]

    // If ProviderID is already set, the server was already provisioned
    if baremetalMachine.Spec.ProviderID != nil {
        // Verify the server is still healthy
        serverID := extractServerID(*baremetalMachine.Spec.ProviderID)
        server, err := r.BMClient.GetServer(ctx, serverID)
        if err != nil {
            return ctrl.Result{}, fmt.Errorf("failed to get server status: %w", err)
        }

        if server.State == "active" {
            baremetalMachine.Status.Ready = true
            conditions.MarkTrue(baremetalMachine, infrav1.InstanceProvisionedCondition)
        }
        return ctrl.Result{}, nil
    }

    // Find an available server from the pool
    servers, err := r.BMClient.ListAvailableServers(ctx, baremetalMachine.Spec.ServerSelector)
    if err != nil {
        return ctrl.Result{}, fmt.Errorf("failed to list available servers: %w", err)
    }

    if len(servers) == 0 {
        log.Info("No available servers found, requeuing")
        conditions.MarkFalse(
            baremetalMachine,
            infrav1.InstanceProvisionedCondition,
            infrav1.WaitingForServerReason,
            clusterv1.ConditionSeverityWarning,
            "No available servers matching selector",
        )
        return ctrl.Result{RequeueAfter: 30}, nil
    }

    // Provision the first available server
    server := servers[0]
    log.Info("Provisioning server", "serverID", server.ID)

    if err := r.BMClient.ProvisionServer(ctx, baremetal.ProvisionRequest{
        ServerID:      server.ID,
        Image:         baremetalMachine.Spec.Image,
        UserData:      string(bootstrapData),
        ClusterName:   cluster.Name,
        MachineName:   machine.Name,
    }); err != nil {
        return ctrl.Result{}, fmt.Errorf("failed to provision server: %w", err)
    }

    // Update ProviderID
    providerID := fmt.Sprintf("baremetal://%s", server.ID)
    baremetalMachine.Spec.ProviderID = &providerID
    baremetalMachine.Status.ProvisioningState = "Provisioning"

    conditions.MarkFalse(
        baremetalMachine,
        infrav1.InstanceProvisionedCondition,
        infrav1.ProvisioningReason,
        clusterv1.ConditionSeverityInfo,
        "Server is being provisioned",
    )

    return ctrl.Result{RequeueAfter: 30}, nil
}

func (r *BaremetalMachineReconciler) reconcileDelete(
    ctx context.Context,
    log logr.Logger,
    baremetalMachine *infrav1.BaremetalMachine,
) (ctrl.Result, error) {

    if baremetalMachine.Spec.ProviderID != nil {
        serverID := extractServerID(*baremetalMachine.Spec.ProviderID)
        log.Info("Deprovisioning server", "serverID", serverID)

        if err := r.BMClient.DeprovisionServer(ctx, serverID); err != nil {
            return ctrl.Result{}, fmt.Errorf("failed to deprovision server: %w", err)
        }
    }

    controllerutil.RemoveFinalizer(baremetalMachine, machineFinalizer)
    return ctrl.Result{}, nil
}

func extractServerID(providerID string) string {
    // "baremetal://server-id" -> "server-id"
    return providerID[len("baremetal://"):]
}

func (r *BaremetalMachineReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&infrav1.BaremetalMachine{}).
        Complete(r)
}
```

## Section 8: Operational Best Practices

### Health Monitoring

```bash
# Check CAPI controller health
kubectl get pods -n capi-system -n capa-system -n capi-kubeadm-bootstrap-system

# Check for stuck reconciliations
kubectl get clusters --all-namespaces -o custom-columns=\
NAME:.metadata.name,NAMESPACE:.metadata.namespace,PHASE:.status.phase,READY:.status.conditions[0].status

# Get all machines and their states
kubectl get machines --all-namespaces -o custom-columns=\
NAME:.metadata.name,NODE:.status.nodeRef.name,PHASE:.status.phase,READY:.status.conditions[0].status

# Check for failed machines
kubectl get machines --all-namespaces \
  -o jsonpath='{.items[?(@.status.phase=="Failed")].metadata.name}'
```

### Backup and Recovery

```bash
# Backup all CAPI resources for disaster recovery
kubectl get clusters,machinedeployments,machines,machinesets \
  --all-namespaces -o yaml > capi-backup-$(date +%Y%m%d).yaml

# Pivot management cluster (move CAPI to a different management cluster)
clusterctl move \
  --to-kubeconfig new-management.kubeconfig \
  --namespace capi-workloads
```

## Conclusion

Cluster API transforms Kubernetes cluster management from a procedural, error-prone process into a declarative, GitOps-compatible workflow. The core value proposition is treating clusters as cattle: standardized, reproducible, and managed at scale through the same reconciliation loop that manages application workloads. ClusterClass templating eliminates the per-cluster boilerplate while maintaining flexibility through the variables and patches mechanism. The ability to build custom providers means CAPI can extend to any infrastructure platform. For organizations managing more than 10 clusters, the investment in CAPI-based fleet management pays dividends through reduced operational overhead, consistent security baselines, and the ability to perform Kubernetes version upgrades across hundreds of clusters with a single manifest update.
