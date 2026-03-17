---
title: "Kubernetes Cluster API v1.8: Infrastructure Provider Development, ClusterClass Templates, and Upgrade Automation"
date: 2031-11-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster API", "CAPI", "Infrastructure Provider", "ClusterClass", "GitOps", "Automation"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Cluster API v1.8 covering custom infrastructure provider development, ClusterClass topology templates, and fully automated cluster lifecycle management for enterprise fleets."
more_link: "yes"
url: "/kubernetes-cluster-api-v18-infrastructure-provider-clusterclass-upgrade-automation/"
---

Cluster API (CAPI) v1.8 represents a major step forward for platform engineering teams managing large Kubernetes fleets. This release brings production-hardened ClusterClass topology, improved infrastructure provider contracts, and automation primitives that reduce human toil in cluster lifecycle management to near zero. This post covers the full stack: writing a custom infrastructure provider, composing ClusterClass templates for multi-environment fleets, and implementing automated upgrade pipelines with rollback.

<!--more-->

# Kubernetes Cluster API v1.8: Infrastructure Provider Development, ClusterClass Templates, and Upgrade Automation

## The CAPI Architecture Refresher

Before diving into v1.8 specifics, a concise architecture recap is worth having on hand. CAPI separates cluster management into three layers:

- **Core provider**: The CAPI controller set that owns Cluster, Machine, MachineDeployment, MachineSet, and topology objects.
- **Bootstrap provider**: Generates node bootstrap configuration (cloud-init, ignition). CABPK (kubeadm) is the reference implementation.
- **Infrastructure provider**: Provisions the actual compute and networking resources on a target platform. CAPD (Docker), CAPZ (Azure), CAPA (AWS), CAPG (GCP) are the maintained implementations.

ClusterClass, promoted to GA in v1.7 and refined in v1.8, sits above all three as a template engine that binds them together and encodes organizational topology decisions once rather than per-cluster.

## Section 1: Custom Infrastructure Provider Development

### 1.1 Provider Contract in v1.8

Every infrastructure provider must implement a set of CRDs and controller behaviors that satisfy the CAPI contract. The key objects are:

| Object | Purpose |
|---|---|
| `InfrastructureCluster` | Cluster-scoped infrastructure (VPC, LB) |
| `InfrastructureMachine` | Per-node compute resources |
| `InfrastructureClusterTemplate` | Template for ClusterClass usage |
| `InfrastructureMachineTemplate` | Template for ClusterClass usage |

The provider must also implement the `infrastructurecluster.Status.Ready` and `infrastructuremachine.Status.Ready` fields and populate `InfrastructureMachine.Status.Addresses`.

### 1.2 Scaffolding with kubebuilder

```bash
# Initialize a new provider repository
mkdir capi-provider-examplecloud
cd capi-provider-examplecloud

go mod init github.com/exampleorg/capi-provider-examplecloud

kubebuilder init \
  --domain cluster.x-k8s.io \
  --repo github.com/exampleorg/capi-provider-examplecloud \
  --project-version 3

# Create infrastructure types
kubebuilder create api \
  --group infrastructure \
  --version v1beta1 \
  --kind ExampleCloudCluster \
  --resource \
  --controller

kubebuilder create api \
  --group infrastructure \
  --version v1beta1 \
  --kind ExampleCloudMachine \
  --resource \
  --controller

kubebuilder create api \
  --group infrastructure \
  --version v1beta1 \
  --kind ExampleCloudClusterTemplate \
  --resource \
  --controller=false

kubebuilder create api \
  --group infrastructure \
  --version v1beta1 \
  --kind ExampleCloudMachineTemplate \
  --resource \
  --controller=false
```

### 1.3 ExampleCloudCluster Type Definition

