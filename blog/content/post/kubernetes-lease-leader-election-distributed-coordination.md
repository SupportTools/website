---
title: "Kubernetes Lease and Leader Election: Distributed Coordination"
date: 2029-04-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Leader Election", "Lease", "Controllers", "High Availability", "Distributed Systems"]
categories: ["Kubernetes", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes Lease API and leader election: coordination.k8s.io/Lease objects, controller-runtime leader election, multi-instance deployments, split-brain prevention, lease duration tuning, and patterns for building highly available operators."
more_link: "yes"
url: "/kubernetes-lease-leader-election-distributed-coordination/"
---

Kubernetes controllers and operators must run as singletons — only one instance should reconcile objects at a time. Yet for availability, multiple instances must be ready to take over if the active one fails. The solution is leader election: a distributed consensus mechanism where instances compete to hold a lease, and only the lease holder performs active work. This guide covers the Lease API, controller-runtime's built-in leader election, custom election patterns, split-brain prevention, and lease duration tuning for production operators.

<!--more-->

# Kubernetes Lease and Leader Election: Distributed Coordination

## Section 1: Why Leader Election Matters

Consider a controller that reconciles DatabaseCluster custom resources by creating PodDisruptionBudgets, Services, and StatefulSets. If two instances reconcile the same object simultaneously, you get:

- Race conditions: both instances read the same state, both generate a desired state, both attempt writes — one write succeeds, the other generates a conflict error and reconciles again
- Thundering herd: if the cluster has 100 DatabaseCluster objects, two reconciling instances create 200 concurrent API server operations
- Inconsistent state: subtle bugs where each instance overwrites the other's changes

Leader election solves this by ensuring exactly one instance (the leader) performs reconciliation work. Other instances run in standby mode, watching for the leader to fail.

### The CAP Tradeoff in Leader Election

Leader election in Kubernetes prioritizes Availability and Partition Tolerance over perfect Consistency:

- **Availability**: If the leader fails, a standby takes over quickly
- **Split-brain risk**: During a network partition, both sides may believe they are the leader for a brief window (bounded by lease duration)
- **Mitigation**: Lease mechanisms bound the split-brain window to `leaseDuration - renewDeadline`

## Section 2: The Lease API

The `coordination.k8s.io/v1` Lease object is the building block of leader election in Kubernetes. It replaces the older ConfigMap/Endpoints-based election.

### Lease Object Structure

```yaml
apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: my-operator-leader
  namespace: kube-system
spec:
  # Who currently holds the lease
  holderIdentity: "my-operator-pod-abc123"
  # How long the lease is valid (seconds)
  leaseDurationSeconds: 15
  # When the lease was last acquired
  acquireTime: "2029-04-25T10:00:00Z"
  # When the lease was last renewed
  renewTime: "2029-04-25T10:05:45Z"
  # Number of times leadership has changed
  leaseTransitions: 3
```

### Lease Semantics

```
Leader holds lease:
  renewTime must be updated within leaseDurationSeconds
  If renewTime + leaseDurationSeconds < now → lease expired → anyone can acquire it

Election process:
  1. Candidate reads current lease
  2. If lease expired (or does not exist):
     a. Candidate writes new lease with holderIdentity = self
     b. API server uses resourceVersion optimistic locking
     c. Only ONE write succeeds (others get Conflict error)
     d. Winner is the new leader
  3. If lease not expired:
     a. Candidate waits until lease expires
     b. Repeat step 2
```

### Manual Lease Inspection

```bash
# List all coordination leases
kubectl get leases -n kube-system

# Watch leader election in real time
kubectl get lease my-operator-leader -n kube-system -w

# Check which instance is the current leader
kubectl get lease my-operator-leader -n kube-system \
  -o jsonpath='{.spec.holderIdentity}'

# Check when lease was last renewed
kubectl get lease my-operator-leader -n kube-system \
  -o jsonpath='{.spec.renewTime}'

# Manually force a leadership transition (for maintenance)
kubectl patch lease my-operator-leader -n kube-system \
  --type=json \
  -p='[{"op":"remove","path":"/spec/holderIdentity"}]'
```

## Section 3: controller-runtime Leader Election

The `sigs.k8s.io/controller-runtime` package provides built-in leader election for Kubernetes operators.

### Basic Leader Election Setup

```go
package main

import (
    "context"
    "flag"
    "os"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/log/zap"
    "sigs.k8s.io/controller-runtime/pkg/manager"
)

var scheme = runtime.NewScheme()

func main() {
    var (
        leaderElect          bool
        leaderElectionID     string
        leaseDuration        time.Duration
        renewDeadline        time.Duration
        retryPeriod          time.Duration
        leaderElectionNS     string
    )

    flag.BoolVar(&leaderElect, "leader-elect", true,
        "Enable leader election for controller manager")
    flag.StringVar(&leaderElectionID, "leader-election-id", "my-operator-leader",
        "Lease resource name for leader election")
    flag.DurationVar(&leaseDuration, "leader-election-lease-duration", 15*time.Second,
        "Duration the leader holds the lease")
    flag.DurationVar(&renewDeadline, "leader-election-renew-deadline", 10*time.Second,
        "Duration the leader retries before giving up")
    flag.DurationVar(&retryPeriod, "leader-election-retry-period", 2*time.Second,
        "Wait between leader election attempts")
    flag.StringVar(&leaderElectionNS, "leader-election-namespace", "kube-system",
        "Namespace for the leader election lease")
    flag.Parse()

    ctrl.SetLogger(zap.New(zap.UseDevMode(false)))

    mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
        Scheme: scheme,

        // Leader election configuration
        LeaderElection:             leaderElect,
        LeaderElectionID:           leaderElectionID,
        LeaderElectionNamespace:    leaderElectionNS,
        LeaseDuration:              &leaseDuration,
        RenewDeadline:              &renewDeadline,
        RetryPeriod:                &retryPeriod,
        LeaderElectionResourceLock: "leases", // Use coordination.k8s.io/Lease

        // What happens when leadership is lost
        LeaderElectionReleaseOnCancel: true,
    })
    if err != nil {
        ctrl.Log.Error(err, "unable to create manager")
        os.Exit(1)
    }

    // Register your reconciler
    if err := (&DatabaseClusterReconciler{
        Client: mgr.GetClient(),
        Scheme: mgr.GetScheme(),
    }).SetupWithManager(mgr); err != nil {
        ctrl.Log.Error(err, "unable to setup controller")
        os.Exit(1)
    }

    ctrl.Log.Info("Starting manager")
    if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
        ctrl.Log.Error(err, "problem running manager")
        os.Exit(1)
    }
}
```

### Reconciler Implementation

```go
package controllers

import (
    "context"
    "fmt"
    "time"

    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"

    myv1alpha1 "github.com/example/my-operator/api/v1alpha1"
)

type DatabaseClusterReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

func (r *DatabaseClusterReconciler) Reconcile(
    ctx context.Context,
    req ctrl.Request,
) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    // This function is ONLY called when this instance is the leader
    // If leadership is lost mid-reconcile, the context is cancelled

    var cluster myv1alpha1.DatabaseCluster
    if err := r.Get(ctx, req.NamespacedName, &cluster); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    logger.Info("Reconciling DatabaseCluster",
        "name", cluster.Name,
        "namespace", cluster.Namespace,
        "generation", cluster.Generation,
    )

    // Check context cancellation (leadership loss)
    select {
    case <-ctx.Done():
        logger.Info("Context cancelled — leadership may have been lost")
        return ctrl.Result{}, ctx.Err()
    default:
    }

    // Perform reconciliation work
    if err := r.reconcileStatefulSet(ctx, &cluster); err != nil {
        return ctrl.Result{}, fmt.Errorf("reconcile statefulset: %w", err)
    }

    if err := r.reconcileServices(ctx, &cluster); err != nil {
        return ctrl.Result{}, fmt.Errorf("reconcile services: %w", err)
    }

    // Requeue after interval to check status
    return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *DatabaseClusterReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&myv1alpha1.DatabaseCluster{}).
        Owns(&appsv1.StatefulSet{}).
        Owns(&corev1.Service{}).
        Complete(r)
}
```

## Section 4: Leader Election Timing Parameters

### Understanding the Parameters

```
leaseDuration: How long the leader's lease is valid
              └─ If the leader stops renewing, a standby can take over after leaseDuration

renewDeadline: How long the leader tries to renew before giving up
              └─ Leader must renew within renewDeadline or it stops acting as leader

retryPeriod: How often standbys check if the lease has expired
            └─ Lower value = faster failover detection, more API server load
```

**Timing constraints:**
- `renewDeadline < leaseDuration` (must succeed before lease expires)
- `retryPeriod < renewDeadline` (enough retries before giving up)
- `retryPeriod * 3 ≤ renewDeadline` (room for at least 3 retry attempts)

### Parameter Recommendations by Availability Requirement

```go
// Conservative (default): minimize split-brain risk
// Failover time: up to 15s
leaseDuration = 15 * time.Second
renewDeadline = 10 * time.Second
retryPeriod   = 2 * time.Second

// Moderate: balance speed and safety
// Failover time: up to 30s
leaseDuration = 30 * time.Second
renewDeadline = 20 * time.Second
retryPeriod   = 5 * time.Second

// Aggressive: fast failover (high API server load)
// Failover time: up to 8s
leaseDuration = 8 * time.Second
renewDeadline = 5 * time.Second
retryPeriod   = 1 * time.Second

// Very safe: minimal impact (slow failover)
// For operators where correct behavior > fast failover
leaseDuration = 60 * time.Second
renewDeadline = 40 * time.Second
retryPeriod   = 10 * time.Second
```

### Split-Brain Window Analysis

```
Split-brain window = leaseDuration - renewDeadline

With default (15s lease, 10s renew):
  Window = 5s
  During a network partition lasting < 5s:
    - Old leader may have sent its last renewal 4.9s ago
    - New leader takes over (lease expired)
    - Old leader's renewal actually arrives (within its renewDeadline)
    - BOTH instances think they're leader for up to 5s

With conservative (30s lease, 20s renew):
  Window = 10s
  Larger split-brain window but more resilience to transient network issues
```

## Section 5: Leader Election in a Deployment

### Operator Deployment Pattern

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-operator
  namespace: kube-system
  labels:
    app: my-operator
spec:
  # Run multiple replicas for availability
  replicas: 2
  selector:
    matchLabels:
      app: my-operator
  # Pod anti-affinity: spread across nodes
  template:
    metadata:
      labels:
        app: my-operator
    spec:
      serviceAccountName: my-operator
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
        image: myregistry/my-operator:v1.0.0
        command:
        - /manager
        args:
        - --leader-elect=true
        - --leader-election-id=my-operator-leader
        - --leader-election-namespace=kube-system
        - --leader-election-lease-duration=15s
        - --leader-election-renew-deadline=10s
        - --leader-election-retry-period=2s
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        ports:
        - containerPort: 8080
          name: metrics
        - containerPort: 8081
          name: health
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8081
          initialDelaySeconds: 15
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8081
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
```

### RBAC for Leader Election

```yaml
# ClusterRole for the operator
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: my-operator
rules:
# Leader election: MUST have full access to Lease objects
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
# Events for conditions/status reporting
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
# Your operator's managed resources
- apiGroups: ["mygroup.example.com"]
  resources: ["databaseclusters", "databaseclusters/status", "databaseclusters/finalizers"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: my-operator
subjects:
- kind: ServiceAccount
  name: my-operator
  namespace: kube-system
roleRef:
  kind: ClusterRole
  name: my-operator
  apiGroup: rbac.authorization.k8s.io
```

## Section 6: Custom Leader Election Without controller-runtime

For non-operator use cases (distributed cron jobs, background workers), implement leader election directly using the `k8s.io/client-go/tools/leaderelection` package:

```go
package main

import (
    "context"
    "flag"
    "fmt"
    "os"
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
    "k8s.io/client-go/tools/leaderelection"
    "k8s.io/client-go/tools/leaderelection/resourcelock"
)

func main() {
    config, err := rest.InClusterConfig()
    if err != nil {
        panic(err)
    }

    client, err := kubernetes.NewForConfig(config)
    if err != nil {
        panic(err)
    }

    // Identity: unique per instance (use Pod name)
    id, err := os.Hostname()
    if err != nil {
        panic(err)
    }

    // Create the lock (Lease-based)
    lock := &resourcelock.LeaseLock{
        LeaseMeta: metav1.ObjectMeta{
            Name:      "my-distributed-job-leader",
            Namespace: "default",
        },
        Client: client.CoordinationV1(),
        LockConfig: resourcelock.ResourceLockConfig{
            Identity: id,
        },
    }

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Run leader election
    leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
        Lock:            lock,
        ReleaseOnCancel: true,
        LeaseDuration:   15 * time.Second,
        RenewDeadline:   10 * time.Second,
        RetryPeriod:     2 * time.Second,
        Callbacks: leaderelection.LeaderCallbacks{
            OnStartedLeading: func(ctx context.Context) {
                // This goroutine runs ONLY while this instance is the leader
                fmt.Printf("[%s] I am the leader — starting work\n", id)
                doLeaderWork(ctx)
            },
            OnStoppedLeading: func() {
                // Called when leadership is lost (or context cancelled)
                fmt.Printf("[%s] Lost leadership — stopping work\n", id)
                cancel() // Shut down this instance
                os.Exit(0)
            },
            OnNewLeader: func(identity string) {
                // Called when any instance becomes leader
                if identity != id {
                    fmt.Printf("[%s] New leader: %s\n", id, identity)
                }
            },
        },
    })
}

