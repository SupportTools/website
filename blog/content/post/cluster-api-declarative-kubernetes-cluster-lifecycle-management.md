---
title: "Cluster API: Declarative Kubernetes Cluster Lifecycle Management"
date: 2030-07-06T00:00:00-05:00
draft: false
tags: ["Cluster API", "CAPI", "Kubernetes", "Infrastructure as Code", "GitOps", "AWS", "GCP", "vSphere"]
categories:
- Kubernetes
- Infrastructure
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Cluster API guide covering infrastructure providers for AWS, GCP, and vSphere, machine deployments and autoscaling, multi-cluster management at scale, cluster upgrade strategies, and integration with GitOps workflows using ArgoCD and Flux."
more_link: "yes"
url: "/cluster-api-declarative-kubernetes-cluster-lifecycle-management/"
---

Cluster API (CAPI) treats Kubernetes clusters as Kubernetes objects, applying the same declarative, reconciliation-driven model to cluster lifecycle that Kubernetes itself applies to application workloads. An operator defines the desired state of a cluster — control plane count, worker machine types, Kubernetes version, network configuration — as CRDs on a management cluster, and CAPI controllers reconcile the actual state of target clusters toward that desired state. This model eliminates the snowflake cluster problem, enables version-controlled cluster configuration, and provides a consistent interface across AWS, GCP, Azure, vSphere, and bare-metal providers.

<!--more-->

## Architecture Overview

Cluster API operates with a clear separation of concerns between the management cluster and workload clusters:

```
Management Cluster
┌─────────────────────────────────────────────────────────────┐
│  Core CAPI Controllers                                      │
│  ├── Cluster Controller                                     │
│  ├── Machine Controller                                     │
│  ├── MachineSet Controller                                  │
│  └── MachineDeployment Controller                          │
│                                                             │
│  Infrastructure Provider (e.g., CAPA for AWS)              │
│  ├── AWSCluster Controller                                  │
│  ├── AWSMachine Controller                                  │
│  └── AWSMachineTemplate Controller                         │
│                                                             │
│  Bootstrap Provider (e.g., kubeadm)                        │
│  ├── KubeadmConfig Controller                              │
│  └── KubeadmControlPlane Controller                        │
└─────────────────────────────────────────────────────────────┘
          │
          │ Kubernetes API + cloud provider APIs
          ▼
Workload Clusters (AWS, GCP, vSphere, bare-metal, ...)
```

### Core CRD Hierarchy

```
Cluster
├── InfrastructureRef → AWSCluster | GCPCluster | VSphereCluster
├── ControlPlaneRef   → KubeadmControlPlane
└── MachineDeployments
    └── MachineSet
        └── Machines
            ├── InfrastructureRef → AWSMachine | GCPMachine
            └── BootstrapRef      → KubeadmConfig
```

## Installing the Management Cluster

### Prerequisites

```bash
# Install clusterctl — the CAPI management CLI
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.7.3/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Verify
clusterctl version
# clusterctl version: &Version{GitVersion:v1.7.3,...}

# Install kubectl and ensure you have a management cluster running
# (e.g., kind cluster for bootstrapping)
kind create cluster --name capi-management
kubectl config use-context kind-capi-management
```

### Initializing with AWS Provider (CAPA)

```bash
# Export credentials for the management cluster bootstrap
export AWS_ACCESS_KEY_ID=<aws-access-key-id>
export AWS_SECRET_ACCESS_KEY=<aws-secret-access-key>
export AWS_REGION=us-east-1

# Prepare AWS prerequisites (VPCs, IAM roles)
# clusterawsadm bootstraps the required IAM components
curl -L https://github.com/kubernetes-sigs/cluster-api-provider-aws/releases/latest/download/clusterawsadm-linux-amd64 \
  -o /usr/local/bin/clusterawsadm
chmod +x /usr/local/bin/clusterawsadm

# Bootstrap IAM resources
clusterawsadm bootstrap iam create-cloudformation-stack

# Encode credentials for CAPI secret
export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)

# Initialize CAPA on the management cluster
clusterctl init --infrastructure aws

# Verify controllers are running
kubectl get pods -n capi-system
kubectl get pods -n capa-system
```