```go
// api/v1beta1/examplecloudcluster_types.go
package v1beta1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
)

// ExampleCloudClusterSpec defines the desired state of ExampleCloudCluster
type ExampleCloudClusterSpec struct {
    // Region is the ExampleCloud region for this cluster.
    // +kubebuilder:validation:Required
    Region string `json:"region"`

    // NetworkSpec contains VPC and subnet configuration.
    // +optional
    Network NetworkSpec `json:"network,omitempty"`

    // ControlPlaneEndpoint is the endpoint for the cluster's control plane.
    // This is set by the controller once the load balancer is provisioned.
    // +optional
    ControlPlaneEndpoint clusterv1.APIEndpoint `json:"controlPlaneEndpoint,omitempty"`
}

type NetworkSpec struct {
    // VPCID is an existing VPC ID. If empty, a new VPC is created.
    // +optional
    VPCID string `json:"vpcID,omitempty"`

    // CIDR is the VPC CIDR block.
    // +kubebuilder:default="10.0.0.0/16"
    CIDR string `json:"cidr,omitempty"`

    // Subnets is the list of subnets to create or reference.
    Subnets []SubnetSpec `json:"subnets,omitempty"`
}

type SubnetSpec struct {
    // ID references an existing subnet.
    // +optional
    ID string `json:"id,omitempty"`

    // CIDR is the subnet CIDR.
    CIDR string `json:"cidr"`

    // AvailabilityZone for this subnet.
    AvailabilityZone string `json:"availabilityZone"`

    // IsPublic determines if a public route table is attached.
    // +kubebuilder:default=false
    IsPublic bool `json:"isPublic,omitempty"`
}

// ExampleCloudClusterStatus defines the observed state of ExampleCloudCluster
type ExampleCloudClusterStatus struct {
    // Ready indicates that the cluster infrastructure is provisioned.
    // +optional
    Ready bool `json:"ready,omitempty"`

    // VPCID is the provisioned VPC ID.
    // +optional
    VPCID string `json:"vpcID,omitempty"`

    // LoadBalancerID is the ID of the API server load balancer.
    // +optional
    LoadBalancerID string `json:"loadBalancerID,omitempty"`

    // FailureReason contains a short reason for failure.
    // +optional
    FailureReason *string `json:"failureReason,omitempty"`

    // FailureMessage contains a long-form failure description.
    // +optional
    FailureMessage *string `json:"failureMessage,omitempty"`

    // Conditions summarises the status of this object.
    // +optional
    Conditions clusterv1.Conditions `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type="boolean",JSONPath=".status.ready"
// +kubebuilder:printcolumn:name="Region",type="string",JSONPath=".spec.region"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
type ExampleCloudCluster struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec   ExampleCloudClusterSpec   `json:"spec,omitempty"`
    Status ExampleCloudClusterStatus `json:"status,omitempty"`
}
```

### 1.4 Infrastructure Cluster Controller

```go
// controllers/examplecloudcluster_controller.go
package controllers

import (
    "context"
    "fmt"

    "github.com/go-logr/logr"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/runtime"
    clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
    "sigs.k8s.io/cluster-api/util"
    "sigs.k8s.io/cluster-api/util/annotations"
    "sigs.k8s.io/cluster-api/util/conditions"
    "sigs.k8s.io/cluster-api/util/patch"
    "sigs.k8s.io/cluster-api/util/predicates"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

    infrav1 "github.com/exampleorg/capi-provider-examplecloud/api/v1beta1"
    "github.com/exampleorg/capi-provider-examplecloud/pkg/cloud"
)

const (
    clusterFinalizer = "examplecloudcluster.infrastructure.cluster.x-k8s.io"
)

type ExampleCloudClusterReconciler struct {
    client.Client
    Log          logr.Logger
    Scheme       *runtime.Scheme
    CloudFactory cloud.ClientFactory
}

