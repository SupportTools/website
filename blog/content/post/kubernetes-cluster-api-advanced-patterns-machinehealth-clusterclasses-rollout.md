---
title: "Kubernetes Cluster API Advanced Patterns: MachineHealthChecks, ClusterClasses, and Machine Rollout Strategies"
date: 2032-04-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "MachineHealthCheck", "ClusterClass", "Infrastructure Automation"]
categories:
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Cluster API advanced patterns including MachineHealthChecks for automatic remediation, ClusterClasses for templated cluster topologies, and controlled Machine rollout strategies for production fleet management."
more_link: "yes"
url: "/kubernetes-cluster-api-advanced-patterns-machinehealth-clusterclasses-rollout/"
---

Cluster API (CAPI) has matured into the de-facto standard for declarative Kubernetes cluster lifecycle management. Beyond basic cluster provisioning, production teams need deep knowledge of automatic machine remediation, topology templating, and controlled rollout mechanics. This post covers those advanced patterns with production-grade configurations.

<!--more-->

## Overview of Cluster API Architecture

Cluster API introduces a set of Custom Resource Definitions and controllers that manage Kubernetes cluster lifecycle through a management cluster. The core object hierarchy is:

```
Cluster
├── ControlPlane (KubeadmControlPlane)
│   └── Machine(s) → InfrastructureMachine (e.g., AWSMachine)
└── MachineDeployment(s)
    └── MachineSet(s)
        └── Machine(s) → InfrastructureMachine
```

Each Machine object corresponds to a physical or virtual node. The infrastructure provider (AWS, Azure, GCP, vSphere, etc.) reconciles the InfrastructureMachine into an actual compute instance.

### Core CRDs

| Resource | Purpose |
|---|---|
| `Cluster` | Top-level cluster object, references control plane and infrastructure |
| `KubeadmControlPlane` | Manages control plane machines with kubeadm bootstrap |
| `MachineDeployment` | Manages worker machine rollouts, analogous to Deployment |
| `MachineSet` | Maintains a stable set of machines, analogous to ReplicaSet |
| `Machine` | Represents a single node in the cluster |
| `MachineHealthCheck` | Defines remediation policy for unhealthy machines |
| `ClusterClass` | Template for creating clusters with shared topology |

---

## MachineHealthChecks

MachineHealthChecks (MHC) provide automated node remediation. When a Machine enters an unhealthy state, the MHC controller deletes and replaces it without manual intervention.

### Basic MachineHealthCheck

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: worker-healthcheck
  namespace: clusters
spec:
  # Selector matches MachineDeployment machines
  clusterName: production-cluster
  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: workers
  # Unhealthy conditions that trigger remediation
  unhealthyConditions:
    - type: Ready
      status: Unknown
      timeout: 300s
    - type: Ready
      status: "False"
      timeout: 300s
  # Maximum machines that can be remediated simultaneously
  maxUnhealthy: 33%
  # Node startup timeout - machine without a node reference
  nodeStartupTimeout: 10m
```

### Advanced MachineHealthCheck with Custom Conditions

Infrastructure providers can surface custom node conditions. The following example handles a GPU-specific health condition from an NVIDIA device plugin:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: gpu-worker-healthcheck
  namespace: clusters
spec:
  clusterName: ml-cluster
  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: gpu-workers
      node-pool: gpu
  unhealthyConditions:
    - type: Ready
      status: Unknown
      timeout: 300s
    - type: Ready
      status: "False"
      timeout: 600s
    # Custom condition from NVIDIA GPU health reporter
    - type: GPUHealthy
      status: "False"
      timeout: 120s
    # DiskPressure triggers remediation after extended period
    - type: DiskPressure
      status: "True"
      timeout: 1800s
    # MemoryPressure on GPU nodes likely indicates driver OOM
    - type: MemoryPressure
      status: "True"
      timeout: 900s
  # Only remediate one GPU node at a time to preserve capacity
  maxUnhealthy: 1
  nodeStartupTimeout: 15m
  # Remediation strategy
  remediationTemplate:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: AWSMachineTemplate
    name: gpu-worker-remediation-template
    namespace: clusters
```

