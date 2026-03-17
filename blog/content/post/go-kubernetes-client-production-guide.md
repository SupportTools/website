---
title: "Go Kubernetes Client: Building Production-Grade Controllers and Operators"
date: 2027-09-07T00:00:00-05:00
draft: false
tags: ["Go", "Kubernetes", "client-go", "Operators"]
categories:
- Go
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to client-go: informers, listers, work queues, leader election, event recording, controller-runtime, dynamic clients, and envtest-based testing."
more_link: "yes"
url: "/go-kubernetes-client-production-guide/"
---

The Kubernetes ecosystem offers two primary paths for writing controllers: the low-level `client-go` library and the higher-level `controller-runtime` framework that powers Kubebuilder and Operator SDK. Understanding both layers — and when to reach for each — separates operators that survive production from operators that create incidents. This guide covers the complete picture: informer caches, work queues, leader election, event recording, the dynamic client for CRDs, and integration testing with `envtest`.

<!--more-->

## Section 1: Project Setup and Dependency Management

Start with a clean module that pins the Kubernetes API versions to a known-good set. The `k8s.io` packages use a coordinated release cycle; mixing versions produces confusing compile errors.

```bash
mkdir myoperator && cd myoperator
go mod init github.com/example/myoperator
go get k8s.io/client-go@v0.29.2
go get k8s.io/api@v0.29.2
go get k8s.io/apimachinery@v0.29.2
go get k8s.io/code-generator@v0.29.2
go get sigs.k8s.io/controller-runtime@v0.17.2
```

Verify the dependency graph is consistent:

```bash
go mod tidy
go mod verify
```

A minimal `go.work` file is useful when developing against a local fork of `client-go`:

```text
go 1.22

use (
    .
    ../client-go
)
```

### Kubeconfig Loading

Production controllers run both inside and outside the cluster. The standard pattern handles both transparently:

```go
package client

import (
    "fmt"
    "os"

    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
    "k8s.io/client-go/tools/clientcmd"
)

// NewClientset returns a Kubernetes clientset configured for the current environment.
// Inside a pod it uses the in-cluster service account; outside it reads KUBECONFIG.
func NewClientset() (kubernetes.Interface, error) {
    cfg, err := restConfig()
    if err != nil {
        return nil, fmt.Errorf("building rest config: %w", err)
    }
    return kubernetes.NewForConfig(cfg)
}

func restConfig() (*rest.Config, error) {
    // Prefer explicit kubeconfig path.
    if kc := os.Getenv("KUBECONFIG"); kc != "" {
        return clientcmd.BuildConfigFromFlags("", kc)
    }
    // Fall back to in-cluster config.
    cfg, err := rest.InClusterConfig()
    if err == nil {
        return cfg, nil
    }
    // Last resort: default kubeconfig location.
    return clientcmd.BuildConfigFromFlags("", clientcmd.RecommendedHomeFile)
}
```

Tune the REST client for higher throughput in controllers that reconcile many objects:

```go
cfg.QPS = 100
cfg.Burst = 200
```

## Section 2: Informers and Listers

Informers are the backbone of every efficient Kubernetes controller. They maintain a local cache of API objects populated via a single long-running watch, eliminating per-reconcile API calls.

### SharedInformerFactory

```go
package informers

import (
    "time"

    "k8s.io/client-go/informers"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/cache"
)

// BuildFactory creates a shared informer factory that resynchronises
// the local cache every 30 minutes.
func BuildFactory(cs kubernetes.Interface) informers.SharedInformerFactory {
    return informers.NewSharedInformerFactoryWithOptions(
        cs,
        30*time.Minute,
        informers.WithNamespace(""), // watch all namespaces; restrict as needed
    )
}

// WireDeploymentInformer registers event handlers and returns the lister.
func WireDeploymentInformer(
    factory informers.SharedInformerFactory,
    addFn, updateFn, deleteFn func(obj interface{}),
) cache.SharedIndexInformer {
    inf := factory.Apps().V1().Deployments().Informer()
    inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc:    addFn,
        UpdateFunc: func(_, newObj interface{}) { updateFn(newObj) },
        DeleteFunc: deleteFn,
    })
    return inf
}
```

### Lister Usage

