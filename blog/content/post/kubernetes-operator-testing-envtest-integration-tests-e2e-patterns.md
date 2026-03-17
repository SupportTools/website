---
title: "Kubernetes Operator Testing: envtest, Integration Tests, and E2E Patterns"
date: 2029-09-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "Testing", "envtest", "controller-runtime", "Go", "kind", "E2E"]
categories: ["Kubernetes", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to testing Kubernetes operators: setting up controller-runtime envtest, using fake clients for unit tests, writing integration tests against a real API server, and running E2E suites with kind."
more_link: "yes"
url: "/kubernetes-operator-testing-envtest-integration-tests-e2e-patterns/"
---

Testing Kubernetes operators requires a layered strategy. Unit tests with fake clients run in milliseconds but cannot catch webhook or RBAC issues. Integration tests with envtest catch API server interactions but skip scheduling and networking. End-to-end tests with kind or a real cluster catch everything but take minutes. This post builds a complete testing pyramid for controller-runtime operators — from fake client unit tests through envtest integration tests to full E2E suites running against kind.

<!--more-->

# Kubernetes Operator Testing: envtest, Integration Tests, and E2E Patterns

## The Operator Testing Pyramid

```
               /\
              /  \
             / E2E\        kind or real cluster — catches scheduling,
            /      \       networking, RBAC, webhook registration
           /--------\
          / Integration\   envtest — real API server, fake scheduler
         /              \  catches admission webhooks, status subresources
        /----------------\
       /   Unit Tests      \ fake client, mocked reconciler dependencies
      /____________________\  fastest, most isolated
```

Each layer has a role. The mistake most teams make is skipping the integration layer — writing only unit tests against fake clients and jumping to full E2E. Integration tests with envtest are fast enough for CI (30-60 seconds) while catching a class of bugs that fake clients hide.

## Setting Up the Test Suite

### Dependencies

```go
// go.mod additions for testing
require (
    sigs.k8s.io/controller-runtime v0.19.0
    github.com/onsi/ginkgo/v2 v2.20.0
    github.com/onsi/gomega v1.34.0
    k8s.io/client-go v0.31.0
    k8s.io/api v0.31.0
    k8s.io/apimachinery v0.31.0
    sigs.k8s.io/envtest v0.19.0
)
```

```bash
# Install envtest binaries (kube-apiserver, etcd)
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest
setup-envtest use 1.31.0 --bin-dir /usr/local/kubebuilder/bin
export KUBEBUILDER_ASSETS=/usr/local/kubebuilder/bin/1.31.0-linux-amd64
```

### Suite Bootstrap

```go
// internal/controller/suite_test.go
package controller_test

import (
    "context"
    "path/filepath"
    "testing"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    "k8s.io/client-go/rest"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"

    appsv1alpha1 "github.com/example/myoperator/api/v1alpha1"
    "github.com/example/myoperator/internal/controller"
)

var (
    cfg        *rest.Config
    k8sClient  client.Client
    testEnv    *envtest.Environment
    ctx        context.Context
    cancel     context.CancelFunc
    scheme     = runtime.NewScheme()
)

func TestControllers(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
    logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

    // Register schemes
    Expect(clientgoscheme.AddToScheme(scheme)).To(Succeed())
    Expect(appsv1alpha1.AddToScheme(scheme)).To(Succeed())

    ctx, cancel = context.WithCancel(context.Background())

    // Configure the test environment
    testEnv = &envtest.Environment{
        // Path to CRD manifests
        CRDDirectoryPaths: []string{
            filepath.Join("..", "..", "config", "crd", "bases"),
        },
        ErrorIfCRDPathMissing: true,

        // Webhook configuration (if your operator uses webhooks)
        WebhookInstallOptions: envtest.WebhookInstallOptions{
            Paths: []string{
                filepath.Join("..", "..", "config", "webhook"),
            },
        },
    }

    var err error
    cfg, err = testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme})
    Expect(err).NotTo(HaveOccurred())
    Expect(k8sClient).NotTo(BeNil())

    // Start the controller manager
    mgr, err := ctrl.NewManager(cfg, ctrl.Options{
        Scheme: scheme,
        // Disable metrics in tests to avoid port conflicts
        Metrics: server.Options{BindAddress: "0"},
        // Disable leader election in tests
        LeaderElection: false,
    })
    Expect(err).NotTo(HaveOccurred())

    // Register controllers under test
    err = (&controller.MyAppReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr)
    Expect(err).NotTo(HaveOccurred())

    // Register webhooks if applicable
    err = (&appsv1alpha1.MyApp{}).SetupWebhookWithManager(mgr)
    Expect(err).NotTo(HaveOccurred())

    go func() {
        defer GinkgoRecover()
        err = mgr.Start(ctx)
        Expect(err).NotTo(HaveOccurred())
    }()
})

var _ = AfterSuite(func() {
    cancel()
    Expect(testEnv.Stop()).To(Succeed())
})
```

## Unit Tests with Fake Clients

Fake clients let you test reconciler logic without any running infrastructure. They are ideal for testing decision logic, status updates, and event generation.

### The Reconciler Under Test

```go
// internal/controller/myapp_controller.go
package controller

import (
    "context"
    "fmt"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"

    appsv1alpha1 "github.com/example/myoperator/api/v1alpha1"
)

type MyAppReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

func (r *MyAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    // Fetch the MyApp instance
    myapp := &appsv1alpha1.MyApp{}
    if err := r.Get(ctx, req.NamespacedName, myapp); err != nil {
        if errors.IsNotFound(err) {
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, err
    }

    // Check if Deployment exists
    deployment := &appsv1.Deployment{}
    err := r.Get(ctx, types.NamespacedName{
        Name:      myapp.Name,
        Namespace: myapp.Namespace,
    }, deployment)

    if errors.IsNotFound(err) {
        // Create the deployment
        dep := r.deploymentForMyApp(myapp)
        logger.Info("Creating Deployment", "Deployment.Name", dep.Name)
        if err := r.Create(ctx, dep); err != nil {
            return ctrl.Result{}, fmt.Errorf("create Deployment: %w", err)
        }
        return ctrl.Result{Requeue: true}, nil
    } else if err != nil {
        return ctrl.Result{}, fmt.Errorf("get Deployment: %w", err)
    }

    // Update replica count if needed
    desired := myapp.Spec.Replicas
    if *deployment.Spec.Replicas != desired {
        deployment.Spec.Replicas = &desired
        if err := r.Update(ctx, deployment); err != nil {
            return ctrl.Result{}, fmt.Errorf("update Deployment replicas: %w", err)
        }
    }

    // Update status
    myapp.Status.AvailableReplicas = deployment.Status.AvailableReplicas
    myapp.Status.Phase = "Running"
    if err := r.Status().Update(ctx, myapp); err != nil {
        return ctrl.Result{}, fmt.Errorf("update MyApp status: %w", err)
    }

    return ctrl.Result{}, nil
}

func (r *MyAppReconciler) deploymentForMyApp(myapp *appsv1alpha1.MyApp) *appsv1.Deployment {
    replicas := myapp.Spec.Replicas
    labels := map[string]string{"app": myapp.Name}

    dep := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      myapp.Name,
            Namespace: myapp.Namespace,
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: &replicas,
            Selector: &metav1.LabelSelector{MatchLabels: labels},
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{Labels: labels},
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{{
                        Name:  "app",
                        Image: myapp.Spec.Image,
                    }},
                },
            },
        },
    }
    ctrl.SetControllerReference(myapp, dep, r.Scheme)
    return dep
}

func (r *MyAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&appsv1alpha1.MyApp{}).
        Owns(&appsv1.Deployment{}).
        Complete(r)
}
```

### Unit Tests with Fake Client

```go
// internal/controller/myapp_controller_unit_test.go
package controller_test

import (
    "context"
    "testing"

    appsv1 "k8s.io/api/apps/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    appsv1alpha1 "github.com/example/myoperator/api/v1alpha1"
    "github.com/example/myoperator/internal/controller"
)

func buildScheme(t *testing.T) *runtime.Scheme {
    t.Helper()
    s := runtime.NewScheme()
    if err := clientgoscheme.AddToScheme(s); err != nil {
        t.Fatalf("AddToScheme (client-go): %v", err)
    }
    if err := appsv1alpha1.AddToScheme(s); err != nil {
        t.Fatalf("AddToScheme (myoperator): %v", err)
    }
    return s
}

func TestReconcile_CreatesDeploymentForNewMyApp(t *testing.T) {
    scheme := buildScheme(t)

    myapp := &appsv1alpha1.MyApp{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-app",
            Namespace: "default",
        },
        Spec: appsv1alpha1.MyAppSpec{
            Image:    "nginx:1.25",
            Replicas: 2,
        },
    }

    // Build fake client pre-populated with the MyApp object
    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme).
        WithObjects(myapp).
        WithStatusSubresource(myapp). // enables Status().Update()
        Build()

    reconciler := &controller.MyAppReconciler{
        Client: fakeClient,
        Scheme: scheme,
    }

    // Run reconciliation
    result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "test-app", Namespace: "default"},
    })
    if err != nil {
        t.Fatalf("Reconcile returned error: %v", err)
    }
    if !result.Requeue {
        t.Error("expected Requeue=true after creating Deployment")
    }

    // Verify Deployment was created
    dep := &appsv1.Deployment{}
    err = fakeClient.Get(context.Background(), types.NamespacedName{
        Name: "test-app", Namespace: "default",
    }, dep)
    if err != nil {
        t.Fatalf("Deployment not found: %v", err)
    }

    if dep.Name != "test-app" {
        t.Errorf("Deployment name = %q; want %q", dep.Name, "test-app")
    }
    if *dep.Spec.Replicas != 2 {
        t.Errorf("Deployment replicas = %d; want 2", *dep.Spec.Replicas)
    }
    if dep.Spec.Template.Spec.Containers[0].Image != "nginx:1.25" {
        t.Errorf("Container image = %q; want nginx:1.25",
            dep.Spec.Template.Spec.Containers[0].Image)
    }
}

func TestReconcile_UpdatesReplicasWhenSpecChanges(t *testing.T) {
    scheme := buildScheme(t)

    originalReplicas := int32(1)
    desiredReplicas := int32(3)

    myapp := &appsv1alpha1.MyApp{
        ObjectMeta: metav1.ObjectMeta{Name: "test-app", Namespace: "default"},
        Spec: appsv1alpha1.MyAppSpec{
            Image:    "nginx:1.25",
            Replicas: desiredReplicas,
        },
    }
    dep := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{Name: "test-app", Namespace: "default"},
        Spec: appsv1.DeploymentSpec{
            Replicas: &originalReplicas,
        },
    }

    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme).
        WithObjects(myapp, dep).
        WithStatusSubresource(myapp).
        Build()

    reconciler := &controller.MyAppReconciler{Client: fakeClient, Scheme: scheme}

    _, err := reconciler.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "test-app", Namespace: "default"},
    })
    if err != nil {
        t.Fatalf("Reconcile error: %v", err)
    }

    updated := &appsv1.Deployment{}
    fakeClient.Get(context.Background(), types.NamespacedName{
        Name: "test-app", Namespace: "default",
    }, updated)

    if *updated.Spec.Replicas != desiredReplicas {
        t.Errorf("replicas = %d; want %d", *updated.Spec.Replicas, desiredReplicas)
    }
}

func TestReconcile_HandlesNotFound(t *testing.T) {
    scheme := buildScheme(t)
    fakeClient := fake.NewClientBuilder().WithScheme(scheme).Build()
    reconciler := &controller.MyAppReconciler{Client: fakeClient, Scheme: scheme}

    result, err := reconciler.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "missing", Namespace: "default"},
    })
    if err != nil {
        t.Errorf("expected nil error for NotFound, got: %v", err)
    }
    if result.Requeue {
        t.Error("expected no requeue for NotFound resource")
    }
}

// Table-driven tests for replica scaling decisions
func TestReplicaScaling(t *testing.T) {
    tests := []struct {
        name             string
        specReplicas     int32
        currentReplicas  int32
        expectUpdateCall bool
    }{
        {"scale up",    5, 1, true},
        {"scale down",  1, 5, true},
        {"no change",   3, 3, false},
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            scheme := buildScheme(t)
            myapp := &appsv1alpha1.MyApp{
                ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
                Spec: appsv1alpha1.MyAppSpec{Replicas: tc.specReplicas, Image: "nginx"},
            }
            dep := &appsv1.Deployment{
                ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
                Spec:       appsv1.DeploymentSpec{Replicas: &tc.currentReplicas},
            }

            fakeClient := fake.NewClientBuilder().
                WithScheme(scheme).
                WithObjects(myapp, dep).
                WithStatusSubresource(myapp).
                Build()

            reconciler := &controller.MyAppReconciler{Client: fakeClient, Scheme: scheme}
            _, err := reconciler.Reconcile(context.Background(), ctrl.Request{
                NamespacedName: types.NamespacedName{Name: "app", Namespace: "default"},
            })
            if err != nil {
                t.Fatalf("unexpected error: %v", err)
            }

            updated := &appsv1.Deployment{}
            fakeClient.Get(context.Background(),
                types.NamespacedName{Name: "app", Namespace: "default"}, updated)

            if *updated.Spec.Replicas != tc.specReplicas {
                t.Errorf("replicas = %d; want %d", *updated.Spec.Replicas, tc.specReplicas)
            }
        })
    }
}
```

## Integration Tests with envtest

envtest runs a real kube-apiserver and etcd, giving you the full Kubernetes API surface including admission webhooks, status subresources, and owner reference garbage collection.

```go
// internal/controller/myapp_integration_test.go
package controller_test

import (
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"

    appsv1alpha1 "github.com/example/myoperator/api/v1alpha1"
)

var _ = Describe("MyApp Controller", func() {
    const (
        appName      = "test-myapp"
        appNamespace = "default"
        timeout      = 30 * time.Second
        interval     = 250 * time.Millisecond
    )

    Context("When creating a MyApp resource", func() {
        var myapp *appsv1alpha1.MyApp

        BeforeEach(func() {
            myapp = &appsv1alpha1.MyApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      appName,
                    Namespace: appNamespace,
                },
                Spec: appsv1alpha1.MyAppSpec{
                    Image:    "nginx:1.25",
                    Replicas: 2,
                },
            }
            Expect(k8sClient.Create(ctx, myapp)).To(Succeed())
        })

        AfterEach(func() {
            // Clean up between tests
            Expect(k8sClient.Delete(ctx, myapp)).To(Succeed())
            // Wait for finalizers to complete
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name: appName, Namespace: appNamespace,
                }, myapp)
                return errors.IsNotFound(err)
            }, timeout, interval).Should(BeTrue())
        })

        It("Should create a Deployment for the MyApp", func() {
            dep := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name: appName, Namespace: appNamespace,
                }, dep)
            }, timeout, interval).Should(Succeed())

            Expect(*dep.Spec.Replicas).To(Equal(int32(2)))
            Expect(dep.Spec.Template.Spec.Containers).To(HaveLen(1))
            Expect(dep.Spec.Template.Spec.Containers[0].Image).To(Equal("nginx:1.25"))
        })

        It("Should set an owner reference on the Deployment", func() {
            dep := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name: appName, Namespace: appNamespace,
                }, dep)
            }, timeout, interval).Should(Succeed())

            Expect(dep.OwnerReferences).To(HaveLen(1))
            Expect(dep.OwnerReferences[0].Name).To(Equal(appName))
            Expect(dep.OwnerReferences[0].Kind).To(Equal("MyApp"))
        })

        It("Should update Deployment replicas when MyApp spec changes", func() {
            // Wait for Deployment to be created first
            dep := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name: appName, Namespace: appNamespace,
                }, dep)
            }, timeout, interval).Should(Succeed())

            // Update the MyApp replica count
            updatedMyApp := &appsv1alpha1.MyApp{}
            Expect(k8sClient.Get(ctx, types.NamespacedName{
                Name: appName, Namespace: appNamespace,
            }, updatedMyApp)).To(Succeed())

            updatedMyApp.Spec.Replicas = 5
            Expect(k8sClient.Update(ctx, updatedMyApp)).To(Succeed())

            // Verify the Deployment is updated
            Eventually(func() int32 {
                d := &appsv1.Deployment{}
                k8sClient.Get(ctx, types.NamespacedName{
                    Name: appName, Namespace: appNamespace,
                }, d)
                if d.Spec.Replicas == nil {
                    return 0
                }
                return *d.Spec.Replicas
            }, timeout, interval).Should(Equal(int32(5)))
        })

        It("Should garbage collect the Deployment when MyApp is deleted", func() {
            // Verify Deployment exists
            dep := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, types.NamespacedName{
                    Name: appName, Namespace: appNamespace,
                }, dep)
            }, timeout, interval).Should(Succeed())

            // Delete the MyApp
            Expect(k8sClient.Delete(ctx, myapp)).To(Succeed())

            // Deployment should be garbage collected
            Eventually(func() bool {
                err := k8sClient.Get(ctx, types.NamespacedName{
                    Name: appName, Namespace: appNamespace,
                }, &appsv1.Deployment{})
                return errors.IsNotFound(err)
            }, timeout, interval).Should(BeTrue())
        })
    })

    Context("Admission Webhook Validation", func() {
        It("Should reject a MyApp with zero replicas", func() {
            invalid := &appsv1alpha1.MyApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "invalid-app",
                    Namespace: "default",
                },
                Spec: appsv1alpha1.MyAppSpec{
                    Image:    "nginx",
                    Replicas: 0, // invalid — should be rejected
                },
            }
            err := k8sClient.Create(ctx, invalid)
            Expect(err).To(HaveOccurred())
            Expect(errors.IsInvalid(err)).To(BeTrue())
        })

        It("Should reject a MyApp with an empty image", func() {
            invalid := &appsv1alpha1.MyApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "no-image-app",
                    Namespace: "default",
                },
                Spec: appsv1alpha1.MyAppSpec{
                    Image:    "",
                    Replicas: 1,
                },
            }
            err := k8sClient.Create(ctx, invalid)
            Expect(err).To(HaveOccurred())
        })
    })
})
```

## Test Fixtures and Helpers

Centralizing test fixtures improves readability and reduces duplication.

```go
// internal/testutil/fixtures.go
package testutil

import (
    "fmt"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    appsv1alpha1 "github.com/example/myoperator/api/v1alpha1"
)

// MyAppBuilder builds MyApp test objects with sensible defaults
type MyAppBuilder struct {
    name      string
    namespace string
    image     string
    replicas  int32
    labels    map[string]string
}

func NewMyApp(name, namespace string) *MyAppBuilder {
    return &MyAppBuilder{
        name:      name,
        namespace: namespace,
        image:     "nginx:1.25",
        replicas:  1,
        labels:    map[string]string{},
    }
}

func (b *MyAppBuilder) WithImage(image string) *MyAppBuilder {
    b.image = image
    return b
}

func (b *MyAppBuilder) WithReplicas(n int32) *MyAppBuilder {
    b.replicas = n
    return b
}

func (b *MyAppBuilder) WithLabel(key, value string) *MyAppBuilder {
    b.labels[key] = value
    return b
}

func (b *MyAppBuilder) Build() *appsv1alpha1.MyApp {
    return &appsv1alpha1.MyApp{
        ObjectMeta: metav1.ObjectMeta{
            Name:      b.name,
            Namespace: b.namespace,
            Labels:    b.labels,
        },
        Spec: appsv1alpha1.MyAppSpec{
            Image:    b.image,
            Replicas: b.replicas,
        },
    }
}

// UniqueAppName generates a unique name for each test to avoid conflicts
func UniqueAppName(base string) string {
    return fmt.Sprintf("%s-%d", base, time.Now().UnixNano()%100000)
}

// WaitForCondition polls until the condition function returns true
// This is a helper for tests that need to poll custom conditions
func WaitForCondition(ctx context.Context, timeout, interval time.Duration, cond func() bool) error {
    deadline := time.Now().Add(timeout)
    for {
        if cond() {
            return nil
        }
        if time.Now().After(deadline) {
            return fmt.Errorf("condition not met within %v", timeout)
        }
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(interval):
        }
    }
}
```

## E2E Tests with kind

End-to-end tests run against a real Kubernetes cluster. kind (Kubernetes in Docker) provides an ephemeral cluster suitable for CI.

### kind Cluster Configuration

```yaml
# test/e2e/kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: operator-e2e
nodes:
  - role: control-plane
    image: kindest/node:v1.31.0
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
  - role: worker
    image: kindest/node:v1.31.0
  - role: worker
    image: kindest/node:v1.31.0
networking:
  disableDefaultCNI: false
```

### E2E Suite Setup

```go
// test/e2e/suite_test.go
package e2e_test

import (
    "context"
    "os"
    "os/exec"
    "testing"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    "k8s.io/apimachinery/pkg/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    "k8s.io/client-go/tools/clientcmd"
    "sigs.k8s.io/controller-runtime/pkg/client"

    appsv1alpha1 "github.com/example/myoperator/api/v1alpha1"
)

var (
    k8sClient client.Client
    ctx       context.Context
    cancel    context.CancelFunc
)

func TestE2E(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "E2E Suite")
}

var _ = BeforeSuite(func() {
    ctx, cancel = context.WithCancel(context.Background())

    // Use KUBECONFIG from environment or default location
    kubeconfig := os.Getenv("KUBECONFIG")
    if kubeconfig == "" {
        kubeconfig = os.Getenv("HOME") + "/.kube/config"
    }

    restCfg, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
    Expect(err).NotTo(HaveOccurred())

    scheme := runtime.NewScheme()
    Expect(clientgoscheme.AddToScheme(scheme)).To(Succeed())
    Expect(appsv1alpha1.AddToScheme(scheme)).To(Succeed())

    k8sClient, err = client.New(restCfg, client.Options{Scheme: scheme})
    Expect(err).NotTo(HaveOccurred())

    // Deploy the operator if not already running
    // This uses kustomize to apply CRDs and operator deployment
    deployOperator()
})

var _ = AfterSuite(func() {
    cancel()
})

func deployOperator() {
    // Apply CRDs
    cmd := exec.CommandContext(ctx,
        "kubectl", "apply", "-f", "../../config/crd/bases")
    cmd.Stdout = GinkgoWriter
    cmd.Stderr = GinkgoWriter
    Expect(cmd.Run()).To(Succeed())

    // Apply operator manifests
    cmd = exec.CommandContext(ctx,
        "kubectl", "apply", "-k", "../../config/default")
    cmd.Stdout = GinkgoWriter
    cmd.Stderr = GinkgoWriter
    Expect(cmd.Run()).To(Succeed())

    // Wait for operator deployment to be ready
    cmd = exec.CommandContext(ctx,
        "kubectl", "rollout", "status", "deployment/myoperator-controller-manager",
        "-n", "myoperator-system", "--timeout=120s")
    cmd.Stdout = GinkgoWriter
    cmd.Stderr = GinkgoWriter
    Expect(cmd.Run()).To(Succeed())
}
```

### E2E Test Cases

```go
// test/e2e/myapp_test.go
package e2e_test

import (
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"

    appsv1alpha1 "github.com/example/myoperator/api/v1alpha1"
)

var _ = Describe("MyApp E2E", func() {
    const (
        e2eNamespace = "e2e-tests"
        timeout      = 2 * time.Minute
        interval     = time.Second
    )

    BeforeEach(func() {
        ns := &corev1.Namespace{
            ObjectMeta: metav1.ObjectMeta{Name: e2eNamespace},
        }
        _ = k8sClient.Create(ctx, ns) // ignore AlreadyExists
    })

    AfterEach(func() {
        // Clean up MyApp resources
        list := &appsv1alpha1.MyAppList{}
        k8sClient.List(ctx, list, &client.ListOptions{Namespace: e2eNamespace})
        for _, item := range list.Items {
            item := item
            k8sClient.Delete(ctx, &item)
        }
    })

    It("Full lifecycle: create, scale, delete", func() {
        By("Creating a MyApp with 1 replica")
        myapp := &appsv1alpha1.MyApp{
            ObjectMeta: metav1.ObjectMeta{
                Name:      "e2e-app",
                Namespace: e2eNamespace,
            },
            Spec: appsv1alpha1.MyAppSpec{
                Image:    "nginx:1.25",
                Replicas: 1,
            },
        }
        Expect(k8sClient.Create(ctx, myapp)).To(Succeed())

        By("Verifying the Deployment is created and available")
        dep := &appsv1.Deployment{}
        Eventually(func() (int32, error) {
            err := k8sClient.Get(ctx, types.NamespacedName{
                Name: "e2e-app", Namespace: e2eNamespace,
            }, dep)
            if err != nil {
                return 0, err
            }
            return dep.Status.AvailableReplicas, nil
        }, timeout, interval).Should(Equal(int32(1)))

        By("Scaling to 3 replicas")
        current := &appsv1alpha1.MyApp{}
        Expect(k8sClient.Get(ctx, types.NamespacedName{
            Name: "e2e-app", Namespace: e2eNamespace,
        }, current)).To(Succeed())
        current.Spec.Replicas = 3
        Expect(k8sClient.Update(ctx, current)).To(Succeed())

        Eventually(func() int32 {
            d := &appsv1.Deployment{}
            k8sClient.Get(ctx, types.NamespacedName{
                Name: "e2e-app", Namespace: e2eNamespace,
            }, d)
            return d.Status.AvailableReplicas
        }, timeout, interval).Should(Equal(int32(3)))

        By("Deleting the MyApp and verifying cleanup")
        Expect(k8sClient.Delete(ctx, myapp)).To(Succeed())

        Eventually(func() bool {
            err := k8sClient.Get(ctx, types.NamespacedName{
                Name: "e2e-app", Namespace: e2eNamespace,
            }, &appsv1.Deployment{})
            return errors.IsNotFound(err)
        }, timeout, interval).Should(BeTrue())
    })
})
```

### Makefile Integration

```makefile
# Makefile
ENVTEST_VERSION ?= 1.31.0
ENVTEST_ASSETS_DIR ?= $(shell pwd)/bin/testenv

.PHONY: setup-envtest
setup-envtest:
	@mkdir -p $(ENVTEST_ASSETS_DIR)
	KUBEBUILDER_ASSETS=$(ENVTEST_ASSETS_DIR) \
	  go run sigs.k8s.io/controller-runtime/tools/setup-envtest@latest \
	  use $(ENVTEST_VERSION) --bin-dir $(ENVTEST_ASSETS_DIR)

.PHONY: test-unit
test-unit:
	go test ./internal/... -run "Unit" -v -count=1

.PHONY: test-integration
test-integration: setup-envtest
	KUBEBUILDER_ASSETS=$(ENVTEST_ASSETS_DIR)/$(ENVTEST_VERSION)-linux-amd64 \
	  go test ./internal/controller/... -v -count=1 -timeout 120s

.PHONY: test-e2e
test-e2e:
	@echo "Creating kind cluster..."
	kind create cluster --config test/e2e/kind-config.yaml --name operator-e2e || true
	@echo "Loading operator image into kind..."
	kind load docker-image $(IMG) --name operator-e2e
	KUBECONFIG=$(shell kind get kubeconfig-path --name operator-e2e) \
	  go test ./test/e2e/... -v -count=1 -timeout 10m
	@echo "Deleting kind cluster..."
	kind delete cluster --name operator-e2e

.PHONY: test-all
test-all: test-unit test-integration test-e2e
```

## Summary

A complete operator testing strategy covers three distinct layers:

- **Unit tests** with fake clients validate reconciler logic in isolation, run in under a second, and should cover every branch of the reconcile function including error paths.
- **Integration tests** with envtest use a real kube-apiserver to verify webhook validation, status subresource behavior, owner reference garbage collection, and controller watch configuration.
- **E2E tests** with kind verify the full operator lifecycle including pod scheduling, image pulling, and real workload behavior — these are the final gate before production.

The key discipline is matching your test layer to what you are verifying: fake clients for logic, envtest for API correctness, E2E for end-to-end behavior.
