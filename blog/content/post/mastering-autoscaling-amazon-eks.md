---
title: "Mastering Autoscaling in Amazon EKS: A Comprehensive Guide"
date: 2027-02-16T09:00:00-05:00
draft: false
tags: ["Kubernetes", "AWS", "EKS", "Autoscaling", "HPA", "Cluster Autoscaler", "DevOps"]
categories:
- Kubernetes
- AWS
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to implement and optimize autoscaling for your Amazon EKS clusters at both pod and node levels using Horizontal Pod Autoscaler (HPA) and Cluster Autoscaler"
more_link: "yes"
url: "/mastering-autoscaling-amazon-eks/"
---

In modern cloud environments, effective resource management is crucial for operational efficiency. Amazon EKS provides powerful autoscaling capabilities that help maintain optimal performance while controlling costs. This guide explores implementing both pod-level and node-level autoscaling in EKS.

<!--more-->

# [Introduction to Autoscaling in EKS](#introduction)

Autoscaling is a fundamental capability for managing Kubernetes workloads efficiently in production environments. In Amazon EKS, two primary autoscaling mechanisms work together to optimize your cluster:

1. **Horizontal Pod Autoscaler (HPA)** - Scales the number of pod replicas based on resource utilization metrics
2. **Cluster Autoscaler** - Automatically adjusts the number of nodes in your cluster based on pod scheduling requirements

These mechanisms work in tandem: HPA ensures your applications can handle varying workloads, while Cluster Autoscaler ensures your infrastructure efficiently accommodates those applications.

## [Why Autoscaling Matters](#why-autoscaling-matters)

Without proper autoscaling:

- **Overprovisioning**: You waste money on idle resources
- **Underprovisioning**: Users experience poor performance or service outages during traffic spikes
- **Operational overhead**: Teams constantly monitor and manually adjust resources

Effective autoscaling addresses these challenges by automatically matching resources to current demands, improving both cost efficiency and application performance.

# [Node-Level Autoscaling with Cluster Autoscaler](#cluster-autoscaler)

The Cluster Autoscaler monitors your cluster for pods that cannot be scheduled due to resource constraints. When it detects such pods, it automatically increases the size of your node group. Similarly, when nodes are underutilized, it scales down the node count.

## [Setting Up Cluster Autoscaler](#setting-up-cluster-autoscaler)

### 1. Create an EKS Cluster with ASG Access

Your EKS cluster needs to be configured with Auto Scaling Groups (ASG) to enable node autoscaling:

```bash
eksctl create cluster \
  --name eks-autoscaling-demo \
  --asg-access \
  --nodes-min 2 \
  --nodes-max 10 \
  --nodes 3 \
  --node-type t3.medium \
  --nodegroup-name standard-workers \
  --version 1.27 \
  --region us-west-2
```

This command creates a cluster with initial capacity of 3 nodes, with the ability to scale between 2 and 10 nodes based on demand.

### 2. Deploy the Cluster Autoscaler

Download the Cluster Autoscaler manifest:

```bash
curl -O https://raw.githubusercontent.com/kubernetes/autoscaler/master/cluster-autoscaler/cloudprovider/aws/examples/cluster-autoscaler-autodiscover.yaml
```

Edit the manifest to specify your cluster name:

```bash
# Replace <YOUR CLUSTER NAME> with your actual EKS cluster name
sed -i 's/<YOUR CLUSTER NAME>/eks-autoscaling-demo/g' cluster-autoscaler-autodiscover.yaml
```

Apply the manifest:

```bash
kubectl apply -f cluster-autoscaler-autodiscover.yaml
```

### 3. Configure the Cluster Autoscaler

Add the safe-to-evict annotation:

```bash
kubectl patch deployment cluster-autoscaler -n kube-system -p '{"spec":{"template":{"metadata":{"annotations":{"cluster-autoscaler.kubernetes.io/safe-to-evict":"false"}}}}}'
```

Edit the deployment to add required command line options:

```bash
kubectl -n kube-system edit deployment.apps/cluster-autoscaler
```

Add these arguments to the command section:
```yaml
- --balance-similar-node-groups=true
- --skip-nodes-with-system-pods=false
```

Update the Cluster Autoscaler image to match your Kubernetes version:

```bash
# For Kubernetes 1.27, use the corresponding Cluster Autoscaler version
kubectl set image deployment cluster-autoscaler -n kube-system cluster-autoscaler=registry.k8s.io/autoscaling/cluster-autoscaler:v1.27.3
```

> **Note**: Always use the Cluster Autoscaler version that matches your Kubernetes version.

