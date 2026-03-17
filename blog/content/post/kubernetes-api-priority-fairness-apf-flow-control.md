---
title: "Kubernetes API Priority and Fairness: APF Flow Control for Multi-Tenant Clusters"
date: 2029-01-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "API Server", "APF", "Multi-Tenancy", "Flow Control"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Kubernetes API Priority and Fairness (APF), covering FlowSchema and PriorityLevelConfiguration design, concurrency tuning, and operational strategies for protecting API server availability in multi-tenant clusters."
more_link: "yes"
url: "/kubernetes-api-priority-fairness-apf-flow-control/"
---

The Kubernetes API server is the control plane's critical path: every kubectl command, controller reconciliation, admission webhook call, and operator watch passes through it. Without flow control, a single runaway controller or a CI/CD system generating thousands of concurrent requests can saturate the API server, causing cascading failures across all cluster operations.

API Priority and Fairness (APF), introduced in Kubernetes 1.18 and graduated to stable in 1.29, replaces the legacy `--max-requests-inflight` and `--max-mutating-requests-inflight` flags with a sophisticated, configurable queuing system that classifies requests into priority levels and enforces fair sharing within each level.

<!--more-->

## APF Core Concepts

APF introduces three fundamental concepts:

**FlowSchema**: Matches incoming requests to a priority level and assigns them to a flow (a logical queue within that level). FlowSchemas are evaluated in order of precedence.

**PriorityLevelConfiguration**: Defines the concurrency budget, queue depth, and queuing strategy for a class of requests. Each priority level has an independent set of queues and an assigned share of the API server's total concurrency.

**Flow**: A specific sequence of requests within a priority level, identified by the distinguished method of flow differentiation (user, namespace, or resource). Fair queuing within a priority level ensures no single flow starves others.

### How APF Processes a Request

```
Incoming Request
    │
    ▼
FlowSchema evaluation (ordered by precedence)
    │
    ├─ Exempt? ──────────────────────────────► Pass through immediately
    │
    ▼
PriorityLevelConfiguration lookup
    │
    ├─ Within concurrency limit? ────────────► Execute immediately
    │
    ├─ Queue not full? ──────────────────────► Enqueue, wait for slot
    │
    └─ Queue full ───────────────────────────► Reject with 429 Too Many Requests
```

## Viewing Current APF Configuration

```bash
# List all FlowSchemas ordered by precedence
kubectl get flowschemas --sort-by='.spec.matchingPrecedence'

# List all PriorityLevelConfigurations
kubectl get prioritylevelconfigurations

# View detailed APF metrics
kubectl get --raw /metrics | grep apiserver_flowcontrol

# View APF status for a specific priority level
kubectl get prioritylevelconfiguration workload-high -o yaml

# Check current queue depths and wait times
kubectl get --raw /debug/api_priority_and_fairness/dump_priority_levels
kubectl get --raw /debug/api_priority_and_fairness/dump_queues
```

## Default Priority Levels

Kubernetes ships with the following built-in priority levels (highest to lowest):

| Priority Level | Concurrency Shares | Queue Length | Purpose |
|----------------|-------------------|--------------|---------|
| `exempt` | N/A | N/A | System-critical (healthz, livez) |
| `node-high` | 40 | 64 | Node status updates |
| `system` | 30 | 64 | System controllers |
| `leader-election` | 10 | 16 | Leader election |
| `workload-high` | 40 | 128 | Important workload traffic |
| `workload-low` | 100 | 128 | General workload traffic |
| `global-default` | 20 | 128 | Catch-all |
| `catch-all` | 5 | 0 | Last resort (always queues) |

The concurrency shares are relative weights. If the API server's total concurrency limit is 600 requests, `workload-low` would receive approximately `(100 / total_shares) * 600` concurrent slots.

## Designing FlowSchemas for Multi-Tenant Clusters

### Tenant Isolation Pattern

