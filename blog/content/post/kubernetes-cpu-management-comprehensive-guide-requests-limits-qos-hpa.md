---
title: "Complete Guide to Kubernetes CPU Management: Requests, Limits, QoS Classes, and HPA Optimization"
date: 2026-10-27T09:00:00-05:00
draft: false
categories: ["Kubernetes", "Performance Optimization", "Resource Management"]
tags: ["Kubernetes", "CPU Management", "QoS Classes", "HPA", "Resource Requests", "Resource Limits", "Pod Scheduling", "Performance Tuning", "Cluster Optimization", "Autoscaling"]
---

# Complete Guide to Kubernetes CPU Management: Requests, Limits, QoS Classes, and HPA Optimization

Kubernetes CPU management is a critical aspect of cluster optimization that directly impacts application performance, resource utilization, and cost efficiency. Understanding how CPU requests, limits, Quality of Service (QoS) classes, and Horizontal Pod Autoscaler (HPA) work together is essential for running production-grade workloads effectively.

This comprehensive guide explores the intricate relationships between these components and provides practical strategies for optimizing CPU resource management in your Kubernetes clusters.

## Understanding CPU Resources in Kubernetes

Before diving into specific concepts, it's crucial to understand how Kubernetes measures and manages CPU resources.

### CPU Units and Measurement

Kubernetes uses standardized CPU units:

- **1 CPU core = 1000 millicores (m)**
- **500m = 0.5 CPU core**
- **100m = 0.1 CPU core**

These units are consistent across different node types and cloud providers, making resource allocation predictable and portable.

### The CPU Management Challenge

Modern applications face several CPU-related challenges:

1. **Variable Workloads**: CPU usage patterns vary dramatically based on traffic, time of day, and business cycles
2. **Resource Contention**: Multiple pods competing for limited CPU resources on shared nodes
3. **Scheduling Decisions**: Kubernetes scheduler needs accurate resource information for optimal pod placement
4. **Cost Optimization**: Balancing performance requirements with infrastructure costs
5. **Auto-scaling Accuracy**: HPA decisions depend on proper CPU resource configuration

## CPU Requests vs. Limits: The Foundation

Understanding the distinction between CPU requests and limits is fundamental to effective Kubernetes resource management.

### CPU Requests: Guaranteed Allocation

CPU requests represent the **minimum guaranteed CPU resources** that Kubernetes promises to provide to your container.

#### Key Characteristics of CPU Requests

1. **Scheduling Basis**: The Kubernetes scheduler uses requests to determine pod placement
2. **Resource Reservation**: Nodes reserve the requested CPU capacity for the pod
3. **QoS Classification**: Requests are used to determine the pod's Quality of Service class
4. **HPA Calculation**: HPA uses requests as the baseline for utilization calculations

#### Example CPU Request Configuration

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-server
spec:
  containers:
  - name: nginx
    image: nginx:1.21
    resources:
      requests:
        cpu: 250m        # Guaranteed 0.25 CPU cores
        memory: 128Mi
```

### CPU Limits: Maximum Consumption

CPU limits define the **maximum CPU resources** a container can consume, preventing resource monopolization.

#### Key Characteristics of CPU Limits

1. **Throttling Mechanism**: When a container exceeds its limit, the kernel throttles its CPU usage
2. **Protection**: Limits protect other workloads from CPU starvation
3. **No Killing**: Unlike memory limits, exceeding CPU limits doesn't kill the container
4. **CFS Scheduler**: Linux Completely Fair Scheduler (CFS) enforces CPU limits

#### Example CPU Limit Configuration

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-server
spec:
  containers:
  - name: nginx
    image: nginx:1.21
    resources:
      requests:
        cpu: 250m        # Guaranteed minimum
        memory: 128Mi
      limits:
        cpu: 500m        # Maximum allowed
        memory: 256Mi
```

### The Request-Limit Relationship

The relationship between requests and limits creates different behavior patterns:

#### Pattern 1: Equal Requests and Limits (Guaranteed)
```yaml
resources:
  requests:
    cpu: 500m
  limits:
    cpu: 500m
```
- **Behavior**: Consistent, predictable performance
- **Use Case**: Critical applications requiring stable CPU allocation
- **Trade-off**: May waste resources during low-utilization periods

