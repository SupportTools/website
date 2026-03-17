---
title: "Kubernetes Operator Testing: envtest, ENVTEST, and End-to-End Validation"
date: 2031-05-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "envtest", "controller-runtime", "Testing", "kubebuilder", "kind"]
categories:
- Kubernetes
- Testing
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete enterprise guide to testing Kubernetes operators using controller-runtime envtest, fake clients, webhook validation, and end-to-end testing in CI with kind."
more_link: "yes"
url: "/kubernetes-operator-testing-envtest-e2e-validation-guide/"
---

Testing Kubernetes operators is one of the harder problems in cloud-native engineering. Unlike ordinary application code, operators interact with the Kubernetes API server, watch resources, and drive reconciliation loops that are inherently asynchronous. Conventional unit tests cannot capture this behavior faithfully. This guide covers the full spectrum of operator testing: from fast fake-client unit tests to envtest integration tests that spin up a real API server binary, webhook validation, and full end-to-end tests running against a live kind cluster in CI.

<!--more-->

# Kubernetes Operator Testing: envtest, ENVTEST, and End-to-End Validation

## Section 1: Why Operator Testing is Different

Kubernetes operators manage the lifecycle of custom resources. Their reconciliation loops interact with etcd through the API server, react to watch events, and often call external APIs. Testing this code requires careful thought about what fidelity each test layer must provide.

There are three distinct test layers for operators:

1. **Unit tests with fake clients** — fast, no external dependencies, limited fidelity
2. **Integration tests with envtest** — real API server + etcd binary, high fidelity, moderate speed
3. **End-to-end tests with kind** — real cluster, full fidelity, slow

Each layer has a role. The goal is a pyramid where unit tests cover logic, envtest tests cover reconciler behavior, and e2e tests cover operational correctness.

### The Reconciler Interface

A typical kubebuilder reconciler looks like this:

```go
package controllers

import (
    "context"
    "fmt"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"

    webappv1 "example.com/webapp-operator/api/v1"
)

type WebAppReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

func (r *WebAppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    log := log.FromContext(ctx)

    webapp := &webappv1.WebApp{}
    if err := r.Get(ctx, req.NamespacedName, webapp); err != nil {
        if errors.IsNotFound(err) {
            return ctrl.Result{}, nil
        }
        return ctrl.Result{}, err
    }

    // Ensure a Deployment exists
    dep := &appsv1.Deployment{}
    err := r.Get(ctx, req.NamespacedName, dep)
    if errors.IsNotFound(err) {
        dep = r.deploymentForWebApp(webapp)
        if err := r.Create(ctx, dep); err != nil {
            log.Error(err, "failed to create Deployment")
            return ctrl.Result{}, err
        }
        return ctrl.Result{Requeue: true}, nil
    }
    if err != nil {
        return ctrl.Result{}, err
    }

    // Reconcile replica count
    desired := webapp.Spec.Replicas
    if *dep.Spec.Replicas != desired {
        dep.Spec.Replicas = &desired
        if err := r.Update(ctx, dep); err != nil {
            return ctrl.Result{}, err
        }
    }

    // Update status
    webapp.Status.ReadyReplicas = dep.Status.ReadyReplicas
    if err := r.Status().Update(ctx, webapp); err != nil {
        return ctrl.Result{}, err
    }

    return ctrl.Result{}, nil
}

func (r *WebAppReconciler) deploymentForWebApp(app *webappv1.WebApp) *appsv1.Deployment {
    labels := map[string]string{"app": app.Name}
    replicas := app.Spec.Replicas
    return &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      app.Name,
            Namespace: app.Namespace,
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: &replicas,
            Selector: &metav1.LabelSelector{MatchLabels: labels},
            Template: corev1.PodTemplateSpec{
                ObjectMeta: metav1.ObjectMeta{Labels: labels},
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{{
                        Name:  "webapp",
                        Image: app.Spec.Image,
                    }},
                },
            },
        },
    }
}

func (r *WebAppReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&webappv1.WebApp{}).
        Owns(&appsv1.Deployment{}).
        Complete(r)
}
```

