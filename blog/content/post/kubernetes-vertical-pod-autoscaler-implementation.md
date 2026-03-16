---
title: "Kubernetes Vertical Pod Autoscaler Implementation: Resource Optimization Guide"
date: 2026-09-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "VPA", "Autoscaling", "Resource Management", "Optimization", "Performance"]
categories: ["Kubernetes", "DevOps", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Kubernetes Vertical Pod Autoscaler for optimal resource allocation, including recommendations, update policies, and integration with HPA."
more_link: "yes"
url: "/kubernetes-vertical-pod-autoscaler-implementation/"
---

The Vertical Pod Autoscaler (VPA) automatically adjusts CPU and memory requests and limits for containers based on historical usage patterns. This guide covers VPA implementation strategies, recommendation modes, update policies, and best practices for production environments.

<!--more-->

## Executive Summary

While Horizontal Pod Autoscaler scales the number of pod replicas, Vertical Pod Autoscaler optimizes resource allocation per pod. VPA analyzes resource consumption patterns and provides recommendations or automatically applies resource adjustments, eliminating manual tuning and preventing resource waste or starvation.

## VPA Architecture and Components

### VPA Component Overview

**VPA consists of three main components:**

```yaml
# VPA Architecture Components
---
# 1. VPA Recommender
# Monitors resource usage and provides recommendations
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vpa-recommender
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vpa-recommender
  template:
    metadata:
      labels:
        app: vpa-recommender
    spec:
      serviceAccountName: vpa-recommender
      containers:
      - name: recommender
        image: registry.k8s.io/autoscaling/vpa-recommender:0.14.0
        command:
        - /recommender
        - --v=4
        - --stderrthreshold=info
        - --prometheus-address=http://prometheus.monitoring:9090
        - --prometheus-cadvisor-job-name=kubernetes-cadvisor
        - --storage=prometheus
        - --recommendation-margin-fraction=0.15  # 15% margin
        - --pod-recommendation-min-cpu-millicores=25  # Min 25m CPU
        - --pod-recommendation-min-memory-mb=250  # Min 250Mi memory
        resources:
          requests:
            cpu: 200m
            memory: 1Gi
          limits:
            cpu: 1000m
            memory: 2Gi
---
# 2. VPA Updater
# Evicts pods when resources need updating
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vpa-updater
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vpa-updater
  template:
    metadata:
      labels:
        app: vpa-updater
    spec:
      serviceAccountName: vpa-updater
      containers:
      - name: updater
        image: registry.k8s.io/autoscaling/vpa-updater:0.14.0
        command:
        - /updater
        - --v=4
        - --stderrthreshold=info
        - --min-replicas=2  # Don't update if less than 2 replicas
        - --eviction-tolerance=0.5  # Max 50% pods can be evicted
        - --eviction-rate-limit=1  # 1 eviction per second
        - --eviction-rate-burst=5  # Burst up to 5 evictions
        resources:
          requests:
            cpu: 100m
            memory: 500Mi
          limits:
            cpu: 500m
            memory: 1Gi
---
# 3. VPA Admission Controller
# Mutates pod resource requests at creation time
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vpa-admission-controller
  namespace: kube-system
spec:
  replicas: 2  # HA for admission controller
  selector:
    matchLabels:
      app: vpa-admission-controller
  template:
    metadata:
      labels:
        app: vpa-admission-controller
    spec:
      serviceAccountName: vpa-admission-controller
      containers:
      - name: admission-controller
        image: registry.k8s.io/autoscaling/vpa-admission-controller:0.14.0
        command:
        - /admission-controller
        - --v=4
        - --stderrthreshold=info
        - --tls-cert-file=/etc/tls-certs/tls.crt
        - --tls-private-key-file=/etc/tls-certs/tls.key
        - --client-ca-file=/etc/tls-certs/ca.crt
        - --port=8944
        volumeMounts:
        - name: tls-certs
          mountPath: /etc/tls-certs
          readOnly: true
        resources:
          requests:
            cpu: 100m
            memory: 200Mi
          limits:
            cpu: 500m
            memory: 500Mi
        ports:
        - containerPort: 8944
          name: https
        livenessProbe:
          httpGet:
            path: /health-check
            port: https
            scheme: HTTPS
          initialDelaySeconds: 30
          periodSeconds: 10
      volumes:
      - name: tls-certs
        secret:
          secretName: vpa-tls-certs
---
apiVersion: v1
kind: Service
metadata:
  name: vpa-webhook
  namespace: kube-system
spec:
  ports:
  - port: 443
    targetPort: 8944
  selector:
    app: vpa-admission-controller
---
# MutatingWebhookConfiguration
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: vpa-webhook-config
webhooks:
- name: vpa.k8s.io
  clientConfig:
    service:
      name: vpa-webhook
      namespace: kube-system
      path: "/mutate"
    caBundle: <base64-encoded-ca-cert>
  rules:
  - operations: ["CREATE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
  admissionReviewVersions: ["v1"]
  sideEffects: None
  timeoutSeconds: 10
  failurePolicy: Ignore  # Don't block pod creation if VPA unavailable
```

### Installation

**Install VPA using Helm:**

```bash
#!/bin/bash
set -e

# Add VPA Helm repository
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

# Install VPA
helm install vpa fairwinds-stable/vpa \
  --namespace kube-system \
  --set recommender.enabled=true \
  --set recommender.extraArgs.prometheus-address=http://prometheus.monitoring:9090 \
  --set recommender.extraArgs.storage=prometheus \
  --set updater.enabled=true \
  --set updater.extraArgs.min-replicas=2 \
  --set admissionController.enabled=true \
  --set admissionController.replicas=2

# Verify installation
kubectl get pods -n kube-system -l app.kubernetes.io/instance=vpa

# Verify CRD
kubectl get crd verticalpodautoscalers.autoscaling.k8s.io
```

## VPA Modes and Update Policies

### Recommendation-Only Mode (Off)

**Safe initial deployment - no automatic updates:**

```yaml
# vpa-recommendation-only.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: webapp-vpa-recommend
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: webapp
  updatePolicy:
    updateMode: "Off"  # Only provide recommendations
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4000m
        memory: 8Gi
      controlledResources: ["cpu", "memory"]
---
# View recommendations
# kubectl describe vpa webapp-vpa-recommend -n production
# Shows:
# Status:
#   Recommendation:
#     Container Recommendations:
#       Container Name:  webapp
#       Lower Bound:
#         Cpu:     250m
#         Memory:  262144k
#       Target:
#         Cpu:     500m
#         Memory:  524288k
#       Uncapped Target:
#         Cpu:     500m
#         Memory:  524288k
#       Upper Bound:
#         Cpu:     1000m
#         Memory:  1048576k
```

### Initial Mode (On Pod Creation Only)

**Apply recommendations only to new pods:**

```yaml
# vpa-initial-mode.yaml
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
    updateMode: "Initial"  # Only update new pods
  resourcePolicy:
    containerPolicies:
    - containerName: 'api'
      minAllowed:
        cpu: 200m
        memory: 256Mi
      maxAllowed:
        cpu: 8000m
        memory: 16Gi
      controlledResources: ["cpu", "memory"]
      # Don't scale these beyond current limits
      mode: Auto
---
# Good for:
# - Rolling updates where you want gradual adoption
# - Deployments with PodDisruptionBudgets
# - Testing VPA without disrupting running pods
```

### Auto Mode (Automatic Updates)

**Automatically evict and restart pods with new resources:**

```yaml
# vpa-auto-mode.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: background-worker-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: background-worker
  updatePolicy:
    updateMode: "Auto"  # Automatically update running pods
    minReplicas: 3  # Minimum replicas before allowing evictions
  resourcePolicy:
    containerPolicies:
    - containerName: 'worker'
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4000m
        memory: 8Gi
      controlledResources: ["cpu", "memory"]
      mode: Auto
---
# Warning: Auto mode will evict pods!
# Ensure:
# - PodDisruptionBudget is configured
# - Multiple replicas exist
# - Application handles restarts gracefully
```

### Recreate Mode (Experimental)

**For pods that can't be evicted (e.g., single replica):**

```yaml
# vpa-recreate-mode.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: statefulset-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: database
  updatePolicy:
    updateMode: "Recreate"  # Delete and recreate pods
  resourcePolicy:
    containerPolicies:
    - containerName: 'postgres'
      minAllowed:
        cpu: 1000m
        memory: 2Gi
      maxAllowed:
        cpu: 16000m
        memory: 64Gi
      controlledResources: ["cpu", "memory"]
```

## Advanced Resource Policies

### Container-Specific Policies

**Fine-grained control per container:**

```yaml
# container-specific-vpa.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: multi-container-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: multi-container-app
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    # Main application container
    - containerName: 'app'
      minAllowed:
        cpu: 500m
        memory: 512Mi
      maxAllowed:
        cpu: 8000m
        memory: 16Gi
      controlledResources: ["cpu", "memory"]
      mode: Auto
    # Sidecar logging container
    - containerName: 'log-shipper'
      minAllowed:
        cpu: 50m
        memory: 64Mi
      maxAllowed:
        cpu: 500m
        memory: 512Mi
      controlledResources: ["cpu", "memory"]
      mode: Auto
    # Metrics exporter - fixed resources
    - containerName: 'metrics-exporter'
      mode: "Off"  # Don't autoscale this container
    # Init containers
    - containerName: 'init-db'
      mode: "Off"  # Don't manage init containers
```

### Controlled Resources

**Specify which resources to manage:**

```yaml
# controlled-resources-vpa.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: cpu-only-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cpu-intensive-app
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      # Only manage CPU, leave memory as-is
      controlledResources: ["cpu"]
      minAllowed:
        cpu: 1000m
      maxAllowed:
        cpu: 16000m
      mode: Auto
---
# Memory-only VPA
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: memory-only-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: memory-intensive-app
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      # Only manage memory
      controlledResources: ["memory"]
      minAllowed:
        memory: 1Gi
      maxAllowed:
        memory: 32Gi
      mode: Auto
```

### Scaling Modes

**Different scaling behaviors:**

```yaml
# scaling-modes-vpa.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: scaling-modes-example
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example-app
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: 'app'
      # Auto: Automatically adjust requests and limits
      mode: Auto
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4000m
        memory: 8Gi
      controlledResources: ["cpu", "memory"]
    - containerName: 'sidecar'
      # Off: Don't autoscale this container
      mode: "Off"
```

## Production Implementation Patterns

### Gradual VPA Adoption

**Phase 1: Observation (Recommendation Mode):**

```yaml
# phase1-observation.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: production-app-vpa-phase1
  namespace: production
  labels:
    vpa-phase: "observation"
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: production-app
  updatePolicy:
    updateMode: "Off"  # Phase 1: Just observe
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 16000m
        memory: 32Gi
      controlledResources: ["cpu", "memory"]
---
# Monitor recommendations for 1-2 weeks
# kubectl describe vpa production-app-vpa-phase1 -n production
# Compare recommendations with current usage:
# kubectl top pods -n production -l app=production-app
```

**Phase 2: Initial Mode (New Pods Only):**

```yaml
# phase2-initial.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: production-app-vpa-phase2
  namespace: production
  labels:
    vpa-phase: "initial"
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: production-app
  updatePolicy:
    updateMode: "Initial"  # Phase 2: Apply to new pods
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 16000m
        memory: 32Gi
      controlledResources: ["cpu", "memory"]
---
# During rolling updates, new pods get VPA recommendations
# Monitor for issues over several deployment cycles
```

**Phase 3: Auto Mode (Full Automation):**

```yaml
# phase3-auto.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: production-app-vpa-phase3
  namespace: production
  labels:
    vpa-phase: "auto"
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: production-app
  updatePolicy:
    updateMode: "Auto"  # Phase 3: Full automation
    minReplicas: 3  # Ensure multiple replicas for safe evictions
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 16000m
        memory: 32Gi
      controlledResources: ["cpu", "memory"]
---
# Requires:
# - PodDisruptionBudget configured
# - Multiple replicas running
# - Graceful shutdown handling
```

### VPA with Pod Disruption Budgets

**Coordinated VPA and PDB:**

```yaml
# vpa-with-pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: production-app-pdb
  namespace: production
spec:
  minAvailable: 70%  # Always keep 70% of pods running
  selector:
    matchLabels:
      app: production-app
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: production-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: production-app
  updatePolicy:
    updateMode: "Auto"
    minReplicas: 5  # VPA won't evict if less than 5 replicas
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      minAllowed:
        cpu: 200m
        memory: 256Mi
      maxAllowed:
        cpu: 8000m
        memory: 16Gi
      controlledResources: ["cpu", "memory"]
---
# VPA respects PDB and will not evict pods
# that would violate the disruption budget
```

### VPA and HPA Integration

**Use VPA and HPA together (with caution):**

```yaml
# vpa-hpa-integration.yaml
# VPA manages vertical scaling (resource requests)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: webapp-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: webapp
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      # VPA manages CPU and memory requests
      controlledResources: ["cpu", "memory"]
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 2000m
        memory: 4Gi
---
# HPA manages horizontal scaling (replica count)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: webapp-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: webapp
  minReplicas: 10
  maxReplicas: 100
  metrics:
  # HPA should use custom metrics, NOT CPU/memory
  # to avoid conflict with VPA
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
---
# WARNING: Using CPU/memory metrics with both VPA and HPA
# can cause conflicts. Best practice:
# - VPA manages resource requests/limits
# - HPA scales based on custom metrics (requests, queue depth, etc.)
```

## Monitoring and Observability

### VPA Metrics

**Prometheus metrics for VPA:**

```yaml
# vpa-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vpa-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: vpa-recommender
  namespaceSelector:
    matchNames:
    - kube-system
  endpoints:
  - port: metrics
    interval: 30s
---
# PrometheusRule for VPA alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vpa-alerts
  namespace: monitoring
spec:
  groups:
  - name: vpa
    interval: 30s
    rules:
    - alert: VPARecommenderDown
      expr: up{job="vpa-recommender"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "VPA Recommender is down"
        description: "VPA Recommender has been down for 5 minutes"

    - alert: VPAUpdaterDown
      expr: up{job="vpa-updater"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "VPA Updater is down"
        description: "VPA Updater has been down for 5 minutes"

    - alert: VPAAdmissionControllerDown
      expr: up{job="vpa-admission-controller"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "VPA Admission Controller is down"
        description: "VPA Admission Controller has been down for 5 minutes"

    - alert: VPARecommendationNotAvailable
      expr: |
        kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"} == 0
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "VPA {{ $labels.namespace }}/{{ $labels.verticalpodautoscaler }} has no recommendations"
        description: "VPA has not generated recommendations for 30 minutes"

    - alert: VPALargeResourceChangeDetected
      expr: |
        abs((kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="cpu"}
        - on(namespace, verticalpodautoscaler, container) kube_pod_container_resource_requests{resource="cpu"})
        / kube_pod_container_resource_requests{resource="cpu"}) > 0.5
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "VPA recommends >50% resource change"
        description: "VPA recommends changing resources by more than 50% for {{ $labels.namespace }}/{{ $labels.verticalpodautoscaler }}"
```

### VPA Dashboard

**Grafana dashboard for VPA:**

```json
{
  "dashboard": {
    "title": "VPA Monitoring",
    "panels": [
      {
        "title": "VPA Recommendations vs Current Resources",
        "targets": [
          {
            "expr": "kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource='cpu'}",
            "legendFormat": "{{ namespace }}/{{ verticalpodautoscaler }} - Recommended CPU"
          },
          {
            "expr": "kube_pod_container_resource_requests{resource='cpu'}",
            "legendFormat": "{{ namespace }}/{{ pod }} - Current CPU Request"
          }
        ]
      },
      {
        "title": "VPA Update Operations",
        "targets": [
          {
            "expr": "rate(vpa_recommender_update_total[5m])",
            "legendFormat": "{{ namespace }}/{{ verticalpodautoscaler }}"
          }
        ]
      },
      {
        "title": "Pod Evictions by VPA",
        "targets": [
          {
            "expr": "rate(vpa_evictions_total[5m])",
            "legendFormat": "{{ namespace }}/{{ verticalpodautoscaler }}"
          }
        ]
      }
    ]
  }
}
```

## Troubleshooting

### VPA Diagnostic Script

```bash
#!/bin/bash
# vpa-diagnostics.sh

NAMESPACE=${1:-production}

echo "=== VPA Status ==="

echo "VPA Resources:"
kubectl get vpa -n ${NAMESPACE}

echo ""
echo "VPA Details:"
for vpa in $(kubectl get vpa -n ${NAMESPACE} -o name); do
  echo "--- $vpa ---"
  kubectl describe $vpa -n ${NAMESPACE}
done

echo ""
echo "=== VPA Components Health ==="
kubectl get pods -n kube-system -l app.kubernetes.io/instance=vpa

echo ""
echo "=== VPA Recommender Logs ==="
kubectl logs -n kube-system -l app=vpa-recommender --tail=50

echo ""
echo "=== VPA Updater Logs ==="
kubectl logs -n kube-system -l app=vpa-updater --tail=50

echo ""
echo "=== VPA Admission Controller Logs ==="
kubectl logs -n kube-system -l app=vpa-admission-controller --tail=50

echo ""
echo "=== Recent VPA Events ==="
kubectl get events -n ${NAMESPACE} --field-selector reason=EvictedByVPA --sort-by='.lastTimestamp'

echo ""
echo "=== Check MutatingWebhookConfiguration ==="
kubectl get mutatingwebhookconfiguration vpa-webhook-config -o yaml

echo ""
echo "=== Metrics Server Status ==="
kubectl get apiservice v1beta1.metrics.k8s.io
```

### Common Issues

**VPA Not Generating Recommendations:**

```bash
# Check if metrics server is working
kubectl top nodes
kubectl top pods -n production

# Check VPA recommender logs
kubectl logs -n kube-system -l app=vpa-recommender

# Verify pods have resource requests set
kubectl get deployment webapp -n production -o json | \
  jq '.spec.template.spec.containers[].resources.requests'

# Check VPA status
kubectl describe vpa webapp-vpa -n production
```

## Best Practices

### Production Deployment Checklist

```yaml
# production-vpa-checklist.yaml
# 1. Start with recommendation mode
# 2. Set appropriate resource bounds
# 3. Configure PodDisruptionBudget
# 4. Enable monitoring and alerting
# 5. Test in non-production first

apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: production-app-vpa
  namespace: production
  annotations:
    # Document VPA configuration
    vpa.kubernetes.io/description: "Manages CPU and memory for production app"
    vpa.kubernetes.io/owner: "platform-team"
    vpa.kubernetes.io/review-date: "2025-12-01"
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: production-app
  updatePolicy:
    updateMode: "Auto"
    minReplicas: 5  # Ensure multiple replicas
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      minAllowed:
        # Set realistic minimums
        cpu: 200m
        memory: 256Mi
      maxAllowed:
        # Set reasonable maximums based on node capacity
        cpu: 8000m
        memory: 16Gi
      controlledResources: ["cpu", "memory"]
      mode: Auto
```

### When to Use VPA

**Good Use Cases:**
- Applications with unpredictable resource needs
- Batch jobs and data processing workloads
- Development and staging environments
- Cost optimization initiatives
- Applications without strict latency requirements

**Avoid VPA When:**
- Using HPA with CPU/memory metrics (conflict)
- Single replica deployments (use recommendation mode)
- Extremely latency-sensitive applications
- Applications that can't tolerate restarts

## Conclusion

Vertical Pod Autoscaler provides powerful resource optimization capabilities when used correctly. Key takeaways:

- Start with recommendation mode to understand patterns
- Progress through initial mode before enabling auto mode
- Always use PodDisruptionBudgets with auto mode
- Set reasonable min/max resource boundaries
- Monitor VPA recommendations and adjust policies
- Be cautious combining VPA and HPA on same metrics
- Document VPA configurations for team awareness

VPA eliminates manual resource tuning while ensuring optimal resource allocation, reducing costs and improving cluster efficiency when implemented with production safeguards.