### MachineHealthCheck with External Remediation

For more sophisticated remediation workflows (e.g., draining workloads before deletion, sending alerts), use the external remediation protocol:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: workers-external-remediation
  namespace: clusters
spec:
  clusterName: production-cluster
  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: workers
  unhealthyConditions:
    - type: Ready
      status: Unknown
      timeout: 300s
    - type: Ready
      status: "False"
      timeout: 300s
  maxUnhealthy: 40%
  remediationTemplate:
    apiVersion: remediation.cluster.x-k8s.io/v1alpha1
    kind: MetalMachineRemediationTemplate
    name: worker-remediation-template
    namespace: clusters
```

The external remediation controller creates a `MetalMachineRemediation` object when a Machine is unhealthy and manages the full remediation lifecycle including drain, decommission, and replace.

### Monitoring MachineHealthCheck Status

```bash
# Check MHC status
kubectl get machinehealthcheck -n clusters

# Detailed status including remediation counts
kubectl describe machinehealthcheck worker-healthcheck -n clusters

# Watch remediation events
kubectl get events -n clusters --field-selector reason=RemediationRestricted
kubectl get events -n clusters --field-selector reason=SuccessfulRemediation

# Check machines currently under remediation
kubectl get machines -n clusters -l cluster.x-k8s.io/remediation-request=true
```

### MHC Interaction with MachineDeployments

MachineHealthCheck integrates with MachineDeployment rollouts. When `maxUnhealthy` is exceeded:

1. No further remediations are attempted
2. An event is emitted: `RemediationRestricted`
3. The cluster operator must investigate and manually intervene

```bash
# Force remove remediation restriction after manual fix
kubectl annotate machine <machine-name> -n clusters \
  cluster.x-k8s.io/remediation-request- \
  --overwrite

# Pause MHC during maintenance windows
kubectl annotate machinehealthcheck worker-healthcheck -n clusters \
  cluster.x-k8s.io/paused=true

# Resume after maintenance
kubectl annotate machinehealthcheck worker-healthcheck -n clusters \
  cluster.x-k8s.io/paused-
```

---

## ClusterClasses

ClusterClass provides a topology template for creating clusters. Instead of defining the full cluster object graph for every cluster, operators define a ClusterClass once and reuse it across all clusters in the fleet.

### ClusterClass Architecture

```
ClusterClass
├── Infrastructure Template (VPC, network config)
├── ControlPlane Template (instance type, image)
│   └── MachineInfrastructure Template
└── Workers
    └── MachineDeployment Classes
        ├── Bootstrap Template (cloud-init config)
        └── Infrastructure Template (instance type, image)
