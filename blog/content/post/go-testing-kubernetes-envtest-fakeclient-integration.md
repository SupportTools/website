---
title: "Go Testing in Kubernetes: envtest, fakeclient, and Integration Test Patterns"
date: 2029-03-14T00:00:00-05:00
draft: false
tags: ["Go", "Kubernetes", "Testing", "envtest", "controller-runtime", "Integration Tests"]
categories:
- Go
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to testing Kubernetes operators and controllers in Go using controller-runtime envtest, fakeclient, and structured integration test patterns — covering reconciler testing, webhook validation, and CI pipeline integration."
more_link: "yes"
url: "/go-testing-kubernetes-envtest-fakeclient-integration/"
---

Testing Kubernetes operators requires tools that simulate the control plane without requiring a running cluster. The controller-runtime project provides two complementary approaches: `fakeclient`, which intercepts API calls in-memory with no real server, and `envtest`, which runs the actual Kubernetes API server and etcd as test infrastructure. Understanding when to use each approach — and how to structure tests around them — determines how effectively a team can validate operator logic before it reaches production.

<!--more-->

## Testing Pyramid for Kubernetes Operators

Kubernetes operator tests fall into three tiers:

| Tier | Tool | Scope | Speed | Fidelity |
|------|------|-------|-------|----------|
| Unit | `fake.NewClientBuilder()` | Single reconciler function | <1ms/test | Business logic only |
| Integration | `envtest` | Full reconciler loop with real API server | 5-30s startup | High — real admission, validation |
| End-to-end | Kind/real cluster | Multi-component interaction | Minutes | Full |

The most productive investment for operator developers is the integration test layer with `envtest`: it provides real API server semantics (admission webhooks, status subresource, watch events) while running in CI without an external cluster dependency.

## Setting Up envtest

### Installation

```bash
# Install setup-envtest to manage test binary versions
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest

# Download the Kubernetes API server and etcd binaries for testing
# Binaries are cached in ~/.local/share/kubebuilder-envtest/
setup-envtest use 1.32.0 --bin-dir /usr/local/kubebuilder/bin

# Verify installation
ls /usr/local/kubebuilder/bin/
# etcd  kube-apiserver
```

### go.mod Dependencies

```
require (
    sigs.k8s.io/controller-runtime v0.19.0
    k8s.io/api v0.32.0
    k8s.io/apimachinery v0.32.0
    k8s.io/client-go v0.32.0
    github.com/onsi/ginkgo/v2 v2.21.0
    github.com/onsi/gomega v1.35.0
)
```

### Suite Setup: suite_test.go

```go
package controller_test

import (
    "context"
    "os"
    "path/filepath"
    "testing"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"

    myapiv1 "github.com/example/my-operator/api/v1"
    "github.com/example/my-operator/internal/controller"
)

var (
    testEnv   *envtest.Environment
    k8sClient client.Client
    ctx       context.Context
    cancel    context.CancelFunc
)

func TestControllers(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
    ctrl.SetLogger(zap.New(zap.UseDevMode(true), zap.WriteTo(GinkgoWriter)))

    ctx, cancel = context.WithCancel(context.Background())

    // Set environment variable for setup-envtest binary path
    // In CI: export KUBEBUILDER_ASSETS=$(setup-envtest use 1.32.0 -p path)
    By("bootstrapping test environment")
    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "..", "config", "crd", "bases"),
        },
        ErrorIfCRDPathMissing: true,
        BinaryAssetsDirectory: os.Getenv("KUBEBUILDER_ASSETS"),
    }

    cfg, err := testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    // Build the scheme with all required types
    scheme := runtime.NewScheme()
    Expect(clientgoscheme.AddToScheme(scheme)).To(Succeed())
    Expect(myapiv1.AddToScheme(scheme)).To(Succeed())

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme})
    Expect(err).NotTo(HaveOccurred())
    Expect(k8sClient).NotTo(BeNil())

    // Start the manager with our controllers
    mgr, err := ctrl.NewManager(cfg, ctrl.Options{
        Scheme: scheme,
        // Disable leader election and metrics for tests
        LeaderElection:          false,
        MetricsBindAddress:      "0",
        HealthProbeBindAddress:  "0",
    })
    Expect(err).NotTo(HaveOccurred())

    // Register the reconciler under test
    err = (&controller.MyAppReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr)
    Expect(err).NotTo(HaveOccurred())

    go func() {
        defer GinkgoRecover()
        err = mgr.Start(ctx)
        Expect(err).NotTo(HaveOccurred())
    }()
})

var _ = AfterSuite(func() {
    By("tearing down the test environment")
    cancel()
    Expect(testEnv.Stop()).To(Succeed())
})
```