### Initializing with GCP Provider (CAPG)

```bash
export GCP_PROJECT=my-gcp-project
export GCP_REGION=us-central1

# Create service account for CAPG
gcloud iam service-accounts create capi-sa \
  --project="${GCP_PROJECT}"

gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
  --member="serviceAccount:capi-sa@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role="roles/compute.instanceAdmin.v1"

gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
  --member="serviceAccount:capi-sa@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

gcloud iam service-accounts keys create /tmp/capg-sa.json \
  --iam-account="capi-sa@${GCP_PROJECT}.iam.gserviceaccount.com"

export GCP_B64ENCODED_CREDENTIALS=$(base64 -w0 /tmp/capg-sa.json)

clusterctl init --infrastructure gcp
```

### Initializing with vSphere Provider (CAPV)

```bash
export VSPHERE_SERVER=vcenter.company.internal
export VSPHERE_USERNAME=capi-user@vsphere.local
export VSPHERE_PASSWORD=<vsphere-password>
export VSPHERE_TLS_THUMBPRINT="<vcenter-tls-thumbprint>"

clusterctl init --infrastructure vsphere
```

## Defining a Workload Cluster

### AWS Cluster Definition

```yaml
# cluster-aws-production.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: production-us-east-1
  namespace: clusters
  labels:
    environment: production
    region: us-east-1
    team: platform
spec:
  clusterNetwork:
    pods:
      cidrBlocks: ["10.244.0.0/16"]
    services:
      cidrBlocks: ["10.96.0.0/12"]
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: production-us-east-1
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: production-us-east-1-control-plane
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: production-us-east-1
  namespace: clusters
spec:
  region: us-east-1
  sshKeyName: company-production-key
  network:
    vpc:
      cidrBlock: "10.0.0.0/16"
      availabilityZoneUsageLimit: 3
    subnets:
      - availabilityZone: us-east-1a
        cidrBlock: "10.0.0.0/20"
        isPublic: true
      - availabilityZone: us-east-1b
        cidrBlock: "10.0.16.0/20"
        isPublic: true
      - availabilityZone: us-east-1c
        cidrBlock: "10.0.32.0/20"
        isPublic: true
      - availabilityZone: us-east-1a
        cidrBlock: "10.0.64.0/20"
        isPublic: false
      - availabilityZone: us-east-1b
        cidrBlock: "10.0.80.0/20"
        isPublic: false
      - availabilityZone: us-east-1c
        cidrBlock: "10.0.96.0/20"
        isPublic: false
  controlPlaneLoadBalancer:
    loadBalancerType: nlb
    scheme: internet-facing
```

### KubeadmControlPlane