```

### Defining a ClusterClass

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: quick-start-rke2
  namespace: clusters
spec:
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSClusterTemplate
      name: quick-start-cluster
      namespace: clusters
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: RKE2ControlPlaneTemplate
      name: quick-start-control-plane
      namespace: clusters
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: quick-start-control-plane-machine
        namespace: clusters
  workers:
    machineDeployments:
      - class: default-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: RKE2ConfigTemplate
              name: quick-start-worker-bootstrap
              namespace: clusters
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: quick-start-worker-machine
              namespace: clusters
      - class: gpu-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: RKE2ConfigTemplate
              name: quick-start-gpu-worker-bootstrap
              namespace: clusters
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: quick-start-gpu-worker-machine
              namespace: clusters
  # Variable definitions for customization
  variables:
    - name: region
      required: true
      schema:
        openAPIV3Schema:
          type: string
          enum:
            - us-east-1
            - us-west-2
            - eu-west-1
    - name: controlPlaneInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: m6i.xlarge
    - name: workerInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: m6i.2xlarge
    - name: kubernetesVersion
      required: true
      schema:
        openAPIV3Schema:
          type: string
          example: "v1.31.0"
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

### Infrastructure Templates for ClusterClass

The referenced AWSClusterTemplate:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSClusterTemplate
metadata:
  name: quick-start-cluster
  namespace: clusters
spec:
  template:
    spec:
      region: us-east-1  # Overridden by patch
      sshKeyName: cluster-admin
      network:
        vpc:
          availabilityZoneUsageLimit: 3
          availabilityZoneSelection: Ordered
        subnets:
          - availabilityZone: us-east-1a
            cidrBlock: "10.0.0.0/20"
            isPublic: false
          - availabilityZone: us-east-1b
            cidrBlock: "10.0.16.0/20"
            isPublic: false
          - availabilityZone: us-east-1c
            cidrBlock: "10.0.32.0/20"
            isPublic: false
          - availabilityZone: us-east-1a
            cidrBlock: "10.0.48.0/20"
            isPublic: true
          - availabilityZone: us-east-1b
            cidrBlock: "10.0.64.0/20"
            isPublic: true
          - availabilityZone: us-east-1c
            cidrBlock: "10.0.80.0/20"
            isPublic: true
      controlPlaneLoadBalancer:
        scheme: internet-facing
      bastion:
        enabled: false
      identityRef:
        kind: AWSClusterControllerIdentity
        name: default
```

### Instantiating a Cluster from ClusterClass

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: tenant-cluster-01
  namespace: clusters
spec:
  topology:
    class: quick-start-rke2
    version: v1.31.0
    controlPlane:
      replicas: 3
      metadata:
        labels:
          environment: production
          cost-center: "12345"
    workers:
      machineDeployments:
        - name: workers
          class: default-worker
          replicas: 5
          metadata:
            labels:
              environment: production
              workload-type: general
        - name: gpu-workers
          class: gpu-worker
          replicas: 2
          metadata:
            labels:
              environment: production
              workload-type: ml
    variables:
      - name: region
        value: us-east-1
      - name: controlPlaneInstanceType
        value: m6i.2xlarge
      - name: workerInstanceType
        value: m6i.4xlarge
      - name: kubernetesVersion
        value: "v1.31.0"
```

### ClusterClass Versioning and Upgrades

When the ClusterClass is updated, all clusters referencing it can be upgraded by bumping `spec.topology.version`:

```bash
# List clusters using a ClusterClass
kubectl get clusters -n clusters -o json | \
  jq '.items[] | select(.spec.topology.class == "quick-start-rke2") | .metadata.name'

# Upgrade a cluster by changing the version
kubectl patch cluster tenant-cluster-01 -n clusters \
  --type=merge \
  -p '{"spec":{"topology":{"version":"v1.32.0"}}}'

# Watch the upgrade progress
kubectl get kubeadmcontrolplanes -n clusters -w
kubectl get machinedeployments -n clusters -w
```

### ClusterClass Patch for Multi-AZ Control Planes

```yaml
# Patch to distribute control plane machines across AZs
- name: controlPlaneAZDistribution
  definitions:
    - selector:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        matchResources:
          controlPlane: true
      jsonPatches:
        - op: add
          path: /spec/template/spec/failureDomain
          valueFrom:
            template: |
              {{ index (list "us-east-1a" "us-east-1b" "us-east-1c") .machineIndex }}
```

---

## Machine Rollout Strategies

MachineDeployments support rolling updates similar to Kubernetes Deployments but with infrastructure-aware semantics.

### MachineDeployment Update Strategies

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: production-workers
  namespace: clusters
spec:
  clusterName: production-cluster
  replicas: 10
  selector:
    matchLabels:
      cluster.x-k8s.io/deployment-name: production-workers
  template:
    metadata:
      labels:
        cluster.x-k8s.io/deployment-name: production-workers
    spec:
      clusterName: production-cluster
      version: v1.31.0
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: production-workers-bootstrap
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-workers-v2
  # Rolling update strategy
  strategy:
    type: RollingUpdate
    rollingUpdate:
      # Maximum nodes unavailable during rollout
      maxUnavailable: 0
      # Maximum surge above desired replica count
      maxSurge: 2
  # Minimum seconds before considering a Machine available
  minReadySeconds: 60
```

