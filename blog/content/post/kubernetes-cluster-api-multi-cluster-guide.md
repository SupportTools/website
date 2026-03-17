---
title: "Kubernetes Multi-Cluster Management with Cluster API: Provider Implementation and GitOps Integration"
date: 2028-07-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "Multi-Cluster", "GitOps", "Infrastructure"]
categories:
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to managing multi-cluster Kubernetes infrastructure with Cluster API, covering AWS and GCP provider configuration, GitOps integration with Fleet or ArgoCD, and cluster lifecycle automation."
more_link: "yes"
url: "/kubernetes-cluster-api-multi-cluster-guide/"
---

Cluster API (CAPI) is the Kubernetes-native way to declaratively manage the lifecycle of Kubernetes clusters. Rather than clicking through cloud consoles or running custom automation scripts, you define clusters as Kubernetes objects and let controllers reconcile the desired state. A management cluster runs the CAPI controllers and owns the lifecycle of workload clusters — creation, upgrades, scaling, and deletion.

This guide covers the complete CAPI workflow: bootstrapping a management cluster, deploying clusters on AWS and GCP, implementing a GitOps workflow with Fleet for cluster lifecycle management, and the operational patterns for running hundreds of clusters through a single management plane.

<!--more-->

# Kubernetes Multi-Cluster Management with Cluster API

## Section 1: Architecture and Core Concepts

### The CAPI Object Model

CAPI defines several core CRDs:

- **Cluster**: The top-level object representing a workload cluster. References an InfrastructureCluster and a ControlPlane object.
- **Machine**: Represents a single node. References an InfrastructureMachine and a Bootstrap object.
- **MachineSet**: Maintains a stable set of Machine objects (similar to ReplicaSet for pods).
- **MachineDeployment**: Provides declarative updates to MachineSets (similar to Deployment).
- **ClusterClass**: A template for creating clusters with standardized configurations.

Provider-specific objects extend these:
- `AWSCluster` / `AWSMachine` (AWS provider)
- `GCPCluster` / `GCPMachine` (GCP provider)
- `AzureCluster` / `AzureMachine` (Azure provider)

### Management vs Workload Clusters

The management cluster runs:
- CAPI controllers
- Provider-specific controllers (CAPA, CAPG, CAPZ)
- Bootstrap provider (kubeadm)
- ArgoCD or Fleet for GitOps

Workload clusters:
- Contain no CAPI infrastructure themselves
- Are fully managed by the management cluster
- Receive applications via GitOps push from the management cluster

## Section 2: Bootstrapping the Management Cluster

### Using clusterctl

```bash
# Install clusterctl
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.7.0/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Initialize the management cluster with AWS provider
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"
export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
export AWS_B64ENCODED_CREDENTIALS=$(clusterctl generate provider --infrastructure aws \
  --list-variables 2>/dev/null | grep -v "^#" | head -1)

# Create the AWS CloudFormation stack for CAPI IAM roles
clusterawsadm bootstrap iam create-cloudformation-stack --region us-east-1

# Export credentials for CAPI
export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)

# Initialize the management cluster
clusterctl init \
  --infrastructure aws \
  --control-plane kubeadm \
  --bootstrap kubeadm

# Verify all providers are ready
kubectl get pods -n capi-system
kubectl get pods -n capa-system
kubectl get pods -n capi-kubeadm-bootstrap-system
kubectl get pods -n capi-kubeadm-control-plane-system
```

### Multi-Provider Management Cluster

For organizations running on multiple clouds:

```bash
# Initialize with multiple providers
clusterctl init \
  --infrastructure aws:v2.5.0,gcp:v1.7.0,azure:v1.14.0 \
  --control-plane kubeadm:v1.7.0 \
  --bootstrap kubeadm:v1.7.0

# Verify all providers
clusterctl describe provider --list
```

## Section 3: Creating Clusters on AWS

### Using ClusterClass for Standardization

ClusterClass defines a reusable cluster topology:

```yaml
# clusterclasses/aws-standard.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: aws-standard-v1
  namespace: default
spec:
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: aws-standard-control-plane
    machineInfrastructure:
      ref:
        kind: AWSMachineTemplate
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        name: aws-standard-control-plane-machine
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: aws-standard-cluster
  workers:
    machineDeployments:
    - class: general-purpose
      template:
        bootstrap:
          ref:
            apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
            kind: KubeadmConfigTemplate
            name: aws-standard-worker-bootstrap
        infrastructure:
          ref:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
            kind: AWSMachineTemplate
            name: aws-standard-worker-machine
  variables:
  - name: region
    required: true
    schema:
      openAPIV3Schema:
        type: string
        description: AWS region
  - name: vpcCidr
    required: false
    schema:
      openAPIV3Schema:
        type: string
        default: "10.0.0.0/16"
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
        default: "m5.large"
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
        path: "/spec/template/spec/region"
        valueFrom:
          variable: region
  - name: control-plane-instance-type
    definitions:
    - selector:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        matchResources:
          controlPlane: true
      jsonPatches:
      - op: replace
        path: "/spec/template/spec/instanceType"
        valueFrom:
          variable: controlPlaneInstanceType
```

### AWSClusterTemplate

```yaml
# templates/aws-cluster-template.yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSClusterTemplate
metadata:
  name: aws-standard-cluster
  namespace: default
spec:
  template:
    spec:
      region: us-east-1  # Will be patched by ClusterClass
      sshKeyName: my-ssh-key
      network:
        vpc:
          availabilityZoneUsageLimit: 3
          availabilityZoneSelection: Ordered
        cni:
          cniIngressRules:
          - description: "BGP (calico)"
            protocol: tcp
            fromPort: 179
            toPort: 179
          - description: "IP-in-IP (calico)"
            protocol: "4"
            fromPort: -1
            toPort: -1
      controlPlaneLoadBalancer:
        loadBalancerType: nlb  # Network Load Balancer
        scheme: internet-facing
      identityRef:
        kind: AWSClusterControllerIdentity
        name: default
```

### KubeadmControlPlaneTemplate

```yaml
# templates/control-plane-template.yaml
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlaneTemplate
metadata:
  name: aws-standard-control-plane
  namespace: default
spec:
  template:
    spec:
      kubeadmConfigSpec:
        initConfiguration:
          nodeRegistration:
            name: "{{ ds.meta_data.local_hostname }}"
            kubeletExtraArgs:
              cloud-provider: external
              node-labels: "cluster-role=control-plane"
        clusterConfiguration:
          apiServer:
            extraArgs:
              cloud-provider: external
              audit-log-path: /var/log/audit/kube-apiserver-audit.log
              audit-log-maxage: "30"
              audit-log-maxbackup: "3"
              audit-log-maxsize: "100"
              audit-policy-file: /etc/kubernetes/audit-policy.yaml
              feature-gates: "ServerSideApply=true"
            extraVolumes:
            - name: audit-policy
              hostPath: /etc/kubernetes/audit-policy.yaml
              mountPath: /etc/kubernetes/audit-policy.yaml
              readOnly: true
            - name: audit-log
              hostPath: /var/log/audit
              mountPath: /var/log/audit
          controllerManager:
            extraArgs:
              cloud-provider: external
          etcd:
            local:
              extraArgs:
                auto-compaction-retention: "1"
                quota-backend-bytes: "8589934592"  # 8GB
        joinConfiguration:
          nodeRegistration:
            name: "{{ ds.meta_data.local_hostname }}"
            kubeletExtraArgs:
              cloud-provider: external
        preKubeadmCommands:
        - "echo 'net.ipv4.ip_forward = 1' >> /etc/sysctl.conf"
        - "sysctl -p"
        - "mkdir -p /etc/kubernetes"
        - "cat > /etc/kubernetes/audit-policy.yaml << 'EOF'\napiVersion: audit.k8s.io/v1\nkind: Policy\nrules:\n- level: RequestResponse\n  resources:\n  - group: ''\n    resources: [secrets, configmaps]\nEOF"
      rolloutStrategy:
        type: RollingUpdate
        rollingUpdate:
          maxSurge: 1
```

### Creating a Cluster from ClusterClass