func (r *ExampleCloudClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (_ ctrl.Result, reterr error) {
    log := r.Log.WithValues("examplecloudcluster", req.NamespacedName)

    // Fetch the ExampleCloudCluster instance
    exCluster := &infrav1.ExampleCloudCluster{}
    if err := r.Get(ctx, req.NamespacedName, exCluster); err != nil {
        if apierrors.IsNotFound(err) {
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, err
    }

    // Fetch the owning CAPI Cluster
    cluster, err := util.GetOwnerCluster(ctx, r.Client, exCluster.ObjectMeta)
    if err != nil {
        return ctrl.Result{}, err
    }
    if cluster == nil {
        log.Info("Cluster controller has not yet set OwnerRef")
        return ctrl.Result{}, nil
    }

    // Return early if the object or cluster is paused
    if annotations.IsPaused(cluster, exCluster) {
        log.Info("ExampleCloudCluster or owning Cluster is paused")
        return ctrl.Result{}, nil
    }

    // Initialize the patch helper
    patchHelper, err := patch.NewHelper(exCluster, r.Client)
    if err != nil {
        return ctrl.Result{}, err
    }
    defer func() {
        if err := patchHelper.Patch(
            ctx,
            exCluster,
            patch.WithOwnedConditions{Conditions: []clusterv1.ConditionType{
                clusterv1.ReadyCondition,
                infrav1.VPCReadyCondition,
                infrav1.LoadBalancerReadyCondition,
            }},
        ); err != nil && reterr == nil {
            reterr = err
        }
    }()

    // Handle deletion
    if !exCluster.DeletionTimestamp.IsZero() {
        return r.reconcileDelete(ctx, log, cluster, exCluster)
    }

    // Add finalizer
    controllerutil.AddFinalizer(exCluster, clusterFinalizer)

    return r.reconcileNormal(ctx, log, cluster, exCluster)
}

func (r *ExampleCloudClusterReconciler) reconcileNormal(
    ctx context.Context,
    log logr.Logger,
    cluster *clusterv1.Cluster,
    exCluster *infrav1.ExampleCloudCluster,
) (ctrl.Result, error) {

    cloudClient, err := r.CloudFactory.NewClient(exCluster.Spec.Region)
    if err != nil {
        return ctrl.Result{}, fmt.Errorf("building cloud client: %w", err)
    }

    // Step 1: Ensure VPC
    if err := r.reconcileVPC(ctx, log, cloudClient, exCluster); err != nil {
        conditions.MarkFalse(exCluster, infrav1.VPCReadyCondition,
            infrav1.VPCProvisionFailedReason, clusterv1.ConditionSeverityError, err.Error())
        return ctrl.Result{}, err
    }
    conditions.MarkTrue(exCluster, infrav1.VPCReadyCondition)

    // Step 2: Ensure Load Balancer
    if err := r.reconcileLoadBalancer(ctx, log, cloudClient, exCluster); err != nil {
        conditions.MarkFalse(exCluster, infrav1.LoadBalancerReadyCondition,
            infrav1.LoadBalancerProvisionFailedReason, clusterv1.ConditionSeverityError, err.Error())
        return ctrl.Result{}, err
    }
    conditions.MarkTrue(exCluster, infrav1.LoadBalancerReadyCondition)

    // Mark the infrastructure as ready
    exCluster.Status.Ready = true
    conditions.MarkTrue(exCluster, clusterv1.ReadyCondition)

    return ctrl.Result{}, nil
}

func (r *ExampleCloudClusterReconciler) reconcileVPC(
    ctx context.Context,
    log logr.Logger,
    cloudClient cloud.Client,
    exCluster *infrav1.ExampleCloudCluster,
) error {
    if exCluster.Status.VPCID != "" {
        log.V(4).Info("VPC already provisioned", "vpcID", exCluster.Status.VPCID)
        return nil
    }

    if exCluster.Spec.Network.VPCID != "" {
        log.Info("Using existing VPC", "vpcID", exCluster.Spec.Network.VPCID)
        exCluster.Status.VPCID = exCluster.Spec.Network.VPCID
        return nil
    }

    log.Info("Creating VPC", "cidr", exCluster.Spec.Network.CIDR)
    vpcID, err := cloudClient.CreateVPC(ctx, cloud.CreateVPCInput{
        Name: exCluster.Name,
        CIDR: exCluster.Spec.Network.CIDR,
        Tags: map[string]string{
            "capi-cluster": exCluster.Name,
            "managed-by":   "cluster-api",
        },
    })
    if err != nil {
        return fmt.Errorf("creating VPC: %w", err)
    }

    exCluster.Status.VPCID = vpcID
    log.Info("VPC created", "vpcID", vpcID)
    return nil
}

func (r *ExampleCloudClusterReconciler) reconcileDelete(
    ctx context.Context,
    log logr.Logger,
    cluster *clusterv1.Cluster,
    exCluster *infrav1.ExampleCloudCluster,
) (ctrl.Result, error) {
    log.Info("Reconciling ExampleCloudCluster deletion")

    cloudClient, err := r.CloudFactory.NewClient(exCluster.Spec.Region)
    if err != nil {
        return ctrl.Result{}, err
    }

    if exCluster.Status.LoadBalancerID != "" {
        if err := cloudClient.DeleteLoadBalancer(ctx, exCluster.Status.LoadBalancerID); err != nil {
            return ctrl.Result{}, fmt.Errorf("deleting load balancer: %w", err)
        }
    }

    if exCluster.Status.VPCID != "" && exCluster.Spec.Network.VPCID == "" {
        if err := cloudClient.DeleteVPC(ctx, exCluster.Status.VPCID); err != nil {
            return ctrl.Result{}, fmt.Errorf("deleting VPC: %w", err)
        }
    }

    controllerutil.RemoveFinalizer(exCluster, clusterFinalizer)
    log.Info("ExampleCloudCluster deletion complete")
    return ctrl.Result{}, nil
}

func (r *ExampleCloudClusterReconciler) SetupWithManager(mgr ctrl.Manager, options controller.Options) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&infrav1.ExampleCloudCluster{}).
        WithOptions(options).
        WithEventFilter(predicates.ResourceNotPausedAndHasFilterLabel(r.Log, "")).
        Complete(r)
}
```

## Section 2: ClusterClass Template Design

### 2.1 ClusterClass Overview

A ClusterClass encodes the topology of a cluster family. Instead of creating per-cluster KubeadmControlPlane and MachineDeployment objects, platform engineers write the topology once and reference it from each Cluster object via `.spec.topology`.

```yaml
# clusterclass-examplecloud-standard.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: examplecloud-standard
  namespace: capi-system
