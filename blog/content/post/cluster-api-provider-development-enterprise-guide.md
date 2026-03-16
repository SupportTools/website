---
title: "Cluster API Provider Development: Building Custom Kubernetes Infrastructure Providers"
date: 2026-05-14T00:00:00-05:00
draft: false
tags: ["Cluster API", "Kubernetes", "CAPI", "Infrastructure Provider", "Custom Controllers", "Go"]
categories: ["Platform Engineering", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to developing custom Cluster API providers for managing Kubernetes infrastructure across any platform with production-ready implementation examples."
more_link: "yes"
url: "/cluster-api-provider-development-enterprise-guide/"
---

Cluster API (CAPI) provides a declarative API for cluster lifecycle management. While providers exist for major clouds, many organizations need custom providers for on-premises infrastructure, specialized clouds, or unique requirements. This guide demonstrates how to build production-grade Cluster API providers from scratch.

<!--more-->

# Cluster API Provider Development: Building Custom Kubernetes Infrastructure Providers

## Understanding Cluster API Architecture

Cluster API extends Kubernetes with custom resources for managing the lifecycle of Kubernetes clusters. The architecture consists of management clusters that control workload clusters through declarative APIs.

Core components include:
- **Cluster Controller**: Manages cluster lifecycle
- **Machine Controller**: Manages individual machines
- **Infrastructure Provider**: Platform-specific implementations
- **Bootstrap Provider**: Handles node initialization
- **Control Plane Provider**: Manages control plane nodes

## Project Setup

### Initialize Provider Project

```bash
# Install kubebuilder
curl -L -o kubebuilder https://go.kubebuilder.io/dl/latest/$(go env GOOS)/$(go env GOARCH)
chmod +x kubebuilder
sudo mv kubebuilder /usr/local/bin/

# Create provider project
mkdir cluster-api-provider-custom
cd cluster-api-provider-custom

# Initialize kubebuilder project
kubebuilder init \
  --domain cluster.x-k8s.io \
  --repo github.com/company/cluster-api-provider-custom

# Create APIs
kubebuilder create api \
  --group infrastructure \
  --version v1beta1 \
  --kind CustomCluster \
  --resource \
  --controller

kubebuilder create api \
  --group infrastructure \
  --version v1beta1 \
  --kind CustomMachine \
  --resource \
  --controller
```

## API Definitions

### CustomCluster Type

```go
// api/v1beta1/customcluster_types.go
package v1beta1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
)

type CustomClusterSpec struct {
	ControlPlaneEndpoint clusterv1.APIEndpoint `json:"controlPlaneEndpoint,omitempty"`
	Region              string                  `json:"region"`
	NetworkSpec         NetworkSpec             `json:"networkSpec,omitempty"`
	LoadBalancerSpec    LoadBalancerSpec        `json:"loadBalancerSpec,omitempty"`
	AdditionalTags      map[string]string       `json:"additionalTags,omitempty"`
}

type NetworkSpec struct {
	VPC            VPCSpec             `json:"vpc,omitempty"`
	Subnets        []SubnetSpec        `json:"subnets,omitempty"`
	SecurityGroups []SecurityGroupSpec `json:"securityGroups,omitempty"`
}

type CustomClusterStatus struct {
	Ready          bool              `json:"ready"`
	Network        NetworkStatus     `json:"network,omitempty"`
	LoadBalancer   LoadBalancerStatus `json:"loadBalancer,omitempty"`
	FailureReason  *string           `json:"failureReason,omitempty"`
	FailureMessage *string           `json:"failureMessage,omitempty"`
	Conditions     clusterv1.Conditions `json:"conditions,omitempty"`
}

//+kubebuilder:object:root=true
//+kubebuilder:subresource:status

type CustomCluster struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              CustomClusterSpec   `json:"spec,omitempty"`
	Status            CustomClusterStatus `json:"status,omitempty"`
}
```

### CustomMachine Type

```go
// api/v1beta1/custommachine_types.go
package v1beta1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
)

type CustomMachineSpec struct {
	ProviderID         *string           `json:"providerID,omitempty"`
	InstanceType       string            `json:"instanceType"`
	ImageID            string            `json:"imageId"`
	SSHKeyName         *string           `json:"sshKeyName,omitempty"`
	SubnetID           *string           `json:"subnetId,omitempty"`
	SecurityGroupIDs   []string          `json:"securityGroupIds,omitempty"`
	IAMInstanceProfile *string           `json:"iamInstanceProfile,omitempty"`
	RootVolume         *VolumeSpec       `json:"rootVolume,omitempty"`
	AdditionalVolumes  []VolumeSpec      `json:"additionalVolumes,omitempty"`
	UserData           *string           `json:"userData,omitempty"`
	Tags               map[string]string `json:"tags,omitempty"`
}

type CustomMachineStatus struct {
	Ready          bool                      `json:"ready"`
	InstanceID     *string                   `json:"instanceId,omitempty"`
	InstanceState  *string                   `json:"instanceState,omitempty"`
	Addresses      []clusterv1.MachineAddress `json:"addresses,omitempty"`
	FailureReason  *string                   `json:"failureReason,omitempty"`
	FailureMessage *string                   `json:"failureMessage,omitempty"`
	Conditions     clusterv1.Conditions      `json:"conditions,omitempty"`
}

//+kubebuilder:object:root=true
//+kubebuilder:subresource:status

type CustomMachine struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              CustomMachineSpec   `json:"spec,omitempty"`
	Status            CustomMachineStatus `json:"status,omitempty"`
}
```

## Controller Implementation

### Cluster Controller

```go
// controllers/customcluster_controller.go
package controllers

import (
	"context"
	
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	
	infrastructurev1 "github.com/company/cluster-api-provider-custom/api/v1beta1"
	"github.com/company/cluster-api-provider-custom/pkg/scope"
	clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
	"sigs.k8s.io/cluster-api/util"
)

type CustomClusterReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func (r *CustomClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := ctrl.LoggerFrom(ctx)

	// Fetch CustomCluster
	customCluster := &infrastructurev1.CustomCluster{}
	if err := r.Get(ctx, req.NamespacedName, customCluster); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Fetch owner Cluster
	cluster, err := util.GetOwnerCluster(ctx, r.Client, customCluster.ObjectMeta)
	if err != nil {
		return ctrl.Result{}, err
	}
	if cluster == nil {
		log.Info("Waiting for Cluster Controller to set OwnerRef")
		return ctrl.Result{}, nil
	}

	// Create scope
	clusterScope, err := scope.NewClusterScope(scope.ClusterScopeParams{
		Client:        r.Client,
		Cluster:       cluster,
		CustomCluster: customCluster,
	})
	if err != nil {
		return ctrl.Result{}, err
	}

	defer func() {
		if err := clusterScope.Close(); err != nil {
			log.Error(err, "failed to close scope")
		}
	}()

	// Handle deletion
	if !customCluster.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, clusterScope)
	}

	// Handle normal reconciliation
	return r.reconcileNormal(ctx, clusterScope)
}

func (r *CustomClusterReconciler) reconcileNormal(ctx context.Context, clusterScope *scope.ClusterScope) (ctrl.Result, error) {
	clusterScope.Info("Reconciling CustomCluster")

	// Add finalizer
	if !controllerutil.ContainsFinalizer(clusterScope.CustomCluster, infrastructurev1.ClusterFinalizer) {
		controllerutil.AddFinalizer(clusterScope.CustomCluster, infrastructurev1.ClusterFinalizer)
		return ctrl.Result{}, nil
	}

	// Reconcile network
	if err := r.reconcileNetwork(ctx, clusterScope); err != nil {
		return ctrl.Result{}, err
	}

	// Reconcile load balancer
	if err := r.reconcileLoadBalancer(ctx, clusterScope); err != nil {
		return ctrl.Result{}, err
	}

	// Mark ready
	clusterScope.CustomCluster.Status.Ready = true

	return ctrl.Result{}, nil
}

func (r *CustomClusterReconciler) reconcileDelete(ctx context.Context, clusterScope *scope.ClusterScope) (ctrl.Result, error) {
	clusterScope.Info("Deleting CustomCluster")

	// Delete infrastructure
	cloudClient := clusterScope.CloudClient()
	
	if err := cloudClient.DeleteLoadBalancer(ctx, clusterScope); err != nil {
		return ctrl.Result{}, err
	}

	if err := cloudClient.DeleteNetwork(ctx, clusterScope); err != nil {
		return ctrl.Result{}, err
	}

	// Remove finalizer
	controllerutil.RemoveFinalizer(clusterScope.CustomCluster, infrastructurev1.ClusterFinalizer)

	return ctrl.Result{}, nil
}

func (r *CustomClusterReconciler) reconcileNetwork(ctx context.Context, clusterScope *scope.ClusterScope) error {
	cloudClient := clusterScope.CloudClient()
	
	vpcID, err := cloudClient.ReconcileVPC(ctx, clusterScope)
	if err != nil {
		return err
	}
	clusterScope.CustomCluster.Status.Network.VPCID = vpcID

	subnetIDs, err := cloudClient.ReconcileSubnets(ctx, clusterScope)
	if err != nil {
		return err
	}
	clusterScope.CustomCluster.Status.Network.Subnets = subnetIDs

	return nil
}

func (r *CustomClusterReconciler) reconcileLoadBalancer(ctx context.Context, clusterScope *scope.ClusterScope) error {
	cloudClient := clusterScope.CloudClient()
	
	lbDNS, lbARN, err := cloudClient.ReconcileLoadBalancer(ctx, clusterScope)
	if err != nil {
		return err
	}

	clusterScope.CustomCluster.Status.LoadBalancer.DNSName = lbDNS
	clusterScope.CustomCluster.Status.LoadBalancer.ARN = lbARN

	clusterScope.CustomCluster.Spec.ControlPlaneEndpoint = clusterv1.APIEndpoint{
		Host: lbDNS,
		Port: 6443,
	}

	return nil
}

func (r *CustomClusterReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&infrastructurev1.CustomCluster{}).
		Complete(r)
}
```

## Cloud Client Interface

```go
// pkg/cloud/client.go
package cloud

import (
	"context"
	
	"github.com/company/cluster-api-provider-custom/pkg/scope"
	clusterv1 "sigs.k8s.io/cluster-api/api/v1beta1"
)

type Client interface {
	// Network operations
	ReconcileVPC(ctx context.Context, clusterScope *scope.ClusterScope) (string, error)
	ReconcileSubnets(ctx context.Context, clusterScope *scope.ClusterScope) ([]string, error)
	ReconcileSecurityGroups(ctx context.Context, clusterScope *scope.ClusterScope) ([]string, error)
	DeleteNetwork(ctx context.Context, clusterScope *scope.ClusterScope) error
	
	// Load balancer operations
	ReconcileLoadBalancer(ctx context.Context, clusterScope *scope.ClusterScope) (string, string, error)
	DeleteLoadBalancer(ctx context.Context, clusterScope *scope.ClusterScope) error
	
	// Instance operations
	ReconcileInstance(ctx context.Context, machineScope *scope.MachineScope) (*Instance, error)
	DeleteInstance(ctx context.Context, machineScope *scope.MachineScope) error
}

type Instance struct {
	InstanceID *string
	State      *string
	Addresses  []clusterv1.MachineAddress
}
```

## Deployment Configuration

### Kubernetes Manifests

```yaml
# config/manager/manager.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: controller-manager
  namespace: system
spec:
  replicas: 1
  selector:
    matchLabels:
      control-plane: controller-manager
  template:
    metadata:
      labels:
        control-plane: controller-manager
    spec:
      serviceAccountName: controller-manager
      containers:
      - name: manager
        image: controller:latest
        command:
        - /manager
        args:
        - --leader-elect
        - --metrics-bind-address=:8080
        ports:
        - containerPort: 8080
          name: metrics
        - containerPort: 8081
          name: healthz
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8081
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8081
        resources:
          limits:
            cpu: 500m
            memory: 512Mi
          requests:
            cpu: 100m
            memory: 128Mi
```

## Usage Example

```yaml
# Create workload cluster
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: my-cluster
spec:
  clusterNetwork:
    pods:
      cidrBlocks: ["192.168.0.0/16"]
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: CustomCluster
    name: my-cluster
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: CustomCluster
metadata:
  name: my-cluster
spec:
  region: us-east-1
  networkSpec:
    vpc:
      cidrBlock: 10.0.0.0/16
    subnets:
    - cidrBlock: 10.0.1.0/24
      availabilityZone: us-east-1a
      isPublic: true
```

## Best Practices

### Controller Development
1. **Use Finalizers**: Always implement proper cleanup
2. **Idempotent Operations**: Ensure reconciliation can run multiple times
3. **Condition Management**: Use standard CAPI conditions
4. **Error Handling**: Return appropriate errors for retry logic
5. **Structured Logging**: Use contextual logging

### API Design
1. **Follow CAPI Patterns**: Align with existing provider conventions
2. **Validation**: Use kubebuilder validation markers
3. **Documentation**: Document all API fields
4. **Versioning**: Plan for API evolution

## Testing Strategy

```go
// Integration test example
var _ = Describe("CustomCluster", func() {
	Context("When creating a CustomCluster", func() {
		It("Should create network infrastructure", func() {
			// Test implementation
		})
	})
})
```

## Conclusion

Building custom Cluster API providers enables standardized Kubernetes cluster management across any infrastructure. Key benefits include:

- **Declarative API**: Consistent interface across platforms
- **GitOps Ready**: Version-controlled infrastructure
- **Extensible**: Easy to customize for specific needs
- **Community Patterns**: Leverage proven approaches

Success requires understanding CAPI contracts, implementing robust controllers, and comprehensive testing before production deployment.