```yaml
# clusters/production-us-east.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: production-us-east
  namespace: clusters
  labels:
    environment: production
    region: us-east-1
    cloud: aws
    cni: calico
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
      - 192.168.0.0/16
    services:
      cidrBlocks:
      - 10.96.0.0/12
  topology:
    class: aws-standard-v1
    version: v1.30.0
    controlPlane:
      replicas: 3
      metadata:
        labels:
          cluster-role: control-plane
    workers:
      machineDeployments:
      - class: general-purpose
        name: general
        replicas: 5
        metadata:
          labels:
            cluster-role: worker
        variables:
          overrides:
          - name: workerInstanceType
            value: "m5.2xlarge"
    variables:
    - name: region
      value: "us-east-1"
    - name: controlPlaneInstanceType
      value: "m5.xlarge"
    - name: vpcCidr
      value: "10.10.0.0/16"
```

## Section 4: GCP Provider Configuration

```bash
# Export GCP credentials for CAPG
export GCP_PROJECT_ID="my-gcp-project"
export GCP_REGION="us-central1"

# Create service account for CAPG
gcloud iam service-accounts create capg-manager \
  --project=${GCP_PROJECT_ID}

# Assign required roles
for role in compute.admin iam.serviceAccountUser storage.admin; do
  gcloud projects add-iam-policy-binding ${GCP_PROJECT_ID} \
    --member="serviceAccount:capg-manager@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/${role}"
done

# Create and export key
gcloud iam service-accounts keys create /tmp/capg-key.json \
  --iam-account=capg-manager@${GCP_PROJECT_ID}.iam.gserviceaccount.com

export GCP_B64ENCODED_CREDENTIALS=$(cat /tmp/capg-key.json | base64 -w0)

# Initialize GCP provider
clusterctl init --infrastructure gcp
```

### GCP Cluster Template

```yaml
# clusters/staging-gcp.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: staging-gcp
  namespace: clusters
  labels:
    environment: staging
    cloud: gcp
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
      - 192.168.0.0/16
    services:
      cidrBlocks:
      - 10.96.0.0/12
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: GCPCluster
    name: staging-gcp
  controlPlaneRef:
    kind: KubeadmControlPlane
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    name: staging-gcp-control-plane
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: GCPCluster
metadata:
  name: staging-gcp
  namespace: clusters
spec:
  region: us-central1
  project: my-gcp-project
  network:
    name: staging-network
  failureDomains:
  - us-central1-a
  - us-central1-b
  - us-central1-c
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: staging-gcp-control-plane
  namespace: clusters
spec:
  replicas: 3
  version: v1.30.0
  machineTemplate:
    infrastructureRef:
      kind: GCPMachineTemplate
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
      name: staging-gcp-control-plane-machine
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: gce
    clusterConfiguration:
      apiServer:
        extraArgs:
          cloud-provider: gce
      controllerManager:
        extraArgs:
          cloud-provider: gce
    joinConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: gce
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: GCPMachineTemplate
metadata:
  name: staging-gcp-control-plane-machine
  namespace: clusters
spec:
  template:
    spec:
      instanceType: n1-standard-4
      image: "projects/my-gcp-project/global/images/ubuntu-2204-k8s-v1-30"
      rootDeviceSize: 50
      serviceAccounts:
        email: capg-nodes@my-gcp-project.iam.gserviceaccount.com
        scopes:
        - "https://www.googleapis.com/auth/cloud-platform"
```

## Section 5: GitOps Integration with Fleet

Rancher Fleet provides multi-cluster GitOps directly on top of CAPI clusters:

### Installing Fleet on the Management Cluster

```bash
helm repo add fleet https://rancher.github.io/fleet-helm-charts/
helm repo update

helm install fleet-crd fleet/fleet-crd -n cattle-fleet-system --create-namespace
helm install fleet fleet/fleet -n cattle-fleet-system \
  --set apiServerURL="https://$(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}'):443"
```

### Registering CAPI Clusters with Fleet

After a CAPI cluster is provisioned, register it with Fleet:

```go
// cmd/cluster-registrar/main.go
package main

import (
    "context"
    "encoding/base64"
    "fmt"
    "log/slog"
    "os"
    "time"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
    "k8s.io/client-go/tools/clientcmd"
    "sigs.k8s.io/controller-runtime/pkg/client"

    clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
    fleetv1 "github.com/rancher/fleet/pkg/apis/fleet.cattle.io/v1alpha1"
)

type ClusterRegistrar struct {
    mgmtClient  client.Client
    fleetClient client.Client
    logger      *slog.Logger
}

func (r *ClusterRegistrar) RegisterCluster(ctx context.Context, cluster *clusterv1.Cluster) error {
    r.logger.Info("registering cluster with Fleet",
        "cluster", cluster.Name,
        "namespace", cluster.Namespace,
    )

    // Get the kubeconfig for the workload cluster
    kubeconfig, err := r.getWorkloadKubeconfig(ctx, cluster)
    if err != nil {
        return fmt.Errorf("getting kubeconfig: %w", err)
    }

    // Create the Fleet ClusterRegistrationToken
    token := &fleetv1.ClusterRegistrationToken{
        ObjectMeta: metav1.ObjectMeta{
            Name:      cluster.Name,
            Namespace: "fleet-local",
        },
        Spec: fleetv1.ClusterRegistrationTokenSpec{
            TTL: &metav1.Duration{Duration: 0}, // No expiry
        },
    }

    if err := r.fleetClient.Create(ctx, token); err != nil {
        return fmt.Errorf("creating registration token: %w", err)
    }

    // Install the Fleet agent on the workload cluster
    workloadClient, err := clientFromKubeconfig(kubeconfig)
    if err != nil {
        return fmt.Errorf("creating workload client: %w", err)
    }

    if err := r.installFleetAgent(ctx, workloadClient, cluster.Name, token); err != nil {
        return fmt.Errorf("installing fleet agent: %w", err)
    }

    r.logger.Info("cluster registered with Fleet", "cluster", cluster.Name)
    return nil
}

func (r *ClusterRegistrar) getWorkloadKubeconfig(ctx context.Context, cluster *clusterv1.Cluster) ([]byte, error) {
    secretName := fmt.Sprintf("%s-kubeconfig", cluster.Name)
    secret := &corev1.Secret{}
    if err := r.mgmtClient.Get(ctx,
        client.ObjectKey{Name: secretName, Namespace: cluster.Namespace},
        secret,
    ); err != nil {
        return nil, err
    }

    kubeconfig, ok := secret.Data["value"]
    if !ok {
        return nil, fmt.Errorf("kubeconfig secret missing 'value' key")
    }
    return kubeconfig, nil
}

func clientFromKubeconfig(kubeconfig []byte) (*kubernetes.Clientset, error) {
    config, err := clientcmd.RESTConfigFromKubeConfig(kubeconfig)
    if err != nil {
        return nil, err
    }
    return kubernetes.NewForConfig(config)
}
```

### Fleet GitRepo for Workload Clusters

```yaml
# fleet/gitrepo.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: platform-workloads
  namespace: fleet-default
spec:
  repo: "https://github.com/myorg/platform-workloads"
  branch: main
  paths:
  - /workloads
  targets:
  - name: production
    clusterSelector:
      matchLabels:
        environment: production
  - name: staging
    clusterSelector:
      matchLabels:
        environment: staging
  - name: development
    clusterSelector:
      matchLabels:
        environment: development
---
# Restrict which clusters receive platform components
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: platform-infrastructure
  namespace: fleet-default
spec:
  repo: "https://github.com/myorg/platform-infrastructure"
  branch: main
  paths:
  - /monitoring    # Prometheus, Grafana
  - /logging       # Loki, Promtail
  - /ingress       # Ingress controllers
  targets:
  - name: all-clusters
    clusterSelector:
      matchExpressions:
      - key: environment
        operator: In
        values: [production, staging, development]
```

## Section 6: Cluster Lifecycle Automation

### Automatic CNI Installation

After CAPI creates a cluster, it needs a CNI. Use a custom controller:

```go
// controllers/cluster_cni_controller.go
package controllers

import (
    "context"
    "fmt"

    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
    "helm.sh/helm/v3/pkg/action"
)

const (
    cniInstalledAnnotation = "myorg.io/cni-installed"
    cniRetryAnnotation     = "myorg.io/cni-install-attempts"
)

type ClusterCNIReconciler struct {
    client.Client
    HelmConfig *action.Configuration
}

func (r *ClusterCNIReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
    logger := log.FromContext(ctx)

    cluster := &clusterv1.Cluster{}
    if err := r.Get(ctx, req.NamespacedName, cluster); err != nil {
        return reconcile.Result{}, client.IgnoreNotFound(err)
    }

    // Only reconcile ready clusters
    if !cluster.Status.ControlPlaneReady {
        return reconcile.Result{RequeueAfter: 30 * time.Second}, nil
    }

    // Check if CNI already installed
    if _, ok := cluster.Annotations[cniInstalledAnnotation]; ok {
        return reconcile.Result{}, nil
    }

    cniType := cluster.Labels["cni"]
    if cniType == "" {
        cniType = "calico"
    }

    logger.Info("installing CNI", "cluster", cluster.Name, "cni", cniType)

    if err := r.installCNI(ctx, cluster, cniType); err != nil {
        return reconcile.Result{}, fmt.Errorf("installing CNI: %w", err)
    }

    // Mark as installed
    patch := client.MergeFrom(cluster.DeepCopy())
    if cluster.Annotations == nil {
        cluster.Annotations = make(map[string]string)
    }
    cluster.Annotations[cniInstalledAnnotation] = "true"
    if err := r.Patch(ctx, cluster, patch); err != nil {
        return reconcile.Result{}, err
    }

    logger.Info("CNI installed", "cluster", cluster.Name)
    return reconcile.Result{}, nil
}

func (r *ClusterCNIReconciler) installCNI(ctx context.Context, cluster *clusterv1.Cluster, cniType string) error {
    // Get workload cluster kubeconfig
    kubeconfig, err := r.getKubeconfig(ctx, cluster)
    if err != nil {
        return err
    }

    switch cniType {
    case "calico":
        return r.installCalico(ctx, kubeconfig, cluster)
    case "cilium":
        return r.installCilium(ctx, kubeconfig, cluster)
    default:
        return fmt.Errorf("unknown CNI type: %s", cniType)
    }
}

func (r *ClusterCNIReconciler) installCalico(ctx context.Context, kubeconfig []byte, cluster *clusterv1.Cluster) error {
    // Use Helm to install Calico
    actionConfig := &action.Configuration{}
    workloadClient, err := buildRESTClientFromKubeconfig(kubeconfig)
    if err != nil {
        return err
    }

    if err := actionConfig.Init(
        k8sRESTClientGetter(workloadClient),
        "calico-system",
        "secret",
        log.Log.Info,
    ); err != nil {
        return err
    }

    install := action.NewInstall(actionConfig)
    install.RepoURL = "https://docs.tigera.io/calico/charts"
    install.ChartPathOptions.Version = "3.28.0"
    install.ReleaseName = "calico"
    install.Namespace = "calico-system"
    install.CreateNamespace = true
    install.WaitForJobs = true
    install.Timeout = 10 * time.Minute

    chart, err := install.LocateChart("tigera-operator", install.ChartPathOptions)
    if err != nil {
        return fmt.Errorf("locating calico chart: %w", err)
    }

    vals := map[string]interface{}{
        "installation": map[string]interface{}{
            "cni": map[string]interface{}{
                "type": "Calico",
            },
            "calicoNetwork": map[string]interface{}{
                "ipPools": []interface{}{
                    map[string]interface{}{
                        "cidr":          cluster.Spec.ClusterNetwork.Pods.CIDRBlocks[0],
                        "encapsulation": "VXLANCrossSubnet",
                    },
                },
            },
        },
    }

    _, err = install.RunWithContext(ctx, chart, vals)
    return err
}
```

## Section 7: Cluster Upgrades

CAPI makes Kubernetes upgrades declarative:

```bash
# Check available upgrades
clusterctl upgrade plan

# Upgrade a specific cluster
kubectl patch cluster production-us-east -n clusters \
  --type=merge \
  -p '{"spec":{"topology":{"version":"v1.31.0"}}}'

# Watch the upgrade progress
kubectl argo rollouts get rollout production-us-east -n clusters --watch

# Or watch with clusterctl
clusterctl describe cluster production-us-east -n clusters --show-conditions all
```

### Upgrade Automation Script

