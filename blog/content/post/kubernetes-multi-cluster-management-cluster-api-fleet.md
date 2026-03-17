---
title: "Kubernetes Multi-Cluster Management with Cluster API and Fleet"
date: 2030-01-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "Fleet", "GitOps", "Multi-Cluster", "Platform Engineering"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to managing multiple Kubernetes clusters with Cluster API providers, Fleet for GitOps across clusters, hub-spoke architecture, and full cluster lifecycle management."
more_link: "yes"
url: "/kubernetes-multi-cluster-management-cluster-api-fleet/"
---

Managing a single Kubernetes cluster is straightforward. Managing dozens or hundreds of clusters across multiple cloud providers, on-premises environments, and edge locations is an entirely different challenge. This guide covers the complete enterprise approach to multi-cluster Kubernetes management using Cluster API (CAPI) for declarative cluster lifecycle management and Fleet (from Rancher) for GitOps-based workload distribution across cluster fleets.

By the end of this guide, your platform team will be able to provision, upgrade, and decommission clusters declaratively, push workloads to targeted cluster subsets through GitOps, and maintain consistent security and configuration posture across your entire fleet.

<!--more-->

# Kubernetes Multi-Cluster Management with Cluster API and Fleet

## The Multi-Cluster Problem

Enterprise Kubernetes adoption rarely stops at one cluster. Common drivers for multi-cluster architectures include:

- **Blast radius isolation**: Production incidents in one cluster do not cascade to others
- **Regulatory compliance**: Data sovereignty requirements mandate geographic separation
- **Team autonomy**: Individual teams own their cluster resources without interfering with others
- **Technology heterogeneity**: GPU clusters for ML workloads, ARM clusters for cost optimization, bare-metal clusters for latency-sensitive applications
- **High availability**: Cross-region active-active deployments require independent cluster control planes

Managing these clusters without automation creates an operational nightmare: manual kubectl config juggling, inconsistent configurations, ad-hoc upgrade procedures, and no audit trail for changes. Cluster API and Fleet solve this by applying Infrastructure-as-Code and GitOps principles to cluster management itself.

## Architecture Overview

### Hub-Spoke Model

The recommended architecture uses a dedicated management cluster that acts as the hub, with workload clusters as spokes:

```
                    ┌─────────────────────────────────┐
                    │      Management Cluster (Hub)    │
                    │                                  │
                    │  ┌─────────┐  ┌──────────────┐  │
                    │  │  CAPI   │  │  Fleet Hub   │  │
                    │  │ Manager │  │  Controller  │  │
                    │  └────┬────┘  └──────┬───────┘  │
                    │       │              │           │
                    └───────┼──────────────┼───────────┘
                            │              │
              ┌─────────────┼──────────────┼──────────────┐
              │             │              │               │
    ┌─────────▼─────┐ ┌────▼──────┐ ┌────▼──────┐ ┌──────▼────┐
    │  Dev Cluster  │ │  Staging  │ │   Prod-US │ │  Prod-EU  │
    │               │ │  Cluster  │ │  Cluster  │ │  Cluster  │
    │  Fleet Agent  │ │Fleet Agent│ │Fleet Agent│ │Fleet Agent│
    └───────────────┘ └───────────┘ └───────────┘ └───────────┘
```

Cluster API manages the lifecycle (create, upgrade, scale, delete) of the spoke clusters. Fleet manages workload deployment to those clusters via GitOps.

## Part 1: Cluster API Deep Dive

### Installing Cluster API

Cluster API uses a provider model. You need an Infrastructure Provider (where the VMs run), a Bootstrap Provider (how nodes are initialized), and a Control Plane Provider.

```bash
# Install clusterctl - the CAPI management CLI
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.7.2/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Verify installation
clusterctl version
```

Create the `clusterctl` configuration for your environment:

```yaml
# ~/.cluster-api/clusterctl.yaml
providers:
  - name: "aws"
    url: "https://github.com/kubernetes-sigs/cluster-api-provider-aws/releases/latest/infrastructure-components.yaml"
    type: "InfrastructureProvider"
  - name: "vsphere"
    url: "https://github.com/kubernetes-sigs/cluster-api-provider-vsphere/releases/latest/infrastructure-components.yaml"
    type: "InfrastructureProvider"
  - name: "kubeadm"
    url: "https://github.com/kubernetes-sigs/cluster-api/releases/latest/bootstrap-components.yaml"
    type: "BootstrapProvider"
  - name: "kubeadm"
    url: "https://github.com/kubernetes-sigs/cluster-api/releases/latest/control-plane-components.yaml"
    type: "ControlPlaneProvider"
```

