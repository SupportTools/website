---
title: "Kubernetes Cluster API (CAPI): Declarative Cluster Lifecycle Management"
date: 2029-01-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "Infrastructure as Code", "Multi-Cluster", "GitOps"]
categories:
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Kubernetes Cluster API (CAPI) for declarative cluster lifecycle management, covering providers, bootstrap configuration, machine deployments, and production operations at scale."
more_link: "yes"
url: "/kubernetes-cluster-api-declarative-lifecycle/"
---

Kubernetes Cluster API (CAPI) transforms cluster lifecycle management from an imperative, provider-specific chore into a declarative, Kubernetes-native workflow. By treating clusters as first-class Kubernetes objects, CAPI enables teams to provision, upgrade, and decommission clusters with the same GitOps practices used for application workloads. This guide covers CAPI architecture, provider selection, production deployment patterns, and day-two operations for enterprise environments managing dozens or hundreds of clusters.

<!--more-->

## Architecture Overview

Cluster API introduces a management cluster — a Kubernetes cluster responsible for creating and managing workload clusters. The management cluster runs CAPI controllers that reconcile custom resources representing infrastructure components. This architecture separates the control plane from the workloads it manages, enabling a hub-and-spoke operational model.

### Core Components

The CAPI architecture consists of four provider categories:

**Infrastructure Provider (INFRA)**: Manages cloud or on-premises resources. Examples include `cluster-api-provider-aws` (CAPA), `cluster-api-provider-azure` (CAPZ), `cluster-api-provider-gcp` (CAPG), and `cluster-api-provider-vsphere` (CAPV).

**Bootstrap Provider**: Generates node bootstrap data (typically cloud-init or Ignition). `Kubeadm Bootstrap Provider` (CABPK) is the most common choice.

**Control Plane Provider**: Manages the Kubernetes control plane. `KubeadmControlPlane` (KCP) handles kubeadm-based control planes; Talos and k0s providers exist for alternative distributions.

**Core Provider**: The `cluster-api` core controller manages generic Cluster, Machine, MachineSet, and MachineDeployment objects.

### API Object Hierarchy

```
Cluster
├── InfrastructureRef → AWSCluster / vSphereCluster / AzureCluster
├── ControlPlaneRef   → KubeadmControlPlane
│     └── MachineTemplate
│           ├── InfrastructureMachineTemplate → AWSMachineTemplate
│           └── BootstrapRef → KubeadmConfigTemplate
└── MachineDeployment (workers)
      ├── MachineSet
      │     └── Machine
      │           ├── InfrastructureMachineRef → AWSMachine
      │           └── BootstrapRef → KubeadmConfig
```

## Prerequisites and Management Cluster Setup

### Installing clusterctl

`clusterctl` is the primary CLI for initializing providers and generating cluster manifests.

```bash
# Install clusterctl
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.7.3/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Verify installation
clusterctl version
# clusterctl version: &version.Info{Major:"1", Minor:"7", GitVersion:"v1.7.3"}

# Configure clusterctl with custom image repositories (air-gapped)
mkdir -p ~/.cluster-api
cat > ~/.cluster-api/clusterctl.yaml <<'EOF'
providers:
  - name: aws
    url: https://github.com/kubernetes-sigs/cluster-api-provider-aws/releases/latest/infrastructure-components.yaml
    type: InfrastructureProvider
  - name: vsphere
    url: https://github.com/kubernetes-sigs/cluster-api-provider-vsphere/releases/latest/infrastructure-components.yaml
    type: InfrastructureProvider

images:
  all:
    repository: registry.corp.example.com/cluster-api
EOF
```

### Initializing the Management Cluster

```bash
# Set AWS credentials for CAPA (example for AWS provider)
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

# Encode credentials for the provider secret
export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)

# Initialize core + AWS providers on the management cluster
clusterctl init \
  --infrastructure aws \
  --bootstrap kubeadm \
  --control-plane kubeadm \
  --core cluster-api:v1.7.3

# Verify all provider controllers are running
kubectl get pods -n capi-system
kubectl get pods -n capa-system
kubectl get pods -n capi-kubeadm-bootstrap-system
kubectl get pods -n capi-kubeadm-control-plane-system

# List installed providers
clusterctl describe providers
```

### Provider Reconciliation Health Check

