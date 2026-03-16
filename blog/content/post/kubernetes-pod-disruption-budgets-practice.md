---
title: "Pod Disruption Budgets in Practice: Ensuring Kubernetes Application Availability"
date: 2026-09-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "PDB", "High Availability", "Reliability", "Maintenance", "SRE"]
categories: ["Kubernetes", "DevOps", "SRE"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Pod Disruption Budgets for maintaining application availability during voluntary disruptions like node drains, upgrades, and cluster scaling."
more_link: "yes"
url: "/kubernetes-pod-disruption-budgets-practice/"
---

Pod Disruption Budgets (PDBs) protect application availability during voluntary disruptions by limiting the number of pods that can be simultaneously unavailable. This guide covers PDB design patterns, best practices, integration with autoscaling, and troubleshooting strategies for production environments.

<!--more-->

## Executive Summary

Kubernetes distinguishes between voluntary disruptions (planned maintenance, scaling, upgrades) and involuntary disruptions (hardware failures, network partitions). Pod Disruption Budgets provide guarantees about application availability during voluntary disruptions, enabling safe cluster operations while maintaining service levels.

## PDB Fundamentals

### Understanding Disruption Types

**Voluntary vs Involuntary Disruptions:**

```yaml
# Voluntary Disruptions (Protected by PDB):
# - kubectl drain
# - Node maintenance
# - Cluster scaling down
# - VPA evictions
# - Application updates
# - Manual pod deletion with PDB awareness

# Involuntary Disruptions (NOT protected by PDB):
# - Hardware failures
# - Kernel panics
# - Network partitions
# - Out of memory kills
# - Cloud provider maintenance
# - Force deletions

---
# Basic PDB Example
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-app-pdb
  namespace: production
spec:
  # Specify minimum available pods
  minAvailable: 3
  selector:
    matchLabels:
      app: web-app
      tier: frontend
---
# Alternative: Maximum unavailable
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  # Specify maximum unavailable pods
  maxUnavailable: 1
  selector:
    matchLabels:
      app: api-server
```

### PDB Calculation Modes

**MinAvailable vs MaxUnavailable:**

```yaml
# minAvailable - Absolute number
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: database-pdb-absolute
  namespace: production
spec:
  minAvailable: 2  # Always keep at least 2 pods running
  selector:
    matchLabels:
      app: database
---
# minAvailable - Percentage
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: cache-pdb-percentage
  namespace: production
spec:
  minAvailable: 75%  # Keep at least 75% of pods running
  selector:
    matchLabels:
      app: cache
---
# maxUnavailable - Absolute number
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: worker-pdb-absolute
  namespace: production
spec:
  maxUnavailable: 1  # Allow at most 1 pod to be unavailable
  selector:
    matchLabels:
      app: worker
---
# maxUnavailable - Percentage
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: frontend-pdb-percentage
  namespace: production
spec:
  maxUnavailable: 25%  # Allow up to 25% of pods to be unavailable
  selector:
    matchLabels:
      app: frontend
---
# Calculation Examples:
#
# Deployment with 10 replicas:
# - minAvailable: 7 → Can disrupt 3 pods
# - minAvailable: 70% → Can disrupt 3 pods
# - maxUnavailable: 3 → Can disrupt 3 pods
# - maxUnavailable: 30% → Can disrupt 3 pods
#
# During scaling:
# - Scaling up from 10 to 15 replicas
#   - minAvailable: 7 → Still 7 (absolute)
#   - minAvailable: 70% → Now 11 (percentage)
# - Scaling down from 10 to 5 replicas
#   - minAvailable: 7 → Cannot scale below 7! (blocks scaling)
#   - minAvailable: 70% → Now 4 (percentage, allows scaling)
```

## Production PDB Patterns

### High Availability Services

**Critical Service PDB:**

```yaml
# critical-service-pdb.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: payment-service
      tier: critical
  template:
    metadata:
      labels:
        app: payment-service
        tier: critical
    spec:
      containers:
      - name: payment
        image: payment-service:v2.0
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /live
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
  annotations:
    description: "Ensures 90% availability during disruptions"
    owner: "payments-team"
    slo: "99.9%"
spec:
  minAvailable: 90%  # Always keep 90% available
  selector:
    matchLabels:
      app: payment-service
      tier: critical
  unhealthyPodEvictionPolicy: AlwaysAllow  # Evict unhealthy pods
---
# With 10 replicas:
# - minAvailable: 90% = 9 pods
# - Can disrupt: 1 pod at a time
# - Allows rolling updates one pod at a time
# - Protects against concurrent disruptions
```

### Stateful Applications

**StatefulSet PDB:**

```yaml
# statefulset-pdb.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch
  namespace: production
spec:
  serviceName: elasticsearch
  replicas: 6
  selector:
    matchLabels:
      app: elasticsearch
  template:
    metadata:
      labels:
        app: elasticsearch
    spec:
      containers:
      - name: elasticsearch
        image: elasticsearch:8.11.0
        ports:
        - containerPort: 9200
          name: http
        - containerPort: 9300
          name: transport
        volumeMounts:
        - name: data
          mountPath: /usr/share/elasticsearch/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 100Gi
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: elasticsearch-pdb
  namespace: production
spec:
  # For Elasticsearch: Allow disrupting minority of nodes
  maxUnavailable: 2  # Never disrupt more than 2 nodes
  selector:
    matchLabels:
      app: elasticsearch
---
# Elasticsearch cluster considerations:
# - 6 node cluster: maxUnavailable: 2
#   - Maintains quorum (4/6 nodes)
#   - Allows rolling updates
# - Prevents split-brain scenarios
# - Ensures data availability during maintenance
```

### Multi-Tier Applications

**Coordinated PDBs:**

```yaml
# multi-tier-pdb.yaml
---
# Frontend tier - can tolerate more disruption
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: frontend-pdb
  namespace: production
spec:
  maxUnavailable: 30%  # Can disrupt up to 30%
  selector:
    matchLabels:
      app: ecommerce
      tier: frontend
---
# API tier - moderate disruption tolerance
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-pdb
  namespace: production
spec:
  minAvailable: 75%  # Keep 75% available
  selector:
    matchLabels:
      app: ecommerce
      tier: api
---
# Backend tier - conservative disruption
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: backend-pdb
  namespace: production
spec:
  maxUnavailable: 1  # Only 1 pod at a time
  selector:
    matchLabels:
      app: ecommerce
      tier: backend
---
# Database tier - strictest protection
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: database-pdb
  namespace: production
spec:
  minAvailable: 2  # Always maintain quorum
  selector:
    matchLabels:
      app: ecommerce
      tier: database
```

## Integration with Autoscaling

### PDB with Horizontal Pod Autoscaler

**HPA and PDB Coordination:**

```yaml
# hpa-pdb-integration.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-service
  namespace: production
spec:
  replicas: 10  # Initial size
  selector:
    matchLabels:
      app: web-service
  template:
    metadata:
      labels:
        app: web-service
    spec:
      containers:
      - name: web
        image: web-service:v1
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
---
# HPA scales between 5 and 50 replicas
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-service
  minReplicas: 5
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
---
# PDB uses percentage to adapt to HPA scaling
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-service-pdb
  namespace: production
spec:
  # Use percentage - adapts to HPA scaling
  minAvailable: 80%  # Always keep 80% available
  selector:
    matchLabels:
      app: web-service
---
# Scaling scenarios:
#
# At minReplicas (5):
# - minAvailable: 80% = 4 pods
# - Can disrupt: 1 pod
#
# At midpoint (25):
# - minAvailable: 80% = 20 pods
# - Can disrupt: 5 pods
#
# At maxReplicas (50):
# - minAvailable: 80% = 40 pods
# - Can disrupt: 10 pods
#
# PDB automatically adjusts as HPA scales!
```

**Avoiding PDB Blocking HPA Scale-Down:**

```yaml
# pdb-hpa-best-practices.yaml
# GOOD: Percentage-based PDB
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: good-pdb
  namespace: production
spec:
  minAvailable: 80%  # Scales with deployment size
  selector:
    matchLabels:
      app: scalable-service
---
# BAD: Absolute PDB higher than HPA minReplicas
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: bad-pdb
  namespace: production
spec:
  minAvailable: 10  # Problem: HPA minReplicas is 5!
  selector:
    matchLabels:
      app: scalable-service
# This PDB will prevent HPA from scaling below 10 replicas
# even though HPA allows 5 minReplicas
---
# BETTER: Use maxUnavailable with appropriate value
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: better-pdb
  namespace: production
spec:
  maxUnavailable: 20%  # Allows disruption of minority
  selector:
    matchLabels:
      app: scalable-service
```

### PDB with Vertical Pod Autoscaler

**VPA Eviction Coordination:**

```yaml
# vpa-pdb-integration.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Auto"  # Will evict pods to apply recommendations
    minReplicas: 5  # Don't evict if fewer replicas
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      minAllowed:
        cpu: 200m
        memory: 256Mi
      maxAllowed:
        cpu: 4000m
        memory: 8Gi
---
# PDB protects during VPA evictions
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: 80%  # VPA respects this during evictions
  selector:
    matchLabels:
      app: api-server
---
# VPA eviction behavior with PDB:
# - VPA wants to evict pod for resource adjustment
# - Checks PDB before eviction
# - If PDB allows: evicts pod
# - If PDB blocks: waits for opportunity
# - Ensures gradual updates maintaining availability
```

### PDB with Cluster Autoscaler

**Node Draining Protection:**

```yaml
# ca-pdb-integration.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
  namespace: production
spec:
  replicas: 20
  selector:
    matchLabels:
      app: batch-processor
  template:
    metadata:
      labels:
        app: batch-processor
      annotations:
        # Don't prevent node scale-down
        cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
    spec:
      containers:
      - name: processor
        image: batch-processor:v1
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
---
# PDB ensures graceful scale-down
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: batch-processor-pdb
  namespace: production
spec:
  minAvailable: 75%  # Keep 75% running during scale-down
  selector:
    matchLabels:
      app: batch-processor
---
# Cluster Autoscaler behavior:
# - Identifies underutilized node
# - Attempts to drain node
# - Respects PDB during drain
# - If PDB blocks: tries different node
# - If all nodes blocked: waits for opportunity
# - Ensures gradual, safe scale-down
```

## Advanced PDB Configurations

### Unhealthy Pod Eviction Policy

**Kubernetes 1.26+ Feature:**

```yaml
# unhealthy-pod-eviction.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: app-with-unhealthy-policy
  namespace: production
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: my-app
  # AlwaysAllow: Evict unhealthy pods even if PDB would be violated
  # IfHealthyBudget: Only evict unhealthy pods if healthy pods meet budget
  unhealthyPodEvictionPolicy: AlwaysAllow
---
# Scenarios:
#
# Deployment with 5 replicas, minAvailable: 3
# - 3 healthy, 2 unhealthy pods
#
# AlwaysAllow:
# - Can evict all 2 unhealthy pods immediately
# - Ignores PDB for unhealthy pods
# - Helps recover from cascading failures
#
# IfHealthyBudget:
# - Can evict unhealthy pods only if 3 healthy remain
# - Still respects PDB constraints
# - Default behavior
```

### Multiple PDBs for Same Pods

**Overlapping Selectors:**

```yaml
# multiple-pdbs.yaml
# Deployment with multiple labels
apiVersion: apps/v1
kind: Deployment
metadata:
  name: multi-role-service
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: multi-role
      role: api
      team: platform
  template:
    metadata:
      labels:
        app: multi-role
        role: api
        team: platform
    spec:
      containers:
      - name: service
        image: multi-role:v1
---
# PDB #1: Team-based budget
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: platform-team-pdb
  namespace: production
spec:
  minAvailable: 8  # Keep 8 pods for platform team
  selector:
    matchLabels:
      team: platform
---
# PDB #2: Role-based budget
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-role-pdb
  namespace: production
spec:
  maxUnavailable: 2  # Allow disrupting 2 API pods
  selector:
    matchLabels:
      role: api
---
# Behavior with multiple PDBs:
# - ALL PDBs must be satisfied for eviction
# - Most restrictive PDB wins
# - In this case: min(8 available from PDB#1, max 2 unavailable from PDB#2)
# - Result: Can disrupt 2 pods maximum
```

## Troubleshooting PDB Issues

### PDB Blocking Operations

**Diagnostic Commands:**

```bash
#!/bin/bash
# pdb-diagnostics.sh

NAMESPACE=${1:-production}

echo "=== Pod Disruption Budgets ==="
kubectl get pdb -n ${NAMESPACE} -o wide

echo ""
echo "=== PDB Details ==="
for pdb in $(kubectl get pdb -n ${NAMESPACE} -o name); do
  echo "--- ${pdb} ---"
  kubectl describe ${pdb} -n ${NAMESPACE}
done

echo ""
echo "=== Pods Covered by PDBs ==="
for pdb in $(kubectl get pdb -n ${NAMESPACE} -o name | cut -d/ -f2); do
  echo "PDB: ${pdb}"
  SELECTOR=$(kubectl get pdb ${pdb} -n ${NAMESPACE} -o jsonpath='{.spec.selector.matchLabels}' | jq -r 'to_entries | map("\(.key)=\(.value)") | join(",")')
  kubectl get pods -n ${NAMESPACE} -l ${SELECTOR}
  echo ""
done

echo "=== Pods NOT Covered by Any PDB ==="
kubectl get pods -n ${NAMESPACE} --show-labels

echo ""
echo "=== Recent PDB-related Events ==="
kubectl get events -n ${NAMESPACE} --sort-by='.lastTimestamp' | grep -i disruption

echo ""
echo "=== Check for Blocked Drains ==="
kubectl get nodes -o json | jq -r '.items[] | select(.spec.unschedulable==true) | .metadata.name'
```

**Common PDB Problems:**

```yaml
# problem-pdbs.yaml
---
# PROBLEM 1: PDB with no matching pods
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: typo-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: webapp  # Typo! Should be "web-app"
# FIX: Ensure selector matches pod labels exactly

---
# PROBLEM 2: PDB stricter than deployment size
apiVersion: apps/v1
kind: Deployment
metadata:
  name: small-app
spec:
  replicas: 2  # Only 2 replicas
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: impossible-pdb
spec:
  minAvailable: 3  # Impossible! Only 2 replicas exist
# FIX: Adjust PDB to maxUnavailable: 1 or minAvailable: 1

---
# PROBLEM 3: Conflicting PDBs
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: pdb-a
spec:
  minAvailable: 8
  selector:
    matchLabels:
      app: service
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: pdb-b
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: service
# With 10 replicas:
# - pdb-a requires: 8 available (2 can be disrupted)
# - pdb-b requires: 1 unavailable (1 can be disrupted)
# - Result: Only 1 can be disrupted (most restrictive)
# FIX: Ensure PDBs have compatible constraints

---
# PROBLEM 4: Forgotten PDB during deployment deletion
# Deployment is deleted but PDB remains
# PDB now matches no pods but prevents future operations
# FIX: Use ownerReferences or delete PDB with deployment
```

### PDB Status Inspection

**Detailed PDB Status:**

```yaml
# Check PDB status
$ kubectl get pdb web-app-pdb -o yaml

status:
  currentHealthy: 8
  desiredHealthy: 7  # Based on minAvailable/maxUnavailable
  disruptionsAllowed: 1  # Can disrupt 1 pod
  expectedPods: 10  # Total pods matching selector
  observedGeneration: 3
  conditions:
  - lastTransitionTime: "2025-12-10T10:00:00Z"
    message: ""
    reason: ""
    status: "True"
    type: DisruptionAllowed
```

## Monitoring and Alerting

### PDB Metrics

**ServiceMonitor for PDB Metrics:**

```yaml
# pdb-monitoring.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pdb-alerts
  namespace: monitoring
spec:
  groups:
  - name: pod-disruption-budgets
    interval: 30s
    rules:
    - alert: PDBViolated
      expr: |
        kube_poddisruptionbudget_status_current_healthy
        < kube_poddisruptionbudget_status_desired_healthy
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} is violated"
        description: "Current healthy: {{ $value }}, Desired: {{ $labels.desired_healthy }}"

    - alert: PDBNoDisruptionsAllowed
      expr: kube_poddisruptionbudget_status_disruptions_allowed == 0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} allows no disruptions"
        description: "Cannot perform voluntary disruptions - check pod health and replica count"

    - alert: PDBMismatchedPods
      expr: |
        kube_poddisruptionbudget_status_expected_pods == 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} matches no pods"
        description: "Check selector labels - PDB may be misconfigured"

    - alert: PDBLowHealthyPods
      expr: |
        (kube_poddisruptionbudget_status_current_healthy
        / kube_poddisruptionbudget_status_expected_pods) < 0.8
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "PDB {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} has low healthy pod ratio"
        description: "Only {{ $value | humanizePercentage }} pods healthy"
```

### Grafana Dashboard

**PDB Dashboard:**

```json
{
  "dashboard": {
    "title": "Pod Disruption Budget Status",
    "panels": [
      {
        "title": "Disruptions Allowed",
        "targets": [
          {
            "expr": "kube_poddisruptionbudget_status_disruptions_allowed",
            "legendFormat": "{{ namespace }}/{{ poddisruptionbudget }}"
          }
        ]
      },
      {
        "title": "Healthy vs Expected Pods",
        "targets": [
          {
            "expr": "kube_poddisruptionbudget_status_current_healthy",
            "legendFormat": "{{ namespace }}/{{ poddisruptionbudget }} - Healthy"
          },
          {
            "expr": "kube_poddisruptionbudget_status_expected_pods",
            "legendFormat": "{{ namespace }}/{{ poddisruptionbudget }} - Expected"
          },
          {
            "expr": "kube_poddisruptionbudget_status_desired_healthy",
            "legendFormat": "{{ namespace }}/{{ poddisruptionbudget }} - Desired"
          }
        ]
      },
      {
        "title": "PDB Health Ratio",
        "targets": [
          {
            "expr": "kube_poddisruptionbudget_status_current_healthy / kube_poddisruptionbudget_status_expected_pods",
            "legendFormat": "{{ namespace }}/{{ poddisruptionbudget }}"
          }
        ]
      }
    ]
  }
}
```

## Best Practices

### Production PDB Checklist

```yaml
# pdb-best-practices.yaml

# 1. Always define PDBs for production services
# - Protects during maintenance
# - Ensures SLO compliance
# - Coordinates with autoscaling

# 2. Use appropriate min/max values
# Good:
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: good-pdb
spec:
  minAvailable: 75%  # Percentage adapts to scaling
  selector:
    matchLabels:
      app: scalable-service

# 3. Match PDB to service criticality
# Critical services: minAvailable: 90%
# Standard services: minAvailable: 75%
# Background jobs: maxUnavailable: 50%

# 4. Coordinate with HPA
# - Use percentages for PDB
# - Ensure PDB minAvailable < HPA minReplicas

# 5. Test PDB effectiveness
# - Simulate node drains
# - Verify rolling updates respect PDB
# - Check autoscaler interactions

# 6. Monitor PDB status
# - Alert on violated PDBs
# - Track disruptions allowed
# - Monitor pod health ratios

# 7. Document PDB decisions
# - Explain min/max choices
# - Link to SLOs
# - Maintain runbooks

# 8. Use labels consistently
# - Ensure selectors match pods
# - Avoid typos in labels
# - Use automation to verify

# 9. Handle unhealthy pods
# - Set unhealthyPodEvictionPolicy appropriately
# - AlwaysAllow for resilient services
# - IfHealthyBudget for critical services

# 10. Clean up obsolete PDBs
# - Remove PDBs when deployments deleted
# - Use ownerReferences
# - Regular audits
```

### PDB Anti-Patterns

```yaml
# pdb-anti-patterns.yaml

# ANTI-PATTERN 1: No PDB for production service
# Risk: Uncontrolled disruptions during maintenance

# ANTI-PATTERN 2: Overly restrictive PDB
apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  minAvailable: 100%  # NEVER allows any disruption!
# Fix: Use 90% or appropriate threshold

# ANTI-PATTERN 3: Absolute values with dynamic scaling
apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  minAvailable: 10  # Blocks scaling below 10
# Fix: Use percentages

# ANTI-PATTERN 4: Overlapping PDBs without coordination
# Multiple PDBs with different constraints
# Fix: Ensure PDBs are compatible

# ANTI-PATTERN 5: Ignoring pod readiness
# PDB counts unhealthy pods as healthy
# Fix: Implement proper readiness probes

# ANTI-PATTERN 6: PDB for single-replica deployment
apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  minAvailable: 1  # Blocks all voluntary disruptions!
# Fix: Don't use PDB, or accept disruptions

# ANTI-PATTERN 7: Forgetting PDB during testing
# Only adding PDB in production
# Fix: Include PDB in all environments

# ANTI-PATTERN 8: Not testing PDB behavior
# Assuming PDB works without verification
# Fix: Regular drain simulations
```

## Real-World Scenarios

### Scenario 1: Rolling Update

```yaml
# rolling-update-with-pdb.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
spec:
  replicas: 20
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 5  # Can have up to 25 pods during update
      maxUnavailable: 0  # Never go below 20 healthy pods
  template:
    spec:
      containers:
      - name: api
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 3
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
spec:
  minAvailable: 90%  # Keep 18/20 pods (90%) available
  selector:
    matchLabels:
      app: api-service
# Rolling update behavior:
# - Kubernetes creates 5 new pods (maxSurge)
# - Waits for new pods to become ready
# - Terminates old pods one by one
# - PDB ensures never more than 2 unavailable
# - Update proceeds gradually and safely
```

### Scenario 2: Node Maintenance

```bash
#!/bin/bash
# safe-node-drain.sh

NODE=$1

echo "Draining node: ${NODE}"

# Check PDBs first
echo "Checking PDBs..."
kubectl get pdb --all-namespaces

# Drain with PDB respect (default)
kubectl drain ${NODE} \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=600 \
  --timeout=15m

# If drain hangs, check which pods are blocking
kubectl get pods --all-namespaces --field-selector spec.nodeName=${NODE}

# Check PDB status for blocking PDBs
for ns in $(kubectl get ns -o name | cut -d/ -f2); do
  kubectl get pdb -n ${ns} -o json | \
    jq -r '.items[] | select(.status.disruptionsAllowed == 0) | .metadata.name'
done

# Once maintenance complete
kubectl uncordon ${NODE}
```

## Conclusion

Pod Disruption Budgets are essential for maintaining application availability during voluntary disruptions. Key takeaways:

- Always define PDBs for production services
- Use percentage-based values for services with dynamic scaling
- Coordinate PDBs with HPA, VPA, and Cluster Autoscaler
- Test PDB effectiveness with drain simulations
- Monitor PDB status and alert on violations
- Document PDB decisions and link to SLOs
- Avoid overly restrictive PDBs that block operations
- Implement proper readiness probes for accurate health detection
- Regular audits to remove obsolete PDBs
- Maintain runbooks for PDB troubleshooting

Properly configured PDBs enable safe cluster operations while maintaining service availability guarantees, forming a critical component of production Kubernetes reliability engineering.