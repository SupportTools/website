---
title: "Kubernetes Lease and Leader Election: Distributed Coordination for Operators"
date: 2030-09-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Operators", "Leader Election", "Lease", "controller-runtime", "High Availability"]
categories:
- Kubernetes
- Operators
- High Availability
author: "Matthew Mattox - mmattox@support.tools"
description: "Production leader election guide covering Kubernetes Lease resource internals, controller-runtime leader election configuration, lease renewal timing, multi-region HA patterns, active-active vs active-passive operator design, and testing leader election behavior."
more_link: "yes"
url: "/kubernetes-lease-leader-election-distributed-coordination-operators/"
---

Running multiple replicas of a Kubernetes operator is essential for high availability, but most operator workloads cannot safely run concurrently — reconciling the same resource from two processes simultaneously leads to race conditions, duplicate events, and split-brain state. The Kubernetes Lease resource provides the distributed lock mechanism that solves this problem: only the lease holder processes work, while standby replicas watch and wait to take over on failure. Understanding how the Lease API works and how controller-runtime manages it is essential for building operators that are both highly available and operationally safe.

<!--more-->

## Kubernetes Lease Resource Internals

The `coordination.k8s.io/v1` Lease resource is a lightweight object designed specifically for distributed locking. It stores:

```yaml
apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: my-operator-leader-election
  namespace: my-operator-system
  resourceVersion: "45678"
  uid: a1b2c3d4-e5f6-7890-abcd-ef1234567890
spec:
  acquireTime: "2030-09-25T10:00:00.000000Z"
  holderIdentity: "my-operator-7d9b6c4f5-xk9p2_a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  leaseDurationSeconds: 15
  leaseTransitions: 3
  renewTime: "2030-09-25T10:01:23.456789Z"
```

Key fields:

- **holderIdentity**: The identifier of the current leader. Typically `<pod-name>_<pod-uid>`. Format is configurable.
- **acquireTime**: When the current holder first acquired the lease.
- **renewTime**: When the current holder last renewed the lease. This is the heartbeat timestamp.
- **leaseDurationSeconds**: How long the lease is valid without renewal. If `now - renewTime > leaseDurationSeconds`, the lease is expired and a new leader can acquire it.
- **leaseTransitions**: Counter incremented each time leadership changes. Useful for audit and alerting.

### How Acquisition Works

The leader election protocol uses optimistic concurrency via Kubernetes resource versioning:

1. Candidate reads the Lease object
2. If lease is expired (or does not exist), candidate attempts to write it with its own `holderIdentity` and the current timestamp
3. The write includes the `resourceVersion` from the read — if another candidate wrote first, the API server rejects with a 409 Conflict
4. The winner of the conflict proceeds as leader; losers retry after a jitter delay

This is a classic compare-and-swap operation using the Kubernetes API server as the coordination point.

### Lease vs ConfigMap vs Endpoints

Three resource types can back leader election:

| Backend | Notes |
|---|---|
| `leases` (coordination.k8s.io/v1) | Recommended. Dedicated resource type, minimal overhead, no side effects |
| `configmaps` | Legacy. Still used by some controllers. Noisy in audit logs |
| `endpoints` | Legacy. Used by early Kubernetes controllers. Avoid in new code |

Always use `leases` for new operators.

## controller-runtime Leader Election Configuration

The `sigs.k8s.io/controller-runtime` library handles leader election as part of the Manager setup. Most configuration is in `ctrl.Options`.

### Basic Leader Election Setup