spec:
  infrastructure:
    ref:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
      kind: ExampleCloudClusterTemplate
      name: examplecloud-cluster-template
      namespace: capi-system

  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: examplecloud-kubeadm-cp-template
      namespace: capi-system
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: ExampleCloudMachineTemplate
        name: examplecloud-control-plane-machine-template
        namespace: capi-system

  workers:
    machineDeployments:
      - class: general-purpose
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: examplecloud-worker-bootstrap-template
              namespace: capi-system
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
              kind: ExampleCloudMachineTemplate
              name: examplecloud-worker-machine-template
              namespace: capi-system
        machineHealthCheck:
          maxUnhealthy: "33%"
          unhealthyConditions:
            - type: Ready
              status: Unknown
              timeout: 300s
            - type: Ready
              status: "False"
              timeout: 300s

      - class: gpu-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: examplecloud-gpu-bootstrap-template
              namespace: capi-system
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
              kind: ExampleCloudMachineTemplate
              name: examplecloud-gpu-machine-template
              namespace: capi-system

  variables:
    - name: kubernetesVersion
      required: true
      schema:
        openAPIV3Schema:
          type: string
          pattern: "^v1\\.[0-9]+\\.[0-9]+$"
          example: "v1.31.2"

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
          default: "m6i.xlarge"
          example: "m6i.2xlarge"

    - name: workerInstanceType
      required: false
      schema:
        openAPIV3Schema:
          type: string
          default: "m6i.large"

    - name: additionalTags
      required: false
      schema:
        openAPIV3Schema:
          type: object
          additionalProperties:
            type: string

  patches:
    - name: set-region
      definitions:
        - selector:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
            kind: ExampleCloudClusterTemplate
            matchResources:
              infrastructureCluster: true
          jsonPatches:
            - op: add
              path: /spec/template/spec/region
              valueFrom:
                variable: region

    - name: set-control-plane-instance-type
      definitions:
        - selector:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
            kind: ExampleCloudMachineTemplate
            matchResources:
              controlPlane: true
          jsonPatches:
            - op: replace
              path: /spec/template/spec/instanceType
              valueFrom:
                variable: controlPlaneInstanceType

    - name: set-worker-instance-type
      definitions:
        - selector:
            apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
            kind: ExampleCloudMachineTemplate
            matchResources:
              machineDeploymentClass:
                names: ["general-purpose"]
          jsonPatches:
            - op: replace
              path: /spec/template/spec/instanceType
              valueFrom:
                variable: workerInstanceType

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
```

### 2.2 Cluster Instantiation from ClusterClass

```yaml
# cluster-prod-us-east.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: prod-us-east-01
  namespace: clusters
  labels:
    environment: production
    region: us-east-1
    team: platform
