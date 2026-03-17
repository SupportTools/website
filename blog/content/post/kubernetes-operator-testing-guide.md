---
title: "Kubernetes Operator Testing: envtest, Mocks, and Integration Testing"
date: 2028-02-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "controller-runtime", "envtest", "Ginkgo", "Testing", "Go"]
categories:
- Kubernetes
- Go
- Testing
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to testing Kubernetes operators using controller-runtime envtest, fake clients, Ginkgo/Gomega, webhook testing, and E2E testing with kind for production-quality operator development."
more_link: "yes"
url: "/kubernetes-operator-testing-envtest-mocks-integration/"
---

Kubernetes operators are complex event-driven systems that interact with the API server, manage external resources, and encode operational knowledge into reconcile loops. Testing them thoroughly requires strategies that go beyond simple unit tests — the reconciler must be exercised against a real API server (or faithful fake), status conditions must be verified through the full reconciliation cycle, and webhooks must validate their admission logic. This guide covers the complete testing stack for controller-runtime operators.

<!--more-->

# Kubernetes Operator Testing: envtest, Mocks, and Integration Testing

## The Operator Testing Pyramid

Operator testing requires three distinct test layers, each serving different purposes:

1. **Unit tests** — Test individual functions, predicates, and helper methods in isolation using the fake client. Milliseconds per test, run in CI on every commit.

2. **Integration tests with envtest** — Test the reconciler loop against a real Kubernetes API server (launched by envtest). Seconds per test, run before merging PRs. Catch issues with informers, watches, finalizers, and owner references that fake clients cannot reproduce.

3. **End-to-end tests with kind** — Deploy the operator in a real cluster and validate it against the full Kubernetes stack. Minutes per test, run on release candidates.

## Setting Up envtest

`envtest` (from `sigs.k8s.io/controller-runtime/pkg/envtest`) launches a real `kube-apiserver` and `etcd` binary for tests. It provides an environment indistinguishable from a real cluster for most operator operations.

### Test Infrastructure Setup

```go
// internal/controller/suite_test.go
package controller_test

import (
    "context"
    "fmt"
    "path/filepath"
    "testing"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    "k8s.io/client-go/rest"

    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"

    appsv1alpha1 "github.com/example/order-operator/api/v1alpha1"
    "github.com/example/order-operator/internal/controller"
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
    // Configure structured logging for tests
    log.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

    ctx, cancel = context.WithCancel(context.Background())

    // Set up the test scheme with all required APIs
    Expect(clientgoscheme.AddToScheme(scheme)).To(Succeed())
    Expect(appsv1alpha1.AddToScheme(scheme)).To(Succeed())

    // Configure envtest to use real binaries.
    // KUBEBUILDER_ASSETS env var points to kube-apiserver and etcd binaries.
    // Download them with: make envtest && ./bin/setup-envtest use 1.30.x
    testEnv = &envtest.Environment{
        // Path to CRD YAML files — envtest installs them before tests run
        CRDDirectoryPaths: []string{
            filepath.Join("..", "..", "config", "crd", "bases"),
        },
        // Use installed CRDs in strict validation mode
        ErrorIfCRDPathMissing: true,
        // Attach all scheme types so the API server knows about them
        Scheme: scheme,
    }

    var err error
    // Start the API server and etcd
    cfg, err = testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    // Build a client for direct API access in tests
    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme})
    Expect(err).NotTo(HaveOccurred())
    Expect(k8sClient).NotTo(BeNil())

    // Start the controller manager in the background
    mgr, err := ctrl.NewManager(cfg, ctrl.Options{
        Scheme: scheme,
        // Disable leader election in tests — only one manager runs
        LeaderElection: false,
    })
    Expect(err).NotTo(HaveOccurred())

    // Register the reconciler under test
    err = (&controller.OrderServiceReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
        // Inject a mock external client for tests that need it
        ExternalAPIClient: &fakeExternalAPIClient{},
    }).SetupWithManager(mgr)
    Expect(err).NotTo(HaveOccurred())

    // Run the manager in a goroutine; it will be stopped by cancel()
    go func() {
        defer GinkgoRecover()
        Expect(mgr.Start(ctx)).To(Succeed())
    }()
})

var _ = AfterSuite(func() {
    // Cancel context to stop the manager
    cancel()
    // Stop kube-apiserver and etcd
    Expect(testEnv.Stop()).To(Succeed())
})
```