### Controlled Node Drain During Machine Deletion

When a Machine is deleted (during rollout or manual deletion), the CAPI controller drains the node before terminating the instance. Configure drain behavior:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: stateful-workers
  namespace: clusters
spec:
  clusterName: production-cluster
  replicas: 5
  template:
    spec:
      clusterName: production-cluster
      version: v1.31.0
      nodeDrainTimeout: 300s  # Wait up to 5 minutes for drain
      nodeVolumeDetachTimeout: 120s  # Wait for EBS detach
      nodeDeletionTimeout: 30s  # Wait for node deletion confirmation
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: stateful-workers-bootstrap
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: stateful-workers-machine
```

### Phased Rollout with Multiple MachineDeployments

For large clusters, split workers into multiple MachineDeployments for phased rollouts:

```yaml
# Phase 1: Canary workers (10% of fleet)
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: workers-canary
  namespace: clusters
  annotations:
    cluster.x-k8s.io/rollout-phase: "1"
spec:
  clusterName: production-cluster
  replicas: 2
  template:
    spec:
      clusterName: production-cluster
      version: v1.32.0
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: workers-v132-bootstrap
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: workers-v132-machine
---
# Phase 2: Main workers (90% of fleet) - updated after canary validates
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: workers-main
  namespace: clusters
  annotations:
    cluster.x-k8s.io/rollout-phase: "2"
spec:
  clusterName: production-cluster
  replicas: 18
  template:
    spec:
      clusterName: production-cluster
      version: v1.31.0  # Still on previous version
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: workers-v131-bootstrap
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: workers-v131-machine
```

### Automation Script: Fleet Rolling Upgrade

```bash
#!/usr/bin/env bash
# Rolling upgrade script for CAPI MachineDeployments
# Usage: ./capi-rolling-upgrade.sh <namespace> <cluster-name> <new-version>

set -euo pipefail

NAMESPACE="${1}"
CLUSTER_NAME="${2}"
NEW_VERSION="${3}"
HEALTH_CHECK_WAIT=120
BATCH_SIZE=3

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

check_cluster_health() {
  local unhealthy
  unhealthy=$(kubectl get machines -n "${NAMESPACE}" \
    -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
    -o json | \
    jq '[.items[] | select(.status.phase != "Running" and .status.phase != "Provisioned")] | length')

  if [[ "${unhealthy}" -gt 0 ]]; then
    log "ERROR: ${unhealthy} machines are not healthy"
    return 1
  fi
  return 0
}

get_machine_deployments() {
  kubectl get machinedeployments -n "${NAMESPACE}" \
    -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
    -o jsonpath='{.items[*].metadata.name}'
}

upgrade_machine_deployment() {
  local md_name="${1}"
  local target_version="${2}"

  log "Upgrading MachineDeployment ${md_name} to ${target_version}"

  kubectl patch machinedeployment "${md_name}" -n "${NAMESPACE}" \
    --type=merge \
    -p "{\"spec\":{\"template\":{\"spec\":{\"version\":\"${target_version}\"}}}}"

  log "Waiting for MachineDeployment ${md_name} rollout..."
  kubectl rollout status machinedeployment "${md_name}" -n "${NAMESPACE}" \
    --timeout=30m

  log "Waiting ${HEALTH_CHECK_WAIT}s for machine health stabilization..."
  sleep "${HEALTH_CHECK_WAIT}"

  check_cluster_health || {
    log "ERROR: Cluster unhealthy after upgrading ${md_name}. Halting."
    exit 1
  }

  log "MachineDeployment ${md_name} upgrade complete and healthy."
}

