---
title: "Container Resource Limits Best Practices: Kubernetes Resource Management Guide"
date: 2026-05-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Containers", "Resource Management", "Performance", "Best Practices", "Docker", "QoS"]
categories: ["Kubernetes", "Performance", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to container resource limits in Kubernetes, covering requests, limits, QoS classes, resource quotas, and best practices for production workload resource management."
more_link: "yes"
url: "/container-resource-limits-best-practices-kubernetes/"
---

Master container resource management in Kubernetes with this comprehensive guide covering resource requests and limits, QoS classes, limit ranges, resource quotas, and production best practices for optimal cluster utilization and application performance.

<!--more-->

# Container Resource Limits Best Practices: Kubernetes Resource Management Guide

## Executive Summary

Proper resource management is fundamental to running stable, performant applications in Kubernetes. Understanding resource requests, limits, Quality of Service (QoS) classes, and implementing appropriate resource constraints ensures efficient cluster utilization, prevents resource contention, and maintains application stability. This guide provides production-tested strategies for container resource management in enterprise Kubernetes environments.

## Understanding Kubernetes Resource Model

### Resource Types and Units

Kubernetes manages two primary resource types:

```yaml
# resource-types-example.yaml
# Understanding Kubernetes resource types and units

apiVersion: v1
kind: Pod
metadata:
  name: resource-types-demo
spec:
  containers:
  - name: demo
    image: nginx:1.25
    resources:
      # Requests: Minimum guaranteed resources
      requests:
        # CPU in millicores (1000m = 1 CPU core)
        cpu: "500m"      # 0.5 CPU cores
        # Memory in bytes with SI or binary suffixes
        memory: "512Mi"  # 512 Mebibytes

        # Ephemeral storage (if supported)
        ephemeral-storage: "2Gi"

      # Limits: Maximum allowed resources
      limits:
        # CPU can burst to this amount
        cpu: "1000m"     # 1 CPU core
        # Memory hard limit (OOM if exceeded)
        memory: "1Gi"    # 1 Gibibyte

        # Ephemeral storage limit
        ephemeral-storage: "4Gi"

    # Extended resources (custom resources like GPUs)
    # requests:
    #   nvidia.com/gpu: 1
    # limits:
    #   nvidia.com/gpu: 1
```

### Resource Units Reference

```bash
#!/bin/bash
# Resource units conversion reference

cat << 'EOF' > /usr/local/bin/k8s-resource-converter.sh
#!/bin/bash

# CPU Units Conversion
echo "=== CPU Units ==="
echo "1 CPU core = 1000m (millicores)"
echo "0.5 CPU = 500m"
echo "0.1 CPU = 100m"
echo
echo "Examples:"
echo "  100m  = 10% of one core"
echo "  500m  = 50% of one core  (0.5)"
echo "  1000m = 100% of one core (1.0)"
echo "  2000m = 200% (2 cores)"

echo
echo "=== Memory Units ==="
echo "Binary (base-2):"
echo "  Ki = Kibibyte (2^10 = 1024 bytes)"
echo "  Mi = Mebibyte (2^20 = 1,048,576 bytes)"
echo "  Gi = Gibibyte (2^30 = 1,073,741,824 bytes)"
echo "  Ti = Tebibyte (2^40 bytes)"
echo
echo "Decimal (base-10):"
echo "  k = Kilobyte (10^3 = 1000 bytes)"
echo "  M = Megabyte (10^6 = 1,000,000 bytes)"
echo "  G = Gigabyte (10^9 = 1,000,000,000 bytes)"
echo "  T = Terabyte (10^12 bytes)"
echo
echo "Common conversions:"
echo "  128Mi  ≈ 134MB"
echo "  256Mi  ≈ 268MB"
echo "  512Mi  ≈ 536MB"
echo "  1Gi    ≈ 1.07GB"
echo "  2Gi    ≈ 2.15GB"

# Conversion functions
convert_memory() {
    local value=$1
    local unit=${value: -2}
    local num=${value%${unit}}

    case $unit in
        Ki) echo "scale=2; $num * 1024" | bc ;;
        Mi) echo "scale=2; $num * 1024 * 1024" | bc ;;
        Gi) echo "scale=2; $num * 1024 * 1024 * 1024" | bc ;;
        Ti) echo "scale=2; $num * 1024 * 1024 * 1024 * 1024" | bc ;;
        *) echo "$value" ;;
    esac
}

if [ $# -eq 2 ]; then
    if [ "$1" = "mem" ]; then
        bytes=$(convert_memory "$2")
        echo "$2 = $bytes bytes"
    fi
fi
EOF

chmod +x /usr/local/bin/k8s-resource-converter.sh
```

## Quality of Service (QoS) Classes

### QoS Class Determination

```yaml
# qos-classes-examples.yaml
# Examples of different QoS classes

---
# Guaranteed QoS: Highest priority
# Requirements:
# - Every container must have requests AND limits
# - Requests must equal limits for both CPU and memory
apiVersion: v1
kind: Pod
metadata:
  name: guaranteed-pod
  labels:
    qos-class: guaranteed
spec:
  containers:
  - name: app
    image: nginx:1.25
    resources:
      requests:
        cpu: "1000m"
        memory: "1Gi"
      limits:
        cpu: "1000m"    # Must equal request
        memory: "1Gi"   # Must equal request

---
# Burstable QoS: Medium priority
# Requirements:
# - At least one container has requests or limits
# - Does not meet Guaranteed requirements
apiVersion: v1
kind: Pod
metadata:
  name: burstable-pod
  labels:
    qos-class: burstable
spec:
  containers:
  - name: app
    image: nginx:1.25
    resources:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "2000m"     # Different from request
        memory: "2Gi"    # Different from request

  - name: sidecar
    image: busybox:1.36
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      # No limits specified

---
# BestEffort QoS: Lowest priority
# Requirements:
# - No containers have requests or limits
apiVersion: v1
kind: Pod
metadata:
  name: besteffort-pod
  labels:
    qos-class: besteffort
spec:
  containers:
  - name: app
    image: nginx:1.25
    # No resources specified

  - name: sidecar
    image: busybox:1.36
    # No resources specified
```

### QoS Class Behavior and Impact

```bash
#!/bin/bash
# Analyze QoS class distribution and behavior

cat << 'EOF' > /usr/local/bin/analyze-qos.sh
#!/bin/bash

set -e

echo "=== QoS Class Analysis ==="
echo

# Count pods by QoS class
echo "Pod Distribution by QoS Class:"
for qos in Guaranteed Burstable BestEffort; do
    count=$(kubectl get pods -A -o json | \
        jq -r ".items[] | select(.status.qosClass==\"$qos\") | .metadata.name" | \
        wc -l)
    echo "  $qos: $count pods"
done

echo
echo "=== Namespace QoS Distribution ==="
kubectl get pods -A -o custom-columns=\
NAMESPACE:.metadata.namespace,\
NAME:.metadata.name,\
QOS:.status.qosClass,\
CPU_REQ:.spec.containers[*].resources.requests.cpu,\
CPU_LIM:.spec.containers[*].resources.limits.cpu,\
MEM_REQ:.spec.containers[*].resources.requests.memory,\
MEM_LIM:.spec.containers[*].resources.limits.memory

echo
echo "=== OOM Kill Risk Analysis ==="
echo "Pods at risk (BestEffort or large memory limit/request ratio):"

kubectl get pods -A -o json | jq -r '
.items[] |
select(
  .status.qosClass == "BestEffort" or
  (
    (.spec.containers[].resources.limits.memory // 0) /
    (.spec.containers[].resources.requests.memory // 1) > 3
  )
) |
"\(.metadata.namespace)/\(.metadata.name) - \(.status.qosClass)"
'

echo
echo "=== Resource Pressure Impact ==="
echo "When node experiences resource pressure:"
echo "1. BestEffort pods are killed first"
echo "2. Burstable pods exceeding requests are killed next"
echo "3. Guaranteed pods are only killed if they exceed limits"
EOF

chmod +x /usr/local/bin/analyze-qos.sh
```

## Resource Requests and Limits Best Practices

### Sizing Guidelines

```yaml
# resource-sizing-examples.yaml
# Best practices for sizing different workload types

---
# Web Frontend: Burstable for traffic spikes
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-frontend
  template:
    metadata:
      labels:
        app: web-frontend
    spec:
      containers:
      - name: nginx
        image: nginx:1.25
        resources:
          requests:
            # Base load requirement
            cpu: "250m"
            memory: "256Mi"
          limits:
            # Allow bursting to 4x CPU
            cpu: "1000m"
            # Memory limit 2x request
            memory: "512Mi"

        # Readiness/liveness probes affect resource usage
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10

---
# API Backend: Guaranteed for consistent performance
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-backend
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: api-backend
  template:
    metadata:
      labels:
        app: api-backend
    spec:
      containers:
      - name: api
        image: api-server:v1.0
        resources:
          requests:
            # Consistent performance requirement
            cpu: "1000m"
            memory: "2Gi"
          limits:
            # Same as requests for Guaranteed QoS
            cpu: "1000m"
            memory: "2Gi"

        env:
        # Java/JVM memory settings should be < container limit
        - name: JAVA_OPTS
          value: "-Xms1536m -Xmx1536m -XX:MaxMetaspaceSize=256m"

---
# Batch Job: Burstable with high limits
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing
  namespace: batch
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: processor
        image: data-processor:v2.0
        resources:
          requests:
            # Minimum for scheduling
            cpu: "500m"
            memory: "1Gi"
          limits:
            # Allow high CPU usage for processing
            cpu: "4000m"
            # Set memory limit to prevent OOM
            memory: "8Gi"

---
# Background Worker: Burstable with conservative limits
apiVersion: apps/v1
kind: Deployment
metadata:
  name: queue-worker
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: queue-worker
  template:
    metadata:
      labels:
        app: queue-worker
    spec:
      containers:
      - name: worker
        image: worker:v1.0
        resources:
          requests:
            cpu: "200m"
            memory: "512Mi"
          limits:
            # Conservative limit to prevent resource hogging
            cpu: "1000m"
            memory: "1Gi"

---
# Database: Guaranteed with large resources
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: databases
spec:
  serviceName: postgresql
  replicas: 3
  selector:
    matchLabels:
      app: postgresql
  template:
    metadata:
      labels:
        app: postgresql
    spec:
      containers:
      - name: postgresql
        image: postgres:15
        resources:
          requests:
            # Large guaranteed resources
            cpu: "2000m"
            memory: "4Gi"
          limits:
            # Same as requests for Guaranteed
            cpu: "2000m"
            memory: "4Gi"

        env:
        # PostgreSQL shared_buffers should be ~25% of memory limit
        - name: POSTGRES_SHARED_BUFFERS
          value: "1GB"
        # effective_cache_size should be ~50-75% of memory limit
        - name: POSTGRES_EFFECTIVE_CACHE_SIZE
          value: "3GB"
```

### Resource Right-Sizing Tools

```bash
#!/bin/bash
# Tools for determining optimal resource settings

cat << 'EOF' > /usr/local/bin/resource-analyzer.sh
#!/bin/bash

set -e

# Analyze actual resource usage
analyze_pod_resources() {
    local namespace=$1
    local pod=$2

    echo "=== Resource Analysis for $namespace/$pod ==="

    # Get current resource settings
    echo "Current Resource Configuration:"
    kubectl get pod -n "$namespace" "$pod" -o json | jq -r '
        .spec.containers[] | {
            name: .name,
            requests: .resources.requests,
            limits: .resources.limits
        }
    '

    echo
    echo "Actual Resource Usage (current):"
    kubectl top pod -n "$namespace" "$pod" --containers

    echo
    echo "Historical Usage (requires metrics-server):"

    # Get pod start time
    START_TIME=$(kubectl get pod -n "$namespace" "$pod" -o json | \
        jq -r '.status.startTime')

    echo "Pod started at: $START_TIME"

    # Recommendation based on usage patterns
    echo
    echo "=== Recommendations ==="

    # Get actual usage
    ACTUAL_CPU=$(kubectl top pod -n "$namespace" "$pod" --no-headers | awk '{print $2}')
    ACTUAL_MEM=$(kubectl top pod -n "$namespace" "$pod" --no-headers | awk '{print $3}')

    echo "Consider these values based on current usage:"
    echo "  CPU Request: Add 20% buffer to average usage"
    echo "  CPU Limit: 2-4x the request for burstable workloads"
    echo "  Memory Request: Add 20-30% buffer to peak usage"
    echo "  Memory Limit: 1.5-2x the request"
}

# Analyze all pods in namespace
analyze_namespace() {
    local namespace=$1

    echo "=== Namespace Resource Analysis: $namespace ==="
    echo

    # Total resources
    echo "Total Resource Usage:"
    kubectl top pods -n "$namespace"

    echo
    echo "Resource Request vs Limit Analysis:"

    kubectl get pods -n "$namespace" -o json | jq -r '
        .items[] |
        .metadata.name as $pod |
        .spec.containers[] | {
            pod: $pod,
            container: .name,
            cpu_request: .resources.requests.cpu // "none",
            cpu_limit: .resources.limits.cpu // "none",
            mem_request: .resources.requests.memory // "none",
            mem_limit: .resources.limits.memory // "none",
            qos: .status.qosClass // "unknown"
        }
    ' | jq -s '.'

    echo
    echo "Pods without resource limits:"
    kubectl get pods -n "$namespace" -o json | jq -r '
        .items[] |
        select(
            .spec.containers[] |
            (.resources.limits.cpu // "" | length) == 0 or
            (.resources.limits.memory // "" | length) == 0
        ) |
        .metadata.name
    '
}

# Generate recommendations
generate_recommendations() {
    local namespace=$1
    local deployment=$2

    echo "=== Resource Recommendations for $namespace/$deployment ==="

    # Get pods for deployment
    PODS=$(kubectl get pods -n "$namespace" -l app="$deployment" -o json)

    # Calculate average and peak usage
    echo "$PODS" | jq -r '
        .items[] |
        .metadata.name
    ' | while read pod; do
        kubectl top pod -n "$namespace" "$pod" --containers 2>/dev/null || true
    done

    echo
    echo "Recommendation Algorithm:"
    echo "1. Monitor pods for at least 24-48 hours"
    echo "2. Calculate P95 usage for memory, P75 for CPU"
    echo "3. Requests: P95/P75 + 20% buffer"
    echo "4. Limits: Requests * 1.5-2x"
    echo "5. Test in staging before production"
}

# Compare request vs usage
compare_request_usage() {
    echo "=== Request vs Actual Usage Comparison ==="

    kubectl get pods -A -o json | jq -r '
        .items[] |
        {
            namespace: .metadata.namespace,
            pod: .metadata.name,
            containers: [
                .spec.containers[] | {
                    name: .name,
                    cpu_request: .resources.requests.cpu // "0",
                    mem_request: .resources.requests.memory // "0"
                }
            ]
        }
    ' | jq -s '.' > /tmp/requests.json

    # Get actual usage
    kubectl top pods -A --containers > /tmp/usage.txt

    echo "Pods using significantly less than requested (potential waste):"
    # Analysis logic here

    echo
    echo "Pods using more than requested (potential throttling):"
    # Analysis logic here
}

# Main execution
case "${1:-help}" in
    pod)
        if [ $# -lt 3 ]; then
            echo "Usage: $0 pod <namespace> <pod-name>"
            exit 1
        fi
        analyze_pod_resources "$2" "$3"
        ;;
    namespace)
        if [ $# -lt 2 ]; then
            echo "Usage: $0 namespace <namespace>"
            exit 1
        fi
        analyze_namespace "$2"
        ;;
    recommend)
        if [ $# -lt 3 ]; then
            echo "Usage: $0 recommend <namespace> <deployment>"
            exit 1
        fi
        generate_recommendations "$2" "$3"
        ;;
    compare)
        compare_request_usage
        ;;
    *)
        echo "Usage: $0 {pod|namespace|recommend|compare} [args]"
        echo
        echo "Commands:"
        echo "  pod <namespace> <pod>              - Analyze specific pod"
        echo "  namespace <namespace>              - Analyze namespace resources"
        echo "  recommend <namespace> <deployment> - Generate recommendations"
        echo "  compare                            - Compare requests vs usage"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/resource-analyzer.sh
```

## Limit Ranges and Resource Quotas

### LimitRange Configuration

```yaml
# limitrange-configurations.yaml
# Enforce resource constraints with LimitRange

---
# Development namespace limits
apiVersion: v1
kind: LimitRange
metadata:
  name: dev-limits
  namespace: development
spec:
  limits:
  # Container-level limits
  - type: Container
    max:
      cpu: "2"
      memory: "4Gi"
      ephemeral-storage: "10Gi"
    min:
      cpu: "100m"
      memory: "128Mi"
      ephemeral-storage: "1Gi"
    default:
      cpu: "500m"
      memory: "512Mi"
      ephemeral-storage: "2Gi"
    defaultRequest:
      cpu: "250m"
      memory: "256Mi"
      ephemeral-storage: "1Gi"
    maxLimitRequestRatio:
      cpu: "4"      # Limit can be max 4x request
      memory: "2"   # Limit can be max 2x request

  # Pod-level limits
  - type: Pod
    max:
      cpu: "4"
      memory: "8Gi"
    min:
      cpu: "100m"
      memory: "128Mi"

  # PersistentVolumeClaim limits
  - type: PersistentVolumeClaim
    max:
      storage: "100Gi"
    min:
      storage: "1Gi"

---
# Production namespace limits
apiVersion: v1
kind: LimitRange
metadata:
  name: prod-limits
  namespace: production
spec:
  limits:
  - type: Container
    max:
      cpu: "8"
      memory: "32Gi"
      ephemeral-storage: "50Gi"
    min:
      cpu: "100m"
      memory: "128Mi"
      ephemeral-storage: "1Gi"
    default:
      cpu: "1"
      memory: "2Gi"
      ephemeral-storage: "5Gi"
    defaultRequest:
      cpu: "500m"
      memory: "1Gi"
      ephemeral-storage: "2Gi"
    maxLimitRequestRatio:
      cpu: "2"      # Tighter ratio for production
      memory: "1.5"

  - type: Pod
    max:
      cpu: "16"
      memory: "64Gi"

  - type: PersistentVolumeClaim
    max:
      storage: "500Gi"
    min:
      storage: "10Gi"

---
# Batch processing limits
apiVersion: v1
kind: LimitRange
metadata:
  name: batch-limits
  namespace: batch-processing
spec:
  limits:
  - type: Container
    max:
      cpu: "16"
      memory: "64Gi"
    min:
      cpu: "500m"
      memory: "1Gi"
    default:
      cpu: "4"
      memory: "8Gi"
    defaultRequest:
      cpu: "2"
      memory: "4Gi"
    maxLimitRequestRatio:
      cpu: "4"      # Allow high bursting for batch jobs
      memory: "2"
```

### ResourceQuota Configuration

```yaml
# resourcequota-configurations.yaml
# Namespace-level resource quotas

---
# Development team quota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: dev-team-quota
  namespace: development
spec:
  hard:
    # Compute resources
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "80Gi"

    # Storage
    requests.storage: "500Gi"
    persistentvolumeclaims: "20"

    # Object counts
    pods: "50"
    services: "20"
    configmaps: "50"
    secrets: "50"
    replicationcontrollers: "10"

    # Service types
    services.loadbalancers: "2"
    services.nodeports: "5"

  # Scope selectors
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values: ["low", "medium"]

---
# Production quota with priority classes
apiVersion: v1
kind: ResourceQuota
metadata:
  name: prod-critical-quota
  namespace: production
spec:
  hard:
    requests.cpu: "100"
    requests.memory: "200Gi"
    limits.cpu: "200"
    limits.memory: "400Gi"
    pods: "200"

  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values: ["high", "critical"]

---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: prod-standard-quota
  namespace: production
spec:
  hard:
    requests.cpu: "50"
    requests.memory: "100Gi"
    limits.cpu: "100"
    limits.memory: "200Gi"
    pods: "100"

  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values: ["medium"]

---
# GPU resource quota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota
  namespace: ml-workloads
spec:
  hard:
    requests.nvidia.com/gpu: "8"
    limits.nvidia.com/gpu: "8"
    pods: "20"

---
# Quota for specific QoS classes
apiVersion: v1
kind: ResourceQuota
metadata:
  name: guaranteed-quota
  namespace: production
spec:
  hard:
    requests.cpu: "50"
    requests.memory: "100Gi"
    limits.cpu: "50"
    limits.memory: "100Gi"
    pods: "50"

  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: QoSClass
      values: ["Guaranteed"]
```

### Monitoring Quotas and Limits

```bash
#!/bin/bash
# Monitor quota and limit usage

cat << 'EOF' > /usr/local/bin/monitor-quotas.sh
#!/bin/bash

set -e

# Check quota usage across namespaces
check_quota_usage() {
    echo "=== Resource Quota Usage ==="
    echo

    for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
        QUOTAS=$(kubectl get resourcequota -n "$ns" -o name 2>/dev/null)

        if [ -n "$QUOTAS" ]; then
            echo "Namespace: $ns"
            kubectl describe resourcequota -n "$ns"
            echo "---"
        fi
    done
}

# Check limit range enforcement
check_limitranges() {
    echo "=== Limit Ranges ==="
    echo

    for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
        LIMITS=$(kubectl get limitrange -n "$ns" -o name 2>/dev/null)

        if [ -n "$LIMITS" ]; then
            echo "Namespace: $ns"
            kubectl describe limitrange -n "$ns"
            echo "---"
        fi
    done
}

# Find pods approaching limits
check_approaching_limits() {
    echo "=== Pods Approaching Limits (>80% usage) ==="
    echo

    kubectl get pods -A -o json | jq -r '
        .items[] |
        select(.spec.containers[].resources.limits.memory != null) |
        {
            namespace: .metadata.namespace,
            pod: .metadata.name,
            containers: [
                .spec.containers[] | {
                    name: .name,
                    mem_limit: .resources.limits.memory
                }
            ]
        }
    ' | jq -c '.' | while read pod_info; do
        NS=$(echo "$pod_info" | jq -r '.namespace')
        POD=$(echo "$pod_info" | jq -r '.pod')

        # Get actual usage
        USAGE=$(kubectl top pod -n "$NS" "$POD" --containers 2>/dev/null || echo "")

        if [ -n "$USAGE" ]; then
            echo "$NS/$POD:"
            echo "$USAGE"
            echo
        fi
    done
}

# Quota utilization report
quota_utilization_report() {
    echo "=== Quota Utilization Report ==="
    echo

    kubectl get resourcequota -A -o json | jq -r '
        .items[] | {
            namespace: .metadata.namespace,
            name: .metadata.name,
            cpu_used: .status.used."requests.cpu" // "0",
            cpu_hard: .status.hard."requests.cpu" // "0",
            mem_used: .status.used."requests.memory" // "0",
            mem_hard: .status.hard."requests.memory" // "0",
            pods_used: .status.used.pods // "0",
            pods_hard: .status.hard.pods // "0"
        }
    ' | jq -s '
        sort_by(.namespace) |
        .[] |
        "\(.namespace)/\(.name):",
        "  CPU: \(.cpu_used) / \(.cpu_hard)",
        "  Memory: \(.mem_used) / \(.mem_hard)",
        "  Pods: \(.pods_used) / \(.pods_hard)",
        ""
    ' | while read line; do echo "$line"; done
}

# Alert on quota violations
check_quota_violations() {
    echo "=== Quota Violation Check ==="
    echo

    # Check for failed pods due to quota
    kubectl get events -A --field-selector reason=FailedCreate | \
        grep -i quota && echo "WARNING: Quota violations detected!" || \
        echo "No quota violations found"
}

# Main execution
case "${1:-help}" in
    usage)
        check_quota_usage
        ;;
    limits)
        check_limitranges
        ;;
    approaching)
        check_approaching_limits
        ;;
    report)
        quota_utilization_report
        ;;
    violations)
        check_quota_violations
        ;;
    all)
        check_quota_usage
        check_limitranges
        check_approaching_limits
        quota_utilization_report
        check_quota_violations
        ;;
    *)
        echo "Usage: $0 {usage|limits|approaching|report|violations|all}"
        echo
        echo "Commands:"
        echo "  usage       - Show quota usage across namespaces"
        echo "  limits      - Show limit ranges"
        echo "  approaching - Find pods near resource limits"
        echo "  report      - Generate utilization report"
        echo "  violations  - Check for quota violations"
        echo "  all         - Run all checks"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/monitor-quotas.sh
```

## Vertical Pod Autoscaling

### VPA Configuration

```yaml
# vpa-configurations.yaml
# Vertical Pod Autoscaler for automatic resource adjustment

---
# Install VPA (if not already installed)
# kubectl apply -f https://github.com/kubernetes/autoscaler/releases/download/vertical-pod-autoscaler-0.13.0/vpa-v0.13.0.yaml

---
# VPA for automatic updates
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: web-app-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app

  # Update policy
  updatePolicy:
    updateMode: "Auto"  # Auto, Initial, Recreate, or Off

  # Resource policy
  resourcePolicy:
    containerPolicies:
    - containerName: web-app
      minAllowed:
        cpu: "250m"
        memory: "256Mi"
      maxAllowed:
        cpu: "2000m"
        memory: "4Gi"
      controlledResources:
      - cpu
      - memory
      # Control which resource types VPA manages
      controlledValues: RequestsAndLimits  # RequestsOnly or RequestsAndLimits

---
# VPA recommendation-only mode
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-vpa-recommendations
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-backend

  updatePolicy:
    updateMode: "Off"  # Only generate recommendations

  resourcePolicy:
    containerPolicies:
    - containerName: api
      minAllowed:
        cpu: "500m"
        memory: "1Gi"
      maxAllowed:
        cpu: "4000m"
        memory: "8Gi"

---
# VPA with initial mode (only at pod creation)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: batch-job-vpa
  namespace: batch
spec:
  targetRef:
    apiVersion: batch/v1
    kind: Job
    name: data-processor

  updatePolicy:
    updateMode: "Initial"  # Only set resources at creation

  resourcePolicy:
    containerPolicies:
    - containerName: processor
      minAllowed:
        cpu: "1000m"
        memory: "2Gi"
      maxAllowed:
        cpu: "8000m"
        memory: "16Gi"
```

### VPA Monitoring

```bash
#!/bin/bash
# Monitor VPA recommendations

cat << 'EOF' > /usr/local/bin/vpa-monitor.sh
#!/bin/bash

set -e

# Get VPA recommendations
get_vpa_recommendations() {
    local namespace=$1

    echo "=== VPA Recommendations ==="
    echo

    if [ -n "$namespace" ]; then
        NS_FLAG="-n $namespace"
    else
        NS_FLAG="-A"
    fi

    kubectl get vpa $NS_FLAG -o json | jq -r '
        .items[] | {
            namespace: .metadata.namespace,
            name: .metadata.name,
            target: .spec.targetRef.name,
            mode: .spec.updatePolicy.updateMode,
            recommendations: .status.recommendation.containerRecommendations[] | {
                container: .containerName,
                target: .target,
                lowerBound: .lowerBound,
                upperBound: .upperBound,
                uncappedTarget: .uncappedTarget
            }
        }
    ' | jq -s '.'
}

# Compare current vs recommended
compare_current_recommended() {
    local namespace=$1
    local deployment=$2

    echo "=== Current vs Recommended Resources ==="
    echo "Deployment: $namespace/$deployment"
    echo

    # Get current resources
    echo "Current Configuration:"
    kubectl get deployment -n "$namespace" "$deployment" -o json | \
        jq -r '.spec.template.spec.containers[] | {
            name: .name,
            requests: .resources.requests,
            limits: .resources.limits
        }'

    echo
    echo "VPA Recommendations:"
    kubectl get vpa -n "$namespace" -o json | \
        jq -r --arg dep "$deployment" '
        .items[] |
        select(.spec.targetRef.name == $dep) |
        .status.recommendation.containerRecommendations[]
        '
}

# Show VPA history
show_vpa_history() {
    echo "=== VPA Update History ==="
    echo

    kubectl get events -A --field-selector reason=EvictedByVPA --sort-by='.lastTimestamp'
}

# Analyze VPA effectiveness
analyze_vpa_effectiveness() {
    echo "=== VPA Effectiveness Analysis ==="
    echo

    # Get VPAs with Auto mode
    kubectl get vpa -A -o json | jq -r '
        .items[] |
        select(.spec.updatePolicy.updateMode == "Auto") | {
            namespace: .metadata.namespace,
            name: .metadata.name,
            target: .spec.targetRef.name,
            lastUpdate: .status.conditions[] | select(.type == "RecommendationProvided") | .lastTransitionTime
        }
    ' | jq -s '.'

    echo
    echo "Pods evicted by VPA in last 24h:"
    kubectl get events -A --field-selector reason=EvictedByVPA | \
        awk -v date="$(date -d '24 hours ago' '+%Y-%m-%d')" '$1 >= date'
}

# Main execution
case "${1:-help}" in
    recommendations)
        get_vpa_recommendations "${2:-}"
        ;;
    compare)
        if [ $# -lt 3 ]; then
            echo "Usage: $0 compare <namespace> <deployment>"
            exit 1
        fi
        compare_current_recommended "$2" "$3"
        ;;
    history)
        show_vpa_history
        ;;
    analyze)
        analyze_vpa_effectiveness
        ;;
    *)
        echo "Usage: $0 {recommendations|compare|history|analyze} [args]"
        echo
        echo "Commands:"
        echo "  recommendations [namespace]        - Show VPA recommendations"
        echo "  compare <namespace> <deployment>   - Compare current vs recommended"
        echo "  history                            - Show VPA update history"
        echo "  analyze                            - Analyze VPA effectiveness"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/vpa-monitor.sh
```

## Production Best Practices

### Resource Management Policy

```yaml
# resource-management-policy.yaml
# Comprehensive resource management policy

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: resource-management-policy
  namespace: kube-system
data:
  policy.md: |
    # Resource Management Policy

    ## General Guidelines

    1. **Always specify resource requests and limits**
       - All production workloads MUST have requests and limits
       - Development workloads SHOULD have requests and limits

    2. **QoS Class Selection**
       - Critical services: Guaranteed QoS
       - Standard services: Burstable QoS with conservative limits
       - Batch/background: Burstable QoS with flexible limits
       - Development/testing: BestEffort acceptable

    3. **Resource Sizing**
       - Base requests on P95 actual usage + 20% buffer
       - Set limits at 1.5-2x requests for burstable workloads
       - Use Guaranteed QoS (requests = limits) for latency-sensitive apps

    ## CPU Resources

    1. **CPU Requests**
       - Minimum: 100m (0.1 core)
       - Web frontends: 250-500m
       - API backends: 500-1000m
       - Databases: 1000-4000m
       - Batch jobs: 500-2000m

    2. **CPU Limits**
       - Can be 2-4x requests for burstable workloads
       - Should equal requests for latency-sensitive workloads
       - Consider CPU throttling impact on critical services

    ## Memory Resources

    1. **Memory Requests**
       - Minimum: 128Mi
       - Web frontends: 256-512Mi
       - API backends: 512Mi-2Gi
       - Databases: 2-8Gi
       - Batch jobs: 1-4Gi

    2. **Memory Limits**
       - MUST be set (prevents OOM killing other pods)
       - Should be 1.5-2x requests
       - Account for memory leaks with appropriate limits
       - Java/JVM: Set heap to 75-80% of container limit

    ## Namespace Configuration

    1. **LimitRanges**
       - Enforce minimum and maximum resource values
       - Set default requests and limits
       - Limit request-to-limit ratios

    2. **ResourceQuotas**
       - Set per-namespace compute quotas
       - Limit total pods per namespace
       - Control storage allocation

    ## Monitoring and Adjustment

    1. **Regular Review**
       - Review resource usage monthly
       - Adjust based on actual usage patterns
       - Use VPA recommendations as guidance

    2. **Alerting**
       - Alert on pods approaching 80% memory limit
       - Alert on sustained CPU throttling
       - Monitor OOM kills

    3. **Capacity Planning**
       - Track cluster resource utilization
       - Plan for growth based on trends
       - Maintain 20-30% buffer capacity
```

### Automated Right-Sizing

```bash
#!/bin/bash
# Automated resource right-sizing recommendations

cat << 'EOF' > /usr/local/bin/auto-rightsize.sh
#!/bin/bash

set -e

PROMETHEUS_URL=${PROMETHEUS_URL:-"http://prometheus:9090"}
LOOKBACK_DAYS=${LOOKBACK_DAYS:-7}

# Query Prometheus for resource usage
query_prometheus() {
    local query=$1
    local url="$PROMETHEUS_URL/api/v1/query?query=$query"

    curl -s "$url" | jq -r '.data.result'
}

# Calculate recommendations for a deployment
calculate_recommendations() {
    local namespace=$1
    local deployment=$2

    echo "=== Calculating recommendations for $namespace/$deployment ==="

    # Get current configuration
    CURRENT=$(kubectl get deployment -n "$namespace" "$deployment" -o json)

    # Query Prometheus for usage metrics (last 7 days)
    local query_cpu="max_over_time(container_cpu_usage_seconds_total{namespace=\"$namespace\",pod=~\"$deployment.*\"}[${LOOKBACK_DAYS}d])"
    local query_mem="max_over_time(container_memory_working_set_bytes{namespace=\"$namespace\",pod=~\"$deployment.*\"}[${LOOKBACK_DAYS}d])"

    # Calculate P95 values
    local p95_cpu=$(query_prometheus "$query_cpu" | jq -r '.[].value[1]' | sort -n | awk '{count++; sum+=$1; values[count]=$1} END {print values[int(count*0.95)]}')
    local p95_mem=$(query_prometheus "$query_mem" | jq -r '.[].value[1]' | sort -n | awk '{count++; sum+=$1; values[count]=$1} END {print values[int(count*0.95)]}')

    # Add 20% buffer
    local recommended_cpu=$(echo "$p95_cpu * 1.2" | bc)
    local recommended_mem=$(echo "$p95_mem * 1.2" | bc)

    # Calculate limits (2x requests)
    local recommended_cpu_limit=$(echo "$recommended_cpu * 2" | bc)
    local recommended_mem_limit=$(echo "$recommended_mem * 2" | bc)

    echo "Current Configuration:"
    echo "$CURRENT" | jq -r '.spec.template.spec.containers[] | {name, resources}'

    echo
    echo "Recommended Configuration (based on P95 + 20% buffer):"
    cat << YAML
resources:
  requests:
    cpu: "${recommended_cpu}m"
    memory: "${recommended_mem}Mi"
  limits:
    cpu: "${recommended_cpu_limit}m"
    memory: "${recommended_mem_limit}Mi"
YAML

    # Generate kubectl patch command
    echo
    echo "Apply with:"
    cat << CMD
kubectl patch deployment -n $namespace $deployment --patch '
spec:
  template:
    spec:
      containers:
      - name: <container-name>
        resources:
          requests:
            cpu: "${recommended_cpu}m"
            memory: "${recommended_mem}Mi"
          limits:
            cpu: "${recommended_cpu_limit}m"
            memory: "${recommended_mem_limit}Mi"
'
CMD
}

# Scan all deployments in namespace
scan_namespace() {
    local namespace=$1

    echo "=== Scanning namespace: $namespace ==="
    echo

    kubectl get deployments -n "$namespace" -o json | jq -r '.items[].metadata.name' | \
    while read deployment; do
        calculate_recommendations "$namespace" "$deployment"
        echo "---"
    done
}

# Generate report for all namespaces
generate_cluster_report() {
    echo "=== Cluster-wide Resource Right-Sizing Report ==="
    echo "Generated: $(date)"
    echo

    kubectl get namespaces -o json | jq -r '.items[].metadata.name' | \
    while read namespace; do
        # Skip system namespaces
        if [[ "$namespace" == kube-* ]] || [[ "$namespace" == "default" ]]; then
            continue
        fi

        scan_namespace "$namespace"
    done
}

# Main execution
case "${1:-help}" in
    deployment)
        if [ $# -lt 3 ]; then
            echo "Usage: $0 deployment <namespace> <deployment-name>"
            exit 1
        fi
        calculate_recommendations "$2" "$3"
        ;;
    namespace)
        if [ $# -lt 2 ]; then
            echo "Usage: $0 namespace <namespace>"
            exit 1
        fi
        scan_namespace "$2"
        ;;
    cluster)
        generate_cluster_report
        ;;
    *)
        echo "Usage: $0 {deployment|namespace|cluster} [args]"
        echo
        echo "Commands:"
        echo "  deployment <ns> <name>  - Calculate for specific deployment"
        echo "  namespace <name>        - Scan entire namespace"
        echo "  cluster                 - Generate cluster-wide report"
        echo
        echo "Environment variables:"
        echo "  PROMETHEUS_URL          - Prometheus server URL (default: http://prometheus:9090)"
        echo "  LOOKBACK_DAYS           - Days of metrics to analyze (default: 7)"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/auto-rightsize.sh
```

## Conclusion

Effective container resource management in Kubernetes requires understanding resource types, QoS classes, and implementing appropriate limits and quotas. The configurations and tools provided enable production-grade resource management with proper monitoring, right-sizing, and automated optimization to ensure efficient cluster utilization and application stability.

Key principles for production resource management:
- Always specify both requests and limits in production
- Choose appropriate QoS class based on workload criticality
- Size resources based on actual usage data, not guesswork
- Implement LimitRanges and ResourceQuotas at namespace level
- Monitor actual usage and adjust periodically
- Use VPA for automatic right-sizing recommendations
- Account for application-specific behavior (JVM heap, caching, etc.)
- Maintain 20-30% buffer capacity at cluster level
- Test resource changes in staging before production
- Document resource sizing decisions and rationale