```go
package main

import (
    "flag"
    "os"
    "time"

    coordinationv1 "k8s.io/api/coordination/v1"
    "k8s.io/apimachinery/pkg/runtime"
    utilruntime "k8s.io/apimachinery/pkg/util/runtime"
    clientgoscheme "k8s.io/client-go/kubernetes/scheme"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/healthz"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

var (
    scheme   = runtime.NewScheme()
    setupLog = ctrl.Log.WithName("setup")
)

func init() {
    utilruntime.Must(clientgoscheme.AddToScheme(scheme))
    // Add your CRD scheme here
}

func main() {
    var (
        metricsAddr          string
        enableLeaderElection bool
        leaderElectionID     string
        leaseDuration        time.Duration
        renewDeadline        time.Duration
        retryPeriod          time.Duration
    )

    flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "Metrics server bind address")
    flag.BoolVar(&enableLeaderElection, "leader-elect", true, "Enable leader election for controller manager")
    flag.StringVar(&leaderElectionID, "leader-election-id", "my-operator-leader-election", "Leader election ID (Lease name)")
    flag.DurationVar(&leaseDuration, "lease-duration", 15*time.Second, "Lease duration")
    flag.DurationVar(&renewDeadline, "renew-deadline", 10*time.Second, "Renew deadline (must be < lease duration)")
    flag.DurationVar(&retryPeriod, "retry-period", 2*time.Second, "Retry period between election attempts")

    opts := zap.Options{Development: false}
    opts.BindFlags(flag.CommandLine)
    flag.Parse()

    ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,
        Metrics: metricsserver.Options{
            BindAddress: metricsAddr,
        },
        HealthProbeBindAddress: ":8081",
        LeaderElection:         enableLeaderElection,
        LeaderElectionID:       leaderElectionID,
        // Namespace for the Lease object; use operator's own namespace
        LeaderElectionNamespace: os.Getenv("OPERATOR_NAMESPACE"),
        // Leader election resource type
        LeaderElectionResourceLock: "leases",
        // Lease timing parameters
        LeaseDuration: &leaseDuration,
        RenewDeadline: &renewDeadline,
        RetryPeriod:   &retryPeriod,
        // Release leader on graceful shutdown
        LeaderElectionReleaseOnCancel: true,
    })
    if err != nil {
        setupLog.Error(err, "unable to start manager")
        os.Exit(1)
    }

    if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up health check")
        os.Exit(1)
    }
    if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
        setupLog.Error(err, "unable to set up ready check")
        os.Exit(1)
    }

    setupLog.Info("starting manager")
    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        setupLog.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

### Lease Timing Parameters Explained

The three timing parameters have a strict constraint: `renewDeadline < leaseDuration`

```
Timeline:

T=0     Leader acquires lease (renewTime = T=0, leaseDurationSeconds = 15)
T=0-10  Leader renews every 2s (retryPeriod). renewTime advances.
T=10    renewDeadline: if leader hasn't successfully renewed by T=10, it panics/exits.
T=15    leaseDuration: if no renewal by T=15, standby candidates can acquire the lease.

Failure scenario:
T=0     Leader acquires lease
T=5     Leader's network partition - cannot reach API server
T=10    Leader hits renewDeadline, panics (LeaderElectionReleaseOnCancel=true: releases lease)
T=12    Standby sees renewTime is old but lease not expired yet... waits
T=15    Lease expires (now - renewTime > 15s). Standby acquires lease.
T=15+   New leader begins reconciling
```

**Recommended values for different availability profiles:**

```go
// Low-latency failover (accepts higher API server load)
leaseDuration = 10 * time.Second
renewDeadline = 7 * time.Second
retryPeriod   = 2 * time.Second
// Failover time: ~10 seconds

// Balanced (recommended for most operators)
leaseDuration = 15 * time.Second
renewDeadline = 10 * time.Second
retryPeriod   = 2 * time.Second
// Failover time: ~15 seconds

// Conservative (large clusters, high API server latency)
leaseDuration = 30 * time.Second
renewDeadline = 20 * time.Second
retryPeriod   = 5 * time.Second
// Failover time: ~30 seconds
```

## RBAC for Leader Election

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-operator-leader-election-role
  namespace: my-operator-system
rules:
  # Lease-based leader election
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Events for leader election audit trail
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-operator-leader-election-rolebinding
  namespace: my-operator-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: my-operator-leader-election-role
subjects:
  - kind: ServiceAccount
    name: my-operator-controller-manager
    namespace: my-operator-system
```

## Deployment Configuration for HA

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-operator-controller-manager
  namespace: my-operator-system
  labels:
    app: my-operator