```yaml
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: production-us-east-1-control-plane
  namespace: clusters
spec:
  replicas: 3
  version: v1.30.2
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSMachineTemplate
      name: production-us-east-1-control-plane
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
          cloud-provider: aws
          audit-log-path: /var/log/kubernetes/audit.log
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "100"
          feature-gates: "ServiceAccountIssuerDiscovery=true"
        extraVolumes:
          - name: audit-log
            hostPath: /var/log/kubernetes
            mountPath: /var/log/kubernetes
            readOnly: false
            pathType: DirectoryOrCreate
      controllerManager:
        extraArgs:
          cloud-provider: aws
          feature-gates: "RotateKubeletServerCertificate=true"
      etcd:
        local:
          dataDir: /var/lib/etcd
          extraArgs:
            quota-backend-bytes: "8589934592"   # 8 GB
            snapshot-count: "10000"
            heartbeat-interval: "100"
            election-timeout: "1000"
    joinConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: aws
    preKubeadmCommands:
      - |
        bash -c "
          sysctl -w net.ipv4.ip_forward=1
          sysctl -w net.bridge.bridge-nf-call-iptables=1
          sysctl -w fs.inotify.max_user_watches=524288
          echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.d/99-kubernetes.conf
        "
  rolloutStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-us-east-1-control-plane
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m6i.xlarge
      iamInstanceProfile: control-plane.cluster-api-provider-aws.sigs.k8s.io
      ami:
        id: ami-0a4e9d4b21d7b4a91   # Ubuntu 22.04 for k8s 1.30
      rootVolume:
        size: 100
        type: gp3
        iops: 3000
        throughput: 125
      nonRootVolumes:
        - deviceName: /dev/sdb
          size: 200
          type: gp3
          encrypted: true
      additionalTags:
        Environment: production
        ManagedBy: cluster-api
        Cluster: production-us-east-1
```

### MachineDeployment for Worker Nodes

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: production-us-east-1-workers-general
  namespace: clusters
  annotations:
    cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size: "3"
    cluster.x-k8s.io/cluster-api-autoscaler-node-group-max-size: "20"
spec:
  clusterName: production-us-east-1
  replicas: 5
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: production-us-east-1
      cluster.x-k8s.io/deployment-name: workers-general
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: production-us-east-1
        cluster.x-k8s.io/deployment-name: workers-general
        node-type: general
    spec:
      version: v1.30.2
      clusterName: production-us-east-1
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: production-us-east-1-workers
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-us-east-1-workers-general
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2
      maxUnavailable: 0
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSMachineTemplate
metadata:
  name: production-us-east-1-workers-general
  namespace: clusters
spec:
  template:
    spec:
      instanceType: m6i.2xlarge
      iamInstanceProfile: nodes.cluster-api-provider-aws.sigs.k8s.io
      ami:
        id: ami-0a4e9d4b21d7b4a91
      rootVolume:
        size: 200
        type: gp3
        iops: 3000
        encrypted: true
      additionalSecurityGroups:
        - id: sg-0a1b2c3d4e5f67890   # node security group
      additionalTags:
        Environment: production
        ManagedBy: cluster-api
        NodeType: general
---
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: production-us-east-1-workers
  namespace: clusters
spec:
  template:
    spec:
      joinConfiguration:
        nodeRegistration:
          name: "{{ ds.meta_data.local_hostname }}"
          kubeletExtraArgs:
            cloud-provider: aws
            node-labels: "node-type=general"
      preKubeadmCommands:
        - |
          bash -c "
            sysctl -w net.ipv4.ip_forward=1
            sysctl -w fs.inotify.max_user_watches=524288
            sysctl -w fs.file-max=131072
          "
```

## Cluster Autoscaling with CAPI

### Cluster Autoscaler Integration

The Cluster Autoscaler integrates with CAPI MachineDeployments to scale node groups based on pending pod pressure:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    metadata:
      labels:
        app: cluster-autoscaler
    spec:
      serviceAccountName: cluster-autoscaler
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.30.0
          command:
            - /cluster-autoscaler
            - --v=4
            - --cloud-provider=clusterapi
            - --namespace=clusters
            - --node-group-auto-discovery=clusterapi:namespace=clusters,clusterName=production-us-east-1
            - --scale-down-enabled=true
            - --scale-down-delay-after-add=10m
            - --scale-down-unneeded-time=10m
            - --scale-down-utilization-threshold=0.5
            - --max-node-provision-time=15m
            - --balance-similar-node-groups=true
            - --skip-nodes-with-system-pods=false
            - --skip-nodes-with-local-storage=false
            - --expander=least-waste
          resources:
            requests:
              cpu: 100m
              memory: 300Mi
            limits:
              cpu: 500m
              memory: 600Mi
          volumeMounts:
            - name: kubeconfig
              mountPath: /etc/kubernetes
              readOnly: true
      volumes:
        - name: kubeconfig
          secret:
            secretName: production-us-east-1-kubeconfig
```