main() {
  log "Starting fleet upgrade for cluster ${CLUSTER_NAME} to ${NEW_VERSION}"

  check_cluster_health || {
    log "ERROR: Cluster is not healthy before upgrade. Aborting."
    exit 1
  }

  # Upgrade control plane first
  log "Upgrading KubeadmControlPlane..."
  kubectl patch kubeadmcontrolplane \
    "$(kubectl get kcp -n "${NAMESPACE}" -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
      -o jsonpath='{.items[0].metadata.name}')" \
    -n "${NAMESPACE}" \
    --type=merge \
    -p "{\"spec\":{\"version\":\"${NEW_VERSION}\"}}"

  # Wait for control plane to finish
  while true; do
    updated=$(kubectl get kcp -n "${NAMESPACE}" \
      -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
      -o jsonpath='{.items[0].status.updatedReplicas}')
    desired=$(kubectl get kcp -n "${NAMESPACE}" \
      -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
      -o jsonpath='{.items[0].spec.replicas}')

    if [[ "${updated}" == "${desired}" ]]; then
      log "Control plane upgrade complete."
      break
    fi

    log "Control plane: ${updated}/${desired} updated. Waiting..."
    sleep 30
  done

  check_cluster_health || {
    log "ERROR: Cluster unhealthy after control plane upgrade."
    exit 1
  }

  # Upgrade worker MachineDeployments
  read -ra MDS <<< "$(get_machine_deployments)"

  for md in "${MDS[@]}"; do
    upgrade_machine_deployment "${md}" "${NEW_VERSION}"
  done

  log "Fleet upgrade to ${NEW_VERSION} complete for cluster ${CLUSTER_NAME}."
}

main
```

### Machine Remediation Metrics with Prometheus

```yaml
# PrometheusRule for CAPI fleet health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: capi-fleet-alerts
  namespace: monitoring
spec:
  groups:
    - name: capi.machines
      interval: 30s
      rules:
        - alert: MachineNotRunning
          expr: |
            count by (cluster_name, namespace) (
              capi_machine_status_phase{phase!="Running"} == 1
            ) > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Machines not in Running phase"
            description: "{{ $value }} machines in cluster {{ $labels.cluster_name }} are not Running"

        - alert: MachineHealthCheckRemediationRestricted
          expr: |
            capi_machinehealthcheck_remediation_restricted_total > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "MachineHealthCheck remediation restricted"
            description: "MHC {{ $labels.name }} in {{ $labels.namespace }} has hit maxUnhealthy limit"

        - alert: ControlPlaneMachinesUnavailable
          expr: |
            (kcp_controlplane_replicas_count - kcp_controlplane_ready_replicas_count) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Control plane machines unavailable"
```

---

## Advanced ClusterClass Patterns

### Built-in Variables and Builtins

ClusterClass supports built-in variables for common topology properties:

```yaml
# Using builtin variables in patches
patches:
  - name: controlPlaneHostnamePrefix
    definitions:
      - selector:
          apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
          kind: AWSMachineTemplate
          matchResources:
            controlPlane: true
        jsonPatches:
          - op: add
            path: /spec/template/spec/additionalTags/Name
            valueFrom:
              template: |
                {{ .builtin.cluster.name }}-control-plane-{{ .builtin.controlPlane.machineIndex }}

  - name: workerHostnamePrefix
    definitions:
      - selector:
          apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
          kind: AWSMachineTemplate
          matchResources:
            machineDeploymentClass:
              names:
                - default-worker
        jsonPatches:
          - op: add
            path: /spec/template/spec/additionalTags/Name
            valueFrom:
              template: |
                {{ .builtin.cluster.name }}-worker-{{ .builtin.machineDeployment.topologyName }}
```

### ClusterClass with External Patches

For complex logic, use an external patch extension:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: enterprise-cluster
  namespace: clusters
spec:
  patches:
    - name: generate-node-config
      external:
        generateExtension: NodeConfigGenerator
        validateExtension: NodeConfigValidator
        settings:
          configServer: "https://config.internal.company.com"
          tlsSecretName: config-server-tls
```

### Validation Webhooks for ClusterClass

Implement a validation webhook to enforce organizational policies on cluster creation:

```go
package webhook

import (
    "context"
    "fmt"
    "net/http"
    "regexp"

    clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// ClusterTopologyValidator enforces corporate standards on CAPI Clusters
type ClusterTopologyValidator struct {
    Client  client.Client
    Decoder *admission.Decoder
}

var (
    validClusterNamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{3,62}[a-z0-9]$`)
    requiredLabels          = []string{"environment", "cost-center", "team"}
)

func (v *ClusterTopologyValidator) Handle(ctx context.Context, req admission.Request) admission.Response {
    cluster := &clusterv1.Cluster{}
    if err := v.Decoder.Decode(req, cluster); err != nil {
        return admission.Errored(http.StatusBadRequest, err)
    }

    // Only validate topology-based clusters
    if cluster.Spec.Topology == nil {
        return admission.Allowed("non-topology cluster, skipping validation")
    }

    if err := v.validateClusterName(cluster); err != nil {
        return admission.Denied(err.Error())
    }

    if err := v.validateRequiredLabels(cluster); err != nil {
        return admission.Denied(err.Error())
    }

    if err := v.validateReplicaCounts(cluster); err != nil {
        return admission.Denied(err.Error())
    }

    return admission.Allowed("cluster topology is valid")
}

func (v *ClusterTopologyValidator) validateClusterName(c *clusterv1.Cluster) error {
    if !validClusterNamePattern.MatchString(c.Name) {
        return fmt.Errorf("cluster name %q does not match required pattern %s",
            c.Name, validClusterNamePattern.String())
    }
    return nil
}

func (v *ClusterTopologyValidator) validateRequiredLabels(c *clusterv1.Cluster) error {
    for _, label := range requiredLabels {
        if _, ok := c.Labels[label]; !ok {
            return fmt.Errorf("cluster is missing required label: %s", label)
        }
    }
    return nil
}

func (v *ClusterTopologyValidator) validateReplicaCounts(c *clusterv1.Cluster) error {
    cp := c.Spec.Topology.ControlPlane
    if cp.Replicas != nil {
        replicas := int(*cp.Replicas)
        if replicas%2 == 0 {
            return fmt.Errorf("control plane replicas must be odd for etcd quorum, got %d", replicas)
        }
        if replicas < 1 || replicas > 7 {
            return fmt.Errorf("control plane replicas must be between 1 and 7, got %d", replicas)
        }
    }

    for _, md := range c.Spec.Topology.Workers.MachineDeployments {
        if md.Replicas != nil && *md.Replicas == 0 {
            return fmt.Errorf("MachineDeployment %q replicas cannot be 0", md.Name)
        }
    }

    return nil
}
```

---

## Production Operational Patterns

### Pausing Cluster Reconciliation

During infrastructure maintenance or debugging, pause reconciliation:

```bash
# Pause entire cluster reconciliation
kubectl patch cluster production-cluster -n clusters \
  --type=merge \
  -p '{"spec":{"paused":true}}'

# Pause specific MachineDeployment
kubectl patch machinedeployment workers -n clusters \
  --type=merge \
  -p '{"spec":{"paused":true}}'

# Check what is paused
kubectl get clusters,machinedeployments,machinesets,machines \
  -n clusters -o json | \
  jq '.items[] | select(.spec.paused == true) | "\(.kind)/\(.metadata.name)"'
```

### Backing Up Cluster API Objects

```bash
#!/usr/bin/env bash
# Backup all CAPI objects for disaster recovery
set -euo pipefail

BACKUP_DIR="/backup/capi/$(date +%Y%m%d-%H%M%S)"
NAMESPACE="${1:-clusters}"

mkdir -p "${BACKUP_DIR}"

CAPI_RESOURCES=(
  "clusters.cluster.x-k8s.io"
  "kubeadmcontrolplanes.controlplane.cluster.x-k8s.io"
  "machinedeployments.cluster.x-k8s.io"
  "machinesets.cluster.x-k8s.io"
  "machines.cluster.x-k8s.io"
  "machinehealthchecks.cluster.x-k8s.io"
  "clusterclasses.cluster.x-k8s.io"
  "kubeadmconfigs.bootstrap.cluster.x-k8s.io"
  "kubeadmconfigtemplates.bootstrap.cluster.x-k8s.io"
)

