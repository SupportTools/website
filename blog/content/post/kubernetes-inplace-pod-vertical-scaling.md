---
title: "Live Pod Resizing in Kubernetes: A Practical Guide to InPlacePodVerticalScaling"
date: 2026-11-10T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Management", "Vertical Scaling", "Containers", "v1.33", "Performance Tuning", "DevOps"]
categories:
- Kubernetes
- Performance Optimization
author: "Matthew Mattox - mmattox@support.tools"
description: "A hands-on guide to using Kubernetes InPlacePodVerticalScaling to adjust CPU and memory resources without pod restarts, with real-world examples and performance implications"
more_link: "yes"
url: "/kubernetes-inplace-pod-vertical-scaling/"
---

One of Kubernetes' longstanding limitations has been the inability to change a running pod's resource allocations without completely restarting it. For stateless applications behind a service, this wasn't a big issue—but for stateful workloads, batch jobs, or any process where restarts are expensive, it created a significant operational challenge. Kubernetes v1.33 brings good news by promoting InPlacePodVerticalScaling to beta, allowing us to adjust CPU and memory resources on the fly without disrupting workloads. Here's my hands-on experience with this feature and how you can leverage it in your production environments.

<!--more-->

## The Problem: Why Pod Restarts Are Painful

Before diving into the solution, let's understand why restarting pods to change resource allocations creates real-world pain:

1. **Service disruption** - Even with graceful termination, there's always a gap between shutdown and full readiness
2. **Loss of in-memory state** - Any cached data, temporary processing results, or user sessions are wiped out
3. **Connection termination** - Active client connections get dropped, forcing reconnection logic
4. **Processing delays** - Long-running tasks must restart from scratch or implement complex checkpointing
5. **Cold start penalties** - Many applications (especially JVM-based ones) have significant warm-up times
6. **Cascading effects** - For interdependent services, a restart can trigger retry storms and backpressure

I encountered this issue recently when managing a data processing pipeline in Kubernetes. A critical ETL job would occasionally hit memory limits during peak processing. We had two options: overprovision memory for the rare peaks (expensive) or accept occasional failures (unreliable). Neither was ideal.

## InPlacePodVerticalScaling: The Game-Changer

InPlacePodVerticalScaling fundamentally changes this paradigm by allowing live adjustment of container resource allocations. Here's what makes it powerful:

- **CPU adjustments without restarts** - Increase or decrease CPU allocation with zero disruption
- **Memory increases with container-level restart** - Expand memory without terminating the entire pod
- **Granular control via resize policies** - Decide per-resource whether restarts are permitted
- **Support for sidecar adjustment** - Resize init containers that are marked as restartable

## Implementing InPlacePodVerticalScaling: A Step-by-Step Guide

Let's walk through the complete process of setting up and using this feature.

### Step 1: Verify Cluster Readiness

First, check if your cluster supports the feature. You'll need Kubernetes v1.27+ for alpha support, or v1.33+ for beta:

```bash
# Check your Kubernetes version
kubectl version --short

# Look for the feature gate in the API server configuration
kubectl get pods -n kube-system -l component=kube-apiserver -o yaml | grep feature-gates
```

### Step 2: Enable the Feature Gate

If your cluster doesn't have the feature enabled yet, you'll need to configure it:

**For kube-apiserver (control plane):**

```yaml
# In your kube-apiserver manifest or configuration
spec:
  containers:
  - command:
    - kube-apiserver
    - --feature-gates=InPlacePodVerticalScaling=true
    # other args...
```

**For kubelet (worker nodes):**

```yaml
# In your kubelet configuration
featureGates:
  InPlacePodVerticalScaling: true
```

For managed Kubernetes services (like EKS, GKE, or AKS), you may need to wait for the provider to enable this feature or create a cluster with specific feature flags.

### Step 3: Design Pod Specifications with Resize Policies

Now, create a pod that supports in-place scaling by defining resize policies. Here's a real-world example I used for a data processing job:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: data-processor
spec:
  containers:
  - name: processor
    image: data-processing-image:latest
    command: ["python", "process_data.py"]
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
    resizePolicy:
    - resourceName: cpu
      restartPolicy: NotRequired    # CPU can change without restart
    - resourceName: memory
      restartPolicy: RestartContainer  # Memory changes require container restart, not pod restart
    
    # Add volume mounts for checkpoint data if needed
    volumeMounts:
    - name: checkpoint-volume
      mountPath: /data/checkpoints
      
  # Add a sidecar for logging/monitoring that can also be resized
  - name: log-collector
    image: log-collector:latest
    resources:
      requests:
        cpu: "100m"
        memory: "256Mi"
      limits:
        cpu: "100m"
        memory: "256Mi"
    resizePolicy:
    - resourceName: cpu
      restartPolicy: NotRequired
    - resourceName: memory
      restartPolicy: RestartContainer
      
  volumes:
  - name: checkpoint-volume
    persistentVolumeClaim:
      claimName: data-processor-pvc