#### Pattern 2: Lower Requests than Limits (Burstable)
```yaml
resources:
  requests:
    cpu: 200m
  limits:
    cpu: 800m
```
- **Behavior**: Can burst above baseline when resources are available
- **Use Case**: Applications with variable CPU needs
- **Trade-off**: Performance may vary based on node utilization

#### Pattern 3: Only Requests (Burstable)
```yaml
resources:
  requests:
    cpu: 200m
```
- **Behavior**: Guaranteed baseline with unlimited burst potential
- **Use Case**: Batch jobs that may need significant CPU bursts
- **Trade-off**: Can potentially impact other workloads

## Quality of Service (QoS) Classes

Kubernetes assigns QoS classes to pods based on their resource configuration, determining eviction priority during resource pressure.

### Guaranteed QoS Class

Pods receive Guaranteed QoS when **all containers** have:
- CPU and memory requests equal to their limits
- All resources explicitly defined

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: critical-app
spec:
  containers:
  - name: app
    image: critical-app:1.0
    resources:
      requests:
        cpu: 1000m
        memory: 1Gi
      limits:
        cpu: 1000m
        memory: 1Gi
```

#### Guaranteed QoS Characteristics

- **Highest Priority**: Last to be evicted during resource pressure
- **Predictable Performance**: Consistent resource allocation
- **Use Cases**: Critical system components, databases, stateful applications

### Burstable QoS Class

Pods receive Burstable QoS when:
- At least one container has CPU or memory requests
- Not all containers meet Guaranteed criteria

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web-app
spec:
  containers:
  - name: frontend
    image: web-app:1.0
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
  - name: sidecar
    image: logging-agent:1.0
    resources:
      requests:
        cpu: 50m
```

#### Burstable QoS Characteristics

- **Medium Priority**: Evicted after BestEffort but before Guaranteed
- **Flexible Resource Usage**: Can use available resources beyond requests
- **Use Cases**: Web applications, API services, general workloads

### BestEffort QoS Class

Pods receive BestEffort QoS when:
- No containers have CPU or memory requests or limits

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: batch-job
spec:
  containers:
  - name: worker
    image: batch-processor:1.0
    # No resource specifications
```

#### BestEffort QoS Characteristics

- **Lowest Priority**: First to be evicted during resource pressure
- **Opportunistic**: Uses whatever resources are available
- **Use Cases**: Batch jobs, development workloads, non-critical tasks

### QoS Class Impact on Scheduling and Eviction

```yaml
# Node under memory pressure - eviction order:
# 1. BestEffort pods (all)
# 2. Burstable pods (exceeding requests, sorted by usage)
# 3. Guaranteed pods (only if system components need resources)
```

## Horizontal Pod Autoscaler (HPA) and CPU Utilization

HPA automatically scales the number of pods based on observed CPU utilization, but its effectiveness depends heavily on proper resource configuration.

### How HPA Calculates CPU Utilization

HPA uses this formula to determine current utilization:

```
CPU Utilization (%) = (Actual CPU Usage) / (CPU Requests) × 100
```

#### Critical Insight: Requests as the Baseline

The CPU requests value serves as the denominator in HPA calculations, making it the single most important factor in scaling decisions.

### HPA Configuration Example

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-app-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
```

### The Impact of CPU Requests on HPA Scaling

Consider an application that consistently uses 300m CPU with different request configurations:

| CPU Request | Actual Usage | Calculated Utilization | HPA Action (Target: 60%) |
|-------------|--------------|------------------------|--------------------------|
| 100m        | 300m         | 300%                   | Aggressive scale-up      |
| 200m        | 300m         | 150%                   | Moderate scale-up        |
| 300m        | 300m         | 100%                   | Some scale-up            |
| 500m        | 300m         | 60%                    | Maintain (target met)    |
| 600m        | 300m         | 50%                    | Potential scale-down     |

#### Key Observations

1. **Low Requests = Aggressive Scaling**: Setting requests too low causes excessive scaling
2. **High Requests = Under-utilization**: Setting requests too high wastes resources
3. **Optimal Requests**: Should align with typical application CPU usage patterns

### Advanced HPA Configuration

#### Multiple Metrics HPA
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: advanced-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "30"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Pods
        value: 2
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Pods
        value: 4
        periodSeconds: 60
      - type: Percent
        value: 100
        periodSeconds: 60
      selectPolicy: Max