spec:
  replicas: 3  # 3 replicas: 1 active leader + 2 standbys
  selector:
    matchLabels:
      app: my-operator
  template:
    metadata:
      labels:
        app: my-operator
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
    spec:
      serviceAccountName: my-operator-controller-manager
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault

      # Spread replicas across nodes and availability zones
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: my-operator
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: my-operator

      # Prefer different nodes
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: my-operator
                topologyKey: kubernetes.io/hostname

      containers:
        - name: manager
          image: myregistry.example.com/my-operator:v1.5.0
          args:
            - "--leader-elect=true"
            - "--leader-election-id=my-operator-leader-election"
            - "--leader-election-namespace=my-operator-system"
            - "--lease-duration=15s"
            - "--renew-deadline=10s"
            - "--retry-period=2s"
            - "--metrics-bind-address=:8080"
            - "--health-probe-bind-address=:8081"

          ports:
            - name: metrics
              containerPort: 8080
              protocol: TCP
            - name: healthz
              containerPort: 8081
              protocol: TCP

          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 15
            periodSeconds: 20
            failureThreshold: 3

          readinessProbe:
            httpGet:
              path: /readyz
              port: 8081
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3

          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi

          env:
            - name: OPERATOR_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name

          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            readOnlyRootFilesystem: true

      terminationGracePeriodSeconds: 30
```

## Multi-Region HA Patterns

### Challenge: Cross-Region Leader Election

Leader election using a Kubernetes Lease works only when all candidates can reach the same Kubernetes API server. In a genuine multi-region HA deployment with separate clusters per region, each cluster runs its own operator instance and manages its own resources.

Three patterns for multi-region operator HA:

### Pattern 1: Single Active Region (Geographic Failover)

One region hosts the active operator; other regions run operators in standby mode controlled by an external flag:

```yaml
# ConfigMap to control active region
apiVersion: v1
kind: ConfigMap
metadata:
  name: operator-region-config
  namespace: my-operator-system
data:
  active-region: "us-east-1"  # Updated by external failover tooling
  failover-timestamp: "2030-09-25T10:00:00Z"
```

```go
// Operator checks if its region is active before starting reconcilers
func isActiveRegion(ctx context.Context, client client.Client) (bool, error) {
    var cm corev1.ConfigMap
    if err := client.Get(ctx, types.NamespacedName{
        Name:      "operator-region-config",
        Namespace: "my-operator-system",
    }, &cm); err != nil {
        return false, err
    }
    return cm.Data["active-region"] == os.Getenv("AWS_REGION"), nil
}
```

### Pattern 2: Per-Region Leader Election with Global Coordination

Each cluster has its own Lease, but a higher-level coordinator (e.g., Route53 health checks + Lambda) updates ConfigMaps to indicate which region's operators should be authoritative for global resources:

```go
// Operator leader in each region watches for region-active signal
type RegionGate struct {
    client    client.Client
    region    string
    isActive  bool
    mu        sync.RWMutex
}

func (g *RegionGate) Start(ctx context.Context) error {
    for {
        active, err := g.checkActive(ctx)
        if err != nil {
            ctrl.Log.Error(err, "failed to check region active status")
        } else {
            g.mu.Lock()
            g.isActive = active
            g.mu.Unlock()
        }
        select {
        case <-ctx.Done():
            return nil
        case <-time.After(10 * time.Second):
        }
    }
}

func (g *RegionGate) IsActive() bool {
    g.mu.RLock()
    defer g.mu.RUnlock()
    return g.isActive
}
```

### Pattern 3: Active-Active with Conflict Resolution

Some operators can be designed for active-active operation by using optimistic concurrency and idempotent reconciliation:

```go
func (r *MyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var resource myv1.MyResource
    if err := r.Get(ctx, req.NamespacedName, &resource); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Include resource version in all patches to detect concurrent modifications
    patch := client.MergeFromWithOptions(resource.DeepCopy(),
        client.MergeFromWithOptimisticLock{})

    // Make the desired state change
    resource.Status.Phase = "Reconciled"
    resource.Status.ObservedGeneration = resource.Generation

    if err := r.Status().Patch(ctx, &resource, patch); err != nil {
        if apierrors.IsConflict(err) {
            // Another instance modified the resource concurrently
            // Re-queue to pick up the latest version
            return ctrl.Result{Requeue: true}, nil
        }
        return ctrl.Result{}, err
    }

    return ctrl.Result{}, nil
}
```

## Active-Active vs Active-Passive Operator Design

### Active-Passive (Standard Leader Election)

The default pattern: only the leader reconciles, standbys wait.

**Advantages:**
- Simple mental model
- No risk of conflicting reconciliation
- Controller-runtime handles everything automatically

**Disadvantages:**
- Throughput limited to single instance
- Failover time equals lease duration

**Best for:** Most operators. CRD-based controllers, admission webhooks (which don't use leader election at all), stateful provisioners.

### Active-Active

Multiple replicas reconcile concurrently. Requires careful idempotency guarantees.

**Implementation using work sharding:**

```go
// Shard work based on resource name hash modulo replica count
type ShardedReconciler struct {
    client.Client
    shardIndex int    // This replica's shard index
    shardCount int    // Total number of replicas
    logger     logr.Logger
}