func doLeaderWork(ctx context.Context) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            fmt.Println("Context cancelled — stopping leader work")
            return
        case <-ticker.C:
            fmt.Println("Performing scheduled leader work")
            // Do actual work here: database maintenance, metrics aggregation, etc.
        }
    }
}
```

## Section 7: Health Endpoints for Leader Awareness

Operators should expose their leadership status via health endpoints, allowing Kubernetes to route traffic appropriately:

```go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"
    "sync/atomic"
    "time"
)

type HealthServer struct {
    isLeader atomic.Bool
    startTime time.Time
}

func NewHealthServer() *HealthServer {
    return &HealthServer{startTime: time.Now()}
}

func (h *HealthServer) SetLeader(leader bool) {
    h.isLeader.Store(leader)
}

func (h *HealthServer) HandleLivez(w http.ResponseWriter, r *http.Request) {
    // Liveness: always return 200 (process is alive)
    w.WriteHeader(http.StatusOK)
    fmt.Fprintln(w, "ok")
}

func (h *HealthServer) HandleReadyz(w http.ResponseWriter, r *http.Request) {
    // Readiness: only ready if leader (or if you want standby to serve metrics)
    status := map[string]interface{}{
        "leader":    h.isLeader.Load(),
        "uptime":    time.Since(h.startTime).String(),
        "timestamp": time.Now().UTC(),
    }

    w.Header().Set("Content-Type", "application/json")
    if !h.isLeader.Load() {
        w.WriteHeader(http.StatusServiceUnavailable)
        status["message"] = "standby — not the leader"
    } else {
        w.WriteHeader(http.StatusOK)
        status["message"] = "leader — active"
    }
    json.NewEncoder(w).Encode(status)
}