```bash
# Check provider status
kubectl get providers -A
# NAMESPACE                          NAME                   TYPE                   PROVIDER   VERSION   READY   SEVERITY   REASON
# capa-system                        infrastructure-aws     InfrastructureProvider  aws       v2.5.2    True
# capi-kubeadm-bootstrap-system      bootstrap-kubeadm      BootstrapProvider       kubeadm   v1.7.3    True
# capi-kubeadm-control-plane-system  control-plane-kubeadm  ControlPlaneProvider    kubeadm   v1.7.3    True
# capi-system                        core                   CoreProvider            cluster-api v1.7.3  True
```

## Generating and Customizing Cluster Manifests

### Cluster Template Generation

`clusterctl generate cluster` uses environment variables and provider templates to produce cluster manifests.

```bash
# Generate a production-grade AWS cluster manifest
export CLUSTER_NAME=prod-us-east-workload-01
export KUBERNETES_VERSION=v1.29.4
export AWS_REGION=us-east-1
export AWS_CONTROL_PLANE_MACHINE_TYPE=m6i.xlarge
export AWS_NODE_MACHINE_TYPE=m6i.2xlarge
export CONTROL_PLANE_MACHINE_COUNT=3
export WORKER_MACHINE_COUNT=5
export AWS_SSH_KEY_NAME=cluster-api-bastion
export AWS_VPC_ID=vpc-0a1b2c3d4e5f67890

clusterctl generate cluster ${CLUSTER_NAME} \
  --kubernetes-version ${KUBERNETES_VERSION} \
  --control-plane-machine-count ${CONTROL_PLANE_MACHINE_COUNT} \
  --worker-machine-count ${WORKER_MACHINE_COUNT} \
  --infrastructure aws \
  > clusters/${CLUSTER_NAME}.yaml
```

### Full Cluster Manifest (AWS Example)

The following manifest demonstrates a production-ready CAPA cluster with HA control plane, private networking, and managed node groups.

```yaml
# clusters/prod-us-east-workload-01.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: prod-us-east-workload-01
  namespace: clusters
  labels:
    environment: production
    region: us-east-1
    tier: workload
spec:
  clusterNetwork:
    pods:
      cidrBlocks: ["10.244.0.0/16"]
    services:
      cidrBlocks: ["10.96.0.0/12"]
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: prod-us-east-workload-01
    namespace: clusters
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: prod-us-east-workload-01-control-plane
    namespace: clusters
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: prod-us-east-workload-01
  namespace: clusters
spec:
  region: us-east-1
  sshKeyName: cluster-api-bastion
  network:
    vpc:
      id: vpc-0a1b2c3d4e5f67890
    subnets:
      - id: subnet-0a1b2c3d4e5f67891
        availabilityZone: us-east-1a
        isPublic: false
      - id: subnet-0a1b2c3d4e5f67892
        availabilityZone: us-east-1b
        isPublic: false
      - id: subnet-0a1b2c3d4e5f67893
        availabilityZone: us-east-1c
        isPublic: false
  controlPlaneLoadBalancer:
    scheme: internet-facing
  bastion:
    enabled: false
  additionalTags:
    Environment: production
    ManagedBy: cluster-api
    CostCenter: platform-eng
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: prod-us-east-workload-01-control-plane
  namespace: clusters
spec:
  replicas: 3
  version: v1.29.4
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSMachineTemplate
      name: prod-us-east-workload-01-control-plane
      namespace: clusters
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external
          node-labels: "node.kubernetes.io/role=control-plane"
    joinConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external
    clusterConfiguration:
      apiServer:
        extraArgs:
          cloud-provider: external
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "100"
          audit-log-path: /var/log/apiserver/audit.log
          enable-admission-plugins: NodeRestriction,PodSecurityAdmission
      controllerManager:
        extraArgs:
          cloud-provider: external
          bind-address: 0.0.0.0
      etcd:
        local:
          dataDir: /var/lib/etcd
          extraArgs:
            quota-backend-bytes: "8589934592"
            auto-compaction-mode: periodic
            auto-compaction-retention: "8"
    preKubeadmCommands:
      - systemctl enable --now containerd
      - echo "net.bridge.bridge-nf-call-iptables=1" >> /etc/sysctl.d/99-kubernetes.conf
      - sysctl --system
    postKubeadmCommands:
      - kubectl --kubeconfig /etc/kubernetes/admin.conf apply -f https://raw.githubusercontent.com/aws/amazon-vpc-cni-k8s/v1.18.1/config/master/aws-k8s-cni.yaml
  rolloutStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: prod-us-east-workload-01-control-plane
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m6i.xlarge
      iamInstanceProfile: control-plane.cluster-api-provider-aws.sigs.k8s.io
      rootVolume:
        size: 100
        type: gp3
        encrypted: true
      ami:
        id: ami-0c02fb55956c7d316  # Amazon Linux 2 EKS-optimized 1.29
      nonRootVolumes:
        - deviceName: /dev/xvdb
          size: 50
          type: gp3
          encrypted: true
      publicIP: false
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: prod-us-east-workload-01-workers
  namespace: clusters
  labels:
    cluster.x-k8s.io/cluster-name: prod-us-east-workload-01
spec:
  clusterName: prod-us-east-workload-01
  replicas: 5
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: prod-us-east-workload-01
  template:
    spec:
      clusterName: prod-us-east-workload-01
      version: v1.29.4
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: prod-us-east-workload-01-workers
          namespace: clusters
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: prod-us-east-workload-01-workers
        namespace: clusters
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: prod-us-east-workload-01-workers
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m6i.2xlarge
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
      rootVolume:
        size: 120
        type: gp3
        encrypted: true
      ami:
        id: ami-0c02fb55956c7d316
      publicIP: false
      spotMarketOptions: {}
---
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: prod-us-east-workload-01-workers
  namespace: clusters
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          name: "{{ ds.meta_data.local_hostname }}"
          kubeletExtraArgs:
            cloud-provider: external
            node-labels: "node.kubernetes.io/role=worker"
      preKubeadmCommands:
        - systemctl enable --now containerd
        - echo "net.bridge.bridge-nf-call-iptables=1" >> /etc/sysctl.d/99-kubernetes.conf
        - sysctl --system
```