## Cluster Upgrades

### Rolling Control Plane Upgrade

CAPI handles control plane upgrades by updating the `version` field on `KubeadmControlPlane`. The controller replaces control plane machines one at a time using the rollout strategy:

```bash
# Upgrade control plane version
kubectl patch kcp production-us-east-1-control-plane \
  -n clusters \
  --type merge \
  -p '{"spec":{"version":"v1.31.0"}}'

# Monitor the rollout
kubectl get kcp -n clusters -w
# NAME                                     CLUSTER                  INITIALIZED  API SERVER AVAILABLE  REPLICAS  READY  UPDATED  UNAVAILABLE  AGE  VERSION
# production-us-east-1-control-plane       production-us-east-1     true         true                  3         3      1        0            30d  v1.31.0

# Watch individual machine transitions
kubectl get machines -n clusters -l cluster.x-k8s.io/cluster-name=production-us-east-1
```

### Worker Node Upgrade

Worker node upgrades proceed through updating the `MachineDeployment` spec:

```bash
# Update worker Kubernetes version
kubectl patch machinedeployment production-us-east-1-workers-general \
  -n clusters \
  --type merge \
  -p '{"spec":{"template":{"spec":{"version":"v1.31.0"}}}}'

# Update machine template to new AMI for k8s 1.31
kubectl patch awsmachinetemplate production-us-east-1-workers-general \
  -n clusters \
  --type merge \
  -p '{"spec":{"template":{"spec":{"ami":{"id":"ami-0new1ami2forv13130"}}}}}'

# Monitor
kubectl rollout status machinedeployment/production-us-east-1-workers-general -n clusters
```

### Pre-Upgrade Health Validation

```bash
#!/usr/bin/env bash
# pre-upgrade-check.sh
set -euo pipefail

CLUSTER_NAME="${1:?cluster name required}"
NAMESPACE="${2:-clusters}"

echo "Pre-upgrade health check for ${CLUSTER_NAME}..."

# Get kubeconfig for workload cluster
clusterctl get kubeconfig "${CLUSTER_NAME}" -n "${NAMESPACE}" > /tmp/wl-kubeconfig.yaml
export KUBECONFIG=/tmp/wl-kubeconfig.yaml

# Check all nodes ready
NOT_READY=$(kubectl get nodes --no-headers | grep -v ' Ready' | wc -l)
if [[ "${NOT_READY}" -gt 0 ]]; then
  echo "FAIL: ${NOT_READY} nodes are not Ready"
  kubectl get nodes | grep -v ' Ready'
  exit 1
fi
echo "PASS: All nodes Ready"

# Check control plane pods
for component in kube-apiserver kube-controller-manager kube-scheduler etcd; do
  NOT_RUNNING=$(kubectl get pods -n kube-system -l "component=${component}" \
    --no-headers | grep -v Running | wc -l)
  if [[ "${NOT_RUNNING}" -gt 0 ]]; then
    echo "FAIL: ${component} has ${NOT_RUNNING} non-running pods"
    exit 1
  fi
  echo "PASS: ${component} pods running"
done

# Check etcd member health
ETCD_POD=$(kubectl get pods -n kube-system -l component=etcd -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n kube-system "${ETCD_POD}" -- \
  etcdctl --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
    --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
    endpoint health --cluster

echo "Pre-upgrade checks passed for ${CLUSTER_NAME}"
```

## Multi-Cluster Management with ClusterClass

`ClusterClass` introduces templating for cluster definitions, enabling consistent cluster creation across teams with topology-driven customization:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: company-aws-standard
  namespace: clusters