func (h *HealthServer) HandleLeaderz(w http.ResponseWriter, r *http.Request) {
    // Dedicated leader status endpoint
    if h.isLeader.Load() {
        w.WriteHeader(http.StatusOK)
        fmt.Fprintln(w, `{"leader":true}`)
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
        fmt.Fprintln(w, `{"leader":false}`)
    }
}

func main() {
    hs := NewHealthServer()

    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", hs.HandleLivez)
    mux.HandleFunc("/readyz", hs.HandleReadyz)
    mux.HandleFunc("/leaderz", hs.HandleLeaderz)

    go http.ListenAndServe(":8081", mux)

    // Integrate with leader election callbacks
    callbacks := leaderelection.LeaderCallbacks{
        OnStartedLeading: func(ctx context.Context) {
            hs.SetLeader(true)
            // Start work...
        },
        OnStoppedLeading: func() {
            hs.SetLeader(false)
        },
    }
    // ...
}
```

## Section 8: Multi-Instance Deployment Patterns

### Active-Passive Pattern

```yaml
# Primary deployment: leader election enabled, does all work
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-operator-primary
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: manager
        args:
        - --leader-elect=true
        - --leader-election-id=my-operator-leader
```

### Sharded Active-Active Pattern

For high-scale operators processing thousands of objects, use sharding to distribute work across multiple leaders:

```go
package sharding

