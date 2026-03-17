---
title: "Kubernetes Lease API and Leader Election Patterns for Operators"
date: 2028-12-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operator", "Leader Election", "Lease API", "Go", "High Availability"]
categories:
- Kubernetes
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive enterprise guide to the Kubernetes Lease API and leader election patterns for Kubernetes operators, covering the coordination.k8s.io/v1 Lease resource, controller-runtime leader election configuration, custom lease management, and multi-active patterns for stateless controllers."
more_link: "yes"
url: "/kubernetes-lease-api-leader-election-operator-patterns-guide/"
---

Kubernetes operators are control loops that run as multiple replicas for high availability. But most operator logic is not safe to run concurrently — reconciling the same resource from two pods simultaneously leads to conflicting writes, duplicate operations, and race conditions. Leader election solves this by ensuring only one replica (the leader) actively reconciles, while others stand by ready to take over within seconds if the leader fails.

The Kubernetes `coordination.k8s.io/v1` Lease API is the foundation of leader election in modern Kubernetes components. This guide covers the Lease resource semantics, implementing leader election with controller-runtime, custom lease management for advanced scenarios, lease-based distributed locking for operator sidecars, and patterns for multi-active designs that can safely run without single-leader constraints.

<!--more-->

## The Lease API

The `Lease` resource in the `coordination.k8s.io/v1` API group provides a lightweight, atomic mechanism for distributed coordination:

```yaml
apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: payments-operator-leader
  namespace: payments-system
spec:
  # The current leader's identity (typically pod name + UUID)
  holderIdentity: payments-operator-7f9d8b5c4-xk9j2_abc123
  # Duration the lease is valid (seconds)
  leaseDurationSeconds: 15
  # When the leader last renewed the lease
  renewTime: "2028-12-17T10:00:00.000000Z"
  # When the lease was last acquired (leader changed)
  acquireTime: "2028-12-17T09:00:00.000000Z"
  # Number of times the lease has transitioned to a new holder
  leaseTransitions: 3
```

The leader holds this lease by periodically updating the `renewTime` field. Candidates watch for the lease's `renewTime` to become stale (older than `leaseDurationSeconds`). When staleness is detected, candidates compete to atomically update the `holderIdentity` and `acquireTime` fields using a resourceVersion-based optimistic concurrency check. Only one candidate succeeds; others retry.

### Key Properties of the Lease API

1. **Atomicity**: Updates use the Kubernetes optimistic concurrency model. The first writer with a matching `resourceVersion` wins; all others receive a 409 Conflict.
2. **Lightweight**: Leases are small objects stored in etcd with no associated finalizers or controllers.
3. **Namespace-scoped**: Leases live in a specific namespace, allowing per-namespace leader election.
4. **Built-in drift tolerance**: The actual TTL includes a small random factor to prevent thundering herds when a leader dies.

## Leader Election with controller-runtime

The `controller-runtime` library (used by kubebuilder and operator-sdk) provides built-in leader election through the `Manager` interface:

### Basic Setup

```go
package main

import (
	"flag"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

func main() {
	var (
		metricsAddr          string
		probeAddr            string
		enableLeaderElection bool
		leaderElectionID     string
		leaderElectionNS     string
	)

	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "The address the metric endpoint binds to.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", true, "Enable leader election for controller manager.")
	flag.StringVar(&leaderElectionID, "leader-election-id", "payments-operator-leader", "The name of the Lease object for leader election.")
	flag.StringVar(&leaderElectionNS, "leader-election-namespace", "payments-system", "The namespace for the leader election Lease object.")
	opts := zap.Options{Development: false}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme: scheme,
		Metrics: server.Options{
			BindAddress: metricsAddr,
		},
		HealthProbeBindAddress: probeAddr,

		// Leader election configuration
		LeaderElection:                enableLeaderElection,
		LeaderElectionID:              leaderElectionID,
		LeaderElectionNamespace:       leaderElectionNS,
		LeaderElectionReleaseOnCancel: true, // Release lease on graceful shutdown

		// Lease duration settings
		// These match the defaults but are shown here for documentation
		// LeaseDuration: 15 * time.Second,  // How long a lease is valid
		// RenewDeadline: 10 * time.Second,  // How long to retry renewal before giving up
		// RetryPeriod:   2 * time.Second,   // How often to retry after failure
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	// Add health check endpoints
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	// Register controllers
	if err = (&PaymentsReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "Payments")
		os.Exit(1)
	}

	setupLog.Info("starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}
```