In a multi-tenant cluster, different teams should not be able to impact each other's ability to access the API server:

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: tenant-gold
spec:
  type: Limited
  limited:
    nominalConcurrencyShares: 30
    limitResponse:
      type: Queue
      queuing:
        queues: 16
        handSize: 4
        queueLengthLimit: 50
---
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: tenant-silver
spec:
  type: Limited
  limited:
    nominalConcurrencyShares: 20
    limitResponse:
      type: Queue
      queuing:
        queues: 16
        handSize: 4
        queueLengthLimit: 30
---
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: tenant-bronze
spec:
  type: Limited
  limited:
    nominalConcurrencyShares: 10
    limitResponse:
      type: Queue
      queuing:
        queues: 8
        handSize: 4
        queueLengthLimit: 20
```

FlowSchemas to route tenant traffic to the appropriate priority levels:

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: gold-tenants
spec:
  matchingPrecedence: 500
  priorityLevelConfiguration:
    name: tenant-gold
  distinguisherMethod:
    type: ByNamespace
  rules:
    - subjects:
        - kind: Group
          group:
            name: gold-tenants
      resourceRules:
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
          namespaces: ["gold-*"]
---
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: silver-tenants
spec:
  matchingPrecedence: 600
  priorityLevelConfiguration:
    name: tenant-silver
  distinguisherMethod:
    type: ByNamespace
  rules:
    - subjects:
        - kind: Group
          group:
            name: silver-tenants
      resourceRules:
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
          namespaces: ["silver-*"]
---
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: bronze-tenants
spec:
  matchingPrecedence: 700
  priorityLevelConfiguration:
    name: tenant-bronze
  distinguisherMethod:
    type: ByNamespace
  rules:
    - subjects:
        - kind: Group
          group:
            name: bronze-tenants
      resourceRules:
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
          namespaces: ["bronze-*"]
```

### CI/CD Traffic Isolation

CI/CD pipelines often generate burst traffic during deployments. Isolate this traffic to prevent it from impacting live cluster operations:

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: cicd-deployments
spec:
  type: Limited
  limited:
    nominalConcurrencyShares: 15
    limitResponse:
      type: Queue
      queuing:
        queues: 8
        handSize: 4
        queueLengthLimit: 100
---
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: cicd-service-accounts
spec:
  matchingPrecedence: 450
  priorityLevelConfiguration:
    name: cicd-deployments
  distinguisherMethod:
    type: ByUser
  rules:
    - subjects:
        - kind: ServiceAccount
          serviceAccount:
            name: argocd-application-controller
            namespace: argocd
        - kind: ServiceAccount
          serviceAccount:
            name: github-actions-deployer
            namespace: ci-system
        - kind: ServiceAccount
          serviceAccount:
            name: flux-system-controller
            namespace: flux-system
      resourceRules:
        - verbs: ["create", "update", "patch", "delete", "apply"]
          apiGroups: ["apps", ""]
          resources: ["deployments", "replicasets", "pods", "configmaps", "secrets"]
```

### Operator Traffic Management

Kubernetes operators can generate significant API traffic through watch events and reconciliation loops. High-frequency operators should be placed in appropriate priority levels:

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: operators-standard
spec:
  type: Limited
  limited:
    nominalConcurrencyShares: 25
    limitResponse:
      type: Queue
      queuing:
        queues: 16
        handSize: 6
        queueLengthLimit: 64
---
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: custom-operators
spec:
  matchingPrecedence: 520
  priorityLevelConfiguration:
    name: operators-standard
  distinguisherMethod:
    type: ByUser
  rules:
    - subjects:
        - kind: ServiceAccount
          serviceAccount:
            name: cert-manager-controller
            namespace: cert-manager
        - kind: ServiceAccount
          serviceAccount:
            name: prometheus-operator
            namespace: monitoring
        - kind: ServiceAccount
          serviceAccount:
            name: longhorn-manager
            namespace: longhorn-system
      nonResourceRules:
        - verbs: ["*"]
          nonResourceURLs: ["*"]
      resourceRules:
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
```