```

The key elements here are:

1. The `resizePolicy` section for each container
2. Setting the appropriate restart policy for each resource type
3. Using persistent volumes for checkpointing when container restarts might be necessary

### Step 4: Perform Live CPU Scaling

When your workload needs more CPU, use the `--subresource=resize` option with `kubectl patch`:

```bash
kubectl patch pod data-processor --subresource=resize --patch '
{
  "spec": {
    "containers": [
      {
        "name": "processor", 
        "resources": {
          "requests": {"cpu": "4"},
          "limits": {"cpu": "4"}
        }
      }
    ]
  }
}'
```

Let's verify the change was successful:

```bash
# Check the pod's status
kubectl get pod data-processor -o json | jq '.status.resize'

# Verify the actual allocated resources for the container
kubectl get pod data-processor -o jsonpath='{.status.containerStatuses[0].resources}'

# Confirm no restart occurred
kubectl get pod data-processor -o jsonpath='{.status.containerStatuses[0].restartCount}'
```

The container should show the updated CPU allocation without any restart—the process continues running with more CPU cycles allocated to it.

### Step 5: Increase Memory Allocation (With Container Restart)

When memory usage spikes, increase the allocation:

```bash
kubectl patch pod data-processor --subresource=resize --patch '
{
  "spec": {
    "containers": [
      {
        "name": "processor",
        "resources": {
          "requests": {"memory": "8Gi"},
          "limits": {"memory": "8Gi"}
        }
      }
    ]
  }
}'
```

Because our memory `restartPolicy` is set to `RestartContainer`, this will restart just the individual container, not the entire pod. The restart count will increase:

```bash
kubectl get pod data-processor -o jsonpath='{.status.containerStatuses[0].restartCount}'
```

**Pro Tip**: For applications that support dynamic memory allocation (like JVMs with configurable heap sizes), you can use container lifecycle hooks to adjust the application's memory usage during restart:

```yaml
lifecycle:
  postStart:
    exec:
      command: 
      - /bin/sh
      - -c
      - |
        # Get available memory and set to 80% for JVM heap
        CONTAINER_MEM_BYTES=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
        CONTAINER_MEM_MB=$((CONTAINER_MEM_BYTES / 1024 / 1024))
        JVM_HEAP_MB=$((CONTAINER_MEM_MB * 8 / 10))
        export JAVA_OPTS="-Xms${JVM_HEAP_MB}m -Xmx${JVM_HEAP_MB}m"
        echo "Set JVM heap to ${JVM_HEAP_MB}MB"
```

## Under the Hood: How InPlacePodVerticalScaling Works

Understanding how this feature works helps predict its behavior in different scenarios:

1. **Control Plane Process**:
   - The API server validates the resize request
   - The scheduler confirms node capacity
   - The resize controller tracks status

2. **Node-Level Process**:
   - Kubelet receives the resize request
   - For CPU changes, kubelet updates cgroup CPU limits without container restart
   - For memory changes with `RestartContainer` policy, kubelet:
     - Preserves the pod IP and volumes
     - Stops only the specific container
     - Updates cgroup memory limits
     - Restarts the container with new limits
     - Other containers in the pod remain untouched

3. **Status Tracking**:
   - `status.resize` field indicates the current state: `InProgress`, `Deferred`, or `Infeasible`
   - `status.containerStatuses[].resources` shows the actual applied resources
   - `status.containerStatuses[].allocatedResources` shows node confirmation

## Real-World Use Cases I've Implemented

Here are scenarios where I've found InPlacePodVerticalScaling particularly valuable:

### 1. JVM Application with Dynamic Resource Needs

For a Spring Boot application with varying load patterns:

```yaml
# Initial deployment with baseline resources
resources:
  requests:
    cpu: "1"
    memory: "2Gi"
  limits:
    cpu: "1"
    memory: "2Gi"
resizePolicy:
- resourceName: cpu
  restartPolicy: NotRequired
- resourceName: memory
  restartPolicy: RestartContainer