## Cluster Lifecycle Operations

### Applying Cluster Manifests

```bash
# Create namespace for cluster objects
kubectl create namespace clusters

# Apply the cluster manifest
kubectl apply -f clusters/prod-us-east-workload-01.yaml

# Watch cluster provisioning progress
kubectl get cluster -n clusters -w

# Watch machines come online
watch -n 5 'kubectl get machines -n clusters'

# Get kubeconfig for the workload cluster
clusterctl get kubeconfig prod-us-east-workload-01 -n clusters \
  > ~/.kube/prod-us-east-workload-01.kubeconfig

# Verify workload cluster connectivity
kubectl --kubeconfig ~/.kube/prod-us-east-workload-01.kubeconfig get nodes
```

### Scaling Worker Nodes

```bash
# Scale a MachineDeployment
kubectl scale machinedeployment prod-us-east-workload-01-workers \
  -n clusters \
  --replicas=8

# Or patch directly with strategic merge
kubectl patch machinedeployment prod-us-east-workload-01-workers \
  -n clusters \
  --type=merge \
  -p '{"spec":{"replicas":8}}'

# Watch scaling progress
kubectl get machinedeployment -n clusters -w
```

### Cluster Upgrades

CAPI handles rolling Kubernetes upgrades through the `KubeadmControlPlane` and `MachineDeployment` controllers.

```bash
# Upgrade control plane to v1.30.2
kubectl patch kubeadmcontrolplane prod-us-east-workload-01-control-plane \
  -n clusters \
  --type=merge \
  -p '{"spec":{"version":"v1.30.2","machineTemplate":{"infrastructureRef":{"name":"prod-us-east-workload-01-control-plane-v130"}}}}'

# After control plane upgrade completes, upgrade workers
kubectl patch machinedeployment prod-us-east-workload-01-workers \
  -n clusters \
  --type=merge \
  -p '{"spec":{"template":{"spec":{"version":"v1.30.2"}}}}'

# Monitor upgrade status
clusterctl describe cluster prod-us-east-workload-01 -n clusters
```

## ClusterClass: Topology-Based Cluster Management

ClusterClass (graduated in CAPI v1.4) provides a reusable cluster template that can be instantiated many times with variable substitution.