Initialize the management cluster with the required providers:

```bash
# Set required AWS credentials for CAPA
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=<your-access-key>
export AWS_SECRET_ACCESS_KEY=<your-secret-key>
export AWS_SESSION_TOKEN=<your-session-token>  # if using assumed roles

# Encode credentials for CAPA
export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)

# Initialize CAPI with AWS infrastructure provider
clusterctl init \
  --infrastructure aws \
  --bootstrap kubeadm \
  --control-plane kubeadm

# Verify all providers are healthy
kubectl get providers -n capi-system
kubectl get providers -n capa-system
kubectl get providers -n capi-kubeadm-bootstrap-system
kubectl get providers -n capi-kubeadm-control-plane-system
```

### Cluster Templates and ClusterClass

ClusterClass is the CAPI abstraction for reusable cluster topologies. Define your standard cluster topology once and instantiate it for each environment.

```yaml
# cluster-class-aws-standard.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: aws-standard
  namespace: default
spec:
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta2
      kind: KubeadmControlPlaneTemplate
      name: aws-standard-control-plane
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: aws-standard-control-plane-machine
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: aws-standard-cluster
  workers:
    machineDeployments:
      - class: default-worker
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
    - name: kubernetesVersion
      required: true
      schema:
        openAPIV3Schema:
          type: string
          pattern: "^v1\\.[0-9]+\\.[0-9]+$"
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
                names:
                  - default-worker
          jsonPatches:
            - op: replace
              path: /spec/template/spec/instanceType
              valueFrom:
                variable: workerInstanceType
```

Define the underlying templates referenced by the ClusterClass:

```yaml
# aws-standard-cluster-template.yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSClusterTemplate
metadata:
  name: aws-standard-cluster
  namespace: default
spec:
  template:
    spec:
      region: us-east-1  # Will be overridden by ClusterClass patch
      sshKeyName: capi-management
      network:
        vpc:
          availabilityZoneUsageLimit: 3
          availabilityZoneSelection: Ordered
        cni:
          cniIngressRules:
            - description: bgp (calico)
              protocol: tcp
              fromPort: 179
              toPort: 179
            - description: IP-in-IP (calico)
              protocol: "4"
              fromPort: -1
              toPort: -1
      controlPlaneLoadBalancer:
        loadBalancerType: nlb
        scheme: internet-facing
      bastion:
        enabled: false
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta2
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
              node-labels: "node.kubernetes.io/role=control-plane"
        clusterConfiguration:
          apiServer:
            extraArgs:
              cloud-provider: external
              audit-log-path: /var/log/kubernetes/audit.log
              audit-log-maxage: "30"
              audit-log-maxbackup: "10"
              audit-log-maxsize: "100"
              enable-admission-plugins: "NodeRestriction,PodSecurity"
              audit-policy-file: /etc/kubernetes/audit-policy.yaml
            extraVolumes:
              - name: audit-policy
                hostPath: /etc/kubernetes/audit-policy.yaml
                mountPath: /etc/kubernetes/audit-policy.yaml
                readOnly: true
              - name: audit-log
                hostPath: /var/log/kubernetes
                mountPath: /var/log/kubernetes
                readOnly: false
          controllerManager:
            extraArgs:
              cloud-provider: external
              bind-address: "0.0.0.0"
          etcd:
            local:
              extraArgs:
                quota-backend-bytes: "8589934592"  # 8GB
                auto-compaction-mode: periodic
                auto-compaction-retention: "1h"
        files:
          - path: /etc/kubernetes/audit-policy.yaml
            owner: "root:root"
            permissions: "0600"
            content: |
              apiVersion: audit.k8s.io/v1
              kind: Policy
              rules:
                - level: None
                  userGroups: ["system:nodes"]
                  verbs: ["get", "list", "watch"]
                  resources:
                    - group: ""
                      resources: ["nodes", "pods"]
                - level: Metadata
                  resources:
                    - group: ""
                      resources: ["secrets", "configmaps"]
                - level: RequestResponse
                  verbs: ["create", "update", "patch", "delete"]
                - level: None
                  verbs: ["get", "list", "watch"]
        postKubeadmCommands:
          - >-
            kubectl --kubeconfig /etc/kubernetes/admin.conf apply -f
            https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/calico.yaml
        preKubeadmCommands:
          - echo "nameserver 8.8.8.8" >> /etc/resolv.conf
          - apt-get update -y
          - apt-get install -y awscli
      machineTemplate:
        infrastructureRef:
          apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
          kind: AWSMachineTemplate
          name: aws-standard-control-plane-machine
      replicas: 3
      version: v1.29.0
```