### Lease Timing Parameters

The three timing parameters form a failure detection window:

```
leaseDuration = 15s   # Lease TTL
renewDeadline = 10s   # Maximum time to retry renewal before giving up leadership
retryPeriod   = 2s    # Time between renewal retry attempts
```

A new leader can be elected after at most `leaseDuration` seconds following the current leader's failure. The actual failover time is:

```
max_failover_time = leaseDuration + renewDeadline = 25s
```

For faster failover, reduce `leaseDuration`:

```go
// Fast failover: ~7-10 seconds
ctrl.Options{
    LeaseDuration: 7 * time.Second,
    RenewDeadline: 5 * time.Second,
    RetryPeriod:   1 * time.Second,
}
```

Warning: Very short lease durations increase the frequency of etcd writes and may cause false failovers under API server load. The defaults (15s/10s/2s) represent a tested balance for production clusters.

## RBAC for Lease Resources

```yaml
# ClusterRole for the operator's service account
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: payments-operator-leader-election
  namespace: payments-system
rules:
# Required for leader election via Lease API
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
# Required for Events (controller-runtime emits events during leader election)
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-operator-leader-election
  namespace: payments-system
subjects:
- kind: ServiceAccount
  name: payments-operator
  namespace: payments-system
roleRef:
  kind: Role
  name: payments-operator-leader-election
  apiGroup: rbac.authorization.k8s.io
```

## Custom Lease Management

For scenarios requiring more control than controller-runtime provides — such as distributing work across multiple leases or implementing multi-level leadership — use the `k8s.io/client-go/tools/leaderelection` package directly:

```go
package election

import (
	"context"
	"fmt"
	"os"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	clientset "k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

// LeaderElector manages leader election for a named role
type LeaderElector struct {
	client    clientset.Interface
	namespace string
	leaseName string
	identity  string
	callbacks leaderelection.LeaderCallbacks
}

func NewLeaderElector(
	client clientset.Interface,
	namespace string,
	leaseName string,
	onStartLeading func(context.Context),
	onStopLeading func(),
	onNewLeader func(identity string),
) *LeaderElector {
	hostname, _ := os.Hostname()
	podName := os.Getenv("POD_NAME")

	// Identity uniquely identifies this candidate across restarts
	identity := fmt.Sprintf("%s_%s", hostname, podName)

	return &LeaderElector{
		client:    client,
		namespace: namespace,
		leaseName: leaseName,
		identity:  identity,
		callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: onStartLeading,
			OnStoppedLeading: onStopLeading,
			OnNewLeader:      onNewLeader,
		},
	}
}

func (le *LeaderElector) Run(ctx context.Context) error {
	// Create the resource lock backed by the Lease API
	lock, err := resourcelock.New(
		resourcelock.LeasesResourceLock,
		le.namespace,
		le.leaseName,
		le.client.CoreV1(),
		le.client.CoordinationV1(),
		resourcelock.ResourceLockConfig{
			Identity: le.identity,
		},
	)
	if err != nil {
		return fmt.Errorf("creating resource lock: %w", err)
	}

	leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
		Lock:                lock,
		LeaseDuration:       15 * time.Second,
		RenewDeadline:       10 * time.Second,
		RetryPeriod:         2 * time.Second,
		Callbacks:           le.callbacks,
		WatchDog:            leaderelection.NewLeaderHealthzAdaptor(time.Second * 20),
		ReleaseOnCancel:     true,
		Name:                le.leaseName,
	})

	return nil
}
```

### Using Custom Lease Elector in a Reconciler