spec:
  topology:
    class: examplecloud-standard
    version: v1.31.2
    variables:
      - name: region
        value: "us-east-1"
      - name: controlPlaneInstanceType
        value: "m6i.2xlarge"
      - name: workerInstanceType
        value: "m6i.xlarge"
      - name: additionalTags
        value:
          cost-center: "eng-platform"
          compliance: "pci-dss"

    controlPlane:
      replicas: 3
      metadata:
        labels:
          node-role: control-plane

    workers:
      machineDeployments:
        - name: general-workers
          class: general-purpose
          replicas: 6
          metadata:
            labels:
              node-pool: general
          failureDomains: ["us-east-1a", "us-east-1b", "us-east-1c"]

        - name: gpu-workers
          class: gpu-worker
          replicas: 2
          metadata:
            labels:
              node-pool: gpu
              nvidia.com/gpu: "true"
```

### 2.3 Runtime Extension for Custom Lifecycle Hooks

CAPI v1.8 stabilized Runtime Extensions, which allow providers to inject custom logic at key lifecycle points.

```go
// pkg/runtimeextension/handler.go
package runtimeextension

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"

    runtimehooksv1 "sigs.k8s.io/cluster-api/exp/runtime/hooks/api/v1alpha1"
    runtimeclient "sigs.k8s.io/cluster-api/exp/runtime/client"
)

type Handler struct {
    notifier NotificationService
}

// BeforeClusterUpgrade is called before the cluster upgrade starts.
func (h *Handler) BeforeClusterUpgrade(
    ctx context.Context,
    req *runtimehooksv1.BeforeClusterUpgradeRequest,
    resp *runtimehooksv1.BeforeClusterUpgradeResponse,
) {
    cluster := req.Cluster

    // Check if the cluster has an active maintenance window
    if !h.isInMaintenanceWindow(cluster) {
        resp.Status = runtimehooksv1.ResponseStatusFailure
        resp.Message = fmt.Sprintf(
            "cluster %s/%s is not in a maintenance window; upgrade blocked",
            cluster.Namespace, cluster.Name,
        )
        return
    }

    // Notify on-call team
    if err := h.notifier.SendUpgradeStarting(ctx, cluster.Name, req.ToKubernetesVersion); err != nil {
        // Non-fatal: log but do not block
        fmt.Printf("WARNING: failed to send upgrade notification: %v\n", err)
    }

    resp.Status = runtimehooksv1.ResponseStatusSuccess
    resp.Message = "maintenance window confirmed; upgrade may proceed"
}

// AfterClusterUpgrade is called after all nodes have been upgraded.
func (h *Handler) AfterClusterUpgrade(
    ctx context.Context,
    req *runtimehooksv1.AfterClusterUpgradeRequest,
    resp *runtimehooksv1.AfterClusterUpgradeResponse,
) {
    cluster := req.Cluster

    // Run post-upgrade validation
    if err := h.runPostUpgradeChecks(ctx, cluster.Name); err != nil {
        resp.Status = runtimehooksv1.ResponseStatusFailure
        resp.Message = fmt.Sprintf("post-upgrade checks failed: %v", err)
        return
    }

    h.notifier.SendUpgradeComplete(ctx, cluster.Name, req.ToKubernetesVersion)
    resp.Status = runtimehooksv1.ResponseStatusSuccess
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Route based on path
    switch r.URL.Path {
    case "/hooks/v1alpha1/beforeclusterupgrade":
        h.handleBeforeClusterUpgrade(w, r)
    case "/hooks/v1alpha1/afterclusterupgrade":
        h.handleAfterClusterUpgrade(w, r)
    default:
        http.NotFound(w, r)
    }
}
```

## Section 3: Upgrade Automation

### 3.1 Automated Upgrade Controller Design

The upgrade automation strategy follows a pipeline model: detect available versions, validate compatibility, apply topology updates with controlled rollout, and verify health.

```go
// pkg/upgradeautomation/controller.go
package upgradeautomation