```

When the application hits high traffic periods, scale up CPU without disruption:

```bash
kubectl patch pod app-pod --subresource=resize --patch '
{
  "spec": {
    "containers": [
      {
        "name": "app",
        "resources": {
          "requests": {"cpu": "2"},
          "limits": {"cpu": "2"}
        }
      }
    ]
  }
}'
```

### 2. ETL Job with Progressive Memory Requirements

For data processing jobs that need more memory as they load larger datasets:

```yaml
# Initial deployment with starter resources
resources:
  requests:
    memory: "4Gi"
  limits:
    memory: "4Gi"
resizePolicy:
- resourceName: memory
  restartPolicy: RestartContainer
```

The application includes checkpointing to resume after memory-related restarts:

```python
# Pseudocode for the application
def process_data():
    checkpoint_file = "/data/checkpoints/progress.json"
    if os.path.exists(checkpoint_file):
        state = load_checkpoint(checkpoint_file)
        current_position = state["position"]
    else:
        current_position = 0
        
    # Process data starting from checkpoint
    while current_position < total_records:
        # Process batch
        process_batch(current_position, batch_size)
        current_position += batch_size
        
        # Save checkpoint frequently
        save_checkpoint(checkpoint_file, {"position": current_position})
```

When memory pressure is detected, increase the allocation:

```bash
kubectl patch pod etl-job --subresource=resize --patch '
{
  "spec": {
    "containers": [
      {
        "name": "processor",
        "resources": {
          "requests": {"memory": "8Gi"},
          "limits": {"memory": "8Gi"}
        }
      }
    ]
  }
}'
```

### 3. Optimizing Sidecar Resource Allocation

For service mesh or monitoring sidecars:

```yaml
- name: envoy-proxy
  image: envoy:v1.20
  resources:
    requests:
      cpu: "100m"
      memory: "256Mi"
    limits:
      cpu: "100m"
      memory: "256Mi"
  resizePolicy:
  - resourceName: cpu
    restartPolicy: NotRequired
```

Adjust sidecars without disrupting the main application:

```bash
kubectl patch pod service-pod --subresource=resize --patch '
{
  "spec": {
    "containers": [
      {
        "name": "envoy-proxy",
        "resources": {
          "requests": {"cpu": "200m"},
          "limits": {"cpu": "200m"}
        }
      }
    ]
  }
}'
```

## Limitations and Considerations

Based on my testing, here are important caveats to be aware of:

1. **QoS Class Cannot Change**: A pod's Quality of Service class is determined at creation and cannot be modified with resize operations.

2. **Node Resource Constraints**: If a node lacks available resources, the resize request may be marked as `Deferred` until resources become available.

3. **Memory Reduction Challenges**: Reducing memory limits is trickier than increasing them, as the container runtime might not be able to shrink an already allocated heap.

4. **Minimum Kubernetes Version**: You need v1.27+ for alpha support and v1.33+ for beta. The feature also requires containerd 1.6.9+.

5. **Custom Metrics Not Supported**: Currently, only CPU and memory can be adjusted—not custom or extended resources like GPUs.

6. **Interaction with VPA**: If you're using Vertical Pod Autoscaler, be aware that it doesn't yet fully support InPlacePodVerticalScaling.

## Implementing in Production: My Approach

For safe implementation in production environments, I recommend this phased approach:

### Phase 1: Controlled Testing

1. Create a separate test namespace with the feature enabled
2. Deploy test pods with various resize policies
3. Conduct resize operations and observe behavior
4. Test application-specific recovery mechanisms

### Phase 2: Limited Production Rollout

1. Identify good candidate workloads (stateful, resource-sensitive, restartable)
2. Implement with monitoring to track resize operations
3. Document procedures for operations teams
4. Start with CPU-only resizing before implementing memory resizing

### Phase 3: Automation Integration

1. Integrate with monitoring systems to trigger resizes based on usage patterns
2. Create custom controllers for specific workload types
3. Implement safeguards against resize storms or rapid oscillations
4. Build dashboard visibility into resize operations

## Conclusion: A Significant Step Forward

InPlacePodVerticalScaling represents one of the most operationally significant Kubernetes features in recent releases. It addresses a fundamental limitation that has forced operators to choose between overprovisioning resources or accepting periodic disruptions.

While not completely eliminating container restarts for memory changes, it still provides substantial benefits by:

1. Allowing seamless CPU adjustments
2. Limiting restarts to individual containers rather than whole pods
3. Preserving pod networking and attachments during resizes
4. Enabling right-sized resource allocation without disruption

For environments running workloads with variable resource needs, this feature should be on your radar for implementation as soon as your Kubernetes version supports it.

Have you started experimenting with InPlacePodVerticalScaling? What workloads do you think will benefit most from this capability? I'd love to hear about your experiences in the comments below.