Listers read from the in-memory cache without hitting the API server:

```go
func getDeployment(factory informers.SharedInformerFactory, ns, name string) error {
    lister := factory.Apps().V1().Deployments().Lister()
    dep, err := lister.Deployments(ns).Get(name)
    if err != nil {
        return fmt.Errorf("lister get %s/%s: %w", ns, name, err)
    }
    fmt.Printf("deployment %s has %d replicas\n", dep.Name, *dep.Spec.Replicas)
    return nil
}
```

Always wait for the cache to sync before processing events:

```go
stopCh := make(chan struct{})
factory.Start(stopCh)
if !cache.WaitForCacheSync(stopCh,
    factory.Apps().V1().Deployments().Informer().HasSynced,
    factory.Core().V1().Pods().Informer().HasSynced,
) {
    return fmt.Errorf("caches never synced")
}
```

## Section 3: Work Queue Patterns

The reconciliation loop should be decoupled from the informer callbacks via a rate-limiting work queue. This prevents cascading failures when the API server is slow and provides natural back-pressure.

```go
package controller

import (
    "context"
    "fmt"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    "k8s.io/apimachinery/pkg/util/runtime"
    "k8s.io/apimachinery/pkg/util/wait"
    "k8s.io/client-go/tools/cache"
    "k8s.io/client-go/util/workqueue"
)

// Controller reconciles Deployments.
type Controller struct {
    queue    workqueue.RateLimitingInterface
    informer cache.SharedIndexInformer
}

// New constructs a Controller with sensible rate-limiting defaults.
func New(informer cache.SharedIndexInformer) *Controller {
    c := &Controller{
        queue: workqueue.NewRateLimitingQueueWithConfig(
            workqueue.NewItemExponentialFailureRateLimiter(
                500*time.Millisecond, // base delay
                60*time.Second,       // max delay
            ),
            workqueue.RateLimitingQueueConfig{Name: "deployment-controller"},
        ),
        informer: informer,
    }
    informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc:    c.enqueue,
        UpdateFunc: func(_, n interface{}) { c.enqueue(n) },
        DeleteFunc: c.enqueue,
    })
    return c
}

func (c *Controller) enqueue(obj interface{}) {
    key, err := cache.MetaNamespaceKeyFunc(obj)
    if err != nil {
        runtime.HandleError(fmt.Errorf("enqueue key: %w", err))
        return
    }
    c.queue.Add(key)
}

// Run starts workers and blocks until ctx is cancelled.
func (c *Controller) Run(ctx context.Context, workers int) {
    defer c.queue.ShutDown()
    for i := 0; i < workers; i++ {
        go wait.UntilWithContext(ctx, c.runWorker, time.Second)
    }
    <-ctx.Done()
}

func (c *Controller) runWorker(ctx context.Context) {
    for c.processNext(ctx) {
    }
}

func (c *Controller) processNext(ctx context.Context) bool {
    item, quit := c.queue.Get()
    if quit {
        return false
    }
    defer c.queue.Done(item)

    key, ok := item.(string)
    if !ok {
        c.queue.Forget(item)
        return true
    }

    if err := c.reconcile(ctx, key); err != nil {
        if c.queue.NumRequeues(item) < 5 {
            c.queue.AddRateLimited(item)
            return true
        }
        c.queue.Forget(item)
        runtime.HandleError(fmt.Errorf("reconcile %s exceeded retries: %w", key, err))
        return true
    }
    c.queue.Forget(item)
    return true
}

func (c *Controller) reconcile(_ context.Context, key string) error {
    ns, name, err := cache.SplitMetaNamespaceKey(key)
    if err != nil {
        return fmt.Errorf("split key %q: %w", key, err)
    }
    obj, exists, err := c.informer.GetIndexer().GetByKey(key)
    if err != nil {
        return fmt.Errorf("indexer get %s/%s: %w", ns, name, err)
    }
    if !exists {
        fmt.Printf("deployment %s/%s deleted\n", ns, name)
        return nil
    }
    dep := obj.(*appsv1.Deployment)
    fmt.Printf("reconciling deployment %s/%s replicas=%d\n",
        dep.Namespace, dep.Name, *dep.Spec.Replicas)
    return nil
}
```