## Protecting Leader Election

Leader election is critical for controller availability. If leader election requests queue behind general workload traffic, controllers can lose leadership, triggering unnecessary failovers:

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: custom-leader-election
spec:
  matchingPrecedence: 100
  priorityLevelConfiguration:
    name: leader-election
  distinguisherMethod:
    type: ByUser
  rules:
    - subjects:
        - kind: ServiceAccount
          serviceAccount:
            name: "*"
            namespace: "*"
      resourceRules:
        - verbs: ["get", "create", "update"]
          apiGroups: ["coordination.k8s.io"]
          resources: ["leases"]
        - verbs: ["get", "create", "update"]
          apiGroups: [""]
          resources: ["endpoints", "configmaps"]
```

## Borrowing and Concurrency Management

Kubernetes 1.26 added the `lendablePercent` and `borrowingLimitPercent` fields to PriorityLevelConfiguration, allowing priority levels to lend unused capacity to others:

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: workload-high-borrowable
spec:
  type: Limited
  limited:
    nominalConcurrencyShares: 40
    borrowingLimitPercent: 50    # Can borrow up to 50% extra from others
    lendablePercent: 20           # Can lend up to 20% of its allocation
    limitResponse:
      type: Queue
      queuing:
        queues: 16
        handSize: 6
        queueLengthLimit: 128
```

This allows bursty workloads to use spare capacity without permanently reducing allocations for other priority levels.

## APF Observability and Monitoring

### Key Prometheus Metrics

```bash
# Request wait time by priority level and flow schema
apiserver_flowcontrol_request_wait_duration_seconds

# Current queue depth
apiserver_flowcontrol_current_inqueue_requests

# Requests executing currently
apiserver_flowcontrol_current_executing_requests

# Total requests dispatched
apiserver_flowcontrol_dispatched_requests_total

# Total requests rejected (queue full)
apiserver_flowcontrol_rejected_requests_total

# Concurrency limit in use
apiserver_flowcontrol_nominal_limit_seats
apiserver_flowcontrol_current_limit_seats
```

### Grafana Dashboard Queries

```promql
# P99 wait time by priority level
histogram_quantile(0.99,
  rate(apiserver_flowcontrol_request_wait_duration_seconds_bucket[5m])
)

# Request rejection rate (should be 0 in normal operation)
sum by (priority_level, flow_schema) (
  rate(apiserver_flowcontrol_rejected_requests_total[5m])
)

# Queue depth as percentage of queue length limit
sum by (priority_level) (
  apiserver_flowcontrol_current_inqueue_requests
)

# Concurrency utilization per priority level
sum by (priority_level) (
  apiserver_flowcontrol_current_executing_requests
) / sum by (priority_level) (
  apiserver_flowcontrol_nominal_limit_seats
)
```

### Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: apf-alerts
  namespace: monitoring
spec:
  groups:
    - name: apf.critical
      rules:
        - alert: APFRequestsRejected
          expr: |
            sum by (priority_level, flow_schema) (
              rate(apiserver_flowcontrol_rejected_requests_total[5m])
            ) > 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "APF is rejecting requests"
            description: "Priority level {{ $labels.priority_level }} is rejecting requests from {{ $labels.flow_schema }}. Queue is full. Investigate runaway clients or increase queue limits."

        - alert: APFHighWaitTime
          expr: |
            histogram_quantile(0.99,
              sum by (priority_level, le) (
                rate(apiserver_flowcontrol_request_wait_duration_seconds_bucket[5m])
              )
            ) > 1.0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "APF P99 wait time exceeds 1 second"
            description: "Priority level {{ $labels.priority_level }} has P99 wait time of {{ $value }}s. API server may be under high load."

        - alert: APFHighQueueDepth
          expr: |
            apiserver_flowcontrol_current_inqueue_requests > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "APF queue depth is high"
            description: "Priority level {{ $labels.priority_level }} has {{ $value }} requests queued."