for resource in "${CAPI_RESOURCES[@]}"; do
  echo "Backing up ${resource}..."
  kubectl get "${resource}" -n "${NAMESPACE}" -o yaml \
    > "${BACKUP_DIR}/${resource//\//_}.yaml" 2>/dev/null || true
done

# Also backup infrastructure-specific resources
kubectl get awsclusters,awsmachines,awsmachinetemplates \
  -n "${NAMESPACE}" -o yaml \
  > "${BACKUP_DIR}/aws-infra.yaml" 2>/dev/null || true

echo "Backup complete: ${BACKUP_DIR}"
ls -lh "${BACKUP_DIR}"
```

### Fleet Status Dashboard Query

```bash
# Comprehensive fleet health summary
kubectl get clusters -A -o json | jq -r '
  ["NAMESPACE", "CLUSTER", "PHASE", "CP-READY", "WORKERS", "INFRA-READY"],
  (.items[] | [
    .metadata.namespace,
    .metadata.name,
    (.status.phase // "Unknown"),
    ((.status.controlPlaneReady // false) | tostring),
    (.status.observedGeneration // 0 | tostring),
    ((.status.infrastructureReady // false) | tostring)
  ])
  | @tsv' | column -t

# Machine count per cluster
kubectl get machines -A -o json | jq -r '
  .items | group_by(.spec.clusterName) |
  map({
    cluster: .[0].spec.clusterName,
    total: length,
    running: (map(select(.status.phase == "Running")) | length),
    failed: (map(select(.status.phase == "Failed")) | length)
  }) | .[] | "\(.cluster): \(.running)/\(.total) running, \(.failed) failed"'
```

---

## Troubleshooting Common Issues

### Machine Stuck in Provisioning

```bash
# Check infrastructure machine status
kubectl describe awsmachine <machine-name> -n clusters

# Check bootstrap config
kubectl describe kubeadmconfig <bootstrap-name> -n clusters

# Look for events
kubectl get events -n clusters --sort-by=.lastTimestamp | tail -30

# Check cloud-init logs on the node (via SSM or bastion)
# journalctl -u cloud-init --no-pager | tail -50
```

### MachineHealthCheck Not Remediating

```bash
# Check MHC conditions
kubectl get machinehealthcheck -n clusters -o json | \
  jq '.items[] | {name: .metadata.name, conditions: .status.conditions}'

# Verify maxUnhealthy is not exceeded
kubectl get machinehealthcheck worker-healthcheck -n clusters \
  -o jsonpath='{.status.unhealthyMachineCount}/{.status.expectedMachines}'

# Check if MHC is paused
kubectl get machinehealthcheck -n clusters \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.paused}{"\n"}{end}'
```

### ClusterClass Patch Not Applied

```bash
# Enable verbose logging on CAPI controller
kubectl patch deployment capi-controller-manager -n capi-system \
  --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--v=4"}]'

# Watch controller logs for patch application
kubectl logs -n capi-system -l control-plane=controller-manager -f | \
  grep -i "patch\|topology\|cluster"

# Validate ClusterClass patches with dry-run
kubectl apply --dry-run=server -f cluster-with-topology.yaml
```

---

## Summary

Cluster API advanced patterns enable enterprise teams to:

- **MachineHealthChecks**: Automatically remediate unhealthy nodes with configurable thresholds, custom conditions, and external remediation workflows
- **ClusterClasses**: Define reusable cluster topologies with parameterization, reducing configuration duplication across large fleets
- **Machine Rollout Strategies**: Implement controlled rolling upgrades with proper drain timeouts, surge limits, and phased rollout across MachineDeployment groups

The combination of these patterns provides a robust, GitOps-compatible foundation for managing Kubernetes clusters at scale in production environments.