```yaml
# clusterclass-production.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: production-aws-class
  namespace: clusters
spec:
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: production-aws-class
      namespace: clusters
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: production-aws-class
      namespace: clusters
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-aws-class-controlplane
        namespace: clusters
  workers:
    machineDeployments:
      - class: default-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: production-aws-class-workers
              namespace: clusters
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: production-aws-class-workers
              namespace: clusters
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
          default: m6i.2xlarge
    - name: controlPlaneInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: m6i.xlarge
    - name: kubernetesVersion
      required: true
      schema:
        openAPIV3Schema:
          type: string
          example: v1.29.4
  patches:
    - name: region
      definitions:
        - selector:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
            kind: AWSClusterTemplate
            matchResources:
              infrastructureCluster: true
          jsonPatches:
            - op: add
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
                names: ["default-worker"]
          jsonPatches:
            - op: replace
              path: /spec/template/spec/instanceType
              valueFrom:
                variable: workerInstanceType
---
# Instantiate a cluster from the ClusterClass
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: staging-us-west-workload-03
  namespace: clusters
  labels:
    environment: staging
spec:
  topology:
    class: production-aws-class
    version: v1.29.4
    controlPlane:
      replicas: 3
    workers:
      machineDeployments:
        - class: default-worker
          name: workers
          replicas: 4
    variables:
      - name: region
        value: us-west-2
      - name: workerInstanceType
        value: m6i.xlarge
      - name: kubernetesVersion
        value: v1.29.4
```

## Machine Health Checks

`MachineHealthCheck` automatically remediates unhealthy nodes by deleting and reprovisioning machines that fail health criteria.

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: prod-us-east-workload-01-worker-mhc
  namespace: clusters
spec:
  clusterName: prod-us-east-workload-01
  maxUnhealthy: 33%
  nodeStartupTimeout: 10m
  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: prod-us-east-workload-01-workers
  unhealthyConditions:
    - type: Ready
      status: Unknown
      timeout: 300s
    - type: Ready
      status: "False"
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
```

## GitOps Integration with Flux

Managing CAPI clusters through Flux enables true GitOps-driven cluster lifecycle management.

```yaml
# flux/clusters/management/capi-clusters-source.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: capi-clusters
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/corp/capi-clusters.git
  ref:
    branch: main
  secretRef:
    name: github-token
---
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
    name: capi-clusters
  healthChecks:
    - apiVersion: cluster.x-k8s.io/v1beta1
      kind: Cluster
      name: prod-us-east-workload-01
      namespace: clusters
  timeout: 30m
```

## Observability and Monitoring

### Prometheus Metrics

CAPI controllers expose Prometheus metrics for cluster and machine state.

```bash
# Port-forward to CAPI core metrics
kubectl port-forward -n capi-system \
  deploy/capi-controller-manager 8443:8443

# Key metrics to monitor
curl -sk https://localhost:8443/metrics | grep -E \
  'capi_cluster_|capi_machine_|capi_machinedeployment_'

# Useful metric examples:
# capi_cluster_ready{cluster_name="prod-us-east-workload-01",namespace="clusters"} 1
# capi_machine_phase{machine="prod-us-east-workload-01-cp-xyz",phase="Running"} 1
# capi_machinedeployment_replicas_desired{name="prod-us-east-workload-01-workers"} 5
# capi_machinedeployment_replicas_ready{name="prod-us-east-workload-01-workers"} 5
```

### Cluster Status Dashboard Query

```bash
# Quick status overview of all managed clusters
kubectl get clusters -A \
  -o custom-columns=\
'NAME:.metadata.name,\
NAMESPACE:.metadata.namespace,\
PHASE:.status.phase,\
INFRA_READY:.status.infrastructureReady,\
CP_READY:.status.controlPlaneReady,\
K8S_VERSION:.spec.topology.version,\
AGE:.metadata.creationTimestamp'

# Detailed cluster condition summary
kubectl get clusters -A -o json | \
  jq -r '.items[] | "\(.metadata.name) \(.status.conditions[] | select(.type=="Ready") | .status + " " + .reason)"'
```

## Troubleshooting Common Issues

### Machine Stuck in Provisioning

```bash
# Examine machine and its conditions
kubectl describe machine prod-us-east-workload-01-workers-abcde -n clusters

# Check bootstrap data generation
kubectl describe kubeadmconfig prod-us-east-workload-01-workers-abcde -n clusters