## Writing Integration Tests with envtest

### Testing a Reconciler

```go
package controller_test

import (
    "context"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client"

    myapiv1 "github.com/example/my-operator/api/v1"
)

const (
    timeout  = 30 * time.Second
    interval = 250 * time.Millisecond
)

var _ = Describe("MyApp Controller", func() {
    Context("When creating a MyApp resource", func() {
        var (
            myApp     *myapiv1.MyApp
            namespace string
        )

        BeforeEach(func() {
            // Create an isolated namespace for each test
            ns := &corev1.Namespace{
                ObjectMeta: metav1.ObjectMeta{
                    GenerateName: "test-",
                },
            }
            Expect(k8sClient.Create(ctx, ns)).To(Succeed())
            namespace = ns.Name

            myApp = &myapiv1.MyApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-app",
                    Namespace: namespace,
                },
                Spec: myapiv1.MyAppSpec{
                    Replicas: 3,
                    Image:    "registry.example.com/my-app:v1.2.0",
                    Port:     8080,
                },
            }
        })

        AfterEach(func() {
            // Cleanup the MyApp resource
            Expect(k8sClient.Delete(ctx, myApp)).To(Succeed())

            // Wait for the namespace to be fully deleted
            // (envtest may not fully delete, so we just patch for isolation)
        })

        It("Should create a Deployment with the correct replica count", func() {
            Expect(k8sClient.Create(ctx, myApp)).To(Succeed())

            // The reconciler should create a Deployment
            deployment := &appsv1.Deployment{}
            Eventually(func(g Gomega) {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-app",
                    Namespace: namespace,
                }, deployment)
                g.Expect(err).NotTo(HaveOccurred())
                g.Expect(deployment.Spec.Replicas).NotTo(BeNil())
                g.Expect(*deployment.Spec.Replicas).To(Equal(int32(3)))
            }, timeout, interval).Should(Succeed())

            // Verify the image is set correctly
            Expect(deployment.Spec.Template.Spec.Containers).To(HaveLen(1))
            Expect(deployment.Spec.Template.Spec.Containers[0].Image).
                To(Equal("registry.example.com/my-app:v1.2.0"))
        })

        It("Should update the Deployment when MyApp spec changes", func() {
            Expect(k8sClient.Create(ctx, myApp)).To(Succeed())

            // Wait for initial Deployment creation
            deployment := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-app",
                    Namespace: namespace,
                }, deployment)
            }, timeout, interval).Should(Succeed())

            // Update the replica count
            patch := client.MergeFrom(myApp.DeepCopy())
            myApp.Spec.Replicas = 5
            Expect(k8sClient.Patch(ctx, myApp, patch)).To(Succeed())

            // Wait for the Deployment to be updated
            Eventually(func(g Gomega) {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-app",
                    Namespace: namespace,
                }, deployment)
                g.Expect(err).NotTo(HaveOccurred())
                g.Expect(*deployment.Spec.Replicas).To(Equal(int32(5)))
            }, timeout, interval).Should(Succeed())
        })

        It("Should set the owner reference on created resources", func() {
            Expect(k8sClient.Create(ctx, myApp)).To(Succeed())

            deployment := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-app",
                    Namespace: namespace,
                }, deployment)
            }, timeout, interval).Should(Succeed())

            Expect(deployment.OwnerReferences).To(HaveLen(1))
            Expect(deployment.OwnerReferences[0].Name).To(Equal("test-app"))
            Expect(deployment.OwnerReferences[0].Kind).To(Equal("MyApp"))
        })

        It("Should delete owned resources when MyApp is deleted", func() {
            Expect(k8sClient.Create(ctx, myApp)).To(Succeed())

            // Wait for Deployment
            deployment := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-app",
                    Namespace: namespace,
                }, deployment)
            }, timeout, interval).Should(Succeed())

            // Delete the MyApp
            Expect(k8sClient.Delete(ctx, myApp)).To(Succeed())

            // The Deployment should be garbage-collected via owner references
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name:      "test-app",
                    Namespace: namespace,
                }, deployment)
                return client.IgnoreNotFound(err) == nil && err != nil
            }, timeout, interval).Should(BeTrue(), "Deployment should be deleted")
        })
    })
})
```

## Unit Testing with fakeclient

`fakeclient` is ideal for unit-testing individual reconciler functions without standing up envtest. It intercepts API calls in-process, making tests run in microseconds.

