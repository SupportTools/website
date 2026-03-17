---
title: "Kubernetes Crossplane Provider Development: Building Custom Cloud Resource Providers with Go"
date: 2031-09-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Crossplane", "Go", "Infrastructure as Code", "Custom Providers", "Cloud Native"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to developing custom Crossplane providers in Go, covering the provider runtime, managed resource lifecycle, connection details, and publishing to the Upbound Marketplace."
more_link: "yes"
url: "/kubernetes-crossplane-provider-development-go-custom-cloud-resources/"
---

Crossplane extends Kubernetes into a universal control plane for cloud infrastructure. Where Terraform manages infrastructure through HCL files and CLI runs, Crossplane manages it through Kubernetes objects—meaning every piece of infrastructure has a reconciliation loop, a status condition, and can be composed into higher-level abstractions using Compositions. The mechanism that connects Crossplane to actual cloud APIs is the provider, and every major cloud has one. But when you need to manage an internal system, a niche SaaS API, or a custom on-premises resource that no existing provider covers, you build your own.

This guide walks through building a production-quality Crossplane provider in Go from scratch: scaffolding the project, implementing the managed resource controller, handling credentials and connection details, and packaging for distribution.

<!--more-->

# Kubernetes Crossplane Provider Development in Go

## Crossplane Architecture Review

Before writing code, a precise mental model of the component relationships is essential.

```
Crossplane Core (installed once per cluster)
└── Manages ProviderRevision / Provider objects

Provider Pod (one per provider package)
└── Runs the provider's controller-manager
    ├── ProviderConfig controller — manages auth credentials
    └── ManagedResource controllers (one per type)
        ├── Observe  — read current cloud state
        ├── Create   — provision the resource
        ├── Update   — reconcile drift
        └── Delete   — deprovision with finalizer
```

A **Managed Resource** is a Kubernetes CRD that maps 1:1 to a cloud API resource. Users create these objects; the provider reconciles them against the external API. When a user deletes the object, the provider deletes the underlying resource (unless a deletion policy prevents it).

A **ProviderConfig** holds credentials. Every managed resource references a ProviderConfig by name.

## Setting Up the Development Environment

```bash
# Install crossplane-runtime and crossplane-tools
go install github.com/crossplane/crossplane-tools/cmd/angryjet@latest
go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest

# Install the Crossplane CLI
curl -sL https://raw.githubusercontent.com/crossplane/crossplane/master/install.sh | sh

# Scaffold a new provider using upjet (the official scaffold tool)
# For pure Go providers without Terraform underneath, use provider-runtime directly.

mkdir provider-acmestorage
cd provider-acmestorage
go mod init github.com/example/provider-acmestorage
```

## Project Structure

```
provider-acmestorage/
├── apis/
│   ├── v1alpha1/
│   │   ├── bucket_types.go      # Managed resource CRD type
│   │   ├── groupversion_info.go
│   │   └── zz_generated.deepcopy.go
│   └── v1beta1/
│       ├── providerconfig_types.go
│       ├── groupversion_info.go
│       └── zz_generated.deepcopy.go
├── internal/
│   └── controller/
│       ├── bucket/
│       │   └── reconciler.go    # Main reconciler
│       └── providerconfig/
│           └── reconciler.go
├── package/
│   ├── crossplane.yaml          # Provider package metadata
│   └── crds/                   # Generated CRD manifests
├── cmd/
│   └── provider/
│       └── main.go
├── Dockerfile
├── Makefile
└── go.mod
```

## Defining the Managed Resource Type