### Makefile Integration for envtest

```makefile
# Makefile targets for envtest binary management

ENVTEST_VERSION ?= release-0.18
ENVTEST_K8S_VERSION ?= 1.30.x
ENVTEST = $(LOCALBIN)/setup-envtest
LOCALBIN ?= $(shell pwd)/bin

.PHONY: envtest
envtest: $(ENVTEST)
$(ENVTEST): $(LOCALBIN)
	$(call go-install-tool,$(ENVTEST),sigs.k8s.io/controller-runtime/tools/setup-envtest,$(ENVTEST_VERSION))

.PHONY: setup-envtest-binaries
setup-envtest-binaries: envtest
	$(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(LOCALBIN) -p path

.PHONY: test
test: envtest setup-envtest-binaries
	KUBEBUILDER_ASSETS="$(shell $(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(LOCALBIN) -p path)" \
	go test ./... \
		-v \
		-count=1 \
		-timeout 10m \
		-coverprofile=coverage.out
```

## Reconciler Unit Tests

Unit tests for reconcilers use the fake client — an in-memory implementation of the Kubernetes API client that does not require a running API server.

### CRD Type Definition

```go
// api/v1alpha1/orderservice_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type OrderServiceSpec struct {
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=50
    Replicas int32 `json:"replicas"`

    // +kubebuilder:validation:MinLength=1
    Image string `json:"image"`

    // +kubebuilder:validation:Enum=development;staging;production
    Environment string `json:"environment"`

    Database DatabaseSpec `json:"database"`
}

type DatabaseSpec struct {
    Host string `json:"host"`
    Port int32  `json:"port,omitempty"`
    Name string `json:"name"`
}

type OrderServiceStatus struct {
    // Standard condition types: Available, Progressing, Degraded
    Conditions []metav1.Condition `json:"conditions,omitempty"`

    // ObservedGeneration tracks the metadata.generation when the status was last updated
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`

    // ReadyReplicas is the number of ready pods
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Replicas",type="integer",JSONPath=".spec.replicas"
// +kubebuilder:printcolumn:name="Ready",type="integer",JSONPath=".status.readyReplicas"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
type OrderService struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   OrderServiceSpec   `json:"spec,omitempty"`
    Status OrderServiceStatus `json:"status,omitempty"`
}
```

### Reconciler Unit Tests with Fake Client

```go
// internal/controller/orderservice_controller_unit_test.go
package controller_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"

    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"
    "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"

    appsv1alpha1 "github.com/example/order-operator/api/v1alpha1"
    "github.com/example/order-operator/internal/controller"
)

func init() {
    log.SetLogger(zap.New(zap.UseDevMode(true)))
}

func newTestScheme(t *testing.T) *runtime.Scheme {
    t.Helper()
    s := runtime.NewScheme()
    require.NoError(t, clientgoscheme.AddToScheme(s))
    require.NoError(t, appsv1alpha1.AddToScheme(s))
    return s
}