import (
    "context"
    "fmt"
    "sort"
    "time"

    "github.com/Masterminds/semver/v3"
    clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// ClusterUpgradePolicy defines automated upgrade behavior for a fleet.
type ClusterUpgradePolicy struct {
    // MaxKubernetesVersionSkew is the max number of minor versions behind latest.
    MaxKubernetesVersionSkew int

    // AllowedUpgradeWindow is the time range during which upgrades are allowed.
    AllowedUpgradeWindow MaintenanceWindow

    // MaxConcurrentUpgrades limits how many clusters upgrade simultaneously.
    MaxConcurrentUpgrades int

    // RequiredSoakDuration is how long a version must be stable in staging
    // before being promoted to production clusters.
    RequiredSoakDuration time.Duration
}

type MaintenanceWindow struct {
    // DaysOfWeek: 0=Sunday through 6=Saturday
    DaysOfWeek []int
    StartHour  int // UTC
    EndHour    int // UTC
}

type UpgradeAutomationReconciler struct {
    client.Client
    Policy        ClusterUpgradePolicy
    VersionSource VersionSource
}

func (r *UpgradeAutomationReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    // List all clusters managed by this policy
    clusterList := &clusterv1.ClusterList{}
    if err := r.List(ctx, clusterList, client.MatchingLabels{
        "upgrade-policy": req.Name,
    }); err != nil {
        return ctrl.Result{}, err
    }

    // Get available versions from the version source (e.g., ExampleCloud API)
    availableVersions, err := r.VersionSource.ListAvailableVersions(ctx)
    if err != nil {
        return ctrl.Result{RequeueAfter: 5 * time.Minute}, fmt.Errorf("listing versions: %w", err)
    }

    targetVersion, err := r.selectTargetVersion(availableVersions)
    if err != nil {
        return ctrl.Result{}, err
    }

    // Count clusters currently upgrading
    upgrading := 0
    for _, cluster := range clusterList.Items {
        if r.isUpgrading(&cluster) {
            upgrading++
        }
    }

    if upgrading >= r.Policy.MaxConcurrentUpgrades {
        return ctrl.Result{RequeueAfter: 2 * time.Minute}, nil
    }

    // Find clusters that need upgrading, prioritize by environment tier
    candidates := r.selectUpgradeCandidates(clusterList.Items, targetVersion)
    slotsAvailable := r.Policy.MaxConcurrentUpgrades - upgrading

    for i, cluster := range candidates {
        if i >= slotsAvailable {
            break
        }
        if err := r.triggerUpgrade(ctx, &cluster, targetVersion); err != nil {
            return ctrl.Result{}, fmt.Errorf("triggering upgrade for %s: %w", cluster.Name, err)
        }
    }

    return ctrl.Result{RequeueAfter: 10 * time.Minute}, nil
}

func (r *UpgradeAutomationReconciler) selectTargetVersion(versions []string) (string, error) {
    parsed := make([]*semver.Version, 0, len(versions))
    for _, v := range versions {
        sv, err := semver.NewVersion(v)
        if err != nil {
            continue
        }
        parsed = append(parsed, sv)
    }

    sort.Slice(parsed, func(i, j int) bool {
        return parsed[i].GreaterThan(parsed[j])
    })

    if len(parsed) == 0 {
        return "", fmt.Errorf("no valid versions available")
    }

    return "v" + parsed[0].String(), nil
}

func (r *UpgradeAutomationReconciler) triggerUpgrade(
    ctx context.Context,
    cluster *clusterv1.Cluster,
    targetVersion string,
) error {
    patch := client.MergeFrom(cluster.DeepCopy())
    cluster.Spec.Topology.Version = targetVersion
    return r.Patch(ctx, cluster, patch)
}

func (r *UpgradeAutomationReconciler) isUpgrading(cluster *clusterv1.Cluster) bool {
    for _, condition := range cluster.Status.Conditions {
        if condition.Type == clusterv1.TopologyReconciledCondition &&
            condition.Status == "False" &&
            condition.Reason == "UpgradePending" {
            return true
        }
    }
    return false
}
```

### 3.2 GitOps Integration: ArgoCD ApplicationSet for Fleet Management

```yaml
# fleet-applicationset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: capi-cluster-fleet
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          - git:
              repoURL: https://git.example.com/platform/cluster-definitions.git
              revision: main
              directories:
                - path: "clusters/*/*"
          - list:
              elements:
                - environment: production
                  wave: "3"
                - environment: staging
                  wave: "2"
                - environment: development
                  wave: "1"

  template:
    metadata:
      name: "{{path.basename}}"
      namespace: argocd
      annotations:
        argocd.argoproj.io/sync-wave: "{{wave}}"
      labels:
        environment: "{{environment}}"
    spec:
      project: platform-clusters
      source:
        repoURL: https://git.example.com/platform/cluster-definitions.git
        targetRevision: main
        path: "{{path}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: clusters
      syncPolicy:
        automated:
          prune: false       # Never auto-prune clusters
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ServerSideApply=true
        retry:
          limit: 5
          backoff:
            duration: 30s
            factor: 2
            maxDuration: 5m
```

### 3.3 Health Verification After Upgrade

```bash
#!/usr/bin/env bash
# verify-cluster-upgrade.sh
# Runs post-upgrade health checks against a CAPI-managed cluster

set -euo pipefail

CLUSTER_NAME="${1:?Usage: $0 <cluster-name> <namespace>}"
NAMESPACE="${2:-clusters}"
TIMEOUT="${3:-600}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

wait_condition() {
  local resource="$1" condition="$2" timeout="$3"
  kubectl wait "$resource" \
    --for="condition=${condition}" \
    --timeout="${timeout}s" \
    -n "$NAMESPACE"
}

log "Verifying upgrade for cluster: ${CLUSTER_NAME}"

# 1. Wait for CAPI Cluster to reach Ready
log "Waiting for Cluster to be Ready..."
wait_condition "cluster/${CLUSTER_NAME}" "Ready" "$TIMEOUT"

# 2. Verify all MachineDeployments are at desired replicas
log "Checking MachineDeployments..."
kubectl get machinedeployments \
  -n "$NAMESPACE" \
  -l "cluster.x-k8s.io/cluster-name=${CLUSTER_NAME}" \
  -o json | jq -r '
  .items[] |
  select(.status.readyReplicas != .status.replicas) |
  "MachineDeployment \(.metadata.name) not fully ready: \(.status.readyReplicas)/\(.status.replicas)"
' | while read -r msg; do
  log "ERROR: $msg"
  exit 1
done

# 3. Get kubeconfig and verify node versions
log "Retrieving cluster kubeconfig..."
clusterctl get kubeconfig "$CLUSTER_NAME" \
  -n "$NAMESPACE" > /tmp/cluster-kubeconfig.yaml

EXPECTED_VERSION=$(kubectl get cluster "$CLUSTER_NAME" \
  -n "$NAMESPACE" \
  -o jsonpath='{.spec.topology.version}')

log "Expected Kubernetes version: ${EXPECTED_VERSION}"

MISMATCHED=$(kubectl --kubeconfig=/tmp/cluster-kubeconfig.yaml \
  get nodes \
  -o json | jq -r \
  --arg expected "$EXPECTED_VERSION" \
  '.items[] | select(.status.nodeInfo.kubeletVersion != $expected) |
   "\(.metadata.name): \(.status.nodeInfo.kubeletVersion)"')

if [[ -n "$MISMATCHED" ]]; then
  log "ERROR: Nodes with mismatched versions:"
  echo "$MISMATCHED"
  exit 1
fi

# 4. Verify core system pods
log "Verifying system pods..."
kubectl --kubeconfig=/tmp/cluster-kubeconfig.yaml \
  wait pods \
  --for=condition=Ready \
  --timeout=120s \
  -n kube-system \
  -l tier=control-plane

log "Upgrade verification complete for cluster: ${CLUSTER_NAME}"
rm -f /tmp/cluster-kubeconfig.yaml
```

## Section 4: Observability and Alerting

### 4.1 Prometheus Metrics for the Fleet

```yaml
# prometheusrule-capi-fleet.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: capi-fleet-alerts
  namespace: monitoring
spec:
  groups:
    - name: capi.cluster.health
      interval: 60s
      rules:
        - alert: CAPIClusterNotReady
          expr: |
            capi_cluster_ready == 0
          for: 10m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "CAPI cluster {{ $labels.cluster_name }} is not Ready"
            description: "Cluster {{ $labels.cluster_name }} in namespace {{ $labels.namespace }} has been NotReady for 10 minutes."
            runbook: "https://runbooks.example.com/capi/cluster-not-ready"

        - alert: CAPIClusterUpgradeStalled
          expr: |
            (
              time() - capi_cluster_topology_reconcile_timestamp
            ) > 3600
            and capi_cluster_topology_version != capi_cluster_version
          for: 0m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Cluster {{ $labels.cluster_name }} upgrade appears stalled"
            description: "Cluster {{ $labels.cluster_name }} has had a version mismatch for over 1 hour."

        - alert: CAPIProviderReconcileErrors
          expr: |
            rate(controller_runtime_reconcile_errors_total{
              controller=~"examplecloudcluster|examplecloudmachine"
            }[5m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High reconcile error rate in CAPI provider"
```

## Section 5: Production Operations

### 5.1 Cluster Rollback Strategy

When an upgrade fails health checks, rolling back in CAPI requires patching the topology version back to the previous value.

```bash
#!/usr/bin/env bash
# rollback-cluster.sh

CLUSTER_NAME="${1:?}"
NAMESPACE="${2:-clusters}"

PREVIOUS_VERSION=$(kubectl get cluster "$CLUSTER_NAME" \
  -n "$NAMESPACE" \
  -o jsonpath='{.metadata.annotations.capi\.example\.com/previous-version}')

if [[ -z "$PREVIOUS_VERSION" ]]; then
  echo "ERROR: No previous version annotation found"
  exit 1
fi

echo "Rolling back ${CLUSTER_NAME} to ${PREVIOUS_VERSION}"

kubectl patch cluster "$CLUSTER_NAME" \
  -n "$NAMESPACE" \
  --type merge \
  -p "{\"spec\":{\"topology\":{\"version\":\"${PREVIOUS_VERSION}\"}}}"

echo "Rollback initiated. Monitor with:"
echo "  kubectl get cluster ${CLUSTER_NAME} -n ${NAMESPACE} -w"
```

### 5.2 Fleet Status Dashboard Query

```promql
# Clusters by upgrade status
count by (topology_version) (
  label_replace(
    capi_cluster_info,
    "topology_version", "$1",
    "topology_version", "(.*)"
  )
)

# P99 upgrade duration across all clusters
histogram_quantile(0.99,
  rate(capi_cluster_upgrade_duration_seconds_bucket[24h])
)
```

## Summary

CAPI v1.8 provides a complete platform for building opinionated, self-service Kubernetes infrastructure. The key operational decisions for enterprise teams are:

1. **Provider development** follows a strict contract around Ready status and finalizer management. Use the patch helper pattern to prevent update conflicts.
2. **ClusterClass** is the correct abstraction for fleets larger than a handful of clusters. Encode all topology decisions — instance types, regions, bootstrap config — as variables with sensible defaults.
3. **Runtime Extensions** allow injecting business logic (maintenance windows, notifications, compliance checks) at upgrade lifecycle hooks without patching the CAPI core.
4. **Upgrade automation** should be gated by maintenance windows, concurrent upgrade limits, and post-upgrade health verification before advancing to the next cluster tier.
5. **GitOps** via ArgoCD ApplicationSets provides the audit trail and declarative drift detection that enterprise governance requires.

The provider development pattern shown here provides a foundation adaptable to any IaaS platform with a Go SDK, with the controller scaffolding handling roughly 70% of the boilerplate.