### 4. Verify Cluster Autoscaler Deployment

Check the logs to confirm the Cluster Autoscaler is working correctly:

```bash
kubectl logs -n kube-system deployment.apps/cluster-autoscaler
```

Look for log entries showing successful API connections and node group discovery.

## [How Cluster Autoscaler Works](#how-cluster-autoscaler-works)

The Cluster Autoscaler continuously monitors the cluster for:

1. **Scale-up events**: When pods are in a pending state due to insufficient cluster capacity
2. **Scale-down events**: When nodes are underutilized for an extended period (default: 10 minutes)

Cluster Autoscaler makes scaling decisions based on several factors:

- Resource requests of pending pods
- Node utilization levels
- Pod disruption budgets
- Node group constraints (min/max sizes)

It's important to note that Cluster Autoscaler respects pod disruption budgets (PDBs) during scale-down operations, ensuring application availability.

# [Pod-Level Autoscaling with HPA](#horizontal-pod-autoscaler)

Horizontal Pod Autoscaler (HPA) automatically scales the number of pod replicas based on observed CPU utilization, memory usage, or custom metrics.

## [Setting Up HPA](#setting-up-hpa)

### 1. Deploy the Metrics Server

HPA requires the Metrics Server to access CPU and memory metrics:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

Verify the Metrics Server is running:

```bash
kubectl get deployment metrics-server -n kube-system
```

### 2. Deploy a Sample Application

Create a deployment for testing HPA:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: php-apache
spec:
  selector:
    matchLabels:
      run: php-apache
  template:
    metadata:
      labels:
        run: php-apache
    spec:
      containers:
      - name: php-apache
        image: registry.k8s.io/hpa-example
        ports:
        - containerPort: 80
        resources:
          limits:
            cpu: 500m
          requests:
            cpu: 200m
---
apiVersion: v1
kind: Service
metadata:
  name: php-apache
  labels:
    run: php-apache
spec:
  ports:
  - port: 80
  selector:
    run: php-apache
```

Save this as `php-apache.yaml` and apply it:

```bash
kubectl apply -f php-apache.yaml
```

### 3. Create the HPA Resource

Create an HPA that targets 50% CPU utilization with 1-10 replicas:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: php-apache
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: php-apache
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
```

Save this as `hpa.yaml` and apply it:

```bash
kubectl apply -f hpa.yaml
```

Alternatively, you can create the HPA using the `kubectl autoscale` command:

```bash
kubectl autoscale deployment php-apache --cpu-percent=50 --min=1 --max=10
```

### 4. Testing HPA

Generate load on your application:

```bash
kubectl run -i --tty load-generator --rm --image=busybox:1.28 --restart=Never -- /bin/sh -c "while sleep 0.01; do wget -q -O- http://php-apache; done"
```

In a separate terminal, watch the HPA status:

```bash
kubectl get hpa php-apache -w
```

You should see the CPU load increase and the HPA begin scaling up your deployment:

```
NAME         REFERENCE               TARGETS    MINPODS   MAXPODS   REPLICAS   AGE
php-apache   Deployment/php-apache   0%/50%     1         10        1          18s
php-apache   Deployment/php-apache   250%/50%   1         10        1          38s
php-apache   Deployment/php-apache   250%/50%   1         10        4          53s
php-apache   Deployment/php-apache   250%/50%   1         10        8          68s
```

# [Advanced Autoscaling Strategies](#advanced-strategies)

## [Memory-Based Autoscaling](#memory-based-autoscaling)

While CPU-based autoscaling is common, memory-based autoscaling can be essential for memory-intensive applications:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: memory-demo
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: memory-demo
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 60
```

## [Multi-Metric Autoscaling](#multi-metric-autoscaling)

HPA supports scaling decisions based on multiple metrics simultaneously:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: multi-metric-demo
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: multi-metric-app
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 60
```

With this configuration, the HPA will scale based on whichever metric requires the larger number of replicas.

## [Custom Metrics Autoscaling](#custom-metrics-autoscaling)

For business-specific scaling, you can use custom metrics with Prometheus and the Prometheus Adapter:

1. Install Prometheus using Helm:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install prometheus prometheus-community/prometheus
```

2. Install the Prometheus Adapter:

```bash
helm install prometheus-adapter prometheus-community/prometheus-adapter -f adapter-values.yaml
```

3. Create an HPA that scales based on custom metrics:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: custom-metric-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: 100
```

## [Scaling Based on External Metrics](#external-metrics)

