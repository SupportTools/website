---
title: "Slashing Kubernetes Costs: How kube-downscaler Saved Us 65% on Non-Production Clusters"
date: 2027-04-01T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Cost Optimization", "DevOps", "kube-downscaler", "Cloud Native", "Kubernetes Tools"]
categories:
- Kubernetes
- Cost Optimization
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to implementing kube-downscaler for automatic scaling down of Kubernetes workloads during off-hours, with real-world examples and configuration patterns"
more_link: "yes"
url: "/reduce-kubernetes-costs-kube-downscaler/"
---

If you're running multiple Kubernetes environments, you're likely all too familiar with the silent budget drain of idle workloads. After helping dozens of organizations optimize their Kubernetes spend, I've found that non-production clusters often run at less than 10% utilization during nights and weekends—yet typically consume 100% of the resources they're allocated. Here's how a simple tool called kube-downscaler helped us dramatically reduce costs without sacrificing development velocity.

<!--more-->

## The Hidden Cost of "Always-On" Kubernetes

Before diving into the solution, let's understand the problem. A typical organization running Kubernetes might have several environments:

- Multiple development clusters
- Staging/QA environments
- Integration testing clusters
- Demo environments
- Production

While production needs to run 24/7, the others often sit completely idle for ~128 hours every week (nights and weekends). That's over 76% of the time where you're essentially paying for compute resources that nobody is using.

In one recent client project, we discovered they were spending nearly $12,000 monthly on non-production Kubernetes clusters that were used actively for less than 6 hours per day. Even with Reserved Instances or Savings Plans, this represented a significant waste.

## Enter kube-downscaler: Schedule-Based Scaling Done Right