func (r *ShardedReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    // Assign resources to shards based on name hash
    h := fnv.New32a()
    h.Write([]byte(req.NamespacedName.String()))
    shard := int(h.Sum32()) % r.shardCount

    if shard != r.shardIndex {
        // Not our shard, skip
        return ctrl.Result{}, nil
    }

    // Process the resource
    return r.reconcileResource(ctx, req)
}

// Shard index injected via environment variable from Downward API
func getShardConfig() (index, count int) {
    idx, _ := strconv.Atoi(os.Getenv("SHARD_INDEX"))
    cnt, _ := strconv.Atoi(os.Getenv("SHARD_COUNT"))
    if cnt == 0 {
        cnt = 1
    }
    return idx, cnt
}
```

```yaml
# StatefulSet for sharded active-active operators
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-operator-sharded
  namespace: my-operator-system
spec:
  replicas: 3
  serviceName: my-operator
  selector:
    matchLabels:
      app: my-operator-sharded
  template:
    metadata:
      labels:
        app: my-operator-sharded
    spec:
      containers:
        - name: manager
          image: myregistry.example.com/my-operator:v1.5.0
          env:
            - name: SHARD_COUNT
              value: "3"
            - name: SHARD_INDEX
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['statefulset.kubernetes.io/pod-name']
              # Note: extract ordinal from pod name (my-operator-sharded-0 -> 0)
```

## LeaderElectionReleaseOnCancel

The `LeaderElectionReleaseOnCancel` option is critical for minimizing failover time during graceful shutdowns:

```go
ctrl.Options{
    LeaderElection:               true,
    LeaderElectionReleaseOnCancel: true,  // Default: false in older versions
}
```

With this enabled:
- On SIGTERM, the manager cancels its context
- The leader election client immediately deletes the Lease (or sets holderIdentity to empty)
- Standby replicas can acquire the lease immediately, without waiting for `leaseDurationSeconds`
- Graceful shutdown becomes fast (seconds instead of 15+ seconds)

**Behavior comparison:**

```
Without LeaderElectionReleaseOnCancel (rolling update):
  T=0   Pod receives SIGTERM
  T=0   Manager starts graceful shutdown
  T=5   All reconciliations complete, pod exits
  T=5   Standby candidates begin polling for expired lease
  T=15  Lease expires (leaseDurationSeconds from last renewal)
  T=15  New leader acquires lease
  Total downtime: ~15 seconds

With LeaderElectionReleaseOnCancel (rolling update):
  T=0   Pod receives SIGTERM
  T=0   Manager releases lease immediately
  T=1   Standby acquires released lease (retryPeriod=2s after jitter)
  T=5   Previous pod exits after reconciliations complete
  Total downtime: ~1-3 seconds
```

## Leader-Aware Components

Sometimes only certain operator components need to run on the leader. Use `LeaderElectionID`-aware runnables:

```go
// Runnable that only executes on the leader
type LeaderOnlyRunnable struct {
    logger logr.Logger
}

func (r *LeaderOnlyRunnable) Start(ctx context.Context) error {
    r.logger.Info("started as leader, initializing leader-only work")

    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            r.logger.Info("leadership lost or shutdown, stopping leader-only work")
            return nil
        case <-ticker.C:
            if err := r.performLeaderWork(ctx); err != nil {
                r.logger.Error(err, "leader work failed")
            }
        }
    }
}

func (r *LeaderOnlyRunnable) NeedLeaderElection() bool {
    return true  // This runnable only runs on the leader
}

// Register in main.go
if err := mgr.Add(&LeaderOnlyRunnable{logger: ctrl.Log.WithName("leader-runnable")}); err != nil {
    setupLog.Error(err, "unable to add leader runnable")
    os.Exit(1)
}
```

## Testing Leader Election

### Unit Testing with Fake Client

```go
// controller_suite_test.go
package controllers_test