### Creating a Workload Cluster from ClusterClass

With the ClusterClass defined, creating new clusters is simple:

```yaml
# production-us-east-cluster.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: production-us-east
  namespace: clusters
  labels:
    environment: production
    region: us-east-1
    tier: critical
    fleet.cattle.io/agent: "true"
spec:
  topology:
    class: aws-standard
    version: v1.29.2
    controlPlane:
      replicas: 3
      metadata:
        annotations:
          node.alpha.kubernetes.io/ttl: "0"
    workers:
      machineDeployments:
        - name: workers
          class: default-worker
          replicas: 6
          metadata:
            labels:
              workload-type: general
    variables:
      - name: region
        value: us-east-1
      - name: controlPlaneInstanceType
        value: m5.2xlarge
      - name: workerInstanceType
        value: m5.4xlarge
      - name: kubernetesVersion
        value: v1.29.2
```

Apply and monitor cluster creation:

```bash
# Create the cluster
kubectl apply -f production-us-east-cluster.yaml

# Watch cluster provisioning status
watch -n 5 kubectl get clusters,machines,machinedeployments -n clusters

# Get the kubeconfig for the new cluster
clusterctl get kubeconfig production-us-east -n clusters > production-us-east.kubeconfig

# Verify cluster is accessible
kubectl --kubeconfig production-us-east.kubeconfig get nodes
```

### Cluster Upgrades with CAPI

CAPI handles rolling upgrades by updating the version field and allowing the control plane provider to orchestrate the replacement of nodes.

```bash
# Trigger a Kubernetes version upgrade
kubectl patch cluster production-us-east -n clusters \
  --type merge \
  -p '{"spec":{"topology":{"version":"v1.30.0"}}}'

# Monitor upgrade progress
kubectl describe kcp production-us-east-control-plane -n clusters

# Watch machines being replaced
kubectl get machines -n clusters -w --field-selector spec.clusterName=production-us-east
```

For a more controlled upgrade process, use a script that validates each step:

```bash
#!/bin/bash
# upgrade-cluster.sh - Safe cluster upgrade with validation

set -euo pipefail

CLUSTER_NAME="${1:-}"
TARGET_VERSION="${2:-}"
NAMESPACE="${3:-clusters}"

if [[ -z "$CLUSTER_NAME" || -z "$TARGET_VERSION" ]]; then
  echo "Usage: $0 <cluster-name> <target-version> [namespace]"
  exit 1
fi

echo "=== Starting upgrade of $CLUSTER_NAME to $TARGET_VERSION ==="

# Pre-upgrade checks
echo "--- Pre-upgrade checks ---"
CURRENT_VERSION=$(kubectl get cluster "$CLUSTER_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.topology.version}')
echo "Current version: $CURRENT_VERSION"
echo "Target version:  $TARGET_VERSION"

# Verify cluster is healthy before upgrade
READY_MACHINES=$(kubectl get machines -n "$NAMESPACE" \
  --field-selector "spec.clusterName=$CLUSTER_NAME" \
  -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | wc -w)
TOTAL_MACHINES=$(kubectl get machines -n "$NAMESPACE" \
  --field-selector "spec.clusterName=$CLUSTER_NAME" \
  -o jsonpath='{.items[*].metadata.name}' | wc -w)

if [[ "$READY_MACHINES" -ne "$TOTAL_MACHINES" ]]; then
  echo "ERROR: Not all machines are ready ($READY_MACHINES/$TOTAL_MACHINES)"
  exit 1
fi

echo "All machines healthy ($READY_MACHINES/$TOTAL_MACHINES)"

# Apply upgrade
echo "--- Applying upgrade ---"
kubectl patch cluster "$CLUSTER_NAME" -n "$NAMESPACE" \
  --type merge \
  -p "{\"spec\":{\"topology\":{\"version\":\"$TARGET_VERSION\"}}}"

# Wait for upgrade to complete
echo "--- Waiting for upgrade completion ---"
timeout 1800 bash -c "
  while true; do
    PHASE=\$(kubectl get cluster $CLUSTER_NAME -n $NAMESPACE -o jsonpath='{.status.phase}')
    READY=\$(kubectl get cluster $CLUSTER_NAME -n $NAMESPACE -o jsonpath='{.status.conditions[?(@.type==\"Ready\")].status}')
    echo \"Phase: \$PHASE, Ready: \$READY\"
    if [[ \"\$PHASE\" == \"Provisioned\" && \"\$READY\" == \"True\" ]]; then
      break
    fi
    sleep 30
  done
"

echo "=== Upgrade of $CLUSTER_NAME to $TARGET_VERSION completed successfully ==="
```

