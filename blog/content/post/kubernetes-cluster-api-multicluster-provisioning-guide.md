---
title: "Cluster API: Declarative Kubernetes Cluster Lifecycle Management"
date: 2027-12-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "Multi-Cluster", "Infrastructure as Code", "kubeadm"]
categories: ["Kubernetes", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Cluster API (CAPI) covering management and workload cluster architecture, infrastructure providers, ClusterClass, MachineHealthCheck, fleet upgrades, and production operations."
more_link: "yes"
url: "/kubernetes-cluster-api-multicluster-provisioning-guide/"
---

Cluster API (CAPI) transforms Kubernetes cluster lifecycle management from a collection of imperative scripts into a declarative, Kubernetes-native workflow. By representing clusters, machines, and infrastructure as custom resources within a management cluster, CAPI enables consistent provisioning, upgrading, and decommissioning of workload clusters across AWS, GCP, Azure, vSphere, and bare metal — at fleet scale.

This guide covers the full operational surface: provider installation with clusterctl, ClusterClass topology, MachinePool management, zero-downtime upgrades, MachineHealthCheck remediation, and multi-cluster fleet governance patterns used in production environments managing hundreds of clusters.

<!--more-->

# Cluster API: Declarative Kubernetes Cluster Lifecycle Management

## Section 1: Architecture — Management vs. Workload Clusters

CAPI introduces a clear separation between the **management cluster** (which hosts CAPI controllers and stores cluster state) and **workload clusters** (the clusters being managed). The management cluster never runs production workloads directly; its sole function is reconciling the desired state of downstream clusters.

### Component Hierarchy

```
Management Cluster
├── CAPI Core Controller Manager
│   ├── Cluster controller
│   ├── Machine controller
│   ├── MachineSet controller
│   ├── MachineDeployment controller
│   └── MachineHealthCheck controller
├── Bootstrap Provider (e.g., CABPK - kubeadm)
│   └── KubeadmConfig / KubeadmConfigTemplate controllers
├── Control Plane Provider (e.g., KCP - kubeadm)
│   └── KubeadmControlPlane controller
└── Infrastructure Provider (e.g., CAPA, CAPG, CAPZ, CAPV)
    └── AWSCluster / AWSMachine controllers
```

Each workload cluster's lifecycle is represented by a tree of objects in the management cluster:

```
Cluster (core)
├── InfrastructureRef → AWSCluster / VSpherCluster (provider-specific)
├── ControlPlaneRef → KubeadmControlPlane
│   └── MachineTemplate → AWSMachineTemplate
└── MachineDeployment (workers)
    ├── InfrastructureTemplate → AWSMachineTemplate
    └── BootstrapTemplate → KubeadmConfigTemplate
```

### Management Cluster Bootstrap

A management cluster can be any conformant Kubernetes cluster. For initial bootstrap, a temporary `kind` cluster is commonly used:

```bash
# Create a temporary kind bootstrap cluster
kind create cluster --name capi-bootstrap

# Install clusterctl
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.7.2/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Verify installation
clusterctl version
```

### Provider Configuration

Provider credentials are passed via environment variables or provider-specific configuration. For AWS (CAPA):

```bash
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=<access-key>
export AWS_SECRET_ACCESS_KEY=<secret-key>

# Generate encoded credentials
clusterawsadm bootstrap iam create-cloudformation-stack

export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)
```

For vSphere (CAPV):

```bash
export VSPHERE_USERNAME="administrator@vsphere.local"
export VSPHERE_PASSWORD="<vcenter-password>"
export VSPHERE_SERVER="vcenter.corp.example.com"
export VSPHERE_DATACENTER="Datacenter"
export VSPHERE_DATASTORE="vsanDatastore"
export VSPHERE_NETWORK="VM Network"
export VSPHERE_RESOURCE_POOL="*/Resources"
export VSPHERE_FOLDER="/Datacenter/vm/CAPI"
export VSPHERE_TEMPLATE="ubuntu-2204-kube-v1.29.3"
```

## Section 2: Provider Installation with clusterctl

The `clusterctl` CLI manages provider installation and generates cluster manifests. A `~/.cluster-api/clusterctl.yaml` file controls provider versions and image overrides.

### Installing Providers

```bash
# Initialize management cluster with AWS provider
clusterctl init \
  --infrastructure aws \
  --bootstrap kubeadm \
  --control-plane kubeadm

# Verify provider installation
clusterctl describe provider --all

# Expected output:
# NAME                  TYPE                     INSTALLED VERSION
# cluster-api           CoreProvider             v1.7.2
# kubeadm               BootstrapProvider        v1.7.2
# kubeadm               ControlPlaneProvider     v1.7.2
# aws                   InfrastructureProvider   v2.5.2
```

### Multi-Provider Setup (AWS + vSphere)

```bash
# Install multiple infrastructure providers simultaneously
clusterctl init \
  --infrastructure aws:v2.5.2,vsphere:v1.10.0 \
  --bootstrap kubeadm:v1.7.2 \
  --control-plane kubeadm:v1.7.2

# Check provider health
kubectl get providers -A
```

### Custom Provider Repository

For air-gapped environments or internal provider mirrors:

```yaml
# ~/.cluster-api/clusterctl.yaml
providers:
  - name: aws
    url: https://registry.corp.example.com/cluster-api/infrastructure-aws/v2.5.2/infrastructure-components.yaml
    type: InfrastructureProvider
  - name: vsphere
    url: https://registry.corp.example.com/cluster-api/infrastructure-vsphere/v1.10.0/infrastructure-components.yaml
    type: InfrastructureProvider

images:
  all:
    repository: registry.corp.example.com/cluster-api
```

## Section 3: Generating and Deploying Workload Clusters

### Cluster Generation via clusterctl

```bash
# Generate an AWS cluster manifest
clusterctl generate cluster production-cluster \
  --kubernetes-version v1.29.3 \
  --control-plane-machine-count 3 \
  --worker-machine-count 5 \
  --infrastructure aws \
  --flavor machinepool \
  > production-cluster.yaml

# Review and apply
kubectl apply -f production-cluster.yaml

# Watch cluster provisioning
clusterctl describe cluster production-cluster
```

### Complete AWS Cluster Manifest

```yaml
# aws-cluster-complete.yaml
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: production-cluster
  namespace: clusters
  labels:
    cluster.x-k8s.io/cluster-name: production-cluster
    environment: production
    region: us-east-1
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
        - 10.244.0.0/16
    services:
      cidrBlocks:
        - 10.96.0.0/12
    serviceDomain: cluster.local
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: production-cluster
    namespace: clusters
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: production-cluster-control-plane
    namespace: clusters
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: production-cluster
  namespace: clusters
spec:
  region: us-east-1
  sshKeyName: capi-keypair
  network:
    vpc:
      cidrBlock: 10.0.0.0/16
      availabilityZoneUsageLimit: 3
    subnets:
      - availabilityZone: us-east-1a
        cidrBlock: 10.0.1.0/24
        isPublic: false
      - availabilityZone: us-east-1b
        cidrBlock: 10.0.2.0/24
        isPublic: false
      - availabilityZone: us-east-1c
        cidrBlock: 10.0.3.0/24
        isPublic: false
      - availabilityZone: us-east-1a
        cidrBlock: 10.0.101.0/24
        isPublic: true
      - availabilityZone: us-east-1b
        cidrBlock: 10.0.102.0/24
        isPublic: true
      - availabilityZone: us-east-1c
        cidrBlock: 10.0.103.0/24
        isPublic: true
  controlPlaneLoadBalancer:
    scheme: internet-facing
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: production-cluster-control-plane
  namespace: clusters
spec:
  version: v1.29.3
  replicas: 3
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSMachineTemplate
      name: production-cluster-control-plane
      namespace: clusters
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
          audit-log-path: /var/log/kubernetes/audit.log
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "100"
          enable-admission-plugins: NodeRestriction,PodSecurity
      controllerManager:
        extraArgs:
          cloud-provider: external
    joinConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external
    postKubeadmCommands:
      - "kubectl --kubeconfig /etc/kubernetes/admin.conf apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/calico.yaml"
    files:
      - path: /etc/kubernetes/audit-policy.yaml
        content: |
          apiVersion: audit.k8s.io/v1
          kind: Policy
          rules:
            - level: RequestResponse
              resources:
                - group: ""
                  resources: ["secrets", "configmaps"]
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-cluster-control-plane
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m6i.2xlarge
      iamInstanceProfile: control-plane.cluster-api-provider-aws.sigs.k8s.io
      sshKeyName: capi-keypair
      ami:
        id: ami-0abcdef1234567890  # Ubuntu 22.04 + containerd
      rootVolume:
        size: 100
        type: gp3
        iops: 3000
        throughput: 125
      additionalTags:
        Environment: production
        ManagedBy: cluster-api
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: production-cluster-workers
  namespace: clusters
spec:
  clusterName: production-cluster
  replicas: 5
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: production-cluster
      cluster.x-k8s.io/deployment-name: production-cluster-workers
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: production-cluster
        cluster.x-k8s.io/deployment-name: production-cluster-workers
        node-role: worker
    spec:
      version: v1.29.3
      clusterName: production-cluster
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: production-cluster-workers
          namespace: clusters
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-cluster-workers
        namespace: clusters
---
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: production-cluster-workers
  namespace: clusters
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          name: "{{ ds.meta_data.local_hostname }}"
          kubeletExtraArgs:
            cloud-provider: external
            node-labels: "node-role=worker"
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-cluster-workers
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m6i.4xlarge
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
      sshKeyName: capi-keypair
      rootVolume:
        size: 200
        type: gp3
        iops: 6000
        throughput: 250
```

## Section 4: ClusterClass — Topology-Based Cluster Templates

ClusterClass is the CAPI v1beta1 feature that introduces cluster topology templates, enabling stamping out clusters from a single parameterized definition rather than duplicating manifests across environments.

### ClusterClass Definition

```yaml
# cluster-class-aws.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: aws-production-class
  namespace: clusters
spec:
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: aws-production-cp-template
      namespace: clusters
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: aws-production-cp-machine
        namespace: clusters
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: aws-production-cluster-template
      namespace: clusters
  workers:
    machineDeployments:
      - class: default-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: aws-production-worker-bootstrap
              namespace: clusters
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: aws-production-worker-machine
              namespace: clusters
      - class: gpu-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: aws-production-gpu-bootstrap
              namespace: clusters
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: aws-production-gpu-machine
              namespace: clusters
  variables:
    - name: region
      required: true
      schema:
        openAPIV3Schema:
          type: string
          example: "us-east-1"
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
    - name: workerReplicas
      required: false
      schema:
        openAPIV3Schema:
          type: integer
          minimum: 1
          maximum: 50
          default: 3
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

### Cluster Using ClusterClass

```yaml
# topology-cluster.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: app-cluster-staging
  namespace: clusters
spec:
  topology:
    class: aws-production-class
    version: v1.29.3
    controlPlane:
      replicas: 3
    variables:
      - name: region
        value: "us-west-2"
      - name: controlPlaneInstanceType
        value: "m6i.2xlarge"
      - name: workerReplicas
        value: 6
    workers:
      machineDeployments:
        - class: default-worker
          name: app-workers
          replicas: 6
        - class: gpu-worker
          name: gpu-workers
          replicas: 2
```

## Section 5: MachinePools for Cloud-Managed Node Groups

MachinePools delegate node group management to the cloud provider (e.g., AWS Auto Scaling Groups, Azure VMSS), enabling cloud-native scaling without CAPI managing individual machines.

### AWS MachinePool with Auto Scaling

```yaml
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachinePool
metadata:
  name: production-cluster-pool
  namespace: clusters
spec:
  clusterName: production-cluster
  replicas: 5
  template:
    spec:
      version: v1.29.3
      clusterName: production-cluster
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfig
          name: production-cluster-pool-bootstrap
          namespace: clusters
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachinePool
        name: production-cluster-pool
        namespace: clusters
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachinePool
metadata:
  name: production-cluster-pool
  namespace: clusters
spec:
  minSize: 3
  maxSize: 20
  availabilityZones:
    - us-east-1a
    - us-east-1b
    - us-east-1c
  awsLaunchTemplate:
    instanceType: m6i.4xlarge
    sshKeyName: capi-keypair
    rootVolume:
      size: 200
      type: gp3
    iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
  refreshPreferences:
    instanceWarmup: 300
    minHealthyPercentage: 90
    strategy: Rolling
```

## Section 6: MachineHealthCheck for Automatic Remediation

MachineHealthCheck monitors node conditions and replaces unhealthy machines automatically, without human intervention.

```yaml
# machine-health-check.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: production-cluster-worker-mhc
  namespace: clusters
spec:
  clusterName: production-cluster
  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: production-cluster-workers
  unhealthyConditions:
    - type: Ready
      status: "False"
      timeout: 300s
    - type: Ready
      status: Unknown
      timeout: 300s
    - type: MemoryPressure
      status: "True"
      timeout: 120s
    - type: DiskPressure
      status: "True"
      timeout: 120s
    - type: PIDPressure
      status: "True"
      timeout: 120s
  maxUnhealthy: 33%
  nodeStartupTimeout: 600s
  remediationTemplate:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSRemediationTemplate
    name: production-cluster-remediation
    namespace: clusters
---
# Control plane MachineHealthCheck
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: production-cluster-cp-mhc
  namespace: clusters
spec:
  clusterName: production-cluster
  selector:
    matchLabels:
      cluster.x-k8s.io/control-plane: ""
  unhealthyConditions:
    - type: Ready
      status: "False"
      timeout: 600s
    - type: Ready
      status: Unknown
      timeout: 600s
  maxUnhealthy: 1
  nodeStartupTimeout: 900s
```

### Monitoring MachineHealthCheck Status

```bash
# Check MachineHealthCheck status
kubectl get machinehealthcheck -n clusters

# Describe specific MHC
kubectl describe machinehealthcheck production-cluster-worker-mhc -n clusters

# Watch remediation events
kubectl get events -n clusters --field-selector reason=MachineRemediationRemediated -w

# View remediated machines
kubectl get machines -n clusters \
  -l cluster.x-k8s.io/deployment-name=production-cluster-workers \
  -o custom-columns="NAME:.metadata.name,PHASE:.status.phase,HEALTHY:.status.conditions[?(@.type=='HealthCheckSucceeded')].status"
```

## Section 7: Cluster Upgrades

CAPI enables in-place, rolling cluster upgrades by updating the `version` field on the control plane and MachineDeployment objects.

### Control Plane Upgrade

```bash
# Patch KubeadmControlPlane to trigger upgrade
kubectl patch kubeadmcontrolplane production-cluster-control-plane \
  -n clusters \
  --type merge \
  -p '{"spec":{"version":"v1.30.1"}}'

# Monitor control plane upgrade
watch -n 5 "kubectl get kubeadmcontrolplane -n clusters production-cluster-control-plane \
  -o custom-columns='VERSION:.spec.version,READY:.status.readyReplicas,UPDATED:.status.updatedReplicas,TOTAL:.status.replicas'"

# Verify etcd cluster health during upgrade
clusterctl get kubeconfig production-cluster -n clusters > /tmp/prod-kubeconfig
kubectl --kubeconfig /tmp/prod-kubeconfig get pods -n kube-system | grep etcd
kubectl --kubeconfig /tmp/prod-kubeconfig exec -n kube-system etcd-controlplane-0 -- \
  etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health --cluster
```

### Worker Node Upgrade

```bash
# Patch MachineDeployment for worker upgrade
kubectl patch machinedeployment production-cluster-workers \
  -n clusters \
  --type merge \
  -p '{"spec":{"template":{"spec":{"version":"v1.30.1"}}}}'

# Monitor rolling upgrade
watch -n 5 "kubectl get machines -n clusters \
  -l cluster.x-k8s.io/deployment-name=production-cluster-workers \
  -o custom-columns='NAME:.metadata.name,VERSION:.spec.version,PHASE:.status.phase'"
```

### Fleet Upgrade with ClusterResourceSet

```yaml
# cluster-resource-set-calico.yaml
apiVersion: addons.cluster.x-k8s.io/v1beta1
kind: ClusterResourceSet
metadata:
  name: calico-cni
  namespace: clusters
spec:
  strategy: ApplyOnce
  clusterSelector:
    matchLabels:
      cni: calico
  resources:
    - name: calico-manifests
      kind: ConfigMap
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: calico-manifests
  namespace: clusters
data:
  calico.yaml: |
    # Calico manifest content here
```

## Section 8: Accessing Workload Clusters

```bash
# Get kubeconfig for a workload cluster
clusterctl get kubeconfig production-cluster -n clusters > ~/.kube/production-cluster.kubeconfig

# Set KUBECONFIG to use it
export KUBECONFIG=~/.kube/production-cluster.kubeconfig

# Verify connectivity
kubectl cluster-info
kubectl get nodes -o wide

# List all clusters and their status
clusterctl describe cluster -n clusters --show-conditions all

# Get cluster status summary
kubectl get clusters -n clusters \
  -o custom-columns="NAME:.metadata.name,PHASE:.status.phase,CONTROLPLANE_READY:.status.controlPlaneReady,INFRA_READY:.status.infrastructureReady,WORKERS:.status.observedGeneration"
```

## Section 9: Fleet Management with GitOps

For managing dozens or hundreds of clusters, GitOps integration with Argo CD or Flux provides auditability and rollback capability.

### Namespace-Per-Cluster Pattern

```bash
# Organizational namespace strategy
kubectl create namespace clusters-production
kubectl create namespace clusters-staging
kubectl create namespace clusters-development

# Label namespaces for policy enforcement
kubectl label namespace clusters-production \
  environment=production \
  cluster-lifecycle=managed
```

### Flux-Based Fleet Management

```yaml
# flux-cluster-management.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: capi-clusters
  namespace: flux-system
spec:
  interval: 5m
  path: ./clusters
  prune: true
  sourceRef:
    kind: GitRepository
    name: fleet-repo
  healthChecks:
    - apiVersion: cluster.x-k8s.io/v1beta1
      kind: Cluster
      name: production-cluster
      namespace: clusters
  timeout: 10m
  retryInterval: 2m
```

## Section 10: Clusterctl Upgrade and Provider Management

```bash
# Check available provider upgrades
clusterctl upgrade plan

# Apply provider upgrades
clusterctl upgrade apply \
  --management-group capi-system/cluster-api \
  --contract v1beta1

# Upgrade specific provider
clusterctl upgrade apply \
  --infrastructure aws:v2.6.0

# Verify provider status after upgrade
kubectl get providers -A
clusterctl describe provider --all

# Move clusters between management clusters (cluster migration)
clusterctl move \
  --to-kubeconfig /path/to/new-management-kubeconfig \
  --namespace clusters \
  --dry-run

clusterctl move \
  --to-kubeconfig /path/to/new-management-kubeconfig \
  --namespace clusters
```

## Section 11: Troubleshooting Common Issues

### Cluster Stuck in Provisioning

```bash
# Check all cluster-related events
kubectl get events -n clusters --sort-by='.lastTimestamp' | grep -E "(Warning|Error)"

# Inspect provider-specific infrastructure
kubectl describe awscluster production-cluster -n clusters
kubectl describe awsmachine -n clusters -l cluster.x-k8s.io/cluster-name=production-cluster

# Check bootstrap data generation
kubectl get kubeadmconfig -n clusters
kubectl describe kubeadmconfig production-cluster-control-plane-xxxxx -n clusters

# Review controller logs
kubectl logs -n capi-system deployment/capi-controller-manager -c manager --tail=100
kubectl logs -n capa-system deployment/capa-controller-manager -c manager --tail=100
```

### Machine Failed to Join

```bash
# SSH into problematic node using AWS SSM (no bastion needed)
aws ssm start-session --target i-0abcdef1234567890

# Check cloud-init logs
sudo cat /var/log/cloud-init-output.log
sudo journalctl -u cloud-init --no-pager | tail -100

# Check kubelet status
sudo systemctl status kubelet
sudo journalctl -u kubelet --no-pager | tail -50

# Verify kubeadm join command was executed
sudo cat /var/log/cloud-init.log | grep kubeadm
```

### MachineDeployment Stuck Rolling

```bash
# Check rollout status
kubectl rollout status machinedeployment/production-cluster-workers -n clusters

# Inspect MachineSet history
kubectl get machinesets -n clusters \
  -l cluster.x-k8s.io/cluster-name=production-cluster

# Describe stuck machines
kubectl describe machines -n clusters \
  -l cluster.x-k8s.io/deployment-name=production-cluster-workers | \
  grep -A 20 "Status:"

# Force delete a stuck machine (CAUTION: verify replacement is healthy first)
kubectl delete machine <machine-name> -n clusters
```

## Section 12: Production Hardening Checklist

```bash
# Verify management cluster RBAC
kubectl auth can-i --list --as=system:serviceaccount:capi-system:capi-controller-manager

# Ensure CAPI webhooks are healthy
kubectl get validatingwebhookconfigurations | grep capi
kubectl get mutatingwebhookconfigurations | grep capi

# Check etcd disk usage on management cluster (CAPI stores all objects)
kubectl exec -n kube-system etcd-mgmt-control-plane -- \
  du -sh /var/lib/etcd/member/

# Set resource requests/limits on provider controllers
kubectl patch deployment capi-controller-manager -n capi-system \
  --type json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/resources","value":{"requests":{"cpu":"200m","memory":"256Mi"},"limits":{"cpu":"1","memory":"1Gi"}}}]'

# Enable leader election health checks
kubectl get lease -n capi-system

# Configure backup for management cluster etcd
# (integrate with Velero or etcdadm snapshot schedule)
```

This guide establishes the operational foundation for Cluster API at enterprise scale. The declarative model, combined with ClusterClass topology templates and MachineHealthCheck automation, enables platform teams to manage cluster fleets with the same confidence and repeatability applied to application workloads.