spec:
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: company-aws-standard-control-plane
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: company-aws-standard-control-plane
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: company-aws-standard
  workers:
    machineDeployments:
      - class: general-purpose
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: company-aws-standard-workers
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: company-aws-standard-workers-general
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
          default: "m6i.xlarge"
    - name: workerInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: "m6i.2xlarge"
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

Teams provision clusters using `ClusterClass`:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: team-payments-prod
  namespace: clusters
  labels:
    team: payments
    environment: production
spec:
  topology:
    class: company-aws-standard
    version: v1.30.2
    variables:
      - name: region
        value: us-east-1
      - name: controlPlaneInstanceType
        value: m6i.2xlarge
    controlPlane:
      replicas: 3
    workers:
      machineDeployments:
        - name: general
          class: general-purpose
          replicas: 8
          variables:
            overrides:
              - name: workerInstanceType
                value: m6i.4xlarge
```

## GitOps Integration with ArgoCD

Store cluster manifests in Git and sync with ArgoCD:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: cluster-management
  namespace: argocd
spec:
  description: "Cluster API workload cluster definitions"
  sourceRepos:
    - "https://github.com/company/cluster-configurations"
  destinations:
    - namespace: clusters
      server: https://kubernetes.default.svc
  clusterResourceWhitelist:
    - group: cluster.x-k8s.io
      kind: "*"
    - group: infrastructure.cluster.x-k8s.io
      kind: "*"
    - group: controlplane.cluster.x-k8s.io
      kind: "*"
    - group: bootstrap.cluster.x-k8s.io
      kind: "*"
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: workload-clusters
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: https://github.com/company/cluster-configurations
        revision: main
        directories:
          - path: "clusters/*"
  template:
    metadata:
      name: "cluster-{{path.basename}}"
    spec:
      project: cluster-management
      source:
        repoURL: https://github.com/company/cluster-configurations
        targetRevision: main
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: clusters
      syncPolicy:
        automated:
          prune: false       # Never auto-delete clusters
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ApplyOutOfSyncOnly=true
        retry:
          limit: 5
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
```

## Operational Commands

```bash
# List all clusters across all namespaces
clusterctl describe cluster -n clusters

# Get kubeconfig for a workload cluster
clusterctl get kubeconfig production-us-east-1 -n clusters > ~/.kube/production-us-east-1.kubeconfig

# Check machine health
kubectl get machines -n clusters -o wide

# View machine phase
kubectl get machines -n clusters \
  -l cluster.x-k8s.io/cluster-name=production-us-east-1 \
  -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,PROVIDER:.status.infrastructure'

# Move management cluster (pivot to permanent management cluster)
# Used when bootstrapping from a temporary kind cluster to a permanent cluster
clusterctl move \
  --to-kubeconfig /path/to/permanent-management-kubeconfig \
  -n clusters

# Generate a cluster manifest from ClusterClass
clusterctl generate cluster team-payments-dev \
  --infrastructure aws:v2.5.2 \
  --kubernetes-version v1.30.2 \
  --control-plane-machine-count 3 \
  --worker-machine-count 5 \
  > team-payments-dev.yaml

# Force machine remediation
kubectl delete machine <machine-name> -n clusters
# CAPI will create a replacement machine automatically
```

## Summary

Cluster API delivers enterprise-grade cluster lifecycle management through declarative Kubernetes objects:

- **Consistent provisioning** across AWS, GCP, vSphere, and bare-metal via provider abstraction
- **Version-controlled cluster definitions** enabling GitOps-driven cluster management
- **ClusterClass** eliminates cluster configuration drift across teams
- **Integrated autoscaling** through Cluster Autoscaler awareness of MachineDeployment bounds
- **Controlled upgrades** with rolling replacement of control plane and worker nodes
- **Operational consistency** — the same `kubectl` tooling used for applications manages cluster infrastructure

For organizations running more than a handful of Kubernetes clusters, Cluster API is the operational foundation that transforms ad-hoc cluster management into a repeatable, auditable engineering practice.