```go
// apis/v1alpha1/bucket_types.go
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"

	xpv1 "github.com/crossplane/crossplane-runtime/apis/common/v1"
)

// BucketParameters defines the desired state of an ACME Storage bucket.
// These fields map 1:1 to the ACME Storage API parameters.
type BucketParameters struct {
	// Region is the geographic region where the bucket will be created.
	// +kubebuilder:validation:Enum=us-east;us-west;eu-west;ap-southeast
	Region string `json:"region"`

	// StorageClass controls cost vs. availability tradeoff.
	// +kubebuilder:default=standard
	// +kubebuilder:validation:Enum=standard;archive;coldline
	// +optional
	StorageClass string `json:"storageClass,omitempty"`

	// PublicAccessBlock prevents public access to the bucket.
	// +kubebuilder:default=true
	// +optional
	PublicAccessBlock bool `json:"publicAccessBlock,omitempty"`

	// Versioning enables object versioning.
	// +kubebuilder:default=false
	// +optional
	Versioning bool `json:"versioning,omitempty"`

	// Tags to apply to the bucket.
	// +optional
	Tags map[string]string `json:"tags,omitempty"`

	// LifecycleRules defines object expiration and transition policies.
	// +optional
	LifecycleRules []LifecycleRule `json:"lifecycleRules,omitempty"`
}

// LifecycleRule defines an object lifecycle policy.
type LifecycleRule struct {
	// ID is a unique identifier for this rule.
	ID string `json:"id"`

	// ExpirationDays causes objects to expire after this many days.
	// +optional
	ExpirationDays *int32 `json:"expirationDays,omitempty"`

	// TransitionDays causes objects to transition to StorageClass after this many days.
	// +optional
	TransitionDays *int32 `json:"transitionDays,omitempty"`

	// TransitionStorageClass is the target storage class for transitions.
	// +optional
	TransitionStorageClass string `json:"transitionStorageClass,omitempty"`
}

// BucketObservation describes the observed state of an ACME Storage bucket.
// These fields are populated by the Observe function and reflect actual API state.
type BucketObservation struct {
	// BucketID is the cloud-assigned identifier for the bucket.
	// +optional
	BucketID string `json:"bucketId,omitempty"`

	// Endpoint is the bucket's access URL.
	// +optional
	Endpoint string `json:"endpoint,omitempty"`

	// CreatedAt is when the bucket was first created.
	// +optional
	CreatedAt *metav1.Time `json:"createdAt,omitempty"`

	// BytesUsed is the current storage usage.
	// +optional
	BytesUsed *int64 `json:"bytesUsed,omitempty"`
}

// BucketSpec defines the desired state of Bucket.
type BucketSpec struct {
	xpv1.ResourceSpec `json:",inline"`
	ForProvider       BucketParameters `json:"forProvider"`
}

// BucketStatus defines the observed state of Bucket.
type BucketStatus struct {
	xpv1.ConditionedStatus `json:",inline"`
	AtProvider             BucketObservation `json:"atProvider,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:storageversion
// +kubebuilder:subresource:status
// +kubebuilder:resource:categories=crossplane;storage,scope=Cluster
// +kubebuilder:printcolumn:name="READY",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="SYNCED",type="string",JSONPath=".status.conditions[?(@.type=='Synced')].status"
// +kubebuilder:printcolumn:name="EXTERNAL-NAME",type="string",JSONPath=".metadata.annotations.crossplane\\.io/external-name"
// +kubebuilder:printcolumn:name="REGION",type="string",JSONPath=".spec.forProvider.region"
// +kubebuilder:printcolumn:name="AGE",type="date",JSONPath=".metadata.creationTimestamp"

// Bucket is the Schema for the Bucket managed resource.
type Bucket struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   BucketSpec   `json:"spec"`
	Status BucketStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// BucketList contains a list of Bucket.
type BucketList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Bucket `json:"items"`
}

// GetCondition of this Bucket.
func (b *Bucket) GetCondition(ct xpv1.ConditionType) xpv1.Condition {
	return b.Status.GetCondition(ct)
}

// SetConditions of this Bucket.
func (b *Bucket) SetConditions(c ...xpv1.Condition) {
	b.Status.SetConditions(c...)
}

// GetDeletionPolicy of this Bucket.
func (b *Bucket) GetDeletionPolicy() xpv1.DeletionPolicy {
	return b.Spec.DeletionPolicy
}

// SetDeletionPolicy of this Bucket.
func (b *Bucket) SetDeletionPolicy(r xpv1.DeletionPolicy) {
	b.Spec.DeletionPolicy = r
}

// GetManagementPolicies of this Bucket.
func (b *Bucket) GetManagementPolicies() xpv1.ManagementPolicies {
	return b.Spec.ManagementPolicies
}

