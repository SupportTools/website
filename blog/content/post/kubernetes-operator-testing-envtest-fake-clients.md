---
title: "Kubernetes Operator Testing: envtest, Fake Clients, and Controller Integration Testing"
date: 2030-02-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "Testing", "envtest", "controller-runtime", "Go"]
categories: ["Kubernetes", "Go"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Test Kubernetes operators with controller-runtime's envtest, fake clients for unit tests, reconciler integration tests, webhook validation testing, and CRD validation coverage strategies."
more_link: "yes"
url: "/kubernetes-operator-testing-envtest-fake-clients/"
---

Kubernetes operators are some of the most difficult Go programs to test well. They react to state changes in an external system (the Kubernetes API), perform operations with side effects, and must handle partial failures gracefully. Testing them thoroughly requires a strategy that spans pure unit tests with fake clients, integration tests against a real API server, and end-to-end validation of the complete reconciliation loop.

This guide covers the full testing stack for controller-runtime operators: fast unit tests with fake clients, integration tests using envtest's embedded API server, testing admission webhooks, and achieving meaningful coverage for CRD validation logic.

<!--more-->

## The Operator Testing Pyramid

For operators, the testing pyramid looks different from typical applications:

```
        /\
       /  \
      /E2E \          1-5 tests: full cluster, real workloads
     /------\
    /        \
   / Integration\      50-200 tests: envtest, real API server
  /  (envtest)  \
 /--------------\
/                \
/  Unit (fake    \    200-1000 tests: fake clients, no network
/   clients)      \
/------------------\
```

Unit tests with fake clients run in milliseconds and cover logic in isolation. Integration tests with envtest (a real kube-apiserver and etcd, no kubelet or scheduler) verify the complete reconciliation loop. E2E tests against a real cluster verify the final behavior but are too slow and expensive to run on every commit.

## Setting Up the Test Environment

### Module Dependencies

```bash
go get sigs.k8s.io/controller-runtime@v0.17.2
go get sigs.k8s.io/controller-runtime/pkg/envtest
go get k8s.io/client-go@v0.29.2
go get k8s.io/api@v0.29.2
go get k8s.io/apimachinery@v0.29.2

# Install envtest binaries (kube-apiserver, etcd, kubectl)
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
setup-envtest use 1.29.x --bin-dir ./bin/k8s
export KUBEBUILDER_ASSETS=$(setup-envtest use 1.29.x --bin-dir ./bin/k8s -p path)
```

### Example CRD: DatabaseCluster

All test examples use this CRD:

```go
// api/v1alpha1/databasecluster_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// DatabaseClusterSpec defines the desired state
type DatabaseClusterSpec struct {
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=10
    Replicas int32 `json:"replicas"`

    // +kubebuilder:validation:Enum=postgres;mysql;mariadb
    Engine string `json:"engine"`

    // +kubebuilder:validation:Pattern=`^[0-9]+\.[0-9]+$`
    Version string `json:"version"`

    StorageGB int32 `json:"storageGB"`

    // +optional
    BackupSchedule string `json:"backupSchedule,omitempty"`
}

type DatabaseClusterStatus struct {
    Phase      string             `json:"phase,omitempty"`
    Replicas   int32              `json:"replicas,omitempty"`
    ReadyNodes int32              `json:"readyNodes,omitempty"`
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Engine",type=string,JSONPath=".spec.engine"
// +kubebuilder:printcolumn:name="Replicas",type=integer,JSONPath=".spec.replicas"
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=".status.phase"
type DatabaseCluster struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   DatabaseClusterSpec   `json:"spec,omitempty"`
    Status DatabaseClusterStatus `json:"status,omitempty"`
}
```

## Unit Tests with Fake Clients

The fake client from `sigs.k8s.io/controller-runtime/pkg/client/fake` provides an in-memory implementation of the Kubernetes API that runs without any network or process dependencies.

### Basic Fake Client Setup

```go
// internal/controller/databasecluster_controller_test.go
package controller_test

import (
    "context"
    "testing"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"

    dbv1alpha1 "github.com/myorg/db-operator/api/v1alpha1"
    "github.com/myorg/db-operator/internal/controller"
)

// buildScheme creates a scheme with all required types registered.
func buildScheme(t *testing.T) *runtime.Scheme {
    t.Helper()
    scheme := runtime.NewScheme()

    if err := clientgoscheme.AddToScheme(scheme); err != nil {
        t.Fatalf("add clientgo scheme: %v", err)
    }
    if err := dbv1alpha1.AddToScheme(scheme); err != nil {
        t.Fatalf("add db scheme: %v", err)
    }
    return scheme
}

// newFakeClient creates a fake client with pre-populated objects.
func newFakeClient(t *testing.T, objs ...client.Object) client.Client {
    t.Helper()
    return fake.NewClientBuilder().
        WithScheme(buildScheme(t)).
        WithObjects(objs...).
        WithStatusSubresource(&dbv1alpha1.DatabaseCluster{}).
        Build()
}

func TestReconciler_CreateStatefulSet(t *testing.T) {
    cluster := &dbv1alpha1.DatabaseCluster{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-postgres",
            Namespace: "default",
        },
        Spec: dbv1alpha1.DatabaseClusterSpec{
            Replicas:  3,
            Engine:    "postgres",
            Version:   "16.2",
            StorageGB: 100,
        },
    }

    c := newFakeClient(t, cluster)
    r := &controller.DatabaseClusterReconciler{
        Client: c,
        Scheme: buildScheme(t),
    }

    req := ctrl.Request{
        NamespacedName: types.NamespacedName{
            Name:      "test-postgres",
            Namespace: "default",
        },
    }

    result, err := r.Reconcile(context.Background(), req)
    if err != nil {
        t.Fatalf("Reconcile failed: %v", err)
    }
    if result.Requeue {
        t.Error("expected no requeue, got requeue=true")
    }

    // Verify StatefulSet was created
    sts := &appsv1.StatefulSet{}
    if err := c.Get(context.Background(), types.NamespacedName{
        Name:      "test-postgres",
        Namespace: "default",
    }, sts); err != nil {
        t.Fatalf("StatefulSet not found: %v", err)
    }

    if *sts.Spec.Replicas != 3 {
        t.Errorf("expected 3 replicas, got %d", *sts.Spec.Replicas)
    }

    // Verify Service was created
    svc := &corev1.Service{}
    if err := c.Get(context.Background(), types.NamespacedName{
        Name:      "test-postgres",
        Namespace: "default",
    }, svc); err != nil {
        t.Fatalf("Service not found: %v", err)
    }

    // Verify owner references are set for garbage collection
    if len(sts.OwnerReferences) == 0 {
        t.Error("StatefulSet has no owner references")
    }
    if sts.OwnerReferences[0].Name != "test-postgres" {
        t.Errorf("expected owner %q, got %q", "test-postgres", sts.OwnerReferences[0].Name)
    }
}

func TestReconciler_ScalesExistingStatefulSet(t *testing.T) {
    replicas := int32(3)
    cluster := &dbv1alpha1.DatabaseCluster{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "scale-test",
            Namespace: "default",
        },
        Spec: dbv1alpha1.DatabaseClusterSpec{
            Replicas: 5, // Scale to 5
            Engine:   "postgres",
            Version:  "16.2",
        },
    }

    // Pre-existing StatefulSet with 3 replicas
    sts := &appsv1.StatefulSet{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "scale-test",
            Namespace: "default",
            OwnerReferences: []metav1.OwnerReference{
                {
                    APIVersion: "db.example.com/v1alpha1",
                    Kind:       "DatabaseCluster",
                    Name:       "scale-test",
                    Controller: boolPtr(true),
                },
            },
        },
        Spec: appsv1.StatefulSetSpec{
            Replicas: &replicas,
        },
    }

    c := newFakeClient(t, cluster, sts)
    r := &controller.DatabaseClusterReconciler{
        Client: c,
        Scheme: buildScheme(t),
    }

    _, err := r.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "scale-test", Namespace: "default"},
    })
    if err != nil {
        t.Fatalf("Reconcile failed: %v", err)
    }

    // Check StatefulSet was updated
    updatedSTS := &appsv1.StatefulSet{}
    if err := c.Get(context.Background(), types.NamespacedName{
        Name: "scale-test", Namespace: "default",
    }, updatedSTS); err != nil {
        t.Fatalf("Get StatefulSet: %v", err)
    }

    if *updatedSTS.Spec.Replicas != 5 {
        t.Errorf("expected 5 replicas after scale, got %d", *updatedSTS.Spec.Replicas)
    }
}

func TestReconciler_HandlesNotFound(t *testing.T) {
    c := newFakeClient(t) // empty client, no objects
    r := &controller.DatabaseClusterReconciler{
        Client: c,
        Scheme: buildScheme(t),
    }

    result, err := r.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "nonexistent", Namespace: "default"},
    })

    // Not-found should be treated as successful (object was deleted)
    if err != nil {
        t.Errorf("expected nil error for not-found, got: %v", err)
    }
    if result.Requeue {
        t.Error("expected no requeue for not-found object")
    }
}

func TestReconciler_StatusUpdate(t *testing.T) {
    cluster := &dbv1alpha1.DatabaseCluster{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "status-test",
            Namespace: "default",
        },
        Spec: dbv1alpha1.DatabaseClusterSpec{
            Replicas: 1,
            Engine:   "postgres",
            Version:  "16.2",
        },
    }

    c := newFakeClient(t, cluster)
    r := &controller.DatabaseClusterReconciler{
        Client: c,
        Scheme: buildScheme(t),
    }

    _, err := r.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "status-test", Namespace: "default"},
    })
    if err != nil {
        t.Fatalf("Reconcile: %v", err)
    }

    // Verify status was updated
    updated := &dbv1alpha1.DatabaseCluster{}
    if err := c.Get(context.Background(), types.NamespacedName{
        Name: "status-test", Namespace: "default",
    }, updated); err != nil {
        t.Fatalf("Get updated cluster: %v", err)
    }

    if updated.Status.Phase == "" {
        t.Error("expected Status.Phase to be set after reconciliation")
    }
}

func boolPtr(b bool) *bool { return &b }
```

### Testing Reconciler Error Conditions

```go
func TestReconciler_PropagatesAPIErrors(t *testing.T) {
    tests := []struct {
        name        string
        setupClient func() client.Client
        wantErr     bool
        wantRequeue bool
    }{
        {
            name: "returns error when create fails",
            setupClient: func() client.Client {
                // Use a client interceptor to inject errors
                return fake.NewClientBuilder().
                    WithScheme(buildScheme(t)).
                    WithObjects(&dbv1alpha1.DatabaseCluster{
                        ObjectMeta: metav1.ObjectMeta{
                            Name: "test", Namespace: "default",
                        },
                        Spec: dbv1alpha1.DatabaseClusterSpec{
                            Replicas: 1, Engine: "postgres", Version: "16.2",
                        },
                    }).
                    WithInterceptorFuncs(interceptor.Funcs{
                        Create: func(ctx context.Context, client client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
                            if obj.GetObjectKind().GroupVersionKind().Kind == "StatefulSet" {
                                return fmt.Errorf("simulated API server error")
                            }
                            return client.Create(ctx, obj, opts...)
                        },
                    }).
                    Build()
            },
            wantErr: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()

            r := &controller.DatabaseClusterReconciler{
                Client: tt.setupClient(),
                Scheme: buildScheme(t),
            }

            _, err := r.Reconcile(context.Background(), ctrl.Request{
                NamespacedName: types.NamespacedName{Name: "test", Namespace: "default"},
            })

            if (err != nil) != tt.wantErr {
                t.Errorf("Reconcile() error = %v, wantErr = %v", err, tt.wantErr)
            }
        })
    }
}
```

## Integration Tests with envtest

envtest provides a real kube-apiserver and etcd binary, giving you real Kubernetes API semantics without a full cluster.

### TestMain with envtest

```go
// internal/controller/suite_test.go
package controller_test

import (
    "context"
    "os"
    "path/filepath"
    "runtime"
    "testing"
    "time"

    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    "sigs.k8s.io/controller-runtime/pkg/envtest/scheme"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

    dbv1alpha1 "github.com/myorg/db-operator/api/v1alpha1"
    "github.com/myorg/db-operator/internal/controller"
    // ...
)

var (
    testEnv   *envtest.Environment
    k8sClient client.Client
    ctx       context.Context
    cancel    context.CancelFunc
)

func TestMain(m *testing.M) {
    ctrl.SetLogger(zap.New(zap.UseDevMode(true)))

    ctx, cancel = context.WithCancel(context.Background())
    defer cancel()

    // Start the envtest API server
    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "..", "config", "crd", "bases"),
        },
        ErrorIfCRDPathMissing: true,
        BinaryAssetsDirectory: envAssetsDir(),
    }

    cfg, err := testEnv.Start()
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to start envtest: %v\n", err)
        os.Exit(1)
    }
    defer func() {
        if err := testEnv.Stop(); err != nil {
            fmt.Fprintf(os.Stderr, "Failed to stop envtest: %v\n", err)
        }
    }()

    // Register types
    testScheme := buildScheme(&testing.T{})

    k8sClient, err = client.New(cfg, client.Options{Scheme: testScheme})
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to create client: %v\n", err)
        os.Exit(1)
    }

    // Start the controller manager
    mgr, err := ctrl.NewManager(cfg, ctrl.Options{
        Scheme: testScheme,
        Metrics: metricsserver.Options{
            BindAddress: "0", // Disable metrics in tests
        },
    })
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to create manager: %v\n", err)
        os.Exit(1)
    }

    // Register our reconciler
    if err := (&controller.DatabaseClusterReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr); err != nil {
        fmt.Fprintf(os.Stderr, "Failed to setup controller: %v\n", err)
        os.Exit(1)
    }

    // Start manager in background
    go func() {
        if err := mgr.Start(ctx); err != nil {
            fmt.Fprintf(os.Stderr, "Manager stopped: %v\n", err)
        }
    }()

    // Wait for cache to sync
    if !mgr.GetCache().WaitForCacheSync(ctx) {
        fmt.Fprintf(os.Stderr, "Cache failed to sync\n")
        os.Exit(1)
    }

    code := m.Run()
    os.Exit(code)
}

func envAssetsDir() string {
    // Use KUBEBUILDER_ASSETS env var if set (from setup-envtest)
    if dir := os.Getenv("KUBEBUILDER_ASSETS"); dir != "" {
        return dir
    }
    // Fall back to local binary path
    _, filename, _, _ := runtime.Caller(0)
    return filepath.Join(filepath.Dir(filename), "..", "..", "bin", "k8s")
}
```

### envtest Integration Test Cases

```go
// internal/controller/databasecluster_integration_test.go
package controller_test

import (
    "context"
    "testing"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client"

    dbv1alpha1 "github.com/myorg/db-operator/api/v1alpha1"
)

// Eventually is a test helper that retries until condition is true or timeout
func Eventually(t *testing.T, timeout time.Duration, interval time.Duration, condition func() bool) {
    t.Helper()
    deadline := time.Now().Add(timeout)
    for time.Now().Before(deadline) {
        if condition() {
            return
        }
        time.Sleep(interval)
    }
    t.Fatalf("condition not met within %s", timeout)
}

func TestIntegration_CreateDatabaseCluster(t *testing.T) {
    ctx := context.Background()

    cluster := &dbv1alpha1.DatabaseCluster{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "integration-test-1",
            Namespace: "default",
        },
        Spec: dbv1alpha1.DatabaseClusterSpec{
            Replicas:  3,
            Engine:    "postgres",
            Version:   "16.2",
            StorageGB: 50,
        },
    }

    if err := k8sClient.Create(ctx, cluster); err != nil {
        t.Fatalf("Create DatabaseCluster: %v", err)
    }

    t.Cleanup(func() {
        k8sClient.Delete(ctx, cluster)
    })

    // Wait for StatefulSet to be created by the controller
    Eventually(t, 30*time.Second, 100*time.Millisecond, func() bool {
        sts := &appsv1.StatefulSet{}
        err := k8sClient.Get(ctx, types.NamespacedName{
            Name: "integration-test-1", Namespace: "default",
        }, sts)
        return err == nil
    })

    // Verify StatefulSet properties
    sts := &appsv1.StatefulSet{}
    if err := k8sClient.Get(ctx, types.NamespacedName{
        Name: "integration-test-1", Namespace: "default",
    }, sts); err != nil {
        t.Fatalf("Get StatefulSet: %v", err)
    }

    if *sts.Spec.Replicas != 3 {
        t.Errorf("expected 3 replicas, got %d", *sts.Spec.Replicas)
    }

    // Wait for status to be updated
    Eventually(t, 15*time.Second, 100*time.Millisecond, func() bool {
        updated := &dbv1alpha1.DatabaseCluster{}
        if err := k8sClient.Get(ctx, types.NamespacedName{
            Name: "integration-test-1", Namespace: "default",
        }, updated); err != nil {
            return false
        }
        return updated.Status.Phase != ""
    })
}

func TestIntegration_DeletePropagates(t *testing.T) {
    ctx := context.Background()

    cluster := &dbv1alpha1.DatabaseCluster{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "delete-test",
            Namespace: "default",
        },
        Spec: dbv1alpha1.DatabaseClusterSpec{
            Replicas: 1,
            Engine:   "postgres",
            Version:  "16.2",
        },
    }

    if err := k8sClient.Create(ctx, cluster); err != nil {
        t.Fatalf("Create: %v", err)
    }

    // Wait for StatefulSet
    Eventually(t, 30*time.Second, 100*time.Millisecond, func() bool {
        sts := &appsv1.StatefulSet{}
        return k8sClient.Get(ctx, types.NamespacedName{
            Name: "delete-test", Namespace: "default",
        }, sts) == nil
    })

    // Delete the cluster
    if err := k8sClient.Delete(ctx, cluster); err != nil {
        t.Fatalf("Delete: %v", err)
    }

    // Verify StatefulSet is garbage collected (via owner reference)
    Eventually(t, 30*time.Second, 100*time.Millisecond, func() bool {
        sts := &appsv1.StatefulSet{}
        err := k8sClient.Get(ctx, types.NamespacedName{
            Name: "delete-test", Namespace: "default",
        }, sts)
        return apierrors.IsNotFound(err)
    })
}
```

## Webhook Testing

Admission webhooks need both unit tests (for validation/mutation logic) and integration tests (for the webhook server itself).

### Validation Webhook Unit Tests

```go
// internal/webhook/databasecluster_webhook_test.go
package webhook_test

import (
    "context"
    "testing"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

    dbv1alpha1 "github.com/myorg/db-operator/api/v1alpha1"
    "github.com/myorg/db-operator/internal/webhook"
)

func TestDatabaseClusterValidator_ValidateCreate(t *testing.T) {
    v := &webhook.DatabaseClusterValidator{}
    ctx := context.Background()

    tests := []struct {
        name    string
        cluster *dbv1alpha1.DatabaseCluster
        wantErr bool
        errMsg  string
    }{
        {
            name: "valid cluster",
            cluster: &dbv1alpha1.DatabaseCluster{
                Spec: dbv1alpha1.DatabaseClusterSpec{
                    Replicas: 3,
                    Engine:   "postgres",
                    Version:  "16.2",
                },
            },
            wantErr: false,
        },
        {
            name: "invalid engine",
            cluster: &dbv1alpha1.DatabaseCluster{
                Spec: dbv1alpha1.DatabaseClusterSpec{
                    Replicas: 1,
                    Engine:   "mongodb",  // not in allowed list
                    Version:  "7.0",
                },
            },
            wantErr: true,
            errMsg:  "unsupported engine",
        },
        {
            name: "even replicas not allowed",
            cluster: &dbv1alpha1.DatabaseCluster{
                Spec: dbv1alpha1.DatabaseClusterSpec{
                    Replicas: 2,  // must be odd for quorum
                    Engine:   "postgres",
                    Version:  "16.2",
                },
            },
            wantErr: true,
            errMsg:  "replicas must be odd",
        },
        {
            name: "version format invalid",
            cluster: &dbv1alpha1.DatabaseCluster{
                Spec: dbv1alpha1.DatabaseClusterSpec{
                    Replicas: 1,
                    Engine:   "postgres",
                    Version:  "latest",  // must match version pattern
                },
            },
            wantErr: true,
            errMsg:  "invalid version format",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()

            _, err := v.ValidateCreate(ctx, tt.cluster)

            if tt.wantErr {
                if err == nil {
                    t.Errorf("expected error containing %q, got nil", tt.errMsg)
                    return
                }
                if tt.errMsg != "" && !strings.Contains(err.Error(), tt.errMsg) {
                    t.Errorf("expected error containing %q, got: %v", tt.errMsg, err)
                }
            } else if err != nil {
                t.Errorf("unexpected error: %v", err)
            }
        })
    }
}

func TestDatabaseClusterValidator_ValidateUpdate(t *testing.T) {
    v := &webhook.DatabaseClusterValidator{}
    ctx := context.Background()

    t.Run("cannot change engine", func(t *testing.T) {
        old := &dbv1alpha1.DatabaseCluster{
            Spec: dbv1alpha1.DatabaseClusterSpec{
                Engine:   "postgres",
                Version:  "16.2",
                Replicas: 3,
            },
        }
        new := old.DeepCopy()
        new.Spec.Engine = "mysql"

        _, err := v.ValidateUpdate(ctx, old, new)
        if err == nil {
            t.Error("expected error when changing engine, got nil")
        }
        if !strings.Contains(err.Error(), "engine is immutable") {
            t.Errorf("expected immutable engine error, got: %v", err)
        }
    })

    t.Run("can scale replicas", func(t *testing.T) {
        old := &dbv1alpha1.DatabaseCluster{
            Spec: dbv1alpha1.DatabaseClusterSpec{
                Engine:   "postgres",
                Version:  "16.2",
                Replicas: 3,
            },
        }
        new := old.DeepCopy()
        new.Spec.Replicas = 5

        _, err := v.ValidateUpdate(ctx, old, new)
        if err != nil {
            t.Errorf("expected nil error when scaling, got: %v", err)
        }
    })
}
```

### Webhook Integration Test with envtest

```go
// internal/webhook/suite_test.go
package webhook_test

import (
    "context"
    "crypto/tls"
    "net"
    "path/filepath"
    "testing"
    "time"

    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    "sigs.k8s.io/controller-runtime/pkg/webhook"

    dbv1alpha1 "github.com/myorg/db-operator/api/v1alpha1"
    dbwebhook "github.com/myorg/db-operator/internal/webhook"
)

var (
    webhookK8sClient client.Client
    webhookTestEnv   *envtest.Environment
    webhookCtx       context.Context
    webhookCancel    context.CancelFunc
)

func TestMainWebhook(m *testing.M) {
    webhookCtx, webhookCancel = context.WithCancel(context.Background())
    defer webhookCancel()

    webhookTestEnv = &envtest.Environment{
        CRDDirectoryPaths:     []string{filepath.Join("..", "..", "config", "crd", "bases")},
        WebhookInstallOptions: envtest.WebhookInstallOptions{
            Paths: []string{filepath.Join("..", "..", "config", "webhook")},
        },
        BinaryAssetsDirectory: os.Getenv("KUBEBUILDER_ASSETS"),
    }

    cfg, err := webhookTestEnv.Start()
    if err != nil {
        panic(err)
    }
    defer webhookTestEnv.Stop()

    webhookK8sClient, _ = client.New(cfg, client.Options{Scheme: buildScheme(nil)})

    mgr, _ := ctrl.NewManager(cfg, ctrl.Options{
        Scheme: buildScheme(nil),
        WebhookServer: webhook.NewServer(webhook.Options{
            Host:    webhookTestEnv.WebhookInstallOptions.LocalServingHost,
            Port:    webhookTestEnv.WebhookInstallOptions.LocalServingPort,
            CertDir: webhookTestEnv.WebhookInstallOptions.LocalServingCertDir,
        }),
        Metrics: metricsserver.Options{BindAddress: "0"},
    })

    // Register webhook handlers
    if err := dbwebhook.SetupDatabaseClusterWebhookWithManager(mgr); err != nil {
        panic(err)
    }

    go func() { mgr.Start(webhookCtx) }()

    // Wait for webhook server to be ready
    dialer := &net.Dialer{Timeout: time.Second}
    addrPort := fmt.Sprintf("%s:%d",
        webhookTestEnv.WebhookInstallOptions.LocalServingHost,
        webhookTestEnv.WebhookInstallOptions.LocalServingPort,
    )

    for i := 0; i < 10; i++ {
        conn, err := tls.DialWithDialer(dialer, "tcp", addrPort, &tls.Config{
            InsecureSkipVerify: true,
        })
        if err == nil {
            conn.Close()
            break
        }
        time.Sleep(time.Second)
    }

    os.Exit(m.Run())
}

func TestWebhook_RejectsInvalidCreate(t *testing.T) {
    ctx := context.Background()

    invalid := &dbv1alpha1.DatabaseCluster{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "webhook-test-invalid",
            Namespace: "default",
        },
        Spec: dbv1alpha1.DatabaseClusterSpec{
            Replicas: 2,        // Even replica count - should be rejected
            Engine:   "postgres",
            Version:  "16.2",
        },
    }

    err := webhookK8sClient.Create(ctx, invalid)
    if err == nil {
        webhookK8sClient.Delete(ctx, invalid)
        t.Fatal("expected webhook to reject creation, got nil error")
    }

    if !strings.Contains(err.Error(), "replicas must be odd") {
        t.Errorf("expected 'replicas must be odd' error, got: %v", err)
    }
}
```

## Testing CRD Validation with CEL

Kubernetes 1.25+ supports CEL (Common Expression Language) validation rules in CRDs:

```go
// api/v1alpha1/databasecluster_types.go
// Add CEL validation
// +kubebuilder:validation:XValidation:rule="self.replicas % 2 == 1",message="replicas must be odd for quorum"
// +kubebuilder:validation:XValidation:rule="self.engine != 'postgres' || self.version.startsWith('1') || self.version.startsWith('9')",message="postgres version must be 9.x or 1x.x"
type DatabaseClusterSpec struct { ... }
```

Test CEL validation via envtest (it's enforced at the API server level):

```go
func TestCRD_CELValidation(t *testing.T) {
    ctx := context.Background()

    t.Run("rejects even replicas via CEL", func(t *testing.T) {
        cluster := &dbv1alpha1.DatabaseCluster{
            ObjectMeta: metav1.ObjectMeta{
                Name:      "cel-test-even",
                Namespace: "default",
            },
            Spec: dbv1alpha1.DatabaseClusterSpec{
                Replicas: 4,
                Engine:   "postgres",
                Version:  "16.2",
            },
        }

        err := k8sClient.Create(ctx, cluster)
        if err == nil {
            k8sClient.Delete(ctx, cluster)
            t.Fatal("expected CEL validation to reject even replicas")
        }

        var statusErr *apierrors.StatusError
        if errors.As(err, &statusErr) {
            details := statusErr.ErrStatus.Details
            for _, cause := range details.Causes {
                if strings.Contains(cause.Message, "replicas must be odd") {
                    return // Correct error
                }
            }
        }
        t.Errorf("expected CEL validation error, got: %v", err)
    })
}
```

## Running Tests with Makefile Targets

```makefile
# Makefile
ENVTEST_K8S_VERSION = 1.29.x
ENVTEST_ASSETS = ./bin/k8s

.PHONY: test test-unit test-integration setup-envtest

setup-envtest:
	GOBIN=$(shell pwd)/bin go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
	./bin/setup-envtest use $(ENVTEST_K8S_VERSION) --bin-dir $(ENVTEST_ASSETS)

test-unit:
	go test -v -race -count=1 -short ./...

test-integration: setup-envtest
	KUBEBUILDER_ASSETS="$(shell ./bin/setup-envtest use $(ENVTEST_K8S_VERSION) --bin-dir $(ENVTEST_ASSETS) -p path)" \
	go test -v -count=1 -timeout=5m ./internal/controller/... ./internal/webhook/...

test: test-unit test-integration

coverage:
	KUBEBUILDER_ASSETS="$(shell ./bin/setup-envtest use $(ENVTEST_K8S_VERSION) --bin-dir $(ENVTEST_ASSETS) -p path)" \
	go test -coverprofile=coverage.out -covermode=atomic ./...
	go tool cover -html=coverage.out -o coverage.html
```

## Key Takeaways

Testing Kubernetes operators well requires a layered approach:

1. **Fake clients for unit tests**: The controller-runtime fake client is fast, requires no external processes, and supports interceptors for error injection. Use it for testing reconciler logic in isolation.
2. **envtest for integration tests**: The embedded kube-apiserver provides real API semantics — CRD validation, admission webhooks, finalizers, and owner reference garbage collection all work correctly.
3. **WithStatusSubresource is critical**: Without it, status updates via the fake client update the main object directly, which doesn't match real API server behavior where `/status` is a separate subresource.
4. **Webhook testing requires a running webhook server**: CEL and webhook validation only fire when requests go through the API server. Test them through envtest, not through the webhook handler directly (those unit tests still add value for testing the logic in isolation).
5. **Eventually patterns beat time.Sleep**: Use retry loops with short intervals and reasonable timeouts rather than fixed sleeps. This makes tests faster when the controller is quick and reliable when it's not.
6. **Set up test namespaces per test**: In parallel envtest tests, per-test namespaces prevent object name conflicts without requiring cleanup of individual objects (just delete the namespace).