### Machine Health Checks and Auto-Remediation

CAPI supports automatic remediation of unhealthy nodes through MachineHealthChecks:

```yaml
# machine-health-check.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: production-us-east-worker-health
  namespace: clusters
spec:
  clusterName: production-us-east
  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: workers
  unhealthyConditions:
    - type: Ready
      status: Unknown
      timeout: 5m
    - type: Ready
      status: "False"
      timeout: 10m
    - type: MemoryPressure
      status: "True"
      timeout: 2m
    - type: DiskPressure
      status: "True"
      timeout: 2m
    - type: PIDPressure
      status: "True"
      timeout: 2m
  maxUnhealthy: 33%
  nodeStartupTimeout: 20m
  remediationTemplate:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: AWSRemediationTemplate
    name: production-remediation-template
    namespace: clusters
```

## Part 2: Fleet for Multi-Cluster GitOps

### Fleet Architecture

Fleet operates with two components:
- **Fleet Manager** (runs on the management cluster): watches Git repositories and creates BundleDeployments for target clusters
- **Fleet Agent** (runs on each workload cluster): applies BundleDeployments from the manager

### Installing Fleet

```bash
# Add the Fleet Helm repository
helm repo add fleet https://rancher.github.io/fleet-helm-charts/
helm repo update

# Install Fleet on the management cluster
helm install fleet-crd fleet/fleet-crd \
  -n cattle-fleet-system \
  --create-namespace \
  --wait

helm install fleet fleet/fleet \
  -n cattle-fleet-system \
  --set apiServerURL="https://$(kubectl get svc kubernetes -o jsonpath='{.spec.clusterIP}'):443" \
  --wait

# Verify Fleet is running
kubectl get pods -n cattle-fleet-system
kubectl get fleet -A
```

### Registering Workload Clusters

Each workload cluster needs a Fleet agent. Fleet provides a ClusterRegistrationToken mechanism:

```yaml
# cluster-registration-token.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: ClusterRegistrationToken
metadata:
  name: production-registration-token
  namespace: fleet-default
spec:
  ttl: 24h
```

```bash
# Get the registration token values
kubectl get clusterregistrationtoken production-registration-token \
  -n fleet-default \
  -o jsonpath='{.status.secretName}'

# Extract the token
TOKEN=$(kubectl get secret \
  $(kubectl get clusterregistrationtoken production-registration-token \
    -n fleet-default \
    -o jsonpath='{.status.secretName}') \
  -n fleet-default \
  -o jsonpath='{.data.values}' | base64 -d)

# Install Fleet agent on workload cluster
kubectl --kubeconfig production-us-east.kubeconfig apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: cattle-fleet-system
EOF

helm --kubeconfig production-us-east.kubeconfig install fleet-agent fleet/fleet-agent \
  -n cattle-fleet-system \
  --set apiServerURL="https://management-cluster-api.internal:6443" \
  --set clusterName="production-us-east" \
  --set token="$TOKEN" \
  --set labels.environment=production \
  --set labels.region=us-east-1 \
  --set labels.tier=critical
```

### Defining GitRepos and Bundles

A GitRepo tells Fleet where to find application manifests:

```yaml
# gitrepo-platform-apps.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: platform-applications
  namespace: fleet-default
spec:
  repo: https://github.com/myorg/platform-applications
  branch: main
  paths:
    - apps/
    - platform/
  targets:
    - name: production
      clusterSelector:
        matchLabels:
          environment: production
      clusterGroup: production-clusters
    - name: staging
      clusterSelector:
        matchLabels:
          environment: staging
    - name: development
      clusterSelector:
        matchLabels:
          environment: development
  clientSecretName: github-credentials
  correctDrift:
    enabled: true
    force: false
    keepFailHistory: true
  imageScanInterval: 1m
  imageScanCommit:
    authorName: "Fleet Bot"
    authorEmail: "fleet@myorg.com"
```

### Fleet Bundle Customization with Overlays

Fleet's bundle system allows environment-specific customizations using Kustomize or Helm:

```
platform-applications/
├── apps/
│   ├── cert-manager/
│   │   ├── fleet.yaml
│   │   ├── kustomization.yaml
│   │   ├── base/
│   │   │   ├── helmrelease.yaml
│   │   │   └── values.yaml
│   │   └── overlays/
│   │       ├── production/
│   │       │   ├── kustomization.yaml
│   │       │   └── values-patch.yaml
│   │       ├── staging/
│   │       │   └── kustomization.yaml
│   │       └── development/
│   │           └── kustomization.yaml
```

The `fleet.yaml` controls how Fleet handles the bundle:

```yaml
# apps/cert-manager/fleet.yaml
namespace: cert-manager
helm:
  releaseName: cert-manager
  chart: cert-manager
  repo: https://charts.jetstack.io
  version: v1.14.3
  values:
    installCRDs: true
    global:
      logLevel: 2
    prometheus:
      enabled: true
      servicemonitor:
        enabled: true
  valuesFiles:
    - base/values.yaml
targetCustomizations:
  - name: production
    clusterSelector:
      matchLabels:
        environment: production
    helm:
      valuesFiles:
        - base/values.yaml
        - overlays/production/values-patch.yaml
  - name: staging
    clusterSelector:
      matchLabels:
        environment: staging
    helm:
      valuesFiles:
        - base/values.yaml
        - overlays/staging/values-patch.yaml
  - name: development
    clusterSelector:
      matchLabels:
        environment: development
    helm:
      values:
        replicaCount: 1
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
```

### ClusterGroups for Logical Targeting

ClusterGroups aggregate clusters into logical units for targeting:

```yaml
# cluster-groups.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: ClusterGroup
metadata:
  name: production-clusters
  namespace: fleet-default
spec:
  selector:
    matchLabels:
      environment: production
---
apiVersion: fleet.cattle.io/v1alpha1
kind: ClusterGroup
metadata:
  name: us-clusters
  namespace: fleet-default
spec:
  selector:
    matchExpressions:
      - key: region
        operator: In
        values:
          - us-east-1
          - us-west-2
---
apiVersion: fleet.cattle.io/v1alpha1
kind: ClusterGroup
metadata:
  name: eu-gdpr-clusters
  namespace: fleet-default
spec:
  selector:
    matchLabels:
      gdpr-compliant: "true"
```

### Monitoring Fleet Deployment Status

```bash
# Check overall Fleet status
kubectl get gitrepo -A
kubectl get bundle -A
kubectl get bundledeployment -A

# Get detailed status of a GitRepo
kubectl describe gitrepo platform-applications -n fleet-default

# Check deployment status across all clusters
kubectl get fleet -A -o wide

# Custom status check script
cat > check-fleet-status.sh << 'EOF'
#!/bin/bash
echo "=== Fleet GitRepo Status ==="
kubectl get gitrepo -A -o custom-columns=\
"NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[?(@.type=='Ready')].status,\
CLUSTERS:.status.summary.readyClusters,MODIFIED:.status.summary.modified,\
ERRORING:.status.summary.erroring"

echo ""
echo "=== Bundle Deployment Summary ==="
kubectl get bundledeployment -A -o custom-columns=\
"NAMESPACE:.metadata.namespace,NAME:.metadata.name,CLUSTER:.status.display.state,\
APPLIED:.status.appliedDeploymentID"

echo ""
echo "=== Erroring Bundles ==="
kubectl get bundle -A -o json | jq -r \
  '.items[] | select(.status.summary.erroring > 0) |
   "\(.metadata.namespace)/\(.metadata.name): \(.status.summary.erroring) erroring"'
EOF
chmod +x check-fleet-status.sh
```