After evaluating several solutions, we implemented [kube-downscaler](https://codeberg.org/hjacobs/kube-downscaler), an elegantly simple open-source tool that reduces replica counts during predefined time windows. Unlike more complex solutions, kube-downscaler does one thing and does it well—it scales your deployments down when you don't need them and back up when you do.

### How kube-downscaler Works

At its core, kube-downscaler is a lightweight controller that watches for specific annotations on your Kubernetes resources. When the current time matches a downtime window you've defined, it captures the original replica count, then scales the resource down to your specified minimum. When the window ends, it restores the original replica count.

The real beauty is in its simplicity—no Custom Resource Definitions (CRDs), no complex operators, just a straightforward controller and some annotations.

## Implementation: Getting Started in 10 Minutes

Let's walk through implementing kube-downscaler in your cluster. I've found this approach works across various Kubernetes distributions, from EKS and GKE to RKE2 and k3s.

### Step 1: Deploy kube-downscaler

The simplest way to deploy is directly from the repository:

```bash
kubectl apply -f https://codeberg.org/hjacobs/kube-downscaler/raw/branch/master/deploy/deploy.yaml
```

If you prefer Helm:

```bash
helm repo add kube-downscaler https://codeberg.org/hjacobs/kube-downscaler/releases/download/helm-chart/
helm install kube-downscaler kube-downscaler/kube-downscaler
```

### Step 2: Configure Your First Deployment

Let's say you have a development API that doesn't need to run overnight or on weekends. Add these annotations to your deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dev-api
  annotations:
    # Scale down to 0 replicas on weekdays from 7PM to 7AM Eastern time
    downscaler/downtime: "Mon-Fri 19:00-07:00 America/New_York"
    # Scale down to 0 replicas all day on weekends
    downscaler/weekend: "1"
    # Ensure we scale to 0, not just reduce replicas
    downscaler/target-replicas: "0"
spec:
  replicas: 3
  # ... rest of your deployment spec
```

With this configuration, your dev-api will automatically scale to zero every weekday evening and all weekend, then scale back to its original replica count during work hours.

### Step 3: Apply Namespace-Wide Default Rules

For development environments, you might want to scale down everything by default. You can do this with namespace annotations:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: development
  annotations:
    downscaler/downtime: "Mon-Fri 19:00-07:00 America/New_York"
    downscaler/weekend: "1"
    downscaler/target-replicas: "0"
```

### Step 4: Exclude Critical Services

Some services might need to remain running even in dev environments. You can exclude them with:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-service
  annotations:
    downscaler/exclude: "true"
spec:
  # ... your deployment spec
```

## Advanced Configurations I've Found Useful

After implementing kube-downscaler across dozens of clusters, I've developed several patterns that work particularly well:

### Staggered Startup to Prevent Resource Contention

When a downtime window ends, all deployments try to scale up simultaneously, which can cause resource contention. To prevent this, stagger your startup times:

```yaml
# Team A deployments
downscaler/uptime: "Mon-Fri 07:00-19:00 America/New_York"

# Team B deployments
downscaler/uptime: "Mon-Fri 07:15-19:00 America/New_York"

# Team C deployments
downscaler/uptime: "Mon-Fri 07:30-19:00 America/New_York"
```

### Scale Down, Not Out

Instead of scaling to zero (which means cold starts when scaling up), you might want to maintain a minimal footprint:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  annotations:
    downscaler/downtime: "Mon-Fri 19:00-07:00 America/New_York"
    downscaler/weekend: "1"
    downscaler/target-replicas: "1"
    # Optional: remember the original replica count
    downscaler/original-replicas: "3"
spec:
  replicas: 3
  # ... rest of deployment
```

This keeps one pod running for quicker startup when needed while still reducing costs by ~67%.

### Integration with HPA (Horizontal Pod Autoscaler)

kube-downscaler works beautifully with HPA. During working hours, HPA manages scaling based on metrics, while kube-downscaler takes over during off-hours:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  annotations:
    downscaler/downtime: "Mon-Fri 19:00-07:00 America/New_York"
    downscaler/target-replicas: "1"
spec:
  replicas: 3
  # ... rest of deployment
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: frontend
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: frontend
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
```

## Real-World Results: The Numbers Don't Lie

After implementing kube-downscaler across our development and staging environments, we saw dramatic cost reductions:

- **Development environment**: 78% cost reduction (workday-only usage, scale to zero)
- **Staging environment**: 53% cost reduction (maintains minimal replicas overnight)
- **Demo environment**: 62% cost reduction (scales up only during business hours)

For a medium-sized organization with 5-10 non-production clusters, this typically translates to $5,000-$15,000 in monthly savings—without any negative impact on developer productivity.

## Comparison: kube-downscaler vs. Alternatives

While kube-downscaler isn't the only option for cost optimization, its simplicity makes it my go-to choice for most scenarios.

| Feature | kube-downscaler | KEDA | Cluster Autoscaler |
|---------|----------------|------|-------------------|
| Schedule-based scaling | ✅ | ❌ (Needs CronJobs) | ❌ |
| Metrics-based scaling | ❌ | ✅ | ✅ |
| Event-driven scaling | ❌ | ✅ | ❌ |
| Implementation complexity | Low | Medium | Medium |
| Resource overhead | Minimal | Moderate | Moderate |
| Learning curve | Very low | Moderate | Moderate |

For simple schedule-based cost optimization, kube-downscaler wins hands down. If you need more complex event-driven or metrics-based scaling, you might want to look at KEDA or other solutions.

## Potential Limitations to Consider

While kube-downscaler has been remarkably reliable for us, there are some considerations to keep in mind:

1. **Services with persistent connections**: Applications that maintain long-lived client connections may experience disruption when scaled down.

2. **Cold start times**: Some applications (especially JVM-based ones) have significant startup times. For these, consider scaling down to 1 replica rather than 0.

3. **Time zone complexity**: If your team spans multiple time zones, managing downtime windows becomes more complex. Consider using UTC for consistency.

4. **State management**: Scaling stateful sets requires careful planning—make sure your applications can handle being scaled down gracefully.

## Implementation Tips from the Trenches

After implementing this in multiple environments, I've learned a few lessons:

1. **Start gradually**: Begin with non-critical deployments before applying namespace-wide rules.

2. **Monitor and adjust**: Watch your scaling patterns for the first few weeks and adjust time windows as needed.

3. **Document your approach**: Make sure your team understands which environments scale down and when.

4. **Consider CI/CD integration**: Update your CI/CD processes to be aware of downtime windows (avoid deployments when targets are scaled to zero).

5. **Set up alerts**: Configure notifications when scaling operations fail or when resources are unexpectedly scaled up during off-hours.

## Conclusion: Simple Solutions to Complex Problems

In the world of Kubernetes optimization, we often reach for complex, metrics-driven solutions. However, for predictable workload patterns like development environments, the simplicity of schedule-based scaling with kube-downscaler provides an excellent return on investment.

By implementing this lightweight tool, we've consistently helped organizations reduce their non-production Kubernetes costs by 50-70% with minimal operational overhead. The best part? Developers barely notice the change—their resources are always available when they need them.

If you're looking for an easy win in your Kubernetes cost optimization journey, kube-downscaler should be high on your list. The half-hour it takes to implement could save your organization thousands of dollars every month.

Have you implemented kube-downscaler or similar cost optimization tools? I'd love to hear about your experiences and any patterns you've found effective in the comments below.