```

## CPU Management Best Practices

### 1. Right-Sizing CPU Requests

Determining optimal CPU requests requires understanding your application's behavior:

#### Method 1: Historical Analysis
```bash
# Get CPU usage over time using kubectl top
kubectl top pods --containers --sort-by=cpu

# Use Prometheus queries for historical data
avg_over_time(rate(container_cpu_usage_seconds_total[5m])[24h:5m])
```

#### Method 2: Load Testing
```yaml
# Deploy with minimal requests for load testing
resources:
  requests:
    cpu: 100m
  limits:
    cpu: 2000m
```

#### Method 3: Gradual Adjustment
Start conservative and adjust based on observed behavior:

```yaml
# Week 1: Conservative estimate
resources:
  requests:
    cpu: 500m
    
# Week 2: Adjust based on actual usage
resources:
  requests:
    cpu: 300m  # If average usage was 250m
    
# Week 3: Fine-tune for HPA effectiveness
resources:
  requests:
    cpu: 350m  # Adjusted for 60% target utilization
```

### 2. Strategic CPU Limit Setting

#### When to Set CPU Limits

**Set Limits When:**
- Running multi-tenant clusters
- Protecting critical workloads
- Compliance requires resource governance
- Preventing runaway processes

**Consider No Limits When:**
- Single-tenant clusters
- Batch processing workloads
- Development environments
- Maximum performance is critical

#### Limit Setting Strategies

```yaml
# Strategy 1: Conservative (Guaranteed QoS)
resources:
  requests:
    cpu: 500m
  limits:
    cpu: 500m

# Strategy 2: Moderate Burst (2x requests)
resources:
  requests:
    cpu: 500m
  limits:
    cpu: 1000m

# Strategy 3: High Burst (4x requests)
resources:
  requests:
    cpu: 250m
  limits:
    cpu: 1000m

# Strategy 4: No Limits (Unlimited burst)
resources:
  requests:
    cpu: 300m
  # No limits specified
```

### 3. Application-Specific Configurations

#### Web Applications
```yaml
# Typical web application pattern
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: app
        resources:
          requests:
            cpu: 200m      # Based on average load
            memory: 256Mi
          limits:
            cpu: 500m      # Allow for traffic spikes
            memory: 512Mi
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-app-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
```

#### Database Applications
```yaml
# Database with guaranteed resources
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: database
spec:
  template:
    spec:
      containers:
      - name: postgres
        resources:
          requests:
            cpu: 2000m     # Guaranteed 2 cores
            memory: 4Gi
          limits:
            cpu: 2000m     # No CPU bursting
            memory: 4Gi    # Guaranteed QoS
```

#### Batch Processing
```yaml
# Batch job with burstable resources
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processor
spec:
  template:
    spec:
      containers:
      - name: processor
        resources:
          requests:
            cpu: 500m      # Minimum for scheduling
            memory: 1Gi
          limits:
            cpu: 4000m     # Can use up to 4 cores
            memory: 8Gi
```

### 4. Node and Cluster Considerations

#### Node Resource Allocation

Understanding node capacity allocation is crucial:

```bash
# Check node allocatable resources
kubectl describe node <node-name> | grep -A 10 "Allocatable"

# View resource requests vs limits across nodes
kubectl describe nodes | grep -A 15 "Allocated resources"
```

#### Cluster-Level Resource Management

```yaml
# ResourceQuota for namespace-level limits
apiVersion: v1
kind: ResourceQuota
metadata:
  name: cpu-quota
  namespace: production
spec:
  hard:
    requests.cpu: "10"     # Max 10 CPU cores requested
    limits.cpu: "20"       # Max 20 CPU cores limited
    pods: "50"             # Maximum 50 pods
```

```yaml
# LimitRange for default values
apiVersion: v1
kind: LimitRange
metadata:
  name: cpu-limit-range
  namespace: production
spec:
  limits:
  - default:               # Default limits
      cpu: 500m
      memory: 512Mi
    defaultRequest:        # Default requests
      cpu: 200m
      memory: 256Mi
    type: Container