## Section 4: Leader Election

Running multiple replicas of a controller without leader election causes split-brain reconciliation. The `client-go` leader election package uses Kubernetes `Lease` objects as a distributed lock.

```go
package leaderelection

import (
    "context"
    "os"
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/leaderelection"
    "k8s.io/client-go/tools/leaderelection/resourcelock"
)

// Run executes onStartedLeading while holding the lock and calls
// onStoppedLeading when the lock is lost. The function blocks until ctx
// is cancelled or leadership is lost.
func Run(ctx context.Context, cs kubernetes.Interface, onStartedLeading func(ctx context.Context), onStoppedLeading func()) {
    id, _ := os.Hostname()
    lock := &resourcelock.LeaseLock{
        LeaseMeta: metav1.ObjectMeta{
            Name:      "myoperator-leader",
            Namespace: "myoperator-system",
        },
        Client: cs.CoordinationV1(),
        LockConfig: resourcelock.ResourceLockConfig{
            Identity: id,
        },
    }

    leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
        Lock:            lock,
        LeaseDuration:   15 * time.Second,
        RenewDeadline:   10 * time.Second,
        RetryPeriod:     2 * time.Second,
        ReleaseOnCancel: true,
        Callbacks: leaderelection.LeaderCallbacks{
            OnStartedLeading: onStartedLeading,
            OnStoppedLeading: onStoppedLeading,
            OnNewLeader: func(identity string) {
                if identity != id {
                    // A different pod holds the lock.
                }
            },
        },
    })
}
```

The recommended `LeaseDuration:RenewDeadline:RetryPeriod` ratio is roughly `3:2:1`. Deviating from this can cause unnecessary failovers or lock contention.

## Section 5: Event Recording

Kubernetes events appear in `kubectl describe` output and are critical for operator observability. Always record events for significant state transitions.

```go
package events

import (
    "fmt"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/kubernetes/scheme"
    typedcorev1 "k8s.io/client-go/kubernetes/typed/core/v1"
    "k8s.io/client-go/tools/record"
)

// NewRecorder creates an EventRecorder scoped to a controller name.
func NewRecorder(cs kubernetes.Interface, controllerName string) record.EventRecorder {
    broadcaster := record.NewBroadcaster()
    broadcaster.StartStructuredLogging(0)
    broadcaster.StartRecordingToSink(&typedcorev1.EventSinkImpl{
        Interface: cs.CoreV1().Events(""),
    })
    return broadcaster.NewRecorder(scheme.Scheme, corev1.EventSource{
        Component: controllerName,
    })
}

// RecordReconcileError records a Warning event on the given object.
func RecordReconcileError(recorder record.EventRecorder, obj runtime.Object, err error) {
    recorder.Eventf(obj, corev1.EventTypeWarning, "ReconcileError",
        "reconciliation failed: %v", err)
}

// RecordScaleEvent records a Normal event describing a replica change.
func RecordScaleEvent(recorder record.EventRecorder, obj runtime.Object, from, to int32) {
    recorder.Eventf(obj, corev1.EventTypeNormal, "ScaledDeployment",
        "scaled replicas from %d to %d", from, to)
}

// Example usage:
func exampleUsage() {
    _ = fmt.Sprintf("recorder.Event(deployment, corev1.EventTypeNormal, \"Synced\", \"synced successfully\")")
}
```

## Section 6: controller-runtime vs Bare client-go

`controller-runtime` (used by Kubebuilder and Operator SDK) provides a Manager, reconciler interface, scheme registration, and webhook support on top of `client-go`. Choose based on the following criteria:

| Concern | Bare client-go | controller-runtime |
|---|---|---|
| Boilerplate | High | Low |
| Flexibility | Maximum | Opinionated |
| CRD webhooks | Manual | Built-in |
| Multiple controllers | Manual wiring | Manager handles it |
| Testing | envtest directly | envtest via suite |
| Learning curve | Steeper | Gentler |

A minimal `controller-runtime` reconciler:

```go
package reconciler

import (
    "context"
    "fmt"

    appsv1 "k8s.io/api/apps/v1"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// DeploymentReconciler watches Deployments and prints replica counts.
type DeploymentReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

func (r *DeploymentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var dep appsv1.Deployment
    if err := r.Get(ctx, req.NamespacedName, &dep); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }
    fmt.Printf("reconcile %s/%s\n", dep.Namespace, dep.Name)
    return ctrl.Result{}, nil
}

func (r *DeploymentReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&appsv1.Deployment{}).
        Complete(r)
}
```

Wire the manager in `main.go`:

```go
mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
    Scheme:                 scheme,
    MetricsBindAddress:     ":8080",
    HealthProbeBindAddress: ":8081",
    LeaderElection:         true,
    LeaderElectionID:       "myoperator-leader.example.com",
})
if err != nil {
    panic(err)
}
if err := (&reconciler.DeploymentReconciler{
    Client: mgr.GetClient(),
    Scheme: mgr.GetScheme(),
}).SetupWithManager(mgr); err != nil {
    panic(err)
}
mgr.AddHealthzCheck("healthz", healthz.Ping)
mgr.AddReadyzCheck("readyz", healthz.Ping)
if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
    panic(err)
}
```

## Section 7: Dynamic Client for CRDs

When the CRD type is unknown at compile time — for example, in generic tooling — use the dynamic client with `unstructured.Unstructured`:

```go
package dynamic

import (
    "context"
    "fmt"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/client-go/dynamic"
    "k8s.io/client-go/rest"
)

var widgetGVR = schema.GroupVersionResource{
    Group:    "example.com",
    Version:  "v1alpha1",
    Resource: "widgets",
}

// ListWidgets returns all Widget CRs in a namespace using the dynamic client.
func ListWidgets(cfg *rest.Config, namespace string) ([]unstructured.Unstructured, error) {
    dc, err := dynamic.NewForConfig(cfg)
    if err != nil {
        return nil, fmt.Errorf("dynamic client: %w", err)
    }
    list, err := dc.Resource(widgetGVR).Namespace(namespace).List(context.TODO(), metav1.ListOptions{})
    if err != nil {
        return nil, fmt.Errorf("list widgets: %w", err)
    }
    return list.Items, nil
}

// PatchWidgetStatus updates a Widget's status subresource.
func PatchWidgetStatus(cfg *rest.Config, namespace, name string, phase string) error {
    dc, err := dynamic.NewForConfig(cfg)
    if err != nil {
        return fmt.Errorf("dynamic client: %w", err)
    }
    patch := &unstructured.Unstructured{}
    patch.SetUnstructuredContent(map[string]interface{}{
        "status": map[string]interface{}{
            "phase": phase,
        },
    })
    data, err := patch.MarshalJSON()
    if err != nil {
        return err
    }
    _, err = dc.Resource(widgetGVR).Namespace(namespace).
        Patch(context.TODO(), name, types.MergePatchType, data,
            metav1.PatchOptions{}, "status")
    return err
}
```

### Server-Side Apply with Dynamic Client

Server-side apply eliminates field ownership conflicts in multi-actor environments:

```go
import "k8s.io/apimachinery/pkg/types"

func ApplyWidget(dc dynamic.Interface, namespace string, obj *unstructured.Unstructured) error {
    data, err := obj.MarshalJSON()
    if err != nil {
        return err
    }
    _, err = dc.Resource(widgetGVR).Namespace(namespace).
        Apply(context.TODO(), obj.GetName(), obj,
            metav1.ApplyOptions{FieldManager: "myoperator", Force: true})
    _ = data
    return err
}
```

## Section 8: Testing Controllers with envtest

`controller-runtime/pkg/envtest` spins up a real API server and etcd binary, enabling integration tests without a full cluster.