## Part 3: Advanced Cluster Lifecycle Operations

### Cluster Autoscaling with MachineDeployments

```yaml
# machine-deployment-autoscaler.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: production-workers
  namespace: clusters
  annotations:
    cluster.x-k8s.io/cluster-name: production-us-east
    # Cluster Autoscaler annotations
    cluster.x-k8s.io/autoscaler-max-size: "20"
    cluster.x-k8s.io/autoscaler-min-size: "3"
spec:
  clusterName: production-us-east
  replicas: 6
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: production-us-east
      cluster.x-k8s.io/deployment-name: production-workers
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: production-us-east
        cluster.x-k8s.io/deployment-name: production-workers
    spec:
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: production-worker-bootstrap
      clusterName: production-us-east
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-worker-machine
      version: v1.29.2
```

Deploy the Cluster Autoscaler configured for CAPI:

```yaml
# cluster-autoscaler-capi.yaml
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
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0
          command:
            - ./cluster-autoscaler
            - --cloud-provider=clusterapi
            - --namespace=clusters
            - --clusterapi-cloud-config-authoritative
            - --scan-interval=10s
            - --scale-down-delay-after-add=5m
            - --scale-down-unneeded-time=5m
            - --scale-down-utilization-threshold=0.5
            - --max-node-provision-time=15m
            - --v=4
          volumeMounts:
            - name: kubeconfig
              mountPath: /etc/kubernetes
      volumes:
        - name: kubeconfig
          secret:
            secretName: workload-cluster-kubeconfig
```

### Cluster Backup and Disaster Recovery

```bash
#!/bin/bash
# backup-cluster-resources.sh - Backup all CAPI cluster objects

BACKUP_DIR="/backups/cluster-api/$(date +%Y-%m-%d)"
mkdir -p "$BACKUP_DIR"

echo "Backing up Cluster API resources to $BACKUP_DIR"

# Backup all CAPI objects
CAPI_RESOURCES=(
  "clusters.cluster.x-k8s.io"
  "machinedeployments.cluster.x-k8s.io"
  "machinesets.cluster.x-k8s.io"
  "machines.cluster.x-k8s.io"
  "machinehealthchecks.cluster.x-k8s.io"
  "awsclusters.infrastructure.cluster.x-k8s.io"
  "awsmachines.infrastructure.cluster.x-k8s.io"
  "awsmachinetemplates.infrastructure.cluster.x-k8s.io"
  "kubeadmcontrolplanes.controlplane.cluster.x-k8s.io"
  "kubeadmconfigs.bootstrap.cluster.x-k8s.io"
  "kubeadmconfigtemplates.bootstrap.cluster.x-k8s.io"
)

for resource in "${CAPI_RESOURCES[@]}"; do
  echo "Backing up $resource..."
  kubectl get "$resource" -A -o yaml > "$BACKUP_DIR/${resource//\//_}.yaml" 2>/dev/null || true
done

# Backup all kubeconfigs
echo "Backing up cluster kubeconfigs..."
kubectl get secrets -A -l clusterctl.cluster.x-k8s.io/move="" \
  -o yaml > "$BACKUP_DIR/cluster-secrets.yaml"

echo "Backup completed: $BACKUP_DIR"
du -sh "$BACKUP_DIR"
```

### Multi-Cluster Observability

Configure centralized monitoring by deploying Prometheus on each cluster and federating to a central instance:

```yaml
# fleet-bundle: monitoring/fleet.yaml
namespace: monitoring
helm:
  releaseName: kube-prometheus-stack
  chart: kube-prometheus-stack
  repo: https://prometheus-community.github.io/helm-charts
  version: "55.5.0"
  values:
    prometheus:
      prometheusSpec:
        externalLabels:
          cluster: "FLEET_CLUSTER_NAME"  # Replaced by Fleet at deploy time
        remoteWrite:
          - url: https://central-prometheus.internal/api/v1/write
            tlsConfig:
              insecureSkipVerify: false
            basicAuth:
              username:
                name: remote-write-credentials
                key: username
              password:
                name: remote-write-credentials
                key: password
targetCustomizations:
  - name: production
    clusterSelector:
      matchLabels:
        environment: production
    helm:
      values:
        prometheus:
          prometheusSpec:
            replicas: 2
            retention: 30d
            storageSpec:
              volumeClaimTemplate:
                spec:
                  storageClassName: gp3
                  resources:
                    requests:
                      storage: 500Gi
```