```

## Tuning the API Server Concurrency Limit

APF's total concurrency budget comes from the `--max-requests-inflight` and `--max-mutating-requests-inflight` API server flags (or their equivalents in kubeadm and managed Kubernetes configurations):

```yaml
# kubeadm ClusterConfiguration
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
apiServer:
  extraArgs:
    max-requests-inflight: "800"
    max-mutating-requests-inflight: "400"
    # Enable APF (default in 1.20+)
    enable-priority-and-fairness: "true"
```

For managed Kubernetes (EKS, GKE, AKS), the control plane flags are managed by the cloud provider. APF configuration through FlowSchema and PriorityLevelConfiguration CRDs works regardless of the underlying concurrency limits.

### Sizing Recommendations

| Cluster Size | Node Count | Recommended max-requests-inflight |
|-------------|------------|----------------------------------|
| Small | 1-10 nodes | 200 |
| Medium | 10-100 nodes | 600 |
| Large | 100-500 nodes | 1200 |
| X-Large | 500+ nodes | 2000+ |

These are starting points. Monitor `apiserver_flowcontrol_current_executing_requests` across all priority levels and adjust if any level is consistently at or near its limit.

## Diagnosing APF Throttling

When an application is throttled, it receives HTTP 429 responses with the `Retry-After` header. Diagnose the root cause:

```bash
# Check which FlowSchema matched a specific request
# Look for 429 responses in API server audit logs
kubectl logs -n kube-system -l component=kube-apiserver | \
  grep '"code":429' | \
  jq '{user: .user.username, verb: .verb, resource: .objectRef.resource, schema: .annotations["flowcontrol.apiserver.k8s.io/flow-schema"]}'

# Check current queue state for all priority levels
kubectl get --raw /debug/api_priority_and_fairness/dump_priority_levels | \
  python3 -m json.tool | \
  jq '.[] | select(.activeQueues > 0) | {name: .name, activeQueues: .activeQueues, seatsInUse: .seatsInUse}'

# Identify the top request sources by flow schema
kubectl get --raw /metrics | \
  grep 'apiserver_flowcontrol_dispatched_requests_total' | \
  sort -t= -k4 -rn | \
  head -20
```

### Common Throttling Scenarios

**Scenario: Runaway operator generating LIST storms**

```bash
# A broken operator is listing all pods in a loop
# Identify it via audit logs
kubectl logs -n kube-system -l component=kube-apiserver --since=10m | \
  grep '"verb":"list"' | \
  jq -r '.user.username' | sort | uniq -c | sort -rn | head -10

# Temporary mitigation: move the operator's service account to a lower priority level
kubectl apply -f - <<EOF
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: quarantine-broken-operator
spec:
  matchingPrecedence: 300   # Higher precedence than operator's normal schema
  priorityLevelConfiguration:
    name: catch-all
  distinguisherMethod:
    type: ByUser
  rules:
    - subjects:
        - kind: ServiceAccount
          serviceAccount:
            name: broken-operator-sa
            namespace: operators
      resourceRules:
        - verbs: ["list", "watch"]
          apiGroups: [""]
          resources: ["pods"]
EOF
```

## Summary

API Priority and Fairness provides the control plane protection that enterprise multi-tenant Kubernetes clusters require. Proper APF configuration ensures that:

- Critical system operations (node heartbeats, leader election) are never starved
- CI/CD burst traffic cannot impact production workload operators
- Individual tenants cannot monopolize the API server
- Problematic clients can be isolated without impacting others

Start with the default configuration and add custom FlowSchemas as specific isolation needs arise. Monitor APF metrics continuously and treat rejected requests as a signal that concurrency limits or queue sizes need adjustment.