```go
package main

import (
	"context"
	"fmt"

	ctrl "sigs.k8s.io/controller-runtime"
)

func main() {
	ctx := ctrl.SetupSignalHandler()

	elector := NewLeaderElector(
		kubeClient,
		"payments-system",
		"payments-operator-shard-0",
		// onStartLeading: called when this instance becomes leader
		func(ctx context.Context) {
			fmt.Println("Became leader, starting reconciliation")
			if err := startReconciler(ctx); err != nil {
				fmt.Printf("reconciler error: %v\n", err)
			}
		},
		// onStopLeading: called when leadership is lost (process should exit)
		func() {
			fmt.Println("Lost leadership, exiting")
			// controller-runtime will restart from scratch
			// panic causes the process to exit and the container to restart
			panic("lost leader election")
		},
		// onNewLeader: informational callback
		func(identity string) {
			fmt.Printf("New leader elected: %s\n", identity)
		},
	)

	if err := elector.Run(ctx); err != nil {
		fmt.Printf("leader election error: %v\n", err)
	}
}
```

## Sharded Leader Election for Large-Scale Operators

A single leader election creates a serialization bottleneck for operators managing thousands of custom resources. Sharding distributes reconciliation work across multiple leader/follower groups:

```go
package sharding

import (
	"context"
	"fmt"
	"hash/fnv"
)

const NumShards = 4

// ShardedLeaderElector manages leader election for a specific shard
type ShardedController struct {
	shardID int
	elector *LeaderElector
}

// DetermineShardForResource assigns a resource to a shard by hashing its namespace/name
func DetermineShardForResource(namespace, name string) int {
	h := fnv.New32a()
	h.Write([]byte(namespace + "/" + name))
	return int(h.Sum32()) % NumShards
}

// StartShardedControllers starts NumShards independent leader election loops
// Each operator replica participates in all shard elections,
// but typically wins only 1/NumShards of them
func StartShardedControllers(ctx context.Context, client clientset.Interface) error {
	for shardID := 0; shardID < NumShards; shardID++ {
		shardID := shardID // Capture for goroutine

		elector := NewLeaderElector(
			client,
			"payments-system",
			fmt.Sprintf("payments-operator-shard-%d", shardID),
			func(ctx context.Context) {
				startShardReconciler(ctx, shardID)
			},
			func() {
				panic(fmt.Sprintf("lost shard %d leadership", shardID))
			},
			func(identity string) {
				log.Printf("Shard %d new leader: %s", shardID, identity)
			},
		)

		go func() {
			if err := elector.Run(ctx); err != nil {
				log.Printf("Shard %d election error: %v", shardID, err)
			}
		}()
	}
	return nil
}
```

With 4 shards and 3 operator replicas, each replica typically leads 1-2 shards while standing by for the others. This provides both load distribution and high availability.

## Observing Leader Election Status

### Reading Lease Status Programmatically

```go
package health

import (
	"context"
	"fmt"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type LeaseStatus struct {
	Holder     string
	IsLeader   bool
	RenewTime  time.Time
	AgeSeconds float64
}

func GetLeaseStatus(ctx context.Context, k8sClient client.Client, namespace, name, myIdentity string) (*LeaseStatus, error) {
	lease := &coordinationv1.Lease{}
	if err := k8sClient.Get(ctx, types.NamespacedName{
		Namespace: namespace,
		Name:      name,
	}, lease); err != nil {
		return nil, fmt.Errorf("getting lease %s/%s: %w", namespace, name, err)
	}

	status := &LeaseStatus{}
	if lease.Spec.HolderIdentity != nil {
		status.Holder = *lease.Spec.HolderIdentity
		status.IsLeader = status.Holder == myIdentity
	}
	if lease.Spec.RenewTime != nil {
		status.RenewTime = lease.Spec.RenewTime.Time
		status.AgeSeconds = time.Since(status.RenewTime).Seconds()
	}

	return status, nil
}
```

### CLI Debugging

```bash
# View the leader election lease
kubectl get lease payments-operator-leader -n payments-system -o yaml

# Watch lease changes in real-time
kubectl get lease payments-operator-leader -n payments-system -w

# Show leader for all leases across all namespaces
kubectl get lease --all-namespaces \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,HOLDER:.spec.holderIdentity,RENEWED:.spec.renewTime'

# Check kube-controller-manager leader election
kubectl get lease kube-controller-manager -n kube-system -o yaml

# Check kube-scheduler leader
kubectl get lease kube-scheduler -n kube-system -o yaml
```

## Prometheus Metrics for Leader Election

Expose leader election state as a metric for alerting:

```go
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
	IsLeader = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "payments_operator_is_leader",
		Help: "Whether this instance is the current leader (1 = leader, 0 = follower)",
	})

	LeaseRenewals = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "payments_operator_lease_renewals_total",
		Help: "Total number of successful lease renewals",
	})

	LeaseTransitions = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "payments_operator_lease_transitions_total",
		Help: "Total number of leader transitions",
	})
)

func init() {
	metrics.Registry.MustRegister(IsLeader, LeaseRenewals, LeaseTransitions)
}
```

```go
// In the LeaderElector callbacks:
callbacks: leaderelection.LeaderCallbacks{
	OnStartedLeading: func(ctx context.Context) {
		metrics.IsLeader.Set(1)
		metrics.LeaseTransitions.Inc()
		startReconciler(ctx)
	},
	OnStoppedLeading: func() {
		metrics.IsLeader.Set(0)
	},
}
```

```yaml
# Alert: no operator has held the leader lease for >30 seconds
groups:
- name: operator-leader-election
  rules:
  - alert: OperatorNoLeader
    expr: |
      sum(payments_operator_is_leader) == 0
    for: 30s
    labels:
      severity: critical
    annotations:
      summary: "No payments-operator instance holds the leader lease"
      description: "No operator is active. Reconciliation is suspended."

  - alert: OperatorLeaderFlapping
    expr: |
      increase(payments_operator_lease_transitions_total[5m]) > 3
    labels:
      severity: warning
    annotations:
      summary: "Operator leadership is changing frequently"
      description: "{{ $value }} leader transitions in the last 5 minutes. Check for resource contention."
```

## Multi-Active Patterns: When Leader Election is Not Needed

Some controller patterns are safe to run concurrently without leader election:

### Idempotent Read-Only Controllers

Controllers that only read state and write to external systems (metrics sinks, audit logs) are safe to multi-run:

```go
// MetricsExporter runs on all replicas simultaneously
// Each instance exports the same metrics — the external system deduplicates
type MetricsExporter struct {
	client   client.Client
	exporter prometheus.Registerer
}

// This reconciler only reads Kubernetes state and writes to Prometheus
// Multiple concurrent runs produce duplicate metric updates, which is harmless
func (r *MetricsExporter) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var pod corev1.Pod
	if err := r.client.Get(ctx, req.NamespacedName, &pod); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	// Export pod status to Prometheus — idempotent, no side effects
	r.updatePodMetrics(&pod)
	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}
```

### Sharded by Resource Ownership

Controllers that only reconcile resources they own (determined by label selector or object ownership) can run concurrently if ownership is exclusive:

```go
// Each reconciler instance is assigned a specific node name via environment variable
// It only reconciles pods on its assigned node
type NodeLocalReconciler struct {
	client   client.Client
	nodeName string
}

func (r *NodeLocalReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1.Pod{}).
		WithEventFilter(predicate.NewPredicateFuncs(func(obj client.Object) bool {
			pod, ok := obj.(*corev1.Pod)
			if !ok {
				return false
			}
			// Only process pods on this specific node — no leader election needed
			return pod.Spec.NodeName == r.nodeName
		})).
		Complete(r)
}
```

## LeaderElectionReleaseOnCancel

A critical setting for graceful operator upgrades:

```go
ctrl.Options{
	LeaderElectionReleaseOnCancel: true,
}
```

With this setting, when the operator process receives SIGTERM (as during a rolling update), it explicitly releases the lease before exiting. The new pod can then immediately acquire the lease without waiting for the `leaseDuration` TTL to expire. This reduces upgrade-induced reconciliation gaps from 15 seconds to under 1 second.

## Conclusion

The Kubernetes Lease API provides a production-hardened foundation for distributed coordination in operators. The key design decisions:

1. **Always enable `LeaderElectionReleaseOnCancel: true`** to minimize failover time during graceful restarts
2. **Tune lease timing carefully**: Shorter durations give faster failover but increase etcd write frequency and false failover risk under API server load
3. **Implement metrics for leader state** to alert on extended periods with no leader
4. **Consider sharding** for operators managing >1000 custom resources to distribute reconciliation load
5. **Use `RoleBinding` (not `ClusterRoleBinding`)** for Lease RBAC — scoping to the operator's namespace reduces blast radius
6. **Test leader election** in staging by sending SIGKILL to the leader pod and measuring the time until the follower begins reconciling