```bash
#!/bin/bash
# upgrade-cluster.sh — Safe cluster upgrade with validation

set -euo pipefail

CLUSTER_NAME=${1:?cluster name required}
TARGET_VERSION=${2:?target version required}
NAMESPACE=${3:-clusters}

echo "Upgrading cluster ${CLUSTER_NAME} to ${TARGET_VERSION}"

# Pre-flight checks
echo "Running pre-flight checks..."

# Check current cluster health
READY=$(kubectl get cluster "${CLUSTER_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
if [[ "${READY}" != "True" ]]; then
  echo "ERROR: Cluster ${CLUSTER_NAME} is not in Ready state"
  exit 1
fi

# Check that worker nodes are healthy
READY_NODES=$(kubectl --kubeconfig=<(clusterctl get kubeconfig "${CLUSTER_NAME}" -n "${NAMESPACE}") \
  get nodes -o jsonpath='{.items[?(@.status.conditions[-1].status=="True")].metadata.name}' | \
  wc -w)
TOTAL_NODES=$(kubectl --kubeconfig=<(clusterctl get kubeconfig "${CLUSTER_NAME}" -n "${NAMESPACE}") \
  get nodes --no-headers | wc -l)

if [[ "${READY_NODES}" -lt "${TOTAL_NODES}" ]]; then
  echo "WARNING: Only ${READY_NODES}/${TOTAL_NODES} nodes are ready"
  echo "Continue anyway? (y/N)"
  read -r answer
  [[ "${answer}" == "y" ]] || exit 1
fi

# Apply the version update
echo "Applying version update..."
kubectl patch cluster "${CLUSTER_NAME}" -n "${NAMESPACE}" \
  --type=merge \
  -p "{\"spec\":{\"topology\":{\"version\":\"${TARGET_VERSION}\"}}}"

# Monitor progress
echo "Monitoring upgrade progress (timeout: 30 minutes)..."
TIMEOUT=1800
START=$(date +%s)

while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))

  if [[ ${ELAPSED} -gt ${TIMEOUT} ]]; then
    echo "ERROR: Upgrade timed out after 30 minutes"
    exit 1
  fi

  # Check control plane version
  CP_VERSION=$(kubectl get kubeadmcontrolplane \
    -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
    -n "${NAMESPACE}" \
    -o jsonpath='{.items[0].status.version}')

  # Check MachineDeployment versions
  MD_VERSIONS=$(kubectl get machinedeployment \
    -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
    -n "${NAMESPACE}" \
    -o jsonpath='{range .items[*]}{.status.readyReplicas}{"/"}{.status.replicas}{"\n"}{end}')

  echo "Progress: Control plane ${CP_VERSION} | Workers: ${MD_VERSIONS}"

  # Check if upgrade complete
  if [[ "${CP_VERSION}" == "${TARGET_VERSION}" ]]; then
    READY=$(kubectl get cluster "${CLUSTER_NAME}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
    if [[ "${READY}" == "True" ]]; then
      echo "Upgrade complete!"
      break
    fi
  fi

  sleep 30
done

echo "Cluster ${CLUSTER_NAME} successfully upgraded to ${TARGET_VERSION}"
```

## Section 8: Multi-Cluster Observability

```yaml
# monitoring/cluster-metrics-federation.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-federation-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 30s
      evaluation_interval: 30s

    scrape_configs:
    # Federate metrics from all workload clusters
    - job_name: 'federate'
      scrape_interval: 15s
      honor_labels: true
      metrics_path: '/federate'
      params:
        'match[]':
          - '{job="kubernetes-pods"}'
          - '{job="kubernetes-nodes"}'
          - '{__name__=~"up|scrape_.*"}'
      static_configs:
      # Dynamically generated from CAPI cluster list
      # Use cluster-discovery sidecar to update this
      - targets:
        - 'prometheus.production-us-east.clusters.local:9090'
        labels:
          cluster: production-us-east
          environment: production
          cloud: aws
      - targets:
        - 'prometheus.staging-gcp.clusters.local:9090'
        labels:
          cluster: staging-gcp
          environment: staging
          cloud: gcp
```

