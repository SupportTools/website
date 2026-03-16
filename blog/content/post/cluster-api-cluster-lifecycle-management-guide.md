---
title: "Cluster API: Declarative Kubernetes Cluster Lifecycle Management"
date: 2027-04-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "Cluster Lifecycle", "Infrastructure as Code"]
categories: ["Kubernetes", "Cluster Lifecycle", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Cluster API (CAPI) for declarative Kubernetes cluster management, covering management cluster setup, AWS/vSphere provider configuration, Machine and MachineDeployment CRDs, rolling upgrades, MachineHealthCheck for auto-remediation, and ClusterClass for standardized cluster templates."
more_link: "yes"
url: "/cluster-api-cluster-lifecycle-management-guide/"
---

Every Kubernetes cluster eventually needs to be upgraded, scaled, or replaced. When the fleet grows beyond a handful of clusters, the manual ceremony of provisioning nodes, joining them to the control plane, and coordinating rolling version upgrades becomes a bottleneck. Cluster API (CAPI) applies the same declarative, reconciliation-based approach that Kubernetes uses for application workloads to the problem of cluster infrastructure itself. A `Cluster` object is the desired state; the management cluster's controllers drive the infrastructure toward that state continuously.

This guide covers the complete CAPI operational model: management cluster bootstrap, provider installation for AWS and vSphere, the core CRD hierarchy, rolling Kubernetes version upgrades, MachineHealthCheck for automatic node remediation, ClusterClass for standardized cluster templates, and GitOps integration with ArgoCD.

<!--more-->

## Section 1: CAPI Architecture

### Core Concepts

CAPI separates cluster management responsibilities across three provider categories:

- **Bootstrap provider (CABPK)**: Generates machine bootstrap data (cloud-init, ignition) that installs the Kubernetes binaries and joins the node to the cluster. The Kubeadm Bootstrap Provider is the standard implementation.
- **Control plane provider (KCP)**: Manages the lifecycle of control plane nodes as a group — creating, replacing, and scaling etcd and kube-apiserver members while maintaining quorum. The Kubeadm Control Plane provider is the standard.
- **Infrastructure provider**: Provisions the actual compute (EC2 instances, vSphere VMs, Azure VMs) and network resources. Provider-specific: CAPA (AWS), CAPV (vSphere), CAPZ (Azure), CAPM3 (bare metal).

### Management vs Workload Clusters

The management cluster runs the CAPI controllers and stores cluster state in its etcd. Workload clusters are the Kubernetes clusters provisioned and managed by CAPI — they run actual application workloads. The management cluster itself is initially bootstrapped with a tool like `kind` or an existing cluster, and is then typically "pivoted" so it manages itself.

## Section 2: Management Cluster Bootstrap

### Prerequisites

```bash
# Install clusterctl CLI
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.7.2/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl
clusterctl version

# Create a temporary management cluster with kind
cat > /tmp/kind-management.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: capi-management
nodes:
  - role: control-plane
    extraMounts:
      # Mount Docker socket for provider integration in dev environments
      - hostPath: /var/run/docker.sock
        containerPath: /var/run/docker.sock
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "node-role.kubernetes.io/master="
EOF
kind create cluster --config=/tmp/kind-management.yaml
kubectl cluster-info --context kind-capi-management
```

### Initialize Providers

```bash
# Set provider credentials as environment variables before clusterctl init
# AWS credentials (used by CAPA to call EC2 APIs)
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID="EXAMPLE_ACCESS_KEY_REPLACE_ME"
export AWS_SECRET_ACCESS_KEY="EXAMPLE_SECRET_KEY_REPLACE_ME"
# For session-based auth:
# export AWS_SESSION_TOKEN="EXAMPLE_SESSION_TOKEN_REPLACE_ME"

# EKS support flag (optional — needed only if managing EKS clusters)
export EXP_EKS=false
export EXP_EKS_IAM=false
export EXP_MACHINE_POOL=true

# Initialize the management cluster with AWS provider
clusterctl init \
  --infrastructure aws:v2.5.2 \
  --core cluster-api:v1.7.2 \
  --bootstrap kubeadm:v1.7.2 \
  --control-plane kubeadm:v1.7.2

# Verify all controllers are running
kubectl get pods -n capi-system
kubectl get pods -n capa-system
kubectl get pods -n capi-kubeadm-bootstrap-system
kubectl get pods -n capi-kubeadm-control-plane-system
```

### Install vSphere Provider (CAPV)

```bash
# vSphere credentials for CAPV
export VSPHERE_SERVER="vcenter.example.com"
export VSPHERE_USERNAME="capi-svc@vsphere.local"
export VSPHERE_PASSWORD="EXAMPLE_VSPHERE_PASSWORD_REPLACE_ME"
export VSPHERE_TLS_THUMBPRINT="AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD"

clusterctl init \
  --infrastructure vsphere:v1.10.2 \
  --core cluster-api:v1.7.2 \
  --bootstrap kubeadm:v1.7.2 \
  --control-plane kubeadm:v1.7.2

kubectl get pods -n capv-system
```

## Section 3: Cluster and Infrastructure CRDs

### AWS Cluster Manifest

A CAPI workload cluster is described by a set of related objects: `Cluster` (core), `AWSCluster` (infrastructure), `KubeadmControlPlane` (control plane), `AWSMachineTemplate` (infrastructure template for control plane nodes), `MachineDeployment` (worker node group), and a second `AWSMachineTemplate` for workers.

```yaml
# cluster-aws-payments-prod.yaml — complete cluster definition
---
# Core cluster object — references the infrastructure and control plane
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: payments-prod
  namespace: capi-clusters
  labels:
    env: prod
    team: payments
    region: us-east-1
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
        - 10.244.0.0/16      # pod CIDR
    services:
      cidrBlocks:
        - 10.96.0.0/12       # service CIDR
    serviceDomain: cluster.local
  # Reference to the infrastructure provider object
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: payments-prod
  # Reference to the control plane provider object
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: payments-prod-control-plane
---
# AWS-specific cluster configuration
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: payments-prod
  namespace: capi-clusters
spec:
  region: us-east-1
  sshKeyName: platform-team-keypair
  # VPC configuration — use existing VPC or let CAPA create one
  network:
    vpc:
      id: vpc-0a1b2c3d4e5f6a7b8     # use existing VPC
      cidrBlock: 10.0.0.0/16
    subnets:
      # Private subnets for worker nodes
      - id: subnet-0a1b2c3d4e5f6a7b1
        availabilityZone: us-east-1a
        isPublic: false
      - id: subnet-0a1b2c3d4e5f6a7b2
        availabilityZone: us-east-1b
        isPublic: false
      - id: subnet-0a1b2c3d4e5f6a7b3
        availabilityZone: us-east-1c
        isPublic: false
      # Public subnets for load balancers
      - id: subnet-0a1b2c3d4e5f6b001
        availabilityZone: us-east-1a
        isPublic: true
      - id: subnet-0a1b2c3d4e5f6b002
        availabilityZone: us-east-1b
        isPublic: true
  # IAM instance profile for control plane nodes
  controlPlaneLoadBalancer:
    scheme: internet-facing    # or internal for private clusters
  additionalTags:
    Environment: production
    Team: payments
    ManagedBy: cluster-api
```

### KubeadmControlPlane

```yaml
# kubeadm-control-plane-payments-prod.yaml
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: payments-prod-control-plane
  namespace: capi-clusters
spec:
  replicas: 3    # HA control plane — must be odd
  version: v1.29.4    # Kubernetes version to provision
  # Reference to the infrastructure template for control plane nodes
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSMachineTemplate
      name: payments-prod-control-plane-mt
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: aws
          node-labels: "node-role.kubernetes.io/control-plane="
    clusterConfiguration:
      apiServer:
        extraArgs:
          audit-log-path: /var/log/kubernetes/audit.log
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "100"
          audit-policy-file: /etc/kubernetes/audit-policy.yaml
          enable-admission-plugins: NodeRestriction,PodSecurity
          oidc-issuer-url: "https://example.okta.com/oauth2/default"
          oidc-client-id: "kubernetes"
          oidc-username-claim: "email"
          oidc-groups-claim: "groups"
        extraVolumes:
          - name: audit-policy
            hostPath: /etc/kubernetes/audit-policy.yaml
            mountPath: /etc/kubernetes/audit-policy.yaml
            readOnly: true
      controllerManager:
        extraArgs:
          cloud-provider: aws
          allocate-node-cidrs: "true"
          cluster-cidr: 10.244.0.0/16
      etcd:
        local:
          extraArgs:
            election-timeout: "5000"
            heartbeat-interval: "500"
    joinConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: aws
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
              verbs: ["create", "update", "patch", "delete"]
            - level: None
              resources:
                - group: ""
                  resources: ["events"]
    preKubeadmCommands:
      - apt-get update -y
      - apt-get install -y containerd
      - systemctl enable containerd
      - sysctl -w net.bridge.bridge-nf-call-iptables=1
      - sysctl -w net.ipv4.ip_forward=1
  # Rolling update strategy for control plane upgrades
  rolloutStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1    # bring up one new node before removing the old one
```

### AWSMachineTemplate for Control Plane

```yaml
# aws-machine-template-cp.yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: payments-prod-control-plane-mt
  namespace: capi-clusters
spec:
  template:
    spec:
      instanceType: m5.xlarge    # 4 vCPU, 16 GB — sized for control plane
      iamInstanceProfile: control-plane.cluster-api-provider-aws.sigs.k8s.io
      ami:
        id: ami-0a1b2c3d4e5f6a7b8    # Ubuntu 22.04 LTS AMI with containerd
      sshKeyName: platform-team-keypair
      rootVolume:
        size: 100    # GB
        type: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        encryptionKey: arn:aws:kms:us-east-1:123456789012:key/example-key-id-replace-me
      additionalSecurityGroups:
        - id: sg-0a1b2c3d4e5f6a7b8   # platform security group for monitoring
      nonRootVolumes:
        - deviceName: /dev/sdb
          size: 50
          type: gp3
          encrypted: true
```

## Section 4: MachineDeployment for Worker Nodes

```yaml
# machine-deployment-workers.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: payments-prod-workers
  namespace: capi-clusters
  labels:
    cluster.x-k8s.io/cluster-name: payments-prod
spec:
  clusterName: payments-prod
  replicas: 6    # initial worker node count
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: payments-prod
      cluster.x-k8s.io/deployment-name: payments-prod-workers
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: payments-prod
        cluster.x-k8s.io/deployment-name: payments-prod-workers
    spec:
      clusterName: payments-prod
      version: v1.29.4    # must match KubeadmControlPlane version
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: payments-prod-workers-kct
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: payments-prod-workers-mt
  # Rolling update strategy for worker upgrades
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1       # create 1 new node before deleting old
      maxUnavailable: 0  # zero downtime rolling update
---
# KubeadmConfigTemplate for workers
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: payments-prod-workers-kct
  namespace: capi-clusters
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          name: "{{ ds.meta_data.local_hostname }}"
          kubeletExtraArgs:
            cloud-provider: aws
            node-labels: "node-role.kubernetes.io/worker=,team=payments,env=prod"
      preKubeadmCommands:
        - apt-get update -y
        - apt-get install -y containerd
        - systemctl enable containerd
        - sysctl -w net.bridge.bridge-nf-call-iptables=1
        - sysctl -w net.ipv4.ip_forward=1
---
# AWSMachineTemplate for workers
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: payments-prod-workers-mt
  namespace: capi-clusters
spec:
  template:
    spec:
      instanceType: m5.2xlarge    # 8 vCPU, 32 GB — sized for application workloads
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
      ami:
        id: ami-0a1b2c3d4e5f6a7b8
      sshKeyName: platform-team-keypair
      rootVolume:
        size: 200
        type: gp3
        iops: 3000
        encrypted: true
        encryptionKey: arn:aws:kms:us-east-1:123456789012:key/example-key-id-replace-me
      additionalSecurityGroups:
        - id: sg-0a1b2c3d4e5f6a7b8
      spotMarketOptions:    # use Spot instances for cost reduction where appropriate
        maxPrice: "0.25"    # max price per hour; empty = on-demand price cap
```

### Multiple Worker Node Groups

```yaml
# machine-deployment-gpu-workers.yaml — GPU node group for ML workloads
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: payments-prod-gpu-workers
  namespace: capi-clusters
spec:
  clusterName: payments-prod
  replicas: 2
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: payments-prod
      cluster.x-k8s.io/deployment-name: payments-prod-gpu-workers
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: payments-prod
        cluster.x-k8s.io/deployment-name: payments-prod-gpu-workers
    spec:
      clusterName: payments-prod
      version: v1.29.4
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: payments-prod-gpu-workers-kct
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: payments-prod-gpu-workers-mt
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: payments-prod-gpu-workers-mt
  namespace: capi-clusters
spec:
  template:
    spec:
      instanceType: g4dn.xlarge    # NVIDIA T4 GPU instance
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
      ami:
        id: ami-0b2c3d4e5f6a7b8c9    # GPU-specific AMI with CUDA drivers
      sshKeyName: platform-team-keypair
      rootVolume:
        size: 200
        type: gp3
        encrypted: true
```

## Section 5: Rolling Kubernetes Version Upgrade

CAPI upgrades proceed in two steps: update the `KubeadmControlPlane` version first (which performs a rolling control plane upgrade), then update all `MachineDeployment` versions.

```bash
#!/usr/bin/env bash
# upgrade-cluster.sh — rolling upgrade of a CAPI-managed cluster
set -euo pipefail

CLUSTER_NAME="${1:?Cluster name required}"
NEW_VERSION="${2:?New Kubernetes version required (e.g. v1.30.1)}"
NAMESPACE="${3:-capi-clusters}"

echo "=== Upgrading cluster ${CLUSTER_NAME} to ${NEW_VERSION} ==="

# Validate the target version is supported by the bootstrap provider
clusterctl get kubeconfig "${CLUSTER_NAME}" -n "${NAMESPACE}" > /tmp/workload-kubeconfig
kubectl --kubeconfig=/tmp/workload-kubeconfig version

echo "Step 1: Upgrade control plane to ${NEW_VERSION}"
kubectl patch kubeadmcontrolplane "${CLUSTER_NAME}-control-plane" \
  -n "${NAMESPACE}" \
  --type=merge \
  -p "{\"spec\":{\"version\":\"${NEW_VERSION}\"}}"

echo "Waiting for control plane upgrade to complete..."
# Poll until all control plane replicas are at the new version
while true; do
  READY=$(kubectl get kubeadmcontrolplane "${CLUSTER_NAME}-control-plane" \
    -n "${NAMESPACE}" \
    -o jsonpath='{.status.readyReplicas}')
  UPDATED=$(kubectl get kubeadmcontrolplane "${CLUSTER_NAME}-control-plane" \
    -n "${NAMESPACE}" \
    -o jsonpath='{.status.updatedReplicas}')
  DESIRED=$(kubectl get kubeadmcontrolplane "${CLUSTER_NAME}-control-plane" \
    -n "${NAMESPACE}" \
    -o jsonpath='{.spec.replicas}')

  echo "Control plane: ready=${READY} updated=${UPDATED} desired=${DESIRED}"
  if [[ "${READY}" == "${DESIRED}" && "${UPDATED}" == "${DESIRED}" ]]; then
    break
  fi
  sleep 30
done

echo "Step 2: Upgrade worker MachineDeployments to ${NEW_VERSION}"
# Iterate over all MachineDeployments for this cluster
for MD in $(kubectl get machinedeployment -n "${NAMESPACE}" \
    -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
    -o jsonpath='{.items[*].metadata.name}'); do

  echo "  Upgrading MachineDeployment ${MD}..."
  kubectl patch machinedeployment "${MD}" \
    -n "${NAMESPACE}" \
    --type=merge \
    -p "{\"spec\":{\"template\":{\"spec\":{\"version\":\"${NEW_VERSION}\"}}}}"

  # Also update the AWSMachineTemplate to the new AMI if needed
  # This requires creating a new AWSMachineTemplate and referencing it
done

echo "Waiting for all worker nodes to update..."
while true; do
  ALL_READY=true
  for MD in $(kubectl get machinedeployment -n "${NAMESPACE}" \
      -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
      -o jsonpath='{.items[*].metadata.name}'); do
    READY=$(kubectl get machinedeployment "${MD}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.readyReplicas}')
    DESIRED=$(kubectl get machinedeployment "${MD}" -n "${NAMESPACE}" \
      -o jsonpath='{.spec.replicas}')
    UPDATED=$(kubectl get machinedeployment "${MD}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.updatedReplicas}')
    echo "  ${MD}: ready=${READY} updated=${UPDATED} desired=${DESIRED}"
    if [[ "${READY}" != "${DESIRED}" || "${UPDATED}" != "${DESIRED}" ]]; then
      ALL_READY=false
    fi
  done
  if [[ "${ALL_READY}" == "true" ]]; then
    break
  fi
  sleep 30
done

echo "=== Upgrade complete: ${CLUSTER_NAME} is now running ${NEW_VERSION} ==="
kubectl --kubeconfig=/tmp/workload-kubeconfig get nodes
```

## Section 6: MachineHealthCheck for Automatic Node Remediation

`MachineHealthCheck` watches Machine objects and triggers replacement when a node fails health conditions for a specified duration.

```yaml
# machinehealthcheck-workers.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: payments-prod-worker-health
  namespace: capi-clusters
spec:
  clusterName: payments-prod
  # Match all worker machines in this cluster
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: payments-prod
      cluster.x-k8s.io/deployment-name: payments-prod-workers

  unhealthyConditions:
    # Node is not reporting Ready for 5 minutes
    - type: Ready
      status: Unknown
      timeout: 5m
    # Node explicitly reports NotReady for 5 minutes
    - type: Ready
      status: "False"
      timeout: 5m
    # Node reports MemoryPressure for 2 minutes
    - type: MemoryPressure
      status: "True"
      timeout: 2m
    # Node reports DiskPressure for 2 minutes
    - type: DiskPressure
      status: "True"
      timeout: 2m

  # Maximum number of machines that can be remediated simultaneously
  # Expressed as a percentage or absolute integer
  maxUnhealthy: "33%"    # never remediate more than 33% at once (protects quorum)

  # Duration between remediation checks
  # nodeStartupTimeout: 10m  # time to wait for new node to join before considering failed
---
# MachineHealthCheck for control plane — more conservative thresholds
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: payments-prod-controlplane-health
  namespace: capi-clusters
spec:
  clusterName: payments-prod
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: payments-prod
      cluster.x-k8s.io/control-plane: ""
  unhealthyConditions:
    - type: Ready
      status: Unknown
      timeout: 10m    # longer timeout for control plane nodes
    - type: Ready
      status: "False"
      timeout: 10m
  maxUnhealthy: "1"    # never remediate more than 1 control plane node at once
```

## Section 7: ClusterClass for Standardized Cluster Templates

`ClusterClass` is a CAPI v1beta1 feature that defines a reusable cluster topology template. Platform teams publish `ClusterClass` objects; application teams consume them by referencing the class in a `Cluster` object, providing only the variable values that differ between clusters.

### Defining a ClusterClass

```yaml
# clusterclass-aws-standard.yaml — platform team's standard cluster blueprint
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: aws-standard-v1
  namespace: capi-clusters
spec:
  # Control plane topology
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: aws-standard-v1-cp-template
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: aws-standard-v1-cp-mt

  # Infrastructure template
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: aws-standard-v1-cluster-template

  # Worker node topology (named groups)
  workers:
    machineDeployments:
      - class: default-workers
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: aws-standard-v1-worker-kct
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: aws-standard-v1-worker-mt

  # Variables that callers can override when creating a Cluster
  variables:
    - name: region
      required: true
      schema:
        openAPIV3Schema:
          type: string
          enum: [us-east-1, eu-west-1, ap-southeast-1]
    - name: kubernetesVersion
      required: true
      schema:
        openAPIV3Schema:
          type: string
          example: v1.29.4
    - name: workerReplicas
      required: false
      schema:
        openAPIV3Schema:
          type: integer
          minimum: 1
          maximum: 100
          default: 3
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

  # Patch transforms that apply the variable values to the referenced templates
  patches:
    - name: set-kubernetes-version
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
        - selector:
            apiVersion: cluster.x-k8s.io/v1beta1
            kind: MachineDeployment
            matchResources:
              machineDeploymentClass:
                names: ["default-workers"]
          jsonPatches:
            - op: replace
              path: /spec/template/spec/version
              valueFrom:
                variable: kubernetesVersion

    - name: set-worker-replicas
      definitions:
        - selector:
            apiVersion: cluster.x-k8s.io/v1beta1
            kind: MachineDeployment
            matchResources:
              machineDeploymentClass:
                names: ["default-workers"]
          jsonPatches:
            - op: replace
              path: /spec/replicas
              valueFrom:
                variable: workerReplicas

    - name: set-worker-instance-type
      definitions:
        - selector:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
            kind: AWSMachineTemplate
            matchResources:
              machineDeploymentClass:
                names: ["default-workers"]
          jsonPatches:
            - op: replace
              path: /spec/template/spec/instanceType
              valueFrom:
                variable: workerInstanceType
```

### Consuming a ClusterClass

```yaml
# cluster-from-clusterclass.yaml — application team creates a cluster from the template
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: team-data-staging
  namespace: capi-clusters
  labels:
    env: staging
    team: data
spec:
  # Reference the ClusterClass instead of individual templates
  topology:
    class: aws-standard-v1     # name of the ClusterClass
    version: v1.29.4           # Kubernetes version

    # Override the default variable values
    variables:
      - name: region
        value: us-east-1
      - name: kubernetesVersion
        value: v1.29.4
      - name: workerReplicas
        value: 4
      - name: workerInstanceType
        value: m5.xlarge

    # Configure the named worker groups
    workers:
      machineDeployments:
        - class: default-workers
          name: workers
          replicas: 4
```

## Section 8: Cluster Observability

### Checking Cluster Status

```bash
# Overview of all clusters and their provisioning status
kubectl get clusters -A

# Detailed status of a specific cluster
clusterctl describe cluster payments-prod -n capi-clusters

# Get the kubeconfig for a workload cluster
clusterctl get kubeconfig payments-prod -n capi-clusters > ~/.kube/payments-prod.kubeconfig
export KUBECONFIG=~/.kube/payments-prod.kubeconfig
kubectl get nodes

# List all Machines across all clusters
kubectl get machines -A

# List MachineDeployments and their replica counts
kubectl get machinedeployments -A

# Check MachineHealthCheck status
kubectl get machinehealthchecks -A

# View events for a cluster (useful for debugging provisioning failures)
kubectl get events -n capi-clusters \
  --field-selector involvedObject.name=payments-prod \
  --sort-by='.lastTimestamp'
```

### Prometheus Metrics for CAPI

```yaml
# prometheusrule-capi.yaml — alerts for cluster provisioning issues
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: capi-cluster-alerts
  namespace: monitoring
spec:
  groups:
    - name: capi.clusters
      rules:
        # Alert if a cluster is not provisioned within 30 minutes
        - alert: CAPIClusterProvisioningTimeout
          expr: |
            (time() - capi_cluster_created_timestamp) > 1800
            and capi_cluster_phase != 4   # 4 = Provisioned
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CAPI cluster {{ $labels.name }} has not provisioned in 30 minutes"

        # Alert if a MachineHealthCheck is remediating machines
        - alert: CAPINodeRemediation
          expr: capi_machinehealthcheck_unhealthy_machines_total > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "CAPI is remediating unhealthy nodes in cluster {{ $labels.cluster }}"
```

## Section 9: GitOps Integration with ArgoCD

Managing CAPI cluster manifests through ArgoCD closes the loop between cluster lifecycle changes and the Git audit trail.

### ArgoCD Application for CAPI Clusters

```yaml
# argocd-app-capi-clusters.yaml — ArgoCD manages CAPI cluster manifests
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: capi-clusters
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/example-org/platform-config.git
    targetRevision: main
    path: capi/clusters   # directory containing all Cluster, KCP, MD manifests
  destination:
    server: https://kubernetes.default.svc   # management cluster
    namespace: capi-clusters
  syncPolicy:
    automated:
      prune: false        # NEVER prune CAPI cluster objects automatically
      selfHeal: true      # restore if manually mutated
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
      - RespectIgnoreDifferences=true
  # Ignore CAPI-managed status fields and infrastructure IDs that change after creation
  ignoreDifferences:
    - group: infrastructure.cluster.x-k8s.io
      kind: AWSCluster
      jsonPointers:
        - /spec/network/vpc/id           # populated by CAPA after VPC is created
        - /spec/network/subnets
        - /status
    - group: cluster.x-k8s.io
      kind: Cluster
      jsonPointers:
        - /status
    - group: controlplane.cluster.x-k8s.io
      kind: KubeadmControlPlane
      jsonPointers:
        - /status
    - group: cluster.x-k8s.io
      kind: MachineDeployment
      jsonPointers:
        - /status
        - /metadata/annotations/machinedeployment.clusters.x-k8s.io~1revision
```

### Workflow: New Cluster from Git Commit

```bash
# 1. Platform engineer creates cluster manifests in the Git repo
mkdir -p capi/clusters/team-frontend-staging
cat > capi/clusters/team-frontend-staging/cluster.yaml <<'EOF'
# ... Cluster, KCP, MachineDeployment manifests ...
EOF

# 2. Commit and push
git add capi/clusters/team-frontend-staging/
git commit -m "feat: provision team-frontend-staging cluster"
git push origin main

# 3. ArgoCD detects the new path and creates the CAPI objects
# (takes ~2-5 minutes for ArgoCD sync interval or manual trigger)
argocd app sync capi-clusters

# 4. CAPI controllers provision the cluster (~15-25 minutes for AWS)
watch kubectl get clusters,kubeadmcontrolplanes,machinedeployments \
  -n capi-clusters \
  -l cluster.x-k8s.io/cluster-name=team-frontend-staging

# 5. Once provisioned, retrieve the kubeconfig and bootstrap ArgoCD on it
clusterctl get kubeconfig team-frontend-staging \
  -n capi-clusters > /tmp/team-frontend-staging.kubeconfig

KUBECONFIG=/tmp/team-frontend-staging.kubeconfig \
  argocd cluster add team-frontend-staging-context
```

## Section 10: Multi-Provider Fleet Management

Large enterprises frequently span AWS, vSphere on-premises, and Azure cloud. CAPI's provider model allows a single management cluster to govern clusters across all three.

```bash
# Initialize all three providers on the management cluster
clusterctl init \
  --infrastructure aws:v2.5.2,vsphere:v1.10.2,azure:v1.14.2 \
  --core cluster-api:v1.7.2 \
  --bootstrap kubeadm:v1.7.2 \
  --control-plane kubeadm:v1.7.2

# List available providers and their versions
clusterctl get providers

# Upgrade a specific provider without upgrading others
clusterctl upgrade plan
clusterctl upgrade apply \
  --infrastructure aws:v2.6.0
```

### vSphere Cluster Manifest (CAPV)

```yaml
# cluster-vsphere-payments-prod.yaml — vSphere cluster
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: payments-prod-vsphere
  namespace: capi-clusters
spec:
  clusterNetwork:
    pods:
      cidrBlocks: [10.244.0.0/16]
    services:
      cidrBlocks: [10.96.0.0/12]
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: VSphereCluster
    name: payments-prod-vsphere
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: payments-prod-vsphere-cp
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: VSphereCluster
metadata:
  name: payments-prod-vsphere
  namespace: capi-clusters
spec:
  server: vcenter.example.com
  thumbprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD"
  identityRef:
    kind: Secret
    name: vsphere-credentials   # contains username and password
  controlPlaneEndpoint:
    host: 10.10.100.50          # static VIP for the control plane load balancer
    port: 6443
```

## Summary

Cluster API transforms cluster provisioning from a runbook exercise into a declarative, reconciliation-driven workflow. The `Cluster`, `KubeadmControlPlane`, `MachineDeployment`, and provider-specific infrastructure objects together describe the complete desired state of a Kubernetes cluster. CAPI controllers continuously reconcile that desired state against the actual state of the cloud or hypervisor, replacing failed nodes via `MachineHealthCheck`, executing rolling version upgrades by sequentially replacing machines, and maintaining control plane quorum throughout.

`ClusterClass` extends this model to fleet standardization: platform teams publish a versioned cluster template that encodes all organizational policies (audit logging, OIDC integration, encryption keys), and application teams consume the template by supplying only the values that vary (region, worker count, instance size). GitOps integration with ArgoCD provides the audit trail and change management layer that connects Git commits to cluster provisioning events, making the entire cluster lifecycle reviewable and reproducible from source control.