## Section 2: Unit Tests with Fake Clients

Fake clients from `sigs.k8s.io/controller-runtime/pkg/client/fake` allow you to test reconciler logic without any network calls. They are ideal for testing conditional logic, error paths, and status updates.

### Setting Up a Fake Client Test

```go
package controllers_test

import (
    "context"
    "testing"

    appsv1 "k8s.io/api/apps/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    webappv1 "example.com/webapp-operator/api/v1"
    "example.com/webapp-operator/controllers"
)

func scheme() *runtime.Scheme {
    s := runtime.NewScheme()
    _ = webappv1.AddToScheme(s)
    _ = appsv1.AddToScheme(s)
    return s
}

func TestReconcile_CreatesDeployment(t *testing.T) {
    replicas := int32(3)
    webapp := &webappv1.WebApp{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "my-webapp",
            Namespace: "default",
        },
        Spec: webappv1.WebAppSpec{
            Replicas: replicas,
            Image:    "nginx:1.25",
        },
    }

    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme()).
        WithObjects(webapp).
        WithStatusSubresource(webapp).
        Build()

    r := &controllers.WebAppReconciler{
        Client: fakeClient,
        Scheme: scheme(),
    }

    req := ctrl.Request{
        NamespacedName: types.NamespacedName{
            Name:      "my-webapp",
            Namespace: "default",
        },
    }

    result, err := r.Reconcile(context.Background(), req)
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if !result.Requeue {
        t.Error("expected Requeue=true after creating Deployment")
    }

    // Verify Deployment was created
    dep := &appsv1.Deployment{}
    if err := fakeClient.Get(context.Background(), req.NamespacedName, dep); err != nil {
        t.Fatalf("deployment not found: %v", err)
    }
    if *dep.Spec.Replicas != replicas {
        t.Errorf("expected %d replicas, got %d", replicas, *dep.Spec.Replicas)
    }
}

func TestReconcile_UpdatesReplicaCount(t *testing.T) {
    oldReplicas := int32(1)
    newReplicas := int32(5)

    webapp := &webappv1.WebApp{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "my-webapp",
            Namespace: "default",
        },
        Spec: webappv1.WebAppSpec{
            Replicas: newReplicas,
            Image:    "nginx:1.25",
        },
    }

    existingDep := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "my-webapp",
            Namespace: "default",
        },
        Spec: appsv1.DeploymentSpec{
            Replicas: &oldReplicas,
        },
    }

    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme()).
        WithObjects(webapp, existingDep).
        WithStatusSubresource(webapp).
        Build()

    r := &controllers.WebAppReconciler{
        Client: fakeClient,
        Scheme: scheme(),
    }

    _, err := r.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "my-webapp", Namespace: "default"},
    })
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }

    dep := &appsv1.Deployment{}
    _ = fakeClient.Get(context.Background(), types.NamespacedName{Name: "my-webapp", Namespace: "default"}, dep)
    if *dep.Spec.Replicas != newReplicas {
        t.Errorf("expected replicas to be updated to %d, got %d", newReplicas, *dep.Spec.Replicas)
    }
}

func TestReconcile_NotFound_ReturnsNoError(t *testing.T) {
    fakeClient := fake.NewClientBuilder().
        WithScheme(scheme()).
        Build()

    r := &controllers.WebAppReconciler{
        Client: fakeClient,
        Scheme: scheme(),
    }

    _, err := r.Reconcile(context.Background(), ctrl.Request{
        NamespacedName: types.NamespacedName{Name: "missing", Namespace: "default"},
    })
    if err != nil {
        t.Fatalf("expected no error for missing resource, got: %v", err)
    }
}
```

### Limitations of Fake Clients

The fake client has important limitations to understand:

- It does not enforce admission webhooks
- It does not run informer caches or watch mechanisms
- Status subresource must be declared explicitly with `WithStatusSubresource`
- It does not enforce field validation from OpenAPI schemas
- Owner references and garbage collection are not enforced
- It does not run finalizer logic automatically