# Inspect CAPA controller logs
kubectl logs -n capa-system \
  deploy/capa-controller-manager \
  -c manager --tail=100 | \
  grep -i "error\|warning\|prod-us-east-workload-01"

# Check AWS events
aws ec2 describe-instances \
  --filters "Name=tag:sigs.k8s.io/cluster-api-provider-aws/cluster/prod-us-east-workload-01,Values=owned" \
  --query 'Reservations[].Instances[].{ID:InstanceId,State:State.Name,AZ:Placement.AvailabilityZone}'
```

### Control Plane Not Becoming Ready

```bash
# Check KubeadmControlPlane status
kubectl get kubeadmcontrolplane -n clusters -o wide

# Examine initialization conditions
kubectl describe kubeadmcontrolplane prod-us-east-workload-01-control-plane -n clusters \
  | grep -A 5 "Conditions:"

# Retrieve bootstrap logs from a specific machine
machine_name="prod-us-east-workload-01-cp-abc12"
instance_id=$(kubectl get awsmachine ${machine_name} -n clusters \
  -o jsonpath='{.spec.instanceID}')
aws ec2 get-console-output --instance-id ${instance_id} \
  --query Output --output text | tail -100
```

### etcd Quorum Loss

```bash
# Check etcd member health on a control plane node
kubectl --kubeconfig ~/.kube/prod-us-east-workload-01.kubeconfig \
  exec -n kube-system etcd-prod-us-east-workload-01-cp-abc12 \
  -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member list

# Remove a failed etcd member
etcdctl member remove <member-id>

# CAPI will remediate by reprovisioning the machine automatically
# if MachineHealthCheck is configured
```

## Production Best Practices

### Namespace Organization

Organize clusters by environment and region using dedicated namespaces:

```bash
# Create namespaces with RBAC isolation
for env in production staging development; do
  kubectl create namespace capi-${env}
  kubectl label namespace capi-${env} \
    environment=${env} \
    managed-by=cluster-api
done

# Apply namespace-scoped RBAC for cluster-admin team
kubectl create rolebinding capi-production-admin \
  --clusterrole=cluster-admin \
  --group=platform-team@corp.example.com \
  -n capi-production
```

### Cluster Deletion Protection

Prevent accidental cluster deletion with finalizers and admission webhooks:

```bash
# Add deletion protection annotation
kubectl annotate cluster prod-us-east-workload-01 \
  -n clusters \
  cluster.x-k8s.io/paused=true

# Verify cluster is paused (controllers will not reconcile)
kubectl get cluster prod-us-east-workload-01 -n clusters \
  -o jsonpath='{.spec.paused}'

# When ready to delete, remove pause and delete
kubectl annotate cluster prod-us-east-workload-01 \
  -n clusters \
  cluster.x-k8s.io/paused-
kubectl delete cluster prod-us-east-workload-01 -n clusters
```

### Multi-Region Cluster Fleet Management

```bash
# List all clusters across all management cluster namespaces
kubectl get clusters -A \
  --sort-by='.metadata.labels.region' \
  -L environment,region,tier

# Fleet-wide version summary
kubectl get kubeadmcontrolplanes -A \
  -o custom-columns=\
'CLUSTER:.metadata.name,\
VERSION:.spec.version,\
REPLICAS:.spec.replicas,\
READY:.status.readyReplicas,\
UPDATED:.status.updatedReplicas'
```

## Summary

Kubernetes Cluster API provides a powerful, declarative approach to cluster lifecycle management that scales from a handful of development clusters to enterprise fleets of hundreds. Key takeaways for production adoption:

- Use ClusterClass for standardizing cluster configurations across teams and environments
- Implement MachineHealthChecks to enable automatic node remediation without manual intervention
- Integrate CAPI cluster manifests with Flux or ArgoCD for full GitOps lifecycle management
- Organize clusters in dedicated namespaces with RBAC isolation per environment
- Monitor CAPI controller metrics alongside workload cluster health for end-to-end visibility

The declarative model fundamentally changes how infrastructure teams operate: instead of maintaining provider-specific scripts or clicking through cloud consoles, clusters become reproducible Kubernetes objects that live in Git, get code-reviewed, and benefit from the same automation tooling as application workloads.