// TestReconcileCreatesDeployment verifies that reconciling a new OrderService
// creates a corresponding Deployment with the correct spec.
func TestReconcileCreatesDeployment(t *testing.T) {
    scheme := newTestScheme(t)
    ctx := context.Background()

    // Create the OrderService CR
    orderService := &appsv1alpha1.OrderService{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "test-order-service",
            Namespace: "commerce",
            // Generation is 1 for newly created objects
            Generation: 1,
        },
        Spec: appsv1alpha1.OrderServiceSpec{
            Replicas:    3,
            Image:       "registry.example.com/order-service:v4.0.0",
            Environment: "production",
            Database: appsv1alpha1.DatabaseSpec{
                Host: "postgres.data-platform.svc.cluster.local",
                Port: 5432,
                Name: "orders",
            },
        },
    }

    // Build fake client pre-populated with the OrderService
    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme).
        WithObjects(orderService).
        // StatusClient is a separate interface in controller-runtime
        WithStatusSubresource(&appsv1alpha1.OrderService{}).
        Build()

    // Create reconciler under test
    reconciler := &controller.OrderServiceReconciler{
        Client: fakeClient,
        Scheme: scheme,
    }

    // Trigger reconciliation
    result, err := reconciler.Reconcile(ctx, ctrl.Request{
        NamespacedName: types.NamespacedName{
            Name:      "test-order-service",
            Namespace: "commerce",
        },
    })

    // Assertions
    require.NoError(t, err)
    assert.False(t, result.Requeue, "should not request immediate requeue on success")

    // Verify the Deployment was created
    deployment := &appsv1.Deployment{}
    err = fakeClient.Get(ctx, types.NamespacedName{
        Name:      "test-order-service",
        Namespace: "commerce",
    }, deployment)
    require.NoError(t, err, "deployment should exist after reconciliation")

    // Verify deployment spec matches the OrderService spec
    assert.Equal(t, int32(3), *deployment.Spec.Replicas,
        "deployment replicas should match OrderService spec")
    assert.Equal(t, "registry.example.com/order-service:v4.0.0",
        deployment.Spec.Template.Spec.Containers[0].Image,
        "deployment image should match OrderService spec")

    // Verify owner reference is set (ensures GC on OrderService deletion)
    require.Len(t, deployment.OwnerReferences, 1)
    assert.Equal(t, "OrderService", deployment.OwnerReferences[0].Kind)
    assert.Equal(t, "test-order-service", deployment.OwnerReferences[0].Name)
}

// TestReconcileStatusConditions verifies that status conditions are set correctly
// for different OrderService states.
func TestReconcileStatusConditions(t *testing.T) {
    scheme := newTestScheme(t)
    ctx := context.Background()

    tests := []struct {
        name                 string
        readyReplicas        int32
        desiredReplicas      int32
        expectedAvailable    metav1.ConditionStatus
        expectedProgressing  metav1.ConditionStatus
    }{
        {
            name:                "all replicas ready",
            readyReplicas:       3,
            desiredReplicas:     3,
            expectedAvailable:   metav1.ConditionTrue,
            expectedProgressing: metav1.ConditionFalse,
        },
        {
            name:                "no replicas ready",
            readyReplicas:       0,
            desiredReplicas:     3,
            expectedAvailable:   metav1.ConditionFalse,
            expectedProgressing: metav1.ConditionTrue,
        },
        {
            name:                "partial replicas ready",
            readyReplicas:       2,
            desiredReplicas:     3,
            expectedAvailable:   metav1.ConditionFalse,
            expectedProgressing: metav1.ConditionTrue,
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            orderService := &appsv1alpha1.OrderService{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-order-service",
                    Namespace: "commerce",
                    Generation: 1,
                },
                Spec: appsv1alpha1.OrderServiceSpec{
                    Replicas:    tc.desiredReplicas,
                    Image:       "registry.example.com/order-service:v4.0.0",
                    Environment: "production",
                },
            }

            // Pre-create a Deployment with the specified readyReplicas
            replicas := tc.desiredReplicas
            deployment := &appsv1.Deployment{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "test-order-service",
                    Namespace: "commerce",
                },
                Spec: appsv1.DeploymentSpec{
                    Replicas: &replicas,
                },
                Status: appsv1.DeploymentStatus{
                    ReadyReplicas: tc.readyReplicas,
                },
            }

            fakeClient := fake.NewClientBuilder().
                WithScheme(scheme).
                WithObjects(orderService, deployment).
                WithStatusSubresource(&appsv1alpha1.OrderService{}, &appsv1.Deployment{}).
                Build()

            reconciler := &controller.OrderServiceReconciler{
                Client: fakeClient,
                Scheme: scheme,
            }

            _, err := reconciler.Reconcile(ctx, ctrl.Request{
                NamespacedName: types.NamespacedName{
                    Name: "test-order-service", Namespace: "commerce",
                },
            })
            require.NoError(t, err)

            // Fetch the updated OrderService to check status
            updated := &appsv1alpha1.OrderService{}
            require.NoError(t, fakeClient.Get(ctx, types.NamespacedName{
                Name: "test-order-service", Namespace: "commerce",
            }, updated))

            // Verify Available condition
            availableCond := meta.FindStatusCondition(updated.Status.Conditions, "Available")
            require.NotNil(t, availableCond, "Available condition should be set")
            assert.Equal(t, tc.expectedAvailable, availableCond.Status)

            // Verify Progressing condition
            progressingCond := meta.FindStatusCondition(updated.Status.Conditions, "Progressing")
            require.NotNil(t, progressingCond, "Progressing condition should be set")
            assert.Equal(t, tc.expectedProgressing, progressingCond.Status)

            // Verify ObservedGeneration is updated
            assert.Equal(t, int64(1), updated.Status.ObservedGeneration)
        })
    }
}
```

## Integration Tests with envtest and Ginkgo

Ginkgo provides BDD-style test structure that integrates well with the async nature of Kubernetes reconciliation.

```go
// internal/controller/orderservice_controller_integration_test.go
package controller_test

import (
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"

    appsv1alpha1 "github.com/example/order-operator/api/v1alpha1"
)

// Integration test constants — envtest operations are asynchronous
const (
    timeout  = 10 * time.Second
    interval = 250 * time.Millisecond
)

var _ = Describe("OrderService Controller", func() {
    Context("When creating a new OrderService", func() {
        const namespaceName = "commerce"
        const resourceName = "test-order-service"

        var orderService *appsv1alpha1.OrderService
        var namespacedName types.NamespacedName

        BeforeEach(func() {
            // Create a fresh namespace for each test to avoid state leakage
            ns := &corev1.Namespace{
                ObjectMeta: metav1.ObjectMeta{Name: namespaceName},
            }
            Expect(k8sClient.Create(ctx, ns)).To(Or(Succeed(), MatchError(ContainSubstring("already exists"))))

            namespacedName = types.NamespacedName{
                Name:      resourceName,
                Namespace: namespaceName,
            }

            orderService = &appsv1alpha1.OrderService{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      resourceName,
                    Namespace: namespaceName,
                },
                Spec: appsv1alpha1.OrderServiceSpec{
                    Replicas:    3,
                    Image:       "registry.example.com/order-service:v4.0.0",
                    Environment: "production",
                    Database: appsv1alpha1.DatabaseSpec{
                        Host: "postgres.data-platform.svc.cluster.local",
                        Port: 5432,
                        Name: "orders",
                    },
                },
            }
        })

        AfterEach(func() {
            // Clean up the OrderService after each test
            // The controller should cascade-delete owned resources via owner references
            existing := &appsv1alpha1.OrderService{}
            if err := k8sClient.Get(ctx, namespacedName, existing); err == nil {
                Expect(k8sClient.Delete(ctx, existing)).To(Succeed())
            }
        })

        It("should create a Deployment with the correct replica count", func() {
            By("Creating the OrderService CR")
            Expect(k8sClient.Create(ctx, orderService)).To(Succeed())

            By("Expecting a Deployment to be created")
            deployment := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, namespacedName, deployment)
            }, timeout, interval).Should(Succeed())

            Expect(*deployment.Spec.Replicas).To(Equal(int32(3)))
            Expect(deployment.Spec.Template.Spec.Containers[0].Image).To(
                Equal("registry.example.com/order-service:v4.0.0"))
        })

        It("should set the Available condition to True when all replicas are ready", func() {
            By("Creating the OrderService CR")
            Expect(k8sClient.Create(ctx, orderService)).To(Succeed())

            By("Waiting for the Deployment to be created")
            deployment := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, namespacedName, deployment)
            }, timeout, interval).Should(Succeed())

            By("Patching the Deployment status to simulate ready replicas")
            // In envtest, the status subresource must be updated separately
            statusPatch := deployment.DeepCopy()
            statusPatch.Status.ReadyReplicas = 3
            statusPatch.Status.AvailableReplicas = 3
            statusPatch.Status.Replicas = 3
            Expect(k8sClient.Status().Update(ctx, statusPatch)).To(Succeed())

            By("Expecting the OrderService status to reflect availability")
            Eventually(func() bool {
                updated := &appsv1alpha1.OrderService{}
                if err := k8sClient.Get(ctx, namespacedName, updated); err != nil {
                    return false
                }
                cond := meta.FindStatusCondition(updated.Status.Conditions, "Available")
                return cond != nil && cond.Status == metav1.ConditionTrue
            }, timeout, interval).Should(BeTrue())
        })

        It("should handle spec updates by updating the Deployment", func() {
            By("Creating the OrderService CR")
            Expect(k8sClient.Create(ctx, orderService)).To(Succeed())

            By("Waiting for initial Deployment creation")
            deployment := &appsv1.Deployment{}
            Eventually(func() error {
                return k8sClient.Get(ctx, namespacedName, deployment)
            }, timeout, interval).Should(Succeed())

            By("Updating the OrderService replica count")
            updated := &appsv1alpha1.OrderService{}
            Expect(k8sClient.Get(ctx, namespacedName, updated)).To(Succeed())
            updated.Spec.Replicas = 6
            Expect(k8sClient.Update(ctx, updated)).To(Succeed())

            By("Expecting the Deployment to be updated to 6 replicas")
            Eventually(func() int32 {
                dep := &appsv1.Deployment{}
                if err := k8sClient.Get(ctx, namespacedName, dep); err != nil {
                    return 0
                }
                return *dep.Spec.Replicas
            }, timeout, interval).Should(Equal(int32(6)))
        })
    })

    Context("When deleting an OrderService", func() {
        It("should clean up owned Deployments via garbage collection", func() {
            namespacedName := types.NamespacedName{Name: "delete-test", Namespace: "commerce"}

            By("Creating the OrderService")
            os := &appsv1alpha1.OrderService{
                ObjectMeta: metav1.ObjectMeta{
                    Name: "delete-test", Namespace: "commerce",
                },
                Spec: appsv1alpha1.OrderServiceSpec{
                    Replicas:    1,
                    Image:       "registry.example.com/order-service:v4.0.0",
                    Environment: "staging",
                },
            }
            Expect(k8sClient.Create(ctx, os)).To(Succeed())

            By("Waiting for the Deployment to be created")
            Eventually(func() error {
                dep := &appsv1.Deployment{}
                return k8sClient.Get(ctx, namespacedName, dep)
            }, timeout, interval).Should(Succeed())

            By("Deleting the OrderService")
            Expect(k8sClient.Delete(ctx, os)).To(Succeed())

            By("Expecting the Deployment to be garbage collected")
            // Kubernetes GC removes owned objects when the owner is deleted
            Eventually(func() bool {
                dep := &appsv1.Deployment{}
                err := k8sClient.Get(ctx, namespacedName, dep)
                return err != nil // expect NotFound error
            }, timeout, interval).Should(BeTrue())
        })
    })
})
```

## Webhook Testing

Admission webhooks require testing both the validation logic and the webhook server integration.

```go
// internal/webhook/orderservice_webhook_test.go
package webhook_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "k8s.io/apimachinery/pkg/runtime"

    appsv1alpha1 "github.com/example/order-operator/api/v1alpha1"
    "github.com/example/order-operator/internal/webhook"
)

func TestOrderServiceValidation(t *testing.T) {
    tests := []struct {
        name        string
        spec        appsv1alpha1.OrderServiceSpec
        expectError bool
        errorMsg    string
    }{
        {
            name: "valid spec passes validation",
            spec: appsv1alpha1.OrderServiceSpec{
                Replicas:    3,
                Image:       "registry.example.com/order-service:v4.0.0",
                Environment: "production",
                Database: appsv1alpha1.DatabaseSpec{
                    Host: "postgres.example.com",
                    Port: 5432,
                    Name: "orders",
                },
            },
            expectError: false,
        },
        {
            name: "zero replicas rejected",
            spec: appsv1alpha1.OrderServiceSpec{
                Replicas:    0,
                Image:       "registry.example.com/order-service:v4.0.0",
                Environment: "production",
            },
            expectError: true,
            errorMsg:    "replicas must be at least 1",
        },
        {
            name: "production requires at least 3 replicas",
            spec: appsv1alpha1.OrderServiceSpec{
                Replicas:    1,
                Image:       "registry.example.com/order-service:v4.0.0",
                Environment: "production",
            },
            expectError: true,
            errorMsg:    "production environment requires at least 3 replicas",
        },
        {
            name: "image tag 'latest' rejected in production",
            spec: appsv1alpha1.OrderServiceSpec{
                Replicas:    3,
                Image:       "registry.example.com/order-service:latest",
                Environment: "production",
            },
            expectError: true,
            errorMsg:    "image tag 'latest' is not allowed in production",
        },
    }

    validator := &webhook.OrderServiceValidator{}

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            os := &appsv1alpha1.OrderService{
                Spec: tc.spec,
            }
            _, err := validator.ValidateCreate(context.Background(), os)

            if tc.expectError {
                require.Error(t, err)
                assert.Contains(t, err.Error(), tc.errorMsg)
            } else {
                require.NoError(t, err)
            }
        })
    }
}

// TestOrderServiceMutation tests the defaulting webhook
func TestOrderServiceMutation(t *testing.T) {
    defaulter := &webhook.OrderServiceDefaulter{}

    os := &appsv1alpha1.OrderService{
        Spec: appsv1alpha1.OrderServiceSpec{
            Replicas:    3,
            Image:       "registry.example.com/order-service:v4.0.0",
            Environment: "production",
            Database: appsv1alpha1.DatabaseSpec{
                Host: "postgres.example.com",
                Name: "orders",
                // Port omitted — should be defaulted to 5432
            },
        },
    }

    err := defaulter.Default(context.Background(), os)
    require.NoError(t, err)

    // Verify defaults were applied
    assert.Equal(t, int32(5432), os.Spec.Database.Port,
        "database port should default to 5432")
}
```

## E2E Testing with kind

```bash
#!/usr/bin/env bash
# e2e-test.sh — deploy operator and run end-to-end tests against a kind cluster

set -euo pipefail

CLUSTER_NAME="operator-e2e-test"
IMAGE_TAG="${IMAGE_TAG:-latest}"
REGISTRY="kind-registry:5001"

echo "=== Setting up E2E test environment ==="

# Create a kind cluster with a local registry
cat <<EOF | kind create cluster --name "${CLUSTER_NAME}" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
- |-
  [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:5001"]
    endpoint = ["http://kind-registry:5001"]
nodes:
- role: control-plane
- role: worker
- role: worker
- role: worker
EOF

# Build and push the operator image to the local registry
docker build -t "localhost:5001/order-operator:${IMAGE_TAG}" .
docker push "localhost:5001/order-operator:${IMAGE_TAG}"

# Install CRDs
kubectl apply -k config/crd

# Deploy the operator
kubectl apply -k config/default
kubectl wait --for=condition=Available \
  deployment/order-operator-controller-manager \
  -n order-operator-system \
  --timeout=120s

echo "=== Running E2E tests ==="

# Run E2E test suite
KUBECONFIG="$(kind get kubeconfig-path --name="${CLUSTER_NAME}")" \
go test ./test/e2e/... \
  -v \
  -count=1 \
  -timeout 30m \
  -tags=e2e

echo "=== Cleaning up ==="
kind delete cluster --name "${CLUSTER_NAME}"
```

## Coverage and Quality Gates

```bash
# Generate coverage report for controller tests
go test ./internal/controller/... \
  -coverprofile=controller-coverage.out \
  -covermode=atomic \
  -v

# Generate coverage report for webhook tests
go test ./internal/webhook/... \
  -coverprofile=webhook-coverage.out \
  -covermode=atomic

# Merge coverage profiles
gocovmerge controller-coverage.out webhook-coverage.out > total-coverage.out

# Display coverage summary
go tool cover -func=total-coverage.out | tail -1

# HTML coverage report
go tool cover -html=total-coverage.out -o coverage.html

# Fail if coverage drops below threshold
COVERAGE=$(go tool cover -func=total-coverage.out | tail -1 | awk '{print $3}' | tr -d '%')
if (( $(echo "${COVERAGE} < 80" | bc -l) )); then
  echo "Coverage ${COVERAGE}% is below required 80% threshold"
  exit 1
fi
```

A well-tested operator relies on unit tests for isolated business logic, envtest for reconciliation behavior with real API semantics, Ginkgo/Gomega for async status assertions, webhook tests for admission logic, and kind-based E2E tests for full-stack validation. Each layer catches different classes of defects, and together they provide the confidence to ship operator changes to production.