```go
package controller

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    myapiv1 "github.com/example/my-operator/api/v1"
)

func buildTestScheme(t *testing.T) *runtime.Scheme {
    t.Helper()
    scheme := runtime.NewScheme()
    require.NoError(t, clientgoscheme.AddToScheme(scheme))
    require.NoError(t, myapiv1.AddToScheme(scheme))
    return scheme
}

func TestReconcile_CreatesDeployment(t *testing.T) {
    scheme := buildTestScheme(t)

    myApp := &myapiv1.MyApp{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-app",
            Namespace: "default",
        },
        Spec: myapiv1.MyAppSpec{
            Replicas: 2,
            Image:    "registry.example.com/my-app:v1.0.0",
            Port:     9090,
        },
    }

    // Build the fake client pre-populated with the MyApp resource
    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme).
        WithObjects(myApp).
        WithStatusSubresource(myApp).  // Enable status subresource tracking
        Build()

    reconciler := &MyAppReconciler{
        Client: fakeClient,
        Scheme: scheme,
    }

    req := ctrl.Request{
        NamespacedName: types.NamespacedName{
            Name:      "test-app",
            Namespace: "default",
        },
    }

    result, err := reconciler.Reconcile(context.Background(), req)
    require.NoError(t, err)
    assert.False(t, result.Requeue)

    // Verify the Deployment was created
    deployment := &appsv1.Deployment{}
    err = fakeClient.Get(context.Background(), types.NamespacedName{
        Name:      "test-app",
        Namespace: "default",
    }, deployment)
    require.NoError(t, err)
    assert.Equal(t, int32(2), *deployment.Spec.Replicas)
    assert.Equal(t, "registry.example.com/my-app:v1.0.0",
        deployment.Spec.Template.Spec.Containers[0].Image)
}

func TestReconcile_NotFound_DoesNotError(t *testing.T) {
    scheme := buildTestScheme(t)

    // Empty client — the resource does not exist
    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme).
        Build()

    reconciler := &MyAppReconciler{
        Client: fakeClient,
        Scheme: scheme,
    }

    req := ctrl.Request{
        NamespacedName: types.NamespacedName{
            Name:      "missing-app",
            Namespace: "default",
        },
    }

    result, err := reconciler.Reconcile(context.Background(), req)
    assert.NoError(t, err)
    assert.False(t, result.Requeue)
}

func TestReconcile_UpdatesExistingDeployment(t *testing.T) {
    scheme := buildTestScheme(t)

    myApp := &myapiv1.MyApp{
        ObjectMeta: metav1.ObjectMeta{
            Name:            "test-app",
            Namespace:       "default",
            ResourceVersion: "1",
        },
        Spec: myapiv1.MyAppSpec{
            Replicas: 5,
            Image:    "registry.example.com/my-app:v2.0.0",
            Port:     8080,
        },
    }

    // Pre-existing Deployment with stale spec
    existingDeploy := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-app",
            Namespace: "default",
            OwnerReferences: []metav1.OwnerReference{
                {
                    APIVersion: myapiv1.GroupVersion.String(),
                    Kind:       "MyApp",
                    Name:       "test-app",
                    Controller: boolPtr(true),
                },
            },
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: int32Ptr(2), // Stale — should be updated to 5
            Selector: &metav1.LabelSelector{
                MatchLabels: map[string]string{"app": "test-app"},
            },
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{
                    Labels: map[string]string{"app": "test-app"},
                },
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {Name: "app", Image: "registry.example.com/my-app:v1.0.0"},
                    },
                },
            },
        },
    }

    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme).
        WithObjects(myApp, existingDeploy).
        Build()

    reconciler := &MyAppReconciler{
        Client: fakeClient,
        Scheme: scheme,
    }

    _, err := reconciler.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "test-app", Namespace: "default"},
    })
    require.NoError(t, err)

    updated := &appsv1.Deployment{}
    require.NoError(t, fakeClient.Get(context.Background(), types.NamespacedName{
        Name: "test-app", Namespace: "default",
    }, updated))

    assert.Equal(t, int32(5), *updated.Spec.Replicas)
    assert.Equal(t, "registry.example.com/my-app:v2.0.0",
        updated.Spec.Template.Spec.Containers[0].Image)
}

func int32Ptr(i int32) *int32 { return &i }
func boolPtr(b bool) *bool    { return &b }
```

## Testing Admission Webhooks