HPA can also scale based on metrics from external systems like AWS SQS queue length:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: queue-processor-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: queue-processor
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: External
    external:
      metric:
        name: sqs_messages_visible
        selector:
          matchLabels:
            queue-name: my-queue
      target:
        type: AverageValue
        averageValue: 30
```

# [Optimizing Autoscaling in Production](#optimizing-autoscaling)

## [Setting Appropriate Resource Requests](#resource-requests)

Effective autoscaling depends on accurate resource requests:

- Set CPU and memory requests based on actual application needs
- Monitor resource usage patterns to refine these values
- For autoscaling, requests are more important than limits

Example of well-defined resource requests:

```yaml
resources:
  requests:
    cpu: 200m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

## [Implementing Pod Disruption Budgets](#pod-disruption-budgets)

Protect application availability during node scaling events with PDBs:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: app-pdb
spec:
  minAvailable: 2  # or use maxUnavailable: 1
  selector:
    matchLabels:
      app: my-app
```

## [Configuring Scale-Down Delay](#scale-down-delay)

Adjust the Cluster Autoscaler's `--scale-down-delay-after-add` and `--scale-down-delay-after-delete` parameters to prevent rapid scale up/down cycles:

```yaml
- --scale-down-delay-after-add=5m
- --scale-down-delay-after-delete=5m
- --scale-down-unneeded-time=5m
```

## [Using Node Taints and Tolerations](#taints-and-tolerations)

Control which pods can be scheduled on autoscaled nodes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-app
spec:
  template:
    spec:
      tolerations:
      - key: "autoscaling"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"
```

This ensures that only pods with specific tolerations can be scheduled on nodes with the corresponding taint.

# [Monitoring Autoscaling Performance](#monitoring)

## [Key Metrics to Watch](#key-metrics)

For proper autoscaling oversight, monitor these metrics:

- **HPA metrics**: CPU/memory utilization vs targets
- **Scaling events**: Frequency and timing of scale up/down events
- **Pod pending time**: Duration pods spend in pending state
- **Node utilization**: CPU, memory, and pod density on nodes
- **Scaling latency**: Time from triggering to completing scaling actions

## [Visualizing Autoscaling with Grafana](#visualizing-with-grafana)

Create dashboards to visualize autoscaling behavior:

1. Install Grafana:

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
helm install grafana grafana/grafana
```

2. Import HPA and Cluster Autoscaler dashboards (IDs: 13524 and 13496)

3. Create alerts for potential issues:
   - Persistent pending pods
   - Frequent scale up/down cycles
   - Consistently high resource utilization

# [Troubleshooting Common Autoscaling Issues](#troubleshooting)

## [HPA Not Scaling Up](#hpa-not-scaling)

If your HPA isn't scaling up properly:

1. Check Metrics Server:
```bash
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/default/pods"
```

2. Verify resource requests:
```bash
kubectl describe deployment your-deployment
```

3. Examine HPA status:
```bash
kubectl describe hpa your-hpa
```

## [Cluster Autoscaler Not Working](#cluster-autoscaler-not-working)

If node autoscaling isn't working:

1. Check permissions:
```bash
kubectl logs -n kube-system deployment/cluster-autoscaler
```

2. Verify ASG configuration:
```bash
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names your-asg-name
```

3. Look for pending pods:
```bash
kubectl get pods --all-namespaces | grep Pending
```

## [Scale-Down Issues](#scale-down-issues)

If nodes aren't scaling down:

1. Check for pods blocking scale-down:
```bash
kubectl get pods -o wide --all-namespaces | grep node-name
```

2. Verify pod disruption budgets:
```bash
kubectl get pdb --all-namespaces
```

3. Review scale-down blockers in logs:
```bash
kubectl logs -n kube-system deployment/cluster-autoscaler | grep "scale-down"
```

# [Conclusion](#conclusion)

Effective autoscaling in Amazon EKS requires configuring both pod-level scaling with HPA and node-level scaling with Cluster Autoscaler. When properly implemented, these mechanisms work together to optimize resource utilization and application performance.

Key takeaways:

1. **Start simple**: Begin with CPU-based HPA before exploring advanced metrics
2. **Set accurate resource requests**: Autoscaling relies on these values
3. **Monitor and adjust**: Regularly review autoscaling performance and refine parameters
4. **Protect availability**: Use PDBs to ensure application stability during scaling
5. **Plan for rapid changes**: Configure appropriate delays to prevent thrashing

By mastering these autoscaling techniques, you'll ensure your EKS clusters efficiently handle workload fluctuations while maintaining optimal cost efficiency and performance.