import (
    "context"
    "testing"
    "time"

    coordinationv1 "k8s.io/api/coordination/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes/fake"
    "sigs.k8s.io/controller-runtime/pkg/client"
    fakeclient "sigs.k8s.io/controller-runtime/pkg/client/fake"
    . "github.com/onsi/ginkgo/v2"
    . "github.com/onsi/gomega"
)

var _ = Describe("Leader Election", func() {
    It("should acquire lease when none exists", func() {
        fakeClient := fakeclient.NewClientBuilder().
            WithScheme(scheme).
            Build()

        leaderID := "test-pod-123_abc"
        err := acquireLease(context.Background(), fakeClient, "test-lease", "test-namespace", leaderID, 15*time.Second)
        Expect(err).ToNot(HaveOccurred())

        var lease coordinationv1.Lease
        err = fakeClient.Get(context.Background(), client.ObjectKey{
            Name:      "test-lease",
            Namespace: "test-namespace",
        }, &lease)
        Expect(err).ToNot(HaveOccurred())
        Expect(*lease.Spec.HolderIdentity).To(Equal(leaderID))
    })

    It("should not acquire lease held by another active holder", func() {
        now := metav1.NewMicroTime(time.Now())
        duration := int32(15)
        existingLease := &coordinationv1.Lease{
            ObjectMeta: metav1.ObjectMeta{
                Name:      "test-lease",
                Namespace: "test-namespace",
            },
            Spec: coordinationv1.LeaseSpec{
                HolderIdentity:       strPtr("existing-holder_xyz"),
                LeaseDurationSeconds: &duration,
                RenewTime:            &now,
            },
        }

        fakeClient := fakeclient.NewClientBuilder().
            WithScheme(scheme).
            WithObjects(existingLease).
            Build()

        err := acquireLease(context.Background(), fakeClient, "test-lease", "test-namespace", "new-holder_abc", 15*time.Second)
        Expect(err).To(HaveOccurred())
        // Verify original holder still holds the lease
        var lease coordinationv1.Lease
        _ = fakeClient.Get(context.Background(), client.ObjectKey{
            Name: "test-lease", Namespace: "test-namespace",
        }, &lease)
        Expect(*lease.Spec.HolderIdentity).To(Equal("existing-holder_xyz"))
    })
})
```

### Integration Testing with envtest

```go
// envtest provides a real Kubernetes API server for testing
var _ = BeforeSuite(func() {
    testEnv = &envtest.Environment{
        CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd", "bases")},
        BinaryAssetsDirectory: filepath.Join("..", "..", "bin", "k8s",
            fmt.Sprintf("1.30.0-%s-%s", runtime.GOOS, runtime.GOARCH)),
    }

    cfg, err = testEnv.Start()
    Expect(err).ToNot(HaveOccurred())

    // Start manager with leader election enabled
    mgr, err = ctrl.NewManager(cfg, ctrl.Options{
        Scheme:                        scheme,
        LeaderElection:                true,
        LeaderElectionID:              "test-operator-leader-election",
        LeaderElectionNamespace:       "default",
        LeaseDuration:                 durationPtr(5 * time.Second),  // Short for tests
        RenewDeadline:                 durationPtr(3 * time.Second),
        RetryPeriod:                   durationPtr(1 * time.Second),
        LeaderElectionReleaseOnCancel: true,
    })
    Expect(err).ToNot(HaveOccurred())

    go func() {
        Expect(mgr.Start(ctx)).ToNot(HaveOccurred())
    }()
})
```

### Chaos Testing Leader Election

```bash
# Simulate leader failure by deleting the leader pod
LEADER_POD=$(kubectl get lease my-operator-leader-election \
  -n my-operator-system \
  -o jsonpath='{.spec.holderIdentity}' | cut -d'_' -f1)

echo "Current leader: $LEADER_POD"

# Record transition count before kill
BEFORE_TRANSITIONS=$(kubectl get lease my-operator-leader-election \
  -n my-operator-system \
  -o jsonpath='{.spec.leaseTransitions}')

# Kill the leader
kubectl delete pod $LEADER_POD -n my-operator-system