```go
package webhook_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

    myapiv1 "github.com/example/my-operator/api/v1"
    "github.com/example/my-operator/internal/webhook"
)

func TestMyAppWebhook_ValidateCreate(t *testing.T) {
    tests := []struct {
        name        string
        obj         *myapiv1.MyApp
        wantErr     bool
        errContains string
    }{
        {
            name: "valid app",
            obj: &myapiv1.MyApp{
                ObjectMeta: metav1.ObjectMeta{Name: "valid", Namespace: "default"},
                Spec: myapiv1.MyAppSpec{
                    Replicas: 3,
                    Image:    "registry.example.com/app:v1.0.0",
                    Port:     8080,
                },
            },
            wantErr: false,
        },
        {
            name: "zero replicas",
            obj: &myapiv1.MyApp{
                ObjectMeta: metav1.ObjectMeta{Name: "bad", Namespace: "default"},
                Spec: myapiv1.MyAppSpec{
                    Replicas: 0,
                    Image:    "registry.example.com/app:v1.0.0",
                    Port:     8080,
                },
            },
            wantErr:     true,
            errContains: "replicas must be at least 1",
        },
        {
            name: "missing image tag",
            obj: &myapiv1.MyApp{
                ObjectMeta: metav1.ObjectMeta{Name: "bad", Namespace: "default"},
                Spec: myapiv1.MyAppSpec{
                    Replicas: 1,
                    Image:    "registry.example.com/app:latest",
                    Port:     8080,
                },
            },
            wantErr:     true,
            errContains: "image must use a specific tag, not latest",
        },
        {
            name: "invalid port",
            obj: &myapiv1.MyApp{
                ObjectMeta: metav1.ObjectMeta{Name: "bad", Namespace: "default"},
                Spec: myapiv1.MyAppSpec{
                    Replicas: 1,
                    Image:    "registry.example.com/app:v1.0.0",
                    Port:     65536,
                },
            },
            wantErr:     true,
            errContains: "port must be between 1 and 65535",
        },
    }

    wh := &webhook.MyAppValidator{}

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            warnings, err := wh.ValidateCreate(context.Background(), tt.obj)
            if tt.wantErr {
                require.Error(t, err)
                assert.Contains(t, err.Error(), tt.errContains)
            } else {
                require.NoError(t, err)
                assert.Empty(t, warnings)
            }
        })
    }
}
```

## Testing Webhook Registration in envtest

```go
// In suite_test.go — add webhook registration
var _ = BeforeSuite(func() {
    // ... existing setup ...

    By("installing webhooks")
    err = (&myapiv1.MyApp{}).SetupWebhookWithManager(mgr)
    Expect(err).NotTo(HaveOccurred())

    // envtest provides a webhook server; register the path
    webhookInstallOptions := &testEnv.WebhookInstallOptions
    mgr, err = ctrl.NewManager(cfg, ctrl.Options{
        Scheme:             scheme,
        LeaderElection:     false,
        MetricsBindAddress: "0",
        WebhookServer: webhook.NewServer(webhook.Options{
            Host:    webhookInstallOptions.LocalServingHost,
            Port:    webhookInstallOptions.LocalServingPort,
            CertDir: webhookInstallOptions.LocalServingCertDir,
        }),
    })
    Expect(err).NotTo(HaveOccurred())
})
```

## CI Pipeline Integration

### GitHub Actions Workflow

```yaml
name: Operator Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-go@v5
      with:
        go-version-file: go.mod
        cache: true

    - name: Install setup-envtest
      run: go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest

    - name: Download envtest binaries
      run: |
        ENVTEST_VERSION=1.32.0
        ENVTEST_ASSETS=$(setup-envtest use $ENVTEST_VERSION -p path)
        echo "KUBEBUILDER_ASSETS=$ENVTEST_ASSETS" >> $GITHUB_ENV

    - name: Run unit tests
      run: go test ./internal/... -v -count=1 -race -coverprofile=coverage-unit.out

    - name: Run integration tests
      run: |
        go test ./test/... -v -count=1 \
          -timeout=300s \
          -coverprofile=coverage-integration.out

    - name: Upload coverage
      uses: codecov/codecov-action@v4
      with:
        files: coverage-unit.out,coverage-integration.out
```

### Makefile Targets

```makefile
ENVTEST_VERSION ?= 1.32.0
KUBEBUILDER_ASSETS ?= $(shell setup-envtest use $(ENVTEST_VERSION) -p path)

.PHONY: test test-unit test-integration

test-unit:
	go test ./internal/... -v -count=1 -race -cover

test-integration: envtest
	KUBEBUILDER_ASSETS="$(KUBEBUILDER_ASSETS)" \
	  go test ./test/... -v -count=1 -timeout=300s

test: test-unit test-integration

envtest:
	which setup-envtest || go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
```