import (
    "fmt"
    "hash/fnv"
)

// ShardedLeaderElection: each operator instance is responsible for
// a subset of objects determined by hash(objectName) % numShards

const numShards = 4

type ShardedOperator struct {
    shardID    int
    totalShards int
}

func NewShardedOperator(podName string, totalShards int) *ShardedOperator {
    // Deterministically assign shard ID based on Pod name suffix
    h := fnv.New32a()
    h.Write([]byte(podName))
    shardID := int(h.Sum32()) % totalShards
    return &ShardedOperator{shardID: shardID, totalShards: totalShards}
}

func (s *ShardedOperator) ShouldProcess(objectName string) bool {
    h := fnv.New32a()
    h.Write([]byte(objectName))
    return int(h.Sum32())%s.totalShards == s.shardID
}

// Each shard has its own lease
func (s *ShardedOperator) LeaderElectionID() string {
    return fmt.Sprintf("my-operator-leader-shard-%d", s.shardID)
}
```

```yaml
# StatefulSet provides stable Pod names for deterministic sharding
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-operator-sharded
spec:
  replicas: 4  # 4 shards
  serviceName: my-operator-sharded
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
        image: myregistry/my-operator:v1.0.0
        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: TOTAL_SHARDS
          value: "4"
        args:
        - --leader-elect=true
        - --sharded-mode=true