## Part 4: Security and Policy Management

### Policy Distribution with Fleet

Distribute OPA Gatekeeper policies across all clusters:

```yaml
# gitrepo-policies.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: security-policies
  namespace: fleet-default
spec:
  repo: https://github.com/myorg/kubernetes-policies
  branch: main
  paths:
    - policies/
  targets:
    - name: all-clusters
      clusterSelector:
        matchExpressions:
          - key: managed-by
            operator: In
            values: ["cluster-api"]
  correctDrift:
    enabled: true
    force: true  # Policies must not drift
```

### Network Policy Templates

```yaml
# policies/network/default-deny.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: default
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: default
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
```

## Operational Best Practices

### Cluster Naming Conventions

Consistent naming enables targeted deployments and clear operational understanding:

```
{organization}-{environment}-{region}-{purpose}-{index}
Examples:
  acme-prod-use1-app-01
  acme-prod-euw1-app-01
  acme-stage-use1-app-01
  acme-dev-use1-app-01
  acme-prod-use1-gpu-01
```

### Gitops Repository Structure

```
fleet-repo/
├── clusters/
│   ├── production/
│   │   ├── us-east-1/
│   │   │   ├── cluster.yaml
│   │   │   └── machine-deployment.yaml
│   │   └── eu-west-1/
│   │       ├── cluster.yaml
│   │       └── machine-deployment.yaml
│   └── staging/
│       └── us-east-1/
│           ├── cluster.yaml
│           └── machine-deployment.yaml
├── apps/
│   ├── cert-manager/
│   ├── ingress-nginx/
│   ├── monitoring/
│   └── security-policies/
└── gitrepos/
    ├── platform-apps.yaml
    └── security-policies.yaml
```

### Troubleshooting Common Issues

**Cluster stuck in Provisioning state:**

```bash
# Check provider-specific conditions
kubectl describe cluster production-us-east -n clusters
kubectl describe awscluster production-us-east -n clusters

# Check for IAM permission issues
kubectl logs -n capa-system \
  $(kubectl get pods -n capa-system -l control-plane=capa-controller-manager \
    -o jsonpath='{.items[0].metadata.name}') \
  --tail=100 | grep -i error

# Check bootstrap token expiry
kubectl get secrets -n clusters | grep bootstrap
```

**Fleet bundle not syncing:**

```bash
# Check Fleet agent on workload cluster
kubectl --kubeconfig workload.kubeconfig get pods -n cattle-fleet-system

# Force re-sync
kubectl annotate gitrepo platform-applications \
  -n fleet-default \
  fleet.cattle.io/force-sync="$(date)"

# Check bundle deployment errors
kubectl get bundledeployment -n fleet-local \
  --kubeconfig workload.kubeconfig \
  -o json | jq '.items[].status.message'
```

## Key Takeaways

Managing multi-cluster Kubernetes at enterprise scale requires treating the cluster itself as a managed resource, not a manually provisioned artifact. Cluster API provides the declarative foundation for cluster lifecycle management across heterogeneous infrastructure, while Fleet extends GitOps principles from individual clusters to fleets of clusters.

The key operational wins from this architecture are:

- **Consistency**: All clusters derive from the same ClusterClass, eliminating configuration drift between environments
- **Auditability**: Every cluster change is a Git commit with a clear author and rationale
- **Velocity**: New clusters are provisioned in minutes by creating a Cluster manifest, not hours of manual setup
- **Reliability**: MachineHealthChecks provide automatic remediation for node failures without human intervention
- **Scale**: Fleet can manage hundreds of clusters with the same operational overhead as managing a handful

The investment in building this platform pays dividends every time you need to respond to a security vulnerability (patch a ClusterClass, watch all clusters auto-upgrade), onboard a new team (create a Cluster manifest, push to Git), or recover from a disaster (apply your cluster manifests from Git backup to a fresh management cluster).