// SetManagementPolicies of this Bucket.
func (b *Bucket) SetManagementPolicies(r xpv1.ManagementPolicies) {
	b.Spec.ManagementPolicies = r
}

// GetProviderConfigReference of this Bucket.
func (b *Bucket) GetProviderConfigReference() *xpv1.Reference {
	return b.Spec.ProviderConfigReference
}

// SetProviderConfigReference of this Bucket.
func (b *Bucket) SetProviderConfigReference(r *xpv1.Reference) {
	b.Spec.ProviderConfigReference = r
}

// GetWriteConnectionSecretToReference of this Bucket.
func (b *Bucket) GetWriteConnectionSecretToReference() *xpv1.SecretReference {
	return b.Spec.WriteConnectionSecretToReference
}

// SetWriteConnectionSecretToReference of this Bucket.
func (b *Bucket) SetWriteConnectionSecretToReference(r *xpv1.SecretReference) {
	b.Spec.WriteConnectionSecretToReference = r
}

var (
	SchemeGroupVersion = schema.GroupVersion{
		Group:   "storage.acme.example.com",
		Version: "v1alpha1",
	}
	SchemeBuilder = &scheme.Builder{GroupVersion: SchemeGroupVersion}
)

func init() {
	SchemeBuilder.Register(&Bucket{}, &BucketList{})
}
```

## ProviderConfig Type

```go
// apis/v1beta1/providerconfig_types.go
package v1beta1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	xpv1 "github.com/crossplane/crossplane-runtime/apis/common/v1"
)

// ProviderConfigSpec defines the desired state of ProviderConfig.
type ProviderConfigSpec struct {
	// Credentials for authenticating to the ACME Storage API.
	Credentials ProviderCredentials `json:"credentials"`

	// APIEndpoint overrides the default ACME Storage API endpoint.
	// Useful for testing against a staging environment.
	// +optional
	APIEndpoint string `json:"apiEndpoint,omitempty"`
}

// ProviderCredentials describes how to authenticate.
type ProviderCredentials struct {
	// Source specifies where credentials are stored.
	// +kubebuilder:validation:Enum=Secret;InjectedIdentity
	Source xpv1.CredentialsSource `json:"source"`

	// SecretRef is a reference to a Kubernetes secret containing credentials.
	// +optional
	SecretRef *xpv1.SecretKeySelector `json:"secretRef,omitempty"`
}