```

## Section 9: Monitoring Leader Election

### Prometheus Metrics

controller-runtime exposes leader election metrics automatically:

```promql
# Is this instance the current leader?
controller_runtime_active_workers{controller="databasecluster"}

# Leader transitions (count)
# (Custom metric — add to your operator)
my_operator_leader_transitions_total

# Time since last lease renewal
my_operator_lease_renewal_age_seconds
```

### Custom Metrics Implementation

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    IsLeader = prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "my_operator_is_leader",
        Help: "1 if this instance is the current leader, 0 otherwise",
    })

    LeaderTransitions = prometheus.NewCounter(prometheus.CounterOpts{
        Name: "my_operator_leader_transitions_total",
        Help: "Total number of times leadership has changed",
    })

    LeaseRenewalAge = prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "my_operator_lease_renewal_age_seconds",
        Help: "Seconds since last successful lease renewal",
    })
)

func init() {
    metrics.Registry.MustRegister(IsLeader, LeaderTransitions, LeaseRenewalAge)
}
```

### Alert Rules

```yaml
# PrometheusRule for leader election health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: operator-leader-election
  namespace: monitoring
spec:
  groups:
  - name: operator.leader-election
    rules:
    # No instance is the leader
    - alert: OperatorNoLeader
      expr: sum(my_operator_is_leader) == 0
      for: 30s
      labels:
        severity: critical
      annotations:
        summary: "No leader elected for my-operator"
        description: "No instance of my-operator is currently the leader. Reconciliation is halted."

    # Multiple leaders detected (split-brain)
    - alert: OperatorMultipleLeaders
      expr: sum(my_operator_is_leader) > 1
      for: 5s
      labels:
        severity: critical
      annotations:
        summary: "Multiple leaders detected for my-operator"
        description: "Split-brain: {{ $value }} instances claim leadership simultaneously"

    # Frequent leadership transitions (instability)
    - alert: OperatorLeadershipFlapping
      expr: rate(my_operator_leader_transitions_total[10m]) > 0.5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "my-operator leadership is unstable"
        description: "More than 1 leadership transition per 2 minutes — check network and API server latency"
```

