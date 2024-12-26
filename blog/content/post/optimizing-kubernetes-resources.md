---
title: "Optimizing Kubernetes Resource Requests and Limits"
date: 2024-12-26T01:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Management", "Optimization"]
categories:
- Kubernetes
- Resource Optimization
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to optimize resource requests and limits in Kubernetes to balance cost and performance effectively while avoiding common pitfalls."
more_link: "yes"
url: "/optimizing-kubernetes-resources/"
---

Balancing performance and cost in Kubernetes clusters often comes down to how well you manage resource requests and limits. Misconfigured workloads can lead to underutilized clusters or unstable applications. This comprehensive guide explores best practices, tools, and strategies to help you optimize your Kubernetes deployments effectively.

<!--more-->

# [Optimizing Kubernetes Resource Requests and Limits](#optimizing-kubernetes-resource-requests-and-limits)

## Why Resource Optimization Matters  

Effective resource management ensures:
- **Cost Efficiency**: Avoid paying for unused resources or over-provisioned clusters.
- **Performance Stability**: Ensure workloads have enough resources to run without throttling or crashes.
- **Scheduling Efficiency**: Enable Kubernetes to schedule workloads properly by reserving the right amount of resources.

Common issues from poor resource configuration:
- Overprovisioning: Wasting cluster resources.
- Underprovisioning: Increased pod evictions or OOM (Out Of Memory) errors.
- Cluster Overcommitment: CPU throttling and degraded performance.

## Understanding Resource Requests and Limits  

In Kubernetes, each container can specify:
- **Requests**: The minimum amount of CPU and memory guaranteed for the container.
- **Limits**: The maximum amount of CPU and memory the container is allowed to use.

### Configuration Example
```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "500m"
  limits:
    memory: "512Mi"
    cpu: "1000m"
```
In this example:
- `256Mi` and `500m` are the minimum guaranteed resources.
- The container cannot exceed `512Mi` memory and `1000m` (1 core) CPU.

### Key Considerations
- Set **requests** based on average resource usage.
- Set **limits** slightly above peak usage to account for spikes.

## Analyzing Current Resource Usage  

Before optimizing, gather insights on current workload performance.  
### Using Metrics Server
Install the Metrics Server:
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

Check real-time resource usage:
```bash
kubectl top pods
kubectl top nodes
```

### Using Prometheus and Grafana
Set up Prometheus and Grafana for in-depth monitoring:
- Deploy the **Kube-Prometheus Stack** using Helm:
  ```bash
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm install prometheus prometheus-community/kube-prometheus-stack --namespace monitoring --create-namespace
  ```
- Import dashboards like **"Kubernetes/Node Metrics"** in Grafana for detailed resource trends.

### Analyzing Trends
Identify patterns:
- **Underutilization**: Reduce requests to free up resources.
- **Frequent Spikes**: Increase limits to handle peak traffic.

## Best Practices for Resource Requests and Limits  

1. **Baseline Metrics**: Start with conservative values and iterate based on usage.
2. **Avoid 1:1 Limits and Requests**: Ensure flexibility by keeping limits slightly higher.
3. **Use Namespace-Level Policies**: Use LimitRanges to enforce policies across teams:
   ```yaml
   apiVersion: v1
   kind: LimitRange
   metadata:
     name: resource-limits
     namespace: team-namespace
   spec:
     limits:
     - default:
         memory: "512Mi"
         cpu: "1"
       defaultRequest:
         memory: "256Mi"
         cpu: "500m"
       type: Container
   ```

4. **Test Under Load**: Use tools like `k6` or `Apache Benchmark` to simulate workload performance under stress.

## Automating Resource Optimization  

### Vertical Pod Autoscaler (VPA)
Automatically adjust requests for pods:
1. Install VPA:
   ```bash
   kubectl apply -f https://github.com/kubernetes/autoscaler/releases/latest/vertical-pod-autoscaler.yaml
   ```
2. Configure VPA:
   ```yaml
   apiVersion: autoscaling.k8s.io/v1
   kind: VerticalPodAutoscaler
   metadata:
     name: my-app-vpa
     namespace: default
   spec:
     targetRef:
       apiVersion: apps/v1
       kind: Deployment
       name: my-app
     updatePolicy:
       updateMode: "Auto"
   ```

### Horizontal Pod Autoscaler (HPA)
Scale pods horizontally based on CPU or memory:
```bash
kubectl autoscale deployment my-app --cpu-percent=50 --min=2 --max=10
```

### Kubecost
Analyze resource costs:
1. Install Kubecost:
   ```bash
   helm repo add kubecost https://kubecost.github.io/cost-analyzer/
   helm install kubecost kubecost/cost-analyzer --namespace kubecost --create-namespace
   ```
2. View cost breakdowns by namespace, workload, or node.

## Avoiding Common Pitfalls  

1. **Setting Limits Too High or Low**:
   - Too High: Wastes cluster resources.
   - Too Low: Leads to throttling or OOM kills.
   
2. **Ignoring Node Allocatable Resources**:
   Nodes reserve a portion of CPU/memory for system processes. Consider this when setting resource requests.

3. **Not Revisiting Configurations**:
   Workloads evolve. Periodically analyze metrics and adjust resources as needed.

4. **Failing to Account for Bursty Workloads**:
   Use buffering strategies or autoscaling to handle traffic spikes.

## Advanced Optimization Techniques  

### Pod Priority Classes
Ensure critical workloads get resources first:
```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 1000
globalDefault: false
description: "Priority class for critical workloads"
```

### Resource Quotas
Prevent overconsumption in shared clusters:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-quota
  namespace: team-namespace
spec:
  hard:
    requests.cpu: "10"
    requests.memory: "10Gi"
    limits.cpu: "20"
    limits.memory: "20Gi"
```

### Node Affinity and Anti-Affinity
Distribute workloads intelligently to balance resource utilization across nodes:
```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: "kubernetes.io/e2e-az-name"
          operator: In
          values:
          - e2e-az1
```

### Outcome:
- Reduced OOM errors by 80%.
- Improved cost efficiency by 20%.

## Conclusion  

Optimizing Kubernetes resource requests and limits is a dynamic process. With proper monitoring, iterative adjustments, and automation, you can ensure a balance between cost and performance. Invest time in understanding workload patterns, leveraging tools, and implementing best practices to unlock the full potential of your Kubernetes cluster.