These limitations are acceptable for unit tests but mean that fake client tests cannot substitute for envtest when testing reconciliation against the actual API server behavior.

## Section 3: envtest Setup and Configuration

envtest uses real `kube-apiserver` and `etcd` binaries to provide a high-fidelity test environment. The binaries are downloaded and managed by the `setup-envtest` tool from `sigs.k8s.io/controller-runtime/tools/setup-envtest`.

### Installing setup-envtest

```bash
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest

# Download binaries for a specific Kubernetes version
setup-envtest use 1.29.x --bin-dir /usr/local/kubebuilder/bin

# List available versions
setup-envtest list

# Use in a shell script
export KUBEBUILDER_ASSETS=$(setup-envtest use 1.29.x -p path --bin-dir /usr/local/kubebuilder/bin)
```

### TestMain with envtest

The standard pattern is to use `TestMain` to start and stop the test environment:

```go
package controllers_test

import (
    "fmt"
    "os"
    "path/filepath"
    "testing"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    "k8s.io/client-go/kubernetes/scheme"
    "k8s.io/client-go/rest"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"

    webappv1 "example.com/webapp-operator/api/v1"
    //+kubebuilder:scaffold:imports
)

var (
    cfg       *rest.Config
    k8sClient client.Client
    testEnv   *envtest.Environment
)

func TestControllers(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
    logf.SetLogger(zap.New(zap.WriteTo(GinkgoWriter), zap.UseDevMode(true)))

    By("bootstrapping test environment")
    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{
            filepath.Join("..", "config", "crd", "bases"),
        },
        ErrorIfCRDPathMissing: true,
        // BinaryAssetsDirectory is set by KUBEBUILDER_ASSETS env var
        // or you can set it explicitly:
        // BinaryAssetsDirectory: "/usr/local/kubebuilder/bin",
    }

    var err error
    cfg, err = testEnv.Start()
    Expect(err).NotTo(HaveOccurred())
    Expect(cfg).NotTo(BeNil())

    err = webappv1.AddToScheme(scheme.Scheme)
    Expect(err).NotTo(HaveOccurred())

    //+kubebuilder:scaffold:scheme

    k8sClient, err = client.New(cfg, client.Options{Scheme: scheme.Scheme})
    Expect(err).NotTo(HaveOccurred())
    Expect(k8sClient).NotTo(BeNil())
})

var _ = AfterSuite(func() {
    By("tearing down the test environment")
    err := testEnv.Stop()
    Expect(err).NotTo(HaveOccurred())
})
```

### Running a Controller Manager in Tests

To test real reconciliation behavior, you need to start the controller manager inside the test:

```go
var _ = Describe("WebApp Controller", func() {
    var (
        ctx    context.Context
        cancel context.CancelFunc
    )

    BeforeEach(func() {
        ctx, cancel = context.WithCancel(context.Background())

        mgr, err := ctrl.NewManager(cfg, ctrl.Options{
            Scheme: scheme.Scheme,
            // Disable metrics server in tests
            MetricsBindAddress: "0",
            // Disable leader election
            LeaderElection: false,
        })
        Expect(err).NotTo(HaveOccurred())

        err = (&controllers.WebAppReconciler{
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

    AfterEach(func() {
        cancel()
    })

    It("should create a Deployment when a WebApp is created", func() {
        webapp := &webappv1.WebApp{
            ObjectMeta: metav1.ObjectMeta{
                Name:      "test-webapp",
                Namespace: "default",
            },
            Spec: webappv1.WebAppSpec{
                Replicas: 2,
                Image:    "nginx:1.25",
            },
        }
        Expect(k8sClient.Create(ctx, webapp)).Should(Succeed())

        dep := &appsv1.Deployment{}
        Eventually(func() error {
            return k8sClient.Get(ctx, types.NamespacedName{
                Name:      "test-webapp",
                Namespace: "default",
            }, dep)
        }, "10s", "250ms").Should(Succeed())

        Expect(*dep.Spec.Replicas).To(Equal(int32(2)))

        // Cleanup
        Expect(k8sClient.Delete(ctx, webapp)).Should(Succeed())
    })

    It("should update Deployment replicas when WebApp spec changes", func() {
        webapp := &webappv1.WebApp{
            ObjectMeta: metav1.ObjectMeta{
                Name:      "scaling-webapp",
                Namespace: "default",
            },
            Spec: webappv1.WebAppSpec{
                Replicas: 1,
                Image:    "nginx:1.25",
            },
        }
        Expect(k8sClient.Create(ctx, webapp)).Should(Succeed())

        // Wait for initial deployment
        dep := &appsv1.Deployment{}
        Eventually(func() error {
            return k8sClient.Get(ctx, types.NamespacedName{
                Name: "scaling-webapp", Namespace: "default",
            }, dep)
        }, "10s", "250ms").Should(Succeed())

        // Update replicas
        updated := webapp.DeepCopy()
        updated.Spec.Replicas = 5
        Expect(k8sClient.Update(ctx, updated)).Should(Succeed())

        Eventually(func() int32 {
            if err := k8sClient.Get(ctx, types.NamespacedName{
                Name: "scaling-webapp", Namespace: "default",
            }, dep); err != nil {
                return 0
            }
            if dep.Spec.Replicas == nil {
                return 0
            }
            return *dep.Spec.Replicas
        }, "10s", "250ms").Should(Equal(int32(5)))

        Expect(k8sClient.Delete(ctx, webapp)).Should(Succeed())
    })
})
```