// ProviderConfigStatus reflects the observed state of the ProviderConfig.
type ProviderConfigStatus struct {
	xpv1.ConditionedStatus `json:",inline"`
	// Users contains the number of managed resources using this ProviderConfig.
	// +optional
	Users int64 `json:"users,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:storageversion
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,categories=crossplane
// +kubebuilder:printcolumn:name="AGE",type="date",JSONPath=".metadata.creationTimestamp"
// +kubebuilder:printcolumn:name="SECRET-NAME",type="string",JSONPath=".spec.credentials.secretRef.name"

// ProviderConfig is the Schema for the ProviderConfig resource.
type ProviderConfig struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ProviderConfigSpec   `json:"spec"`
	Status ProviderConfigStatus `json:"status,omitempty"`
}
```

## The External Client: Wrapping the Cloud API

The external client is the bridge between the managed resource controller and the cloud API. It implements the `managed.ExternalClient` interface.

```go
// internal/controller/bucket/external.go
package bucket

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/crossplane/crossplane-runtime/pkg/meta"
	"github.com/crossplane/crossplane-runtime/pkg/reconciler/managed"
	"github.com/crossplane/crossplane-runtime/pkg/resource"

	"github.com/example/provider-acmestorage/apis/v1alpha1"
	acmeclient "github.com/example/provider-acmestorage/internal/acme"
)

// external implements managed.ExternalClient for ACME Storage buckets.
type external struct {
	client *acmeclient.Client
	region string
}

// Observe checks whether the bucket exists and whether its spec is in sync.
// It must not make any changes to the external resource.
func (e *external) Observe(ctx context.Context, mg resource.Managed) (managed.ExternalObservation, error) {
	cr, ok := mg.(*v1alpha1.Bucket)
	if !ok {
		return managed.ExternalObservation{}, fmt.Errorf("managed resource is not a Bucket")
	}

	externalName := meta.GetExternalName(cr)
	if externalName == "" {
		// The resource has not been created yet.
		return managed.ExternalObservation{ResourceExists: false}, nil
	}

	bucket, err := e.client.GetBucket(ctx, externalName)
	if acmeclient.IsNotFound(err) {
		return managed.ExternalObservation{ResourceExists: false}, nil
	}
	if err != nil {
		return managed.ExternalObservation{}, fmt.Errorf("getting bucket %s: %w", externalName, err)
	}

	// Populate observed state.
	t := metav1.NewTime(bucket.CreatedAt)
	cr.Status.AtProvider = v1alpha1.BucketObservation{
		BucketID:  bucket.ID,
		Endpoint:  bucket.Endpoint,
		CreatedAt: &t,
		BytesUsed: &bucket.BytesUsed,
	}
	cr.SetConditions(xpv1.Available())

	// Check whether the desired state matches actual state.
	upToDate := isUpToDate(cr.Spec.ForProvider, bucket)

	return managed.ExternalObservation{
		ResourceExists:   true,
		ResourceUpToDate: upToDate,
		// ConnectionDetails will be written to the connection secret.
		ConnectionDetails: managed.ConnectionDetails{
			"endpoint":   []byte(bucket.Endpoint),
			"bucketName": []byte(externalName),
		},
	}, nil
}

// Create provisions the bucket in the external system.
func (e *external) Create(ctx context.Context, mg resource.Managed) (managed.ExternalCreation, error) {
	cr, ok := mg.(*v1alpha1.Bucket)
	if !ok {
		return managed.ExternalCreation{}, fmt.Errorf("managed resource is not a Bucket")
	}

	cr.SetConditions(xpv1.Creating())

	// Use the managed resource's name as the external name unless overridden.
	externalName := meta.GetExternalName(cr)
	if externalName == cr.Name {
		externalName = cr.Name
	}

	req := acmeclient.CreateBucketRequest{
		Name:              externalName,
		Region:            cr.Spec.ForProvider.Region,
		StorageClass:      cr.Spec.ForProvider.StorageClass,
		PublicAccessBlock: cr.Spec.ForProvider.PublicAccessBlock,
		Versioning:        cr.Spec.ForProvider.Versioning,
		Tags:              cr.Spec.ForProvider.Tags,
	}

	bucket, err := e.client.CreateBucket(ctx, req)
	if err != nil {
		return managed.ExternalCreation{}, fmt.Errorf("creating bucket: %w", err)
	}

	// Record the external name (may differ from requested name if the API generates it).
	meta.SetExternalName(cr, bucket.Name)

	return managed.ExternalCreation{
		ExternalNameAssigned: true,
		ConnectionDetails: managed.ConnectionDetails{
			"endpoint":   []byte(bucket.Endpoint),
			"bucketName": []byte(bucket.Name),
		},
	}, nil
}

// Update reconciles observed drift in the bucket's configuration.
func (e *external) Update(ctx context.Context, mg resource.Managed) (managed.ExternalUpdate, error) {
	cr, ok := mg.(*v1alpha1.Bucket)
	if !ok {
		return managed.ExternalUpdate{}, fmt.Errorf("managed resource is not a Bucket")
	}

	externalName := meta.GetExternalName(cr)

	req := acmeclient.UpdateBucketRequest{
		StorageClass:      cr.Spec.ForProvider.StorageClass,
		PublicAccessBlock: cr.Spec.ForProvider.PublicAccessBlock,
		Versioning:        cr.Spec.ForProvider.Versioning,
		Tags:              cr.Spec.ForProvider.Tags,
		LifecycleRules:    convertLifecycleRules(cr.Spec.ForProvider.LifecycleRules),
	}

	if err := e.client.UpdateBucket(ctx, externalName, req); err != nil {
		return managed.ExternalUpdate{}, fmt.Errorf("updating bucket %s: %w", externalName, err)
	}

	return managed.ExternalUpdate{}, nil
}

// Delete removes the bucket from the external system.
// Crossplane calls this only when the managed resource's finalizer is being removed.
func (e *external) Delete(ctx context.Context, mg resource.Managed) error {
	cr, ok := mg.(*v1alpha1.Bucket)
	if !ok {
		return fmt.Errorf("managed resource is not a Bucket")
	}

	cr.SetConditions(xpv1.Deleting())
	externalName := meta.GetExternalName(cr)

	if err := e.client.DeleteBucket(ctx, externalName); err != nil {
		if acmeclient.IsNotFound(err) {
			return nil // already gone
		}
		return fmt.Errorf("deleting bucket %s: %w", externalName, err)
	}

	return nil
}

// isUpToDate compares desired parameters with the current cloud state.
func isUpToDate(params v1alpha1.BucketParameters, actual *acmeclient.Bucket) bool {
	if params.StorageClass != "" && params.StorageClass != actual.StorageClass {
		return false
	}
	if params.Versioning != actual.Versioning {
		return false
	}
	if params.PublicAccessBlock != actual.PublicAccessBlock {
		return false
	}
	for k, v := range params.Tags {
		if actual.Tags[k] != v {
			return false
		}
	}
	return true
}
```

## The Reconciler and Controller Setup

```go
// internal/controller/bucket/reconciler.go
package bucket

import (
	"context"
	"fmt"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	xpv1 "github.com/crossplane/crossplane-runtime/apis/common/v1"
	"github.com/crossplane/crossplane-runtime/pkg/connection"
	"github.com/crossplane/crossplane-runtime/pkg/controller"
	"github.com/crossplane/crossplane-runtime/pkg/event"
	"github.com/crossplane/crossplane-runtime/pkg/ratelimiter"
	"github.com/crossplane/crossplane-runtime/pkg/reconciler/managed"
	"github.com/crossplane/crossplane-runtime/pkg/resource"

	"github.com/example/provider-acmestorage/apis/v1alpha1"
	apisv1beta1 "github.com/example/provider-acmestorage/apis/v1beta1"
	acmeclient "github.com/example/provider-acmestorage/internal/acme"
)

// Setup adds a controller that reconciles Bucket managed resources.
func Setup(mgr ctrl.Manager, o controller.Options) error {
	name := managed.ControllerName(v1alpha1.BucketGroupKind)
	cps := []managed.ConnectionPublisher{managed.NewAPISecretPublisher(mgr.GetClient(), mgr.GetScheme())}

	r := managed.NewReconciler(mgr,
		resource.ManagedKind(v1alpha1.BucketGroupVersionKind),
		managed.WithExternalConnecter(&connector{
			kube:  mgr.GetClient(),
			usage: resource.NewProviderConfigUsageTracker(mgr.GetClient(), &apisv1beta1.ProviderConfigUsage{}),
		}),
		managed.WithLogger(o.Logger.WithValues("controller", name)),
		managed.WithRecorder(event.NewAPIRecorder(mgr.GetEventRecorderFor(name))),
		managed.WithConnectionPublishers(cps...),
		managed.WithPollInterval(o.PollInterval),
	)

	return ctrl.NewControllerManagedBy(mgr).
		Named(name).
		WithOptions(o.ForControllerRuntime()).
		WithEventFilter(resource.DesiredStateChanged()).
		For(&v1alpha1.Bucket{}).
		Complete(ratelimiter.NewReconciler(name, r, o.GlobalRateLimiter))
}

// connector creates an ExternalClient for each reconcile cycle.
type connector struct {
	kube  client.Client
	usage resource.Tracker
}

func (c *connector) Connect(ctx context.Context, mg resource.Managed) (managed.ExternalClient, error) {
	cr, ok := mg.(*v1alpha1.Bucket)
	if !ok {
		return nil, fmt.Errorf("managed resource is not a Bucket")
	}

	// Track that this managed resource is using the ProviderConfig.
	if err := c.usage.Track(ctx, mg); err != nil {
		return nil, fmt.Errorf("tracking ProviderConfig usage: %w", err)
	}

	// Fetch the ProviderConfig.
	pc := &apisv1beta1.ProviderConfig{}
	if err := c.kube.Get(ctx, types.NamespacedName{Name: cr.GetProviderConfigReference().Name}, pc); err != nil {
		return nil, fmt.Errorf("getting ProviderConfig: %w", err)
	}

	// Extract credentials from the referenced secret.
	cd := pc.Spec.Credentials
	data, err := resource.CommonCredentialExtractor(ctx, cd.Source, c.kube, cd.SecretRef)
	if err != nil {
		return nil, fmt.Errorf("extracting credentials: %w", err)
	}

	// Parse credentials (format is provider-specific).
	creds, err := acmeclient.ParseCredentials(data)
	if err != nil {
		return nil, fmt.Errorf("parsing credentials: %w", err)
	}

	// Build the API client.
	apiEndpoint := acmeclient.DefaultEndpoint
	if pc.Spec.APIEndpoint != "" {
		apiEndpoint = pc.Spec.APIEndpoint
	}

	client, err := acmeclient.NewClient(creds, apiEndpoint)
	if err != nil {
		return nil, fmt.Errorf("creating ACME client: %w", err)
	}

	return &external{client: client}, nil
}
```

## Main Entry Point

```go
// cmd/provider/main.go
package main

import (
	"os"
	"path/filepath"
	"time"

	"go.uber.org/zap/zapcore"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	xpv1 "github.com/crossplane/crossplane-runtime/apis/common/v1"
	"github.com/crossplane/crossplane-runtime/pkg/controller"
	"github.com/crossplane/crossplane-runtime/pkg/feature"
	"github.com/crossplane/crossplane-runtime/pkg/logging"
	"github.com/crossplane/crossplane-runtime/pkg/ratelimiter"

	"github.com/example/provider-acmestorage/apis/v1alpha1"
	apisv1beta1 "github.com/example/provider-acmestorage/apis/v1beta1"
	"github.com/example/provider-acmestorage/internal/controller/bucket"
	"github.com/example/provider-acmestorage/internal/controller/providerconfig"
)

func main() {
	var (
		debug             bool
		syncInterval      time.Duration
		pollInterval      time.Duration
		maxReconcileRate  int
		namespace         string
		enableManagementPolicies bool
	)

	// Parse flags (omitting flag setup for brevity)
	// ...

	zl := zap.New(zap.UseDevMode(debug),
		zap.WriteTo(os.Stderr),
		zap.Level(zapcore.InfoLevel))
	ctrl.SetLogger(zl)
	log := logging.NewLogrLogger(zl.WithName("provider-acmestorage"))

	cfg, err := ctrl.GetConfig()
	if err != nil {
		log.Info("Cannot get API server rest config", "error", err)
		os.Exit(1)
	}

	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		LeaderElection:   true,
		LeaderElectionID: "crossplane-provider-acmestorage-leader",
		SyncPeriod:       &syncInterval,
	})
	if err != nil {
		log.Info("Cannot create controller manager", "error", err)
		os.Exit(1)
	}

	// Register schemes.
	if err := v1alpha1.SchemeBuilder.AddToScheme(mgr.GetScheme()); err != nil {
		log.Info("Cannot add v1alpha1 to scheme", "error", err)
		os.Exit(1)
	}
	if err := apisv1beta1.SchemeBuilder.AddToScheme(mgr.GetScheme()); err != nil {
		log.Info("Cannot add v1beta1 to scheme", "error", err)
		os.Exit(1)
	}
	if err := xpv1.SchemeBuilder.AddToScheme(mgr.GetScheme()); err != nil {
		log.Info("Cannot add crossplane v1 to scheme", "error", err)
		os.Exit(1)
	}

	o := controller.Options{
		Logger:                  log,
		MaxConcurrentReconciles: maxReconcileRate,
		PollInterval:            pollInterval,
		GlobalRateLimiter:       ratelimiter.NewGlobal(maxReconcileRate),
		Features:                &feature.Flags{},
	}

	if enableManagementPolicies {
		o.Features.Enable(feature.EnableBetaManagementPolicies)
		log.Info("Beta feature enabled", "feature", feature.EnableBetaManagementPolicies)
	}

	if err := providerconfig.Setup(mgr, o); err != nil {
		log.Info("Cannot setup ProviderConfig controller", "error", err)
		os.Exit(1)
	}
	if err := bucket.Setup(mgr, o); err != nil {
		log.Info("Cannot setup Bucket controller", "error", err)
		os.Exit(1)
	}

	log.Info("Starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		log.Info("Cannot start controller manager", "error", err)
		os.Exit(1)
	}
}
```

## Packaging the Provider

Crossplane providers are distributed as OCI images. The image contains:
- The provider binary
- CRD manifests in a specific directory structure

```yaml
# package/crossplane.yaml
apiVersion: meta.pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-acmestorage
  annotations:
    meta.crossplane.io/maintainer: "platform-team@example.com"
    meta.crossplane.io/source: "github.com/example/provider-acmestorage"
    meta.crossplane.io/license: "Apache-2.0"
    meta.crossplane.io/description: "Crossplane provider for ACME Storage."
spec:
  controller:
    image: registry.example.com/provider-acmestorage:v0.1.0
  crossplane:
    version: ">=v1.14.0-0"
```

```dockerfile
# Dockerfile
FROM --platform=${BUILDPLATFORM} golang:1.23 AS builder
ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG TARGETOS
ARG TARGETARCH
WORKDIR /workspace
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -o /provider ./cmd/provider

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /provider /provider
COPY package/crds/ /crds/
USER 65532:65532
ENTRYPOINT ["/provider"]
```

## Usage Example

With the provider installed, users can create buckets declaratively:

```yaml
# provider-credentials.yaml
apiVersion: v1
kind: Secret
metadata:
  name: acme-credentials
  namespace: crossplane-system
type: Opaque
stringData:
  credentials: |
    {
      "apiKey": "<acme-api-key>",
      "apiSecret": "<acme-api-secret>"
    }
---
# provider-config.yaml
apiVersion: storage.acme.example.com/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: acme-credentials
      key: credentials
---
# bucket.yaml
apiVersion: storage.acme.example.com/v1alpha1
kind: Bucket
metadata:
  name: my-app-assets
spec:
  forProvider:
    region: us-east
    storageClass: standard
    publicAccessBlock: true
    versioning: true
    tags:
      environment: production
      team: platform
    lifecycleRules:
      - id: expire-old-versions
        expirationDays: 90
  providerConfigRef:
    name: default
  writeConnectionSecretToRef:
    name: my-app-assets-connection
    namespace: default
```

```bash
kubectl apply -f bucket.yaml
kubectl wait --for=condition=Ready bucket/my-app-assets --timeout=60s
kubectl get bucket my-app-assets -o yaml | yq '.status'
```

## Testing with envtest

```go
// internal/controller/bucket/reconciler_test.go
package bucket_test

import (
	"context"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	v1alpha1 "github.com/example/provider-acmestorage/apis/v1alpha1"
	"github.com/example/provider-acmestorage/internal/controller/bucket"
)

func TestBucketReconciler(t *testing.T) {
	testEnv := &envtest.Environment{
		CRDDirectoryPaths: []string{"../../../package/crds"},
	}

	cfg, err := testEnv.Start()
	if err != nil {
		t.Fatalf("starting test env: %v", err)
	}
	defer testEnv.Stop()

	// ... set up manager, register controllers, create test objects ...
}
```

## Summary

Building a Crossplane provider in Go requires understanding three layers:

1. **CRD types** — precise Go structs with kubebuilder markers that define the user-facing API
2. **External client** — the four lifecycle methods (Observe, Create, Update, Delete) that translate between Kubernetes desired state and cloud API calls
3. **Package manifest** — the OCI image structure that Crossplane's package manager understands

The crossplane-runtime library handles the heavy lifting: finalizer management, condition updates, connection secret publishing, ProviderConfig credential extraction, and rate limiting. Your code only needs to implement the actual cloud API calls and the drift detection logic.

The resulting provider integrates seamlessly with Compositions, enabling platform teams to expose curated, policy-enforced infrastructure abstractions to application teams without requiring them to understand the underlying cloud APIs.