```

## Monitoring and Troubleshooting CPU Management

### Essential Monitoring Metrics

#### Node-Level Metrics
```prometheus
# Node CPU utilization
100 - (avg by (instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# Node CPU throttling
rate(container_cpu_cfs_throttled_seconds_total[5m])

# Node available CPU
kube_node_status_allocatable{resource="cpu"}
```

#### Pod-Level Metrics
```prometheus
# Pod CPU usage
rate(container_cpu_usage_seconds_total[5m])

# Pod CPU throttling
rate(container_cpu_cfs_throttled_seconds_total[5m]) > 0

# HPA scaling events
increase(hpa_controller_scaling_events_total[1h])
```

### Common CPU Management Issues

#### Issue 1: Excessive HPA Scaling

**Symptoms:**
- Frequent scale-up/scale-down events
- High cluster churn
- Inconsistent application performance

**Diagnosis:**
```bash
# Check HPA events
kubectl describe hpa <hpa-name>

# Monitor CPU utilization patterns
kubectl top pods --sort-by=cpu

# Check scaling behavior
kubectl get events --field-selector involvedObject.kind=HorizontalPodAutoscaler
```

**Solutions:**
```yaml
# Adjust HPA behavior for stability
behavior:
  scaleDown:
    stabilizationWindowSeconds: 300  # 5-minute stabilization
    policies:
    - type: Percent
      value: 10               # Max 10% scale-down
      periodSeconds: 60
  scaleUp:
    stabilizationWindowSeconds: 60   # 1-minute stabilization
    policies:
    - type: Pods
      value: 2                # Max 2 pods per minute
      periodSeconds: 60
```

#### Issue 2: CPU Throttling

**Symptoms:**
- High CPU throttling metrics
- Application latency increases
- Performance degradation despite available node CPU

**Diagnosis:**
```bash
# Check throttling metrics
kubectl exec -it <pod-name> -- cat /sys/fs/cgroup/cpu/cpu.stat

# Monitor container metrics
docker stats <container-id>
```

**Solutions:**
1. **Increase CPU limits**
2. **Optimize application code**
3. **Use CPU management policies**

```yaml
# CPU Manager Policy (node-level)
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubelet-config
data:
  config.yaml: |
    cpuManagerPolicy: static
    cpuManagerReconcilePeriod: 10s
```

#### Issue 3: Pod Scheduling Failures

**Symptoms:**
- Pods stuck in Pending state
- "Insufficient CPU" events
- Uneven resource distribution

**Diagnosis:**
```bash
# Check pod events
kubectl describe pod <pod-name>

# View node resource allocation
kubectl describe nodes | grep -E "(Name:|Allocated resources:)" -A 10
```

**Solutions:**
```yaml
# Use pod anti-affinity for better distribution
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchExpressions:
          - key: app
            operator: In
            values:
            - web-app
        topologyKey: kubernetes.io/hostname
```

### Optimization Tools and Scripts

#### CPU Request Recommendation Script
```bash
#!/bin/bash
# get-cpu-recommendations.sh

NAMESPACE=${1:-default}
DEPLOYMENT=${2}

echo "CPU Usage Analysis for $DEPLOYMENT in $NAMESPACE"
echo "=================================================="

# Get current requests
CURRENT_REQUESTS=$(kubectl get deployment $DEPLOYMENT -n $NAMESPACE -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}')
echo "Current CPU Requests: $CURRENT_REQUESTS"

# Get average CPU usage over last 24 hours
USAGE=$(kubectl top pods -n $NAMESPACE -l app=$DEPLOYMENT --no-headers | awk '{sum+=$2} END {print sum/NR}')
echo "Average CPU Usage: ${USAGE}m"

# Calculate recommendation (usage * 1.2 for 20% buffer)
RECOMMENDATION=$(echo "$USAGE * 1.2" | bc)
echo "Recommended CPU Requests: ${RECOMMENDATION}m"

# HPA utilization with current and recommended requests
CURRENT_UTIL=$(echo "scale=2; $USAGE * 100 / ${CURRENT_REQUESTS%m}" | bc)
RECOMMENDED_UTIL=$(echo "scale=2; $USAGE * 100 / $RECOMMENDATION" | bc)

echo "Current HPA Utilization: ${CURRENT_UTIL}%"
echo "Recommended HPA Utilization: ${RECOMMENDED_UTIL}%"
```

## Advanced CPU Management Patterns

### 1. Multi-Container Pod Resource Allocation

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: multi-container-app
spec:
  containers:
  - name: main-app
    image: app:1.0
    resources:
      requests:
        cpu: 500m        # Primary application CPU
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 1Gi
  - name: sidecar-proxy
    image: envoy:1.18
    resources:
      requests:
        cpu: 100m        # Lightweight proxy
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 256Mi
  - name: log-shipper
    image: fluent-bit:1.8
    resources:
      requests:
        cpu: 50m         # Minimal logging agent
        memory: 64Mi
      limits:
        cpu: 100m
        memory: 128Mi
```

### 2. CPU-Intensive vs. I/O-Bound Workloads

#### CPU-Intensive Configuration
```yaml
# Machine learning training job
resources:
  requests:
    cpu: 4000m          # High CPU allocation
    memory: 8Gi
  limits:
    cpu: 8000m          # Allow significant bursting
    memory: 16Gi
```

#### I/O-Bound Configuration
```yaml
# Web server with database connections
resources:
  requests:
    cpu: 200m           # Lower CPU, high memory
    memory: 1Gi
  limits:
    cpu: 500m           # Moderate CPU limit
    memory: 2Gi
```

### 3. Seasonal and Time-Based Scaling

```yaml
# Different HPA configurations for business hours
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: business-hours-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  minReplicas: 10         # Higher baseline during business hours
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50  # Lower threshold for faster response
```

## Performance Testing and Validation

### Load Testing with CPU Resource Constraints

```yaml
# Load test deployment with resource constraints
apiVersion: apps/v1
kind: Deployment
metadata:
  name: load-test-target
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: app
        image: stress-test-app:1.0
        resources:
          requests:
            cpu: 250m
          limits:
            cpu: 500m
        env:
        - name: CPU_STRESS_ENABLED
          value: "true"
```

### Chaos Engineering for CPU Resources

```yaml
# Chaos Monkey for CPU exhaustion testing
apiVersion: v1
kind: Pod
metadata:
  name: cpu-stress-test
spec:
  containers:
  - name: stress
    image: polinux/stress
    command: ["stress"]
    args: ["--cpu", "2", "--timeout", "60s"]
    resources:
      limits:
        cpu: 2000m
```

## Cost Optimization Strategies

### 1. Right-Sizing Analysis

Regular analysis of actual vs. requested resources:

```bash
# Weekly resource utilization report
kubectl top pods --all-namespaces --no-headers | \
  awk '{print $1, $2, $3}' | \
  sort -k3 -nr | \
  head -20
```

### 2. Vertical Pod Autoscaler (VPA) Integration

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: web-app-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: app
      maxAllowed:
        cpu: 2000m
        memory: 4Gi
      minAllowed:
        cpu: 100m
        memory: 128Mi
```

### 3. Spot Instance Optimization

Configure workloads for spot instances with appropriate resource requests:

```yaml
# Spot-friendly configuration
nodeSelector:
  karpenter.sh/capacity-type: spot
tolerations:
- key: karpenter.sh/capacity-type
  operator: Equal
  value: spot
  effect: NoSchedule
resources:
  requests:
    cpu: 500m    # Ensure predictable scheduling
  limits:
    cpu: 1000m   # Allow bursting when available
```

## Conclusion

Effective Kubernetes CPU management requires a deep understanding of how requests, limits, QoS classes, and HPA work together. The key insights for optimal CPU resource management include:

1. **CPU Requests Drive Scheduling**: Set requests based on actual application needs, not theoretical maximums
2. **HPA Depends on Requests**: The ratio of actual usage to requests determines scaling behavior
3. **QoS Classes Affect Reliability**: Choose the appropriate QoS class based on application criticality
4. **Limits Prevent Contention**: Use limits strategically to protect workloads without over-constraining them
5. **Monitor and Adjust**: Continuously monitor and adjust resource allocations based on real-world usage patterns

By following the patterns and best practices outlined in this guide, you can achieve optimal CPU resource utilization, improve application performance, and reduce infrastructure costs while maintaining system reliability and responsiveness.

## Additional Resources

- [Kubernetes Resource Management Documentation](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Horizontal Pod Autoscaler Walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [Quality of Service for Pods](https://kubernetes.io/docs/tasks/configure-pod-container/quality-service-pod/)
- [CPU Management Policies](https://kubernetes.io/docs/tasks/administer-cluster/cpu-management-policies/)
- [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)