## Testing Status Updates

Status subresources require special handling in both `fakeclient` and `envtest`:

```go
func TestReconcile_UpdatesStatus(t *testing.T) {
    scheme := buildTestScheme(t)

    myApp := &myapiv1.MyApp{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-app",
            Namespace: "default",
        },
        Spec: myapiv1.MyAppSpec{Replicas: 2, Image: "app:v1.0.0", Port: 8080},
    }

    // WithStatusSubresource enables proper status subresource handling
    // Without this, Status().Update() and the main resource Update()
    // are the same endpoint in fake — not accurate to production behavior
    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme).
        WithObjects(myApp).
        WithStatusSubresource(&myapiv1.MyApp{}).
        Build()

    reconciler := &MyAppReconciler{Client: fakeClient, Scheme: scheme}

    _, err := reconciler.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "test-app", Namespace: "default"},
    })
    require.NoError(t, err)

    // Read updated MyApp status
    updated := &myapiv1.MyApp{}
    require.NoError(t, fakeClient.Get(context.Background(), types.NamespacedName{
        Name: "test-app", Namespace: "default",
    }, updated))

    // Verify condition was set correctly
    assert.True(t, isConditionTrue(updated.Status.Conditions, "Ready"))
    assert.Equal(t, "DeploymentCreated", updated.Status.Phase)
}

func isConditionTrue(conditions []metav1.Condition, condType string) bool {
    for _, c := range conditions {
        if c.Type == condType {
            return c.Status == metav1.ConditionTrue
        }
    }
    return false
}
```

## Table-Driven Reconciler Tests

Table-driven tests cover edge cases systematically:

```go
func TestReconciler_ErrorScenarios(t *testing.T) {
    scheme := buildTestScheme(t)

    tests := []struct {
        name          string
        existingObjs  []client.Object
        request       ctrl.Request
        wantErr       bool
        wantRequeue   bool
        wantCondition string
    }{
        {
            name:        "resource not found returns no error",
            request:     ctrl.Request{NamespacedName: types.NamespacedName{Name: "missing", Namespace: "default"}},
            wantErr:     false,
            wantRequeue: false,
        },
        {
            name: "app with invalid image returns error condition",
            existingObjs: []client.Object{
                &myapiv1.MyApp{
                    ObjectMeta: metav1.ObjectMeta{Name: "bad-image", Namespace: "default"},
                    Spec:       myapiv1.MyAppSpec{Replicas: 1, Image: "not-a-valid-image", Port: 8080},
                },
            },
            request: ctrl.Request{
                NamespacedName: types.NamespacedName{Name: "bad-image", Namespace: "default"},
            },
            wantErr:       false,
            wantRequeue:   false,
            wantCondition: "InvalidSpec",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            builder := fake.NewClientBuilder().WithScheme(scheme)
            if len(tt.existingObjs) > 0 {
                builder = builder.WithObjects(tt.existingObjs...).
                    WithStatusSubresource(tt.existingObjs...)
            }
            fakeClient := builder.Build()

            reconciler := &MyAppReconciler{Client: fakeClient, Scheme: scheme}
            result, err := reconciler.Reconcile(context.Background(), tt.request)

            if tt.wantErr {
                assert.Error(t, err)
            } else {
                assert.NoError(t, err)
            }
            assert.Equal(t, tt.wantRequeue, result.Requeue)
        })
    }
}
```

## Best Practices Summary

**Isolate each test with a unique namespace.** envtest runs a shared API server; namespace isolation prevents test interference. Use `GenerateName` rather than hardcoded namespace names.

**Use `Eventually` with a `Gomega` function parameter.** The `Eventually(fn, timeout, interval).Should(Succeed())` form with the `g Gomega` parameter provides better failure messages than polling with raw goroutines.

**Enable `WithStatusSubresource` in fakeclient.** Without it, status updates bypass the subresource endpoint, meaning `Status().Update()` and `Update()` behave identically — which masks real bugs where the reconciler uses the wrong update path.

**Test the controller loop, not just the reconcile function.** Unit tests with fakeclient verify business logic. Integration tests with envtest verify that the controller's `SetupWithManager` wiring correctly triggers reconciliation in response to watch events.

**Keep integration test timeouts proportional to operation complexity.** A simple Deployment creation should complete in under 5 seconds; a complex multi-resource topology may need 30 seconds. Set tight timeouts to catch hangs early, not generous timeouts to hide slowness.