```go
package controller_test

import (
    "context"
    "path/filepath"
    "testing"
    "time"

    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/envtest"
)

var (
    testEnv   *envtest.Environment
    k8sClient client.Client
    ctx       context.Context
    cancel    context.CancelFunc
)

func TestController(t *testing.T) {
    RegisterFailHandler(Fail)
    RunSpecs(t, "Controller Suite")
}

var _ = BeforeSuite(func() {
    ctx, cancel = context.WithCancel(context.TODO())
    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{filepath.Join("..", "config", "crd", "bases")},
        BinaryAssetsDirectory: filepath.Join("..", "bin", "k8s",
            "1.29.0-linux-amd64"),
    }
    cfg, err := testEnv.Start()
    Expect(err).NotTo(HaveOccurred())

    mgr, err := ctrl.NewManager(cfg, ctrl.Options{Scheme: scheme.Scheme})
    Expect(err).NotTo(HaveOccurred())

    k8sClient = mgr.GetClient()
    go func() {
        defer GinkgoRecover()
        Expect(mgr.Start(ctx)).To(Succeed())
    }()
})

var _ = AfterSuite(func() {
    cancel()
    Expect(testEnv.Stop()).To(Succeed())
})

var _ = Describe("DeploymentReconciler", func() {
    It("should observe a new deployment", func() {
        ns := &corev1.Namespace{
            ObjectMeta: metav1.ObjectMeta{Name: "test-ns"},
        }
        Expect(k8sClient.Create(ctx, ns)).To(Succeed())

        replicas := int32(2)
        dep := &appsv1.Deployment{
            ObjectMeta: metav1.ObjectMeta{
                Name:      "test-deploy",
                Namespace: "test-ns",
            },
            Spec: appsv1.DeploymentSpec{
                Replicas: &replicas,
                Selector: &metav1.LabelSelector{
                    MatchLabels: map[string]string{"app": "test"},
                },
                Template: corev1.PodTemplateSpec{
                    ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "test"}},
                    Spec: corev1.PodSpec{
                        Containers: []corev1.Container{{Name: "c", Image: "nginx:latest"}},
                    },
                },
            },
        }
        Expect(k8sClient.Create(ctx, dep)).To(Succeed())

        Eventually(func() bool {
            var d appsv1.Deployment
            err := k8sClient.Get(ctx, client.ObjectKeyFromObject(dep), &d)
            return err == nil
        }, 10*time.Second, 250*time.Millisecond).Should(BeTrue())
    })
})
```

Install the envtest binaries before running tests:

```bash
ENVTEST_ASSETS_DIR=$(pwd)/bin/k8s
mkdir -p ${ENVTEST_ASSETS_DIR}
go run sigs.k8s.io/controller-runtime/tools/setup-envtest@latest \
    use 1.29.0 --bin-dir ${ENVTEST_ASSETS_DIR} -p path
```

## Section 9: Production Checklist

Before shipping a controller to production, verify these items:

```text
Informer cache synced before processing any events
Work queue rate limiter configured with sensible base/max delays
Leader election enabled with Lease (not ConfigMap) lock
Events recorded for all significant state transitions
Metrics exposed on /metrics (controller_runtime_reconcile_total, etc.)
Health endpoints /healthz and /readyz wired to manager
RBAC ClusterRole/RoleBinding scoped to minimum required verbs
Finalizers removed before object deletion to prevent orphaned resources
Status conditions updated according to Kubernetes API conventions
envtest integration tests pass in CI without a live cluster
```

### RBAC Minimum Permissions

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: myoperator-controller
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "update", "patch"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  verbs: ["get", "create", "update"]
```

## Section 10: Performance Tuning

For controllers managing tens of thousands of objects, tune the following parameters:

```go
// Increase informer resync period to reduce unnecessary reconciliations.
factory := informers.NewSharedInformerFactoryWithOptions(cs, 10*time.Minute)

// Use a custom rate limiter for high-throughput controllers.
limiter := workqueue.NewMaxOfRateLimiter(
    workqueue.NewItemExponentialFailureRateLimiter(5*time.Millisecond, 30*time.Second),
    // Bucket limiter: 10 items per second, burst of 100.
    &workqueue.BucketRateLimiter{Limiter: rate.NewLimiter(rate.Limit(10), 100)},
)

// Use server-side filtering to reduce watch events.
factory := informers.NewSharedInformerFactoryWithOptions(cs, 30*time.Minute,
    informers.WithTweakListOptions(func(opts *metav1.ListOptions) {
        opts.LabelSelector = "managed-by=myoperator"
    }),
)
```

Partition large clusters by namespace using a namespace-scoped informer factory to reduce memory footprint per controller replica:

```go
factory := informers.NewSharedInformerFactoryWithOptions(
    cs,
    30*time.Minute,
    informers.WithNamespace("production"),
)
```