## Section 4: CRD Installation in envtest

envtest needs to know about your CRDs. There are two approaches: loading from CRD YAML files, or installing them programmatically.

### Loading CRDs from YAML

```go
testEnv = &envtest.Environment{
    CRDDirectoryPaths: []string{
        filepath.Join("..", "..", "config", "crd", "bases"),
        // Also load third-party CRDs your operator depends on
        filepath.Join("..", "..", "testdata", "crds"),
    },
    ErrorIfCRDPathMissing: true,
}
```

### Installing CRDs Programmatically

```go
import (
    apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
)

crd := &apiextensionsv1.CustomResourceDefinition{
    ObjectMeta: metav1.ObjectMeta{
        Name: "webapps.webapp.example.com",
    },
    Spec: apiextensionsv1.CustomResourceDefinitionSpec{
        Group: "webapp.example.com",
        Versions: []apiextensionsv1.CustomResourceDefinitionVersion{
            {
                Name:    "v1",
                Served:  true,
                Storage: true,
                Schema: &apiextensionsv1.CustomResourceValidation{
                    OpenAPIV3Schema: &apiextensionsv1.JSONSchemaProps{
                        Type: "object",
                        Properties: map[string]apiextensionsv1.JSONSchemaProps{
                            "spec": {
                                Type: "object",
                                Properties: map[string]apiextensionsv1.JSONSchemaProps{
                                    "replicas": {Type: "integer"},
                                    "image":    {Type: "string"},
                                },
                            },
                        },
                    },
                },
            },
        },
        Scope: apiextensionsv1.NamespaceScoped,
        Names: apiextensionsv1.CustomResourceDefinitionNames{
            Plural:   "webapps",
            Singular: "webapp",
            Kind:     "WebApp",
        },
    },
}

crds, err := envtest.InstallCRDs(cfg, envtest.CRDInstallOptions{
    CRDs: []*apiextensionsv1.CustomResourceDefinition{crd},
})
```

## Section 5: Webhook Testing with envtest

Admission webhooks are among the hardest parts of operators to test. envtest supports webhook testing, but requires TLS configuration.

### Configuring envtest for Webhook Tests