## Section 10: Kubernetes Core Component Leader Election

Kubernetes core components also use Lease-based leader election:

```bash
# kube-scheduler leader
kubectl get lease kube-scheduler -n kube-system \
  -o jsonpath='{.spec.holderIdentity}'

# kube-controller-manager leader
kubectl get lease kube-controller-manager -n kube-system \
  -o jsonpath='{.spec.holderIdentity}'

# cloud-controller-manager (if applicable)
kubectl get lease cloud-controller-manager -n kube-system \
  -o jsonpath='{.spec.holderIdentity}'

# View all leader election leases
kubectl get leases -n kube-system

# Monitor lease health
watch -n 2 'kubectl get leases -n kube-system'
```

### Diagnosing Leader Election Issues

```bash
# Step 1: Check if any instance holds the lease
kubectl get lease my-operator-leader -n kube-system

# Step 2: Check lease age (should be renewed frequently)
RENEW=$(kubectl get lease my-operator-leader -n kube-system \
  -o jsonpath='{.spec.renewTime}')
echo "Last renewal: $RENEW"
echo "Current time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Step 3: Check operator Pod logs for election messages
kubectl logs -n kube-system -l app=my-operator --tail=50 | \
  grep -i "leader\|lease\|election"

# Example healthy log output:
# INFO  attempting to acquire leader lease kube-system/my-operator-leader...
# INFO  successfully acquired lease kube-system/my-operator-leader
# INFO  Starting reconciliation workers

# Step 4: Check for RBAC issues preventing lease access
kubectl auth can-i get leases --namespace kube-system \
  --as system:serviceaccount:kube-system:my-operator

# Step 5: Check API server audit logs for lease operations
# kubectl get events -n kube-system | grep "my-operator-leader"
```

## Section 11: Graceful Leadership Transfer

For planned maintenance (rolling updates, version upgrades), gracefully release the lease before termination:

```go
// In manager setup
mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
    // Release lease on SIGTERM/SIGINT
    LeaderElectionReleaseOnCancel: true,  // ← Key: releases lease on graceful shutdown
    // ...
})

// In Deployment: ensure graceful shutdown window exceeds lease duration
// terminationGracePeriodSeconds > leaseDuration ensures the leader has time
// to release the lease before being killed
```

```yaml
# Deployment spec for graceful leadership handover
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30  # > leaseDuration (15s)
      containers:
      - name: manager
        # SIGTERM triggers graceful shutdown → lease released → new leader elected
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]  # Allow in-flight reconciles to complete
```

## Conclusion

Kubernetes Lease API provides a robust, consistent foundation for leader election in distributed systems. The coordination.k8s.io/Lease object combines the simplicity of a key-value store with the consistency guarantees of the Kubernetes API server's optimistic locking, making split-brain risk bounded and measurable.

For production operators, the key principles are:

1. Always use Lease-based election (not ConfigMap or Endpoints — deprecated)
2. Tune leaseDuration, renewDeadline, and retryPeriod to balance failover speed against split-brain window
3. Set `LeaderElectionReleaseOnCancel: true` to reduce failover time during rolling updates
4. Monitor with Prometheus alerts for no-leader and multi-leader conditions
5. Deploy with pod anti-affinity to ensure standby instances survive node failures

With these practices in place, operators can safely run at two or more replicas with sub-30-second failover while maintaining correct single-instance reconciliation semantics.