# Measure failover time
START_TIME=$(date +%s%N)
while true; do
    NEW_LEADER=$(kubectl get lease my-operator-leader-election \
      -n my-operator-system \
      -o jsonpath='{.spec.holderIdentity}' 2>/dev/null | cut -d'_' -f1)

    if [ -n "$NEW_LEADER" ] && [ "$NEW_LEADER" != "$LEADER_POD" ]; then
        END_TIME=$(date +%s%N)
        FAILOVER_MS=$(( (END_TIME - START_TIME) / 1000000 ))
        echo "New leader: $NEW_LEADER"
        echo "Failover time: ${FAILOVER_MS}ms"
        break
    fi
    sleep 0.1
done

# Verify transition count incremented
AFTER_TRANSITIONS=$(kubectl get lease my-operator-leader-election \
  -n my-operator-system \
  -o jsonpath='{.spec.leaseTransitions}')
echo "Transitions: $BEFORE_TRANSITIONS -> $AFTER_TRANSITIONS"
```

## Observability: Monitoring Leader Election

### Prometheus Metrics

controller-runtime exposes leader election metrics automatically:

```promql
# Is this instance currently the leader?
leader_election_master_status{name="my-operator-leader-election"}
# 1 = leader, 0 = standby

# Leader transitions per hour
increase(leader_election_transitions_total[1h])

# Lease duration vs actual renewal interval
# Alert if renewal interval approaches lease duration
```

### Custom Lease Monitoring

```go
// Track leader election events in operator metrics
var (
    leaderTransitions = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "operator_leader_transitions_total",
            Help: "Total number of leader election transitions",
        },
        []string{"operator", "namespace"},
    )
    isLeader = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "operator_is_leader",
            Help: "Whether this instance is the current leader (1=yes, 0=no)",
        },
        []string{"operator", "pod"},
    )
)

// Register callbacks
mgr.Add(manager.RunnableFunc(func(ctx context.Context) error {
    // Called when this instance becomes leader
    isLeader.WithLabelValues("my-operator", os.Getenv("POD_NAME")).Set(1)
    leaderTransitions.WithLabelValues("my-operator", os.Getenv("OPERATOR_NAMESPACE")).Inc()
    return nil
}))
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: operator-leader-election-alerts
  namespace: monitoring
spec:
  groups:
    - name: operator-leader-election
      rules:
        - alert: OperatorNoLeader
          expr: |
            max(leader_election_master_status{name="my-operator-leader-election"}) == 0
          for: 30s
          labels:
            severity: critical
          annotations:
            summary: "Operator has no active leader"
            description: "The my-operator has no active leader for >30 seconds. Reconciliation is suspended."

        - alert: OperatorFrequentLeaderTransitions
          expr: |
            rate(leader_election_transitions_total[5m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Frequent leader election transitions"
            description: "Leader is changing frequently, indicating instability in operator pods or API server connectivity."

        - alert: OperatorMultipleLeaders
          expr: |
            sum(leader_election_master_status{name="my-operator-leader-election"}) > 1
          for: 10s
          labels:
            severity: critical
          annotations:
            summary: "Multiple operator leaders detected"
            description: "More than one instance reports being leader. This should not occur and indicates a split-brain condition."
```

## Production Checklist

Before deploying an operator with leader election to production:

- Set `LeaderElectionReleaseOnCancel: true` to minimize failover time during rolling updates
- Deploy at least 3 replicas with pod anti-affinity across nodes and availability zones
- Use topology spread constraints across availability zones
- Set `leaseDuration` based on your acceptable recovery time objective (default 15s is reasonable)
- Verify `renewDeadline < leaseDuration` and `retryPeriod < renewDeadline / 2`
- Add readiness probe to delay leader election until the pod is fully initialized
- Test failover by deleting the leader pod and measuring transition time
- Monitor `leader_election_master_status` and alert on no-leader condition
- Ensure the operator namespace and Lease name are documented and stable — changing them orphans the old lease
- Use unique `LeaderElectionID` values per operator to prevent cross-operator lease conflicts in shared namespaces

Leader election with Kubernetes Leases provides a production-grade distributed coordination mechanism that is well-integrated with the Kubernetes API machinery. The controller-runtime abstraction makes the correct implementation straightforward, while the tuning knobs provide the flexibility needed for diverse performance and availability requirements.