```go
// cmd/cluster-discovery/main.go
// Watches CAPI clusters and updates Prometheus federation targets

package main

import (
    "context"
    "encoding/json"
    "os"
    "path/filepath"
    "time"

    corev1 "k8s.io/api/core/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
)

type PrometheusSD struct {
    Targets []string          `json:"targets"`
    Labels  map[string]string `json:"labels"`
}

func generateSDConfig(clusters []clusterv1.Cluster) []PrometheusSD {
    var configs []PrometheusSD
    for _, cluster := range clusters {
        if cluster.Status.ControlPlaneReady {
            configs = append(configs, PrometheusSD{
                Targets: []string{
                    fmt.Sprintf("prometheus.%s.clusters.local:9090", cluster.Name),
                },
                Labels: map[string]string{
                    "cluster":     cluster.Name,
                    "environment": cluster.Labels["environment"],
                    "cloud":       cluster.Labels["cloud"],
                    "region":      cluster.Labels["region"],
                },
            })
        }
    }
    return configs
}

func main() {
    ctx := context.Background()
    c := buildClient()

    ticker := time.NewTicker(5 * time.Minute)
    defer ticker.Stop()

    for {
        clusterList := &clusterv1.ClusterList{}
        if err := c.List(ctx, clusterList); err != nil {
            slog.Error("listing clusters", "error", err)
            continue
        }

        configs := generateSDConfig(clusterList.Items)
        data, _ := json.MarshalIndent(configs, "", "  ")

        if err := os.WriteFile("/etc/prometheus/sd/clusters.json", data, 0644); err != nil {
            slog.Error("writing SD config", "error", err)
        }

        <-ticker.C
    }
}
```

## Section 9: Cluster Deletion and Cleanup

```bash
# Safe cluster deletion
delete_cluster() {
    local CLUSTER_NAME=$1
    local NAMESPACE=${2:-clusters}

    echo "Preparing to delete cluster ${CLUSTER_NAME}"

    # Verify no applications are running
    kubectl --kubeconfig=<(clusterctl get kubeconfig "${CLUSTER_NAME}" -n "${NAMESPACE}") \
      get pods --all-namespaces | grep -v "^NAMESPACE\|^kube-system\|^cattle" | head -20

    echo "Press ENTER to continue with deletion or Ctrl+C to abort"
    read -r

    # Remove from Fleet/ArgoCD first
    kubectl delete gitrepobinding -l "cluster=${CLUSTER_NAME}" -n fleet-default 2>/dev/null || true
    kubectl delete application -l "cluster=${CLUSTER_NAME}" -n argocd 2>/dev/null || true

    # Delete the CAPI cluster (triggers infrastructure deletion)
    kubectl delete cluster "${CLUSTER_NAME}" -n "${NAMESPACE}"

    # Wait for deletion
    echo "Waiting for cluster deletion..."
    kubectl wait --for=delete cluster "${CLUSTER_NAME}" -n "${NAMESPACE}" --timeout=30m

    echo "Cluster ${CLUSTER_NAME} deleted"
}
```

## Section 10: ClusterClass Versioning and Upgrades

Upgrading the ClusterClass template affects all clusters using it:

```bash
# Create a new ClusterClass version
kubectl apply -f clusterclasses/aws-standard-v2.yaml

# Migrate clusters to new class
for cluster in $(kubectl get clusters -n clusters -l clusterClass=aws-standard-v1 -o name); do
    echo "Migrating ${cluster} to aws-standard-v2..."
    kubectl patch "${cluster}" -n clusters \
      --type=merge \
      -p '{"spec":{"topology":{"class":"aws-standard-v2"}}}'

    # Wait for reconciliation
    kubectl wait "${cluster}" -n clusters \
      --for=condition=Ready \
      --timeout=30m

    echo "${cluster} migrated successfully"
done
```

## Conclusion

Cluster API shifts cluster lifecycle management from procedural scripts to declarative Kubernetes resources, and that shift has profound operational implications. Rolling upgrades, scaling events, and disaster recovery all become `kubectl patch` operations backed by controllers that handle retries, rollbacks, and error reporting in a consistent way.

The integration with Fleet or ArgoCD completes the picture: workload clusters are provisioned, configured with CNI and platform tooling, and enrolled in GitOps workflows without manual intervention. The Cluster class pattern enforces organizational standards (encryption, audit logging, node sizing) across every cluster without requiring each team to understand the underlying complexity. At scale, this means consistent security posture and operational behavior across hundreds of clusters managed by a team of a dozen.