```go
import (
    "sigs.k8s.io/controller-runtime/pkg/envtest"
    "sigs.k8s.io/controller-runtime/pkg/webhook"
)

testEnv = &envtest.Environment{
    CRDDirectoryPaths:     []string{filepath.Join("..", "config", "crd", "bases")},
    ErrorIfCRDPathMissing: true,
    WebhookInstallOptions: envtest.WebhookInstallOptions{
        Paths: []string{filepath.Join("..", "config", "webhook")},
    },
}

cfg, err := testEnv.Start()
Expect(err).NotTo(HaveOccurred())

// The webhook server needs TLS certificates that envtest generates
webhookInstallOptions := testEnv.WebhookInstallOptions
mgr, err := ctrl.NewManager(cfg, ctrl.Options{
    Scheme:             scheme.Scheme,
    Host:               webhookInstallOptions.LocalServingHost,
    Port:               webhookInstallOptions.LocalServingPort,
    CertDir:            webhookInstallOptions.LocalServingCertDir,
    LeaderElection:     false,
    MetricsBindAddress: "0",
})
```

### Registering Webhooks

```go
// In your main_test.go BeforeSuite
err = (&webappv1.WebApp{}).SetupWebhookWithManager(mgr)
Expect(err).NotTo(HaveOccurred())

//+kubebuilder:scaffold:webhook

go func() {
    defer GinkgoRecover()
    err = mgr.Start(ctx)
    Expect(err).NotTo(HaveOccurred())
}()

// Wait for webhook server to be ready
dialer := &net.Dialer{Timeout: time.Second}
addrPort := fmt.Sprintf("%s:%d",
    webhookInstallOptions.LocalServingHost,
    webhookInstallOptions.LocalServingPort,
)
Eventually(func() error {
    conn, err := tls.DialWithDialer(dialer, "tcp", addrPort, &tls.Config{InsecureSkipVerify: true})
    if err != nil {
        return err
    }
    conn.Close()
    return nil
}).Should(Succeed())
```

### Writing Webhook Test Cases

```go
var _ = Describe("WebApp Webhook", func() {
    Context("Validation", func() {
        It("should reject negative replicas", func() {
            webapp := &webappv1.WebApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "invalid-webapp",
                    Namespace: "default",
                },
                Spec: webappv1.WebAppSpec{
                    Replicas: -1,
                    Image:    "nginx:1.25",
                },
            }
            err := k8sClient.Create(ctx, webapp)
            Expect(err).To(HaveOccurred())
            Expect(err.Error()).To(ContainSubstring("replicas must be non-negative"))
        })

        It("should reject empty image", func() {
            webapp := &webappv1.WebApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "no-image-webapp",
                    Namespace: "default",
                },
                Spec: webappv1.WebAppSpec{
                    Replicas: 1,
                    Image:    "",
                },
            }
            err := k8sClient.Create(ctx, webapp)
            Expect(err).To(HaveOccurred())
        })
    })

    Context("Defaulting", func() {
        It("should default replicas to 1 if not specified", func() {
            webapp := &webappv1.WebApp{
                ObjectMeta: metav1.ObjectMeta{
                    Name:      "default-webapp",
                    Namespace: "default",
                },
                Spec: webappv1.WebAppSpec{
                    Image: "nginx:1.25",
                },
            }
            Expect(k8sClient.Create(ctx, webapp)).Should(Succeed())
            Expect(webapp.Spec.Replicas).To(Equal(int32(1)))
            Expect(k8sClient.Delete(ctx, webapp)).Should(Succeed())
        })
    })
})
```

## Section 6: envtest vs Fake Client Trade-offs

Choosing between fake clients and envtest requires understanding the cost/benefit:

| Concern | Fake Client | envtest |
|---|---|---|
| Test speed | Milliseconds | Seconds (startup) |
| API server validation | No | Yes |
| Webhook enforcement | No | Yes |
| Watch/informer behavior | No | Yes |
| Finalizer behavior | No | Yes |
| Status subresource | Manual opt-in | Real subresource |
| External dependencies | None | kube-apiserver + etcd binaries |
| CI requirements | Standard Go toolchain | KUBEBUILDER_ASSETS |

### When to Use Fake Clients

Use fake clients when:
- Testing pure logic in helper functions
- Testing error paths that are hard to trigger via envtest
- Testing rate limiting, retry logic, and backoff behavior
- You need tests to run in under 100ms per test case

### When to Use envtest

Use envtest when:
- Testing admission webhook logic
- Testing owner reference and garbage collection behavior
- Testing watch-triggered reconciliation
- Testing interactions between multiple reconcilers
- Validating CRD schema enforcement

## Section 7: Parameterized Test Helpers

A common pattern is to build table-driven tests that run against either fake or envtest clients:

```go
package controllers_test

import (
    "context"
    "testing"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"

    webappv1 "example.com/webapp-operator/api/v1"
)

type reconcileTestCase struct {
    name          string
    existingObjs  []client.Object
    webappName    string
    wantReplicas  int32
    wantError     bool
}

func runReconcileTests(t *testing.T, c client.Client, cases []reconcileTestCase) {
    t.Helper()
    for _, tc := range cases {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            ctx := context.Background()
            for _, obj := range tc.existingObjs {
                if err := c.Create(ctx, obj); err != nil {
                    t.Fatalf("setup failed: %v", err)
                }
                t.Cleanup(func() {
                    _ = c.Delete(ctx, obj)
                })
            }
            // ... run reconcile and assert
        })
    }
}
```

## Section 8: End-to-End Tests with kind

End-to-end tests validate that the operator works correctly in a real cluster. kind (Kubernetes in Docker) is the standard tool for this in CI.

### Setting Up kind in CI

```yaml
# .github/workflows/e2e.yaml
name: E2E Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      - name: Install kind
        run: |
          curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.23.0/kind-linux-amd64
          chmod +x ./kind
          sudo mv ./kind /usr/local/bin/kind

      - name: Create kind cluster
        run: kind create cluster --config=./e2e/kind-config.yaml

      - name: Install CRDs
        run: make install

      - name: Build and load operator image
        run: |
          make docker-build IMG=webapp-operator:e2e
          kind load docker-image webapp-operator:e2e

      - name: Deploy operator
        run: make deploy IMG=webapp-operator:e2e

      - name: Run E2E tests
        run: go test ./e2e/... -v -timeout 10m

      - name: Collect logs on failure
        if: failure()
        run: |
          kubectl logs -n webapp-system -l control-plane=controller-manager
          kubectl get events --all-namespaces
```

### kind Configuration

```yaml
# e2e/kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 8080
        protocol: TCP
  - role: worker
  - role: worker
```

### E2E Test Structure

```go
package e2e_test

import (
    "context"
    "fmt"
    "os/exec"
    "testing"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/apimachinery/pkg/util/wait"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/clientcmd"

    webappv1 "example.com/webapp-operator/api/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

func kubeClient(t *testing.T) (client.Client, *kubernetes.Clientset) {
    t.Helper()
    cfg, err := clientcmd.BuildConfigFromFlags("", clientcmd.RecommendedHomeFile)
    if err != nil {
        t.Fatalf("failed to build kubeconfig: %v", err)
    }
    c, err := client.New(cfg, client.Options{})
    if err != nil {
        t.Fatalf("failed to create client: %v", err)
    }
    cs, err := kubernetes.NewForConfig(cfg)
    if err != nil {
        t.Fatalf("failed to create clientset: %v", err)
    }
    return c, cs
}

func TestE2E_WebAppLifecycle(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping e2e test in short mode")
    }

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
    defer cancel()

    c, cs := kubeClient(t)

    ns := &corev1.Namespace{
        ObjectMeta: metav1.ObjectMeta{
            Name: fmt.Sprintf("e2e-test-%d", time.Now().Unix()),
        },
    }
    if _, err := cs.CoreV1().Namespaces().Create(ctx, ns, metav1.CreateOptions{}); err != nil {
        t.Fatalf("failed to create namespace: %v", err)
    }
    t.Cleanup(func() {
        _ = cs.CoreV1().Namespaces().Delete(ctx, ns.Name, metav1.DeleteOptions{})
    })

    webapp := &webappv1.WebApp{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "e2e-webapp",
            Namespace: ns.Name,
        },
        Spec: webappv1.WebAppSpec{
            Replicas: 2,
            Image:    "nginx:1.25-alpine",
        },
    }
    if err := c.Create(ctx, webapp); err != nil {
        t.Fatalf("failed to create WebApp: %v", err)
    }

    // Wait for Deployment to be created
    t.Log("waiting for Deployment to be created...")
    dep := &appsv1.Deployment{}
    if err := wait.PollUntilContextTimeout(ctx, 2*time.Second, 2*time.Minute, true, func(ctx context.Context) (bool, error) {
        err := c.Get(ctx, types.NamespacedName{Name: "e2e-webapp", Namespace: ns.Name}, dep)
        if err != nil {
            return false, nil
        }
        return true, nil
    }); err != nil {
        t.Fatalf("Deployment was not created: %v", err)
    }

    // Wait for replicas to be ready
    t.Log("waiting for replicas to be ready...")
    if err := wait.PollUntilContextTimeout(ctx, 5*time.Second, 3*time.Minute, true, func(ctx context.Context) (bool, error) {
        if err := c.Get(ctx, types.NamespacedName{Name: "e2e-webapp", Namespace: ns.Name}, dep); err != nil {
            return false, nil
        }
        return dep.Status.ReadyReplicas == 2, nil
    }); err != nil {
        t.Fatalf("replicas did not become ready: %v", err)
    }

    // Scale up
    t.Log("scaling to 4 replicas...")
    updated := webapp.DeepCopy()
    if err := c.Get(ctx, types.NamespacedName{Name: "e2e-webapp", Namespace: ns.Name}, updated); err != nil {
        t.Fatalf("failed to get latest webapp: %v", err)
    }
    updated.Spec.Replicas = 4
    if err := c.Update(ctx, updated); err != nil {
        t.Fatalf("failed to update WebApp: %v", err)
    }

    if err := wait.PollUntilContextTimeout(ctx, 5*time.Second, 3*time.Minute, true, func(ctx context.Context) (bool, error) {
        if err := c.Get(ctx, types.NamespacedName{Name: "e2e-webapp", Namespace: ns.Name}, dep); err != nil {
            return false, nil
        }
        return dep.Status.ReadyReplicas == 4, nil
    }); err != nil {
        t.Fatalf("scale-up did not complete: %v", err)
    }

    t.Log("E2E test passed")
}
```

## Section 9: Makefile Integration

The kubebuilder Makefile conventions make it easy to integrate tests into CI:

```makefile
# Makefile

ENVTEST_K8S_VERSION = 1.29.x
ENVTEST = $(LOCALBIN)/setup-envtest

.PHONY: envtest
envtest: $(ENVTEST)
$(ENVTEST): $(LOCALBIN)
	test -s $(LOCALBIN)/setup-envtest || \
	GOBIN=$(LOCALBIN) go install sigs.k8s.io/controller-runtime/tools/setup-envtest@latest

.PHONY: test
test: manifests generate fmt vet envtest
	KUBEBUILDER_ASSETS="$(shell $(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(LOCALBIN) -p path)" \
	go test ./... -coverprofile cover.out -timeout 5m

.PHONY: test-unit
test-unit:
	go test ./... -short -coverprofile cover-unit.out

.PHONY: test-integration
test-integration: envtest
	KUBEBUILDER_ASSETS="$(shell $(ENVTEST) use $(ENVTEST_K8S_VERSION) --bin-dir $(LOCALBIN) -p path)" \
	go test ./... -run Integration -v -timeout 5m

.PHONY: test-e2e
test-e2e:
	go test ./e2e/... -v -timeout 15m

.PHONY: test-all
test-all: test test-e2e
```

## Section 10: Testing Finalizers

Finalizers require careful testing because deletion is asynchronous:

```go
var _ = Describe("WebApp Finalizer", func() {
    It("should run cleanup logic before deletion", func() {
        webapp := &webappv1.WebApp{
            ObjectMeta: metav1.ObjectMeta{
                Name:      "finalizer-webapp",
                Namespace: "default",
            },
            Spec: webappv1.WebAppSpec{
                Replicas: 1,
                Image:    "nginx:1.25",
            },
        }
        Expect(k8sClient.Create(ctx, webapp)).Should(Succeed())

        // Wait for finalizer to be added
        Eventually(func() []string {
            updated := &webappv1.WebApp{}
            if err := k8sClient.Get(ctx, types.NamespacedName{
                Name: "finalizer-webapp", Namespace: "default",
            }, updated); err != nil {
                return nil
            }
            return updated.Finalizers
        }, "10s", "250ms").Should(ContainElement("webapp.example.com/cleanup"))

        // Delete the resource
        Expect(k8sClient.Delete(ctx, webapp)).Should(Succeed())

        // Verify external cleanup was called (e.g., via a mock or side effect)
        // ...

        // Verify the resource is eventually gone
        Eventually(func() bool {
            err := k8sClient.Get(ctx, types.NamespacedName{
                Name: "finalizer-webapp", Namespace: "default",
            }, &webappv1.WebApp{})
            return errors.IsNotFound(err)
        }, "30s", "500ms").Should(BeTrue())
    })
})
```

## Section 11: Coverage and Reporting

```bash
# Run tests with coverage
KUBEBUILDER_ASSETS="$(setup-envtest use 1.29.x -p path)" \
go test ./... -coverprofile=cover.out -coverpkg=./...

# View coverage by package
go tool cover -func=cover.out | grep -v "100.0%"

# Generate HTML coverage report
go tool cover -html=cover.out -o coverage.html

# Check minimum coverage threshold
COVERAGE=$(go tool cover -func=cover.out | tail -1 | awk '{print $3}' | sed 's/%//')
if (( $(echo "$COVERAGE < 70" | bc -l) )); then
    echo "Coverage $COVERAGE% is below 70% threshold"
    exit 1
fi
```

## Section 12: Best Practices and Pitfalls

### Race Conditions in envtest Tests

Always use `Eventually` with appropriate timeouts rather than direct assertions after reconcile:

```go
// Wrong - reconciliation is asynchronous
Expect(k8sClient.Create(ctx, webapp)).Should(Succeed())
dep := &appsv1.Deployment{}
Expect(k8sClient.Get(ctx, namespacedName, dep)).Should(Succeed()) // may fail

// Correct
Expect(k8sClient.Create(ctx, webapp)).Should(Succeed())
dep := &appsv1.Deployment{}
Eventually(func() error {
    return k8sClient.Get(ctx, namespacedName, dep)
}, "10s", "250ms").Should(Succeed())
```

### Namespace Isolation Between Tests

Create a unique namespace per test to avoid cross-test pollution:

```go
func uniqueNamespace(prefix string) *corev1.Namespace {
    return &corev1.Namespace{
        ObjectMeta: metav1.ObjectMeta{
            Name: fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano()),
        },
    }
}
```

### Cleaning Up Resources

Always clean up resources after each test to avoid interference:

```go
DeferCleanup(func() {
    Expect(k8sClient.Delete(ctx, webapp)).Should(Succeed())
    // Wait for deletion to complete if finalizers are involved
    Eventually(func() bool {
        err := k8sClient.Get(ctx, namespacedName, &webappv1.WebApp{})
        return errors.IsNotFound(err)
    }, "30s", "500ms").Should(BeTrue())
})
```

### envtest Startup Optimization

envtest startup takes 3-5 seconds. Run it once per test suite in `BeforeSuite`, not per test:

```go
// Good: one envtest.Environment per suite
var _ = BeforeSuite(func() {
    testEnv = &envtest.Environment{...}
    cfg, err = testEnv.Start()
})

// Bad: one per test (very slow)
func TestSomething(t *testing.T) {
    env := &envtest.Environment{...}
    cfg, _ := env.Start()
    defer env.Stop()
    // ...
}
```

## Conclusion

A well-structured operator test suite gives you confidence that your controller handles all the complex state transitions Kubernetes operators must manage. The layered approach — fast fake client unit tests, envtest integration tests for reconciler behavior and webhooks, and kind-based e2e tests for full operational validation — provides the right coverage at each level of the testing pyramid. By using kubebuilder's scaffolding for test setup and Ginkgo/Gomega for expressive assertions, you can build a test suite that catches regressions early and validates operator behavior in conditions that closely mirror production.
