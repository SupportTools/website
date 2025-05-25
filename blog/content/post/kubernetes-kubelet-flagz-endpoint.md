---
title: "Demystifying Kubelet Configuration: The New /flagz Endpoint in Kubernetes v1.33"
date: 2026-11-17T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Kubelet", "v1.33", "Observability", "Debugging", "DevOps", "KEP-4828"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Kubernetes v1.33's new Kubelet /flagz endpoint that exposes runtime configuration flags, with practical examples for debugging, auditing, and cluster management"
more_link: "yes"
url: "/kubernetes-kubelet-flagz-endpoint/"
---

If you've ever spent hours trying to figure out why a Kubernetes node is behaving differently than expected, you know the frustration of digging through logs, SSH sessions, and manifests just to determine what flags your kubelet is actually running with. The good news? Kubernetes v1.33 introduces a simple yet powerful feature that will save operators countless troubleshooting hours: the kubelet `/flagz` endpoint. Let me show you how this endpoint works and why it's about to become an essential tool in your Kubernetes operations toolkit.

<!--more-->

## The Configuration Mystery Problem

Before diving into the solution, let's understand the problem this new feature solves. In large-scale Kubernetes environments, especially those with multiple node pools or clusters, configuration drift is nearly inevitable. You might think all your nodes are running with identical kubelet configurations, but reality often tells a different story:

- Some nodes might be running older versions after a partial upgrade
- Configuration updates may not have been applied during a rolling update
- Manually-managed nodes could have entirely different flag settings
- Infrastructure-as-Code changes might not have propagated correctly
- Different teams might have applied different configurations

Traditionally, verifying the actual runtime configuration required you to:

1. SSH into the node (if even possible in your environment)
2. Find the kubelet process with `ps aux | grep kubelet`
3. Parse through a long, often-wrapped command line
4. Extract the flags from systemd unit files
5. Check kubelet configuration files

This process is tedious, error-prone, and often impractical in secure production environments where direct node access is restricted.

## Enter the /flagz Endpoint

Kubernetes v1.33 introduces a new HTTP endpoint in the kubelet that elegantly solves this problem. The `/flagz` endpoint exposes the **actual runtime flags** that the kubelet is using—not what's in the configuration files, not what you think it should be using, but what's actually in memory right now.

### What /flagz Provides

When you query the endpoint, you get simple, plaintext output showing all flags and their values:

```
title: Kubernetes Flagz
description: Command line flags that Kubernetes component was started with.

address=0.0.0.0
anonymous-auth=true
authorization-mode=Webhook
container-runtime-endpoint=unix:///var/run/containerd/containerd.sock
cpu-manager-policy=static
kubeconfig=/etc/kubernetes/kubelet.conf
max-pods=110
pod-infra-container-image=registry.k8s.io/pause:3.9
rotate-certificates=true
tls-cert-file=/var/lib/kubelet/pki/kubelet-server-current.pem
...
```

This output shows you exactly what's running—including defaults you didn't explicitly set and values that might differ from what you expected.

## How to Use /flagz in Practice

Let's walk through a few real-world scenarios where `/flagz` becomes invaluable:

### 1. Basic Flag Inspection

The simplest use case is checking a node's configuration directly:

```bash
kubectl get --raw "/api/v1/nodes/worker-01/proxy/flagz"
```

This command connects to the kubelet on `worker-01` and requests its flag configuration.

### 2. Comparing Configurations Across Nodes

When troubleshooting node behavior differences, comparing configurations is crucial:

```bash
# Create a script to fetch and compare configurations
for node in $(kubectl get nodes -o name | cut -d/ -f2); do
  echo "Checking $node..."
  kubectl get --raw "/api/v1/nodes/$node/proxy/flagz" > "/tmp/$node-flagz.txt"
done

# Now use diff to compare
diff -y /tmp/worker-01-flagz.txt /tmp/worker-02-flagz.txt | grep -v "^title\|^description" | grep "|"
```

This helps you quickly identify configuration discrepancies between nodes.

### 3. Auditing Critical Security Settings

For security audits, you might want to verify that specific security settings are properly configured:

```bash
for node in $(kubectl get nodes -o name | cut -d/ -f2); do
  echo "Checking $node..."
  kubectl get --raw "/api/v1/nodes/$node/proxy/flagz" | grep -E "authorization-mode|anonymous-auth|client-ca-file"
done
```

This command helps verify critical security configuration across your entire cluster.

### 4. Verifying Feature Gates

When troubleshooting feature-related issues, check if specific feature gates are enabled:

```bash
kubectl get --raw "/api/v1/nodes/worker-01/proxy/flagz" | grep "feature-gates"
```

This shows you which feature gates are enabled on the node, helping verify if experimental features are properly configured.

## Technical Implementation Details

The `/flagz` endpoint is part of KEP-4828 (Kubernetes Enhancement Proposal: Component Flagz) and builds on the existing component-base zpages interface. It's implemented with several important characteristics:

### Security Considerations

The endpoint is secure by default:

- Access is restricted to users in the `system:monitoring` group
- It follows the same security model as other debug endpoints like `/healthz` and `/metrics`
- No sensitive data is exposed through this endpoint
- TLS is enforced when the kubelet serves securely

### Performance Impact

The impact on your cluster is minimal:

- The endpoint returns static state information
- No computation is performed to generate the output
- Memory overhead is negligible
- There's no continuous monitoring or background processing

### Enabling the Feature

The feature is gated in v1.33 behind the `ComponentFlagz` feature gate:

```yaml
# In your kubelet configuration
featureGates:
  ComponentFlagz: true
```

Or via the command line:

```
--feature-gates=ComponentFlagz=true
```

## Beyond Basic Usage: Advanced Patterns

As I've worked with this feature in test environments, I've developed some advanced patterns that provide even more value:

### Creating a Kubelet Configuration Dashboard

You can build a simple dashboard by collecting and formatting the output:

```bash
# Collect configurations
mkdir -p /tmp/kubelet-configs
for node in $(kubectl get nodes -o name | cut -d/ -f2); do
  kubectl get --raw "/api/v1/nodes/$node/proxy/flagz" > "/tmp/kubelet-configs/$node.txt"
done

# Generate a simple HTML report
echo "<html><body><h1>Kubelet Configurations</h1>" > /tmp/report.html
for node in $(ls /tmp/kubelet-configs); do
  echo "<h2>$node</h2><pre>" >> /tmp/report.html
  cat "/tmp/kubelet-configs/$node.txt" >> /tmp/report.html
  echo "</pre>" >> /tmp/report.html
done
echo "</body></html>" >> /tmp/report.html
```

### Integrating with Configuration Management

For those using configuration management tools, you can use `/flagz` to verify that your desired configuration is actually applied:

```bash
# Expected values (from your CM system)
expected_values=(
  "max-pods=110"
  "cpu-manager-policy=static"
  "event-qps=50"
)

# Check actual values
for node in $(kubectl get nodes -o name | cut -d/ -f2); do
  echo "Verifying $node..."
  flagz=$(kubectl get --raw "/api/v1/nodes/$node/proxy/flagz")
  for val in "${expected_values[@]}"; do
    if ! echo "$flagz" | grep -q "$val"; then
      echo "WARNING: $node is missing or has incorrect value for $val"
    fi
  done
done
```

## Limitations and Gotchas

While the `/flagz` endpoint is incredibly useful, there are some limitations to be aware of:

1. **Not Enabled by Default**: You must explicitly enable the feature gate in v1.33

2. **Plain Text Format**: The current output is human-readable but not structured for programmatic parsing (though this may change in future versions)

3. **Node Access Required**: You need network access to the kubelet API on each node

4. **Kubelet Only (For Now)**: In v1.33, only kubelet exposes this endpoint, though other components will likely follow

5. **Not Real-Time Updating**: The values shown are from component startup, so if you're using dynamic reconfiguration, changes won't be reflected

## Future Directions

Based on community discussions and the KEP roadmap, here's what we can expect for the `/flagz` endpoint in future Kubernetes versions:

1. **Extension to Other Components**: The API server, controller manager, scheduler, and kube-proxy will likely get similar endpoints

2. **Structured Output Formats**: JSON and other structured formats for better programmatic use

3. **Historical Tracking**: Potential integration with auditing to track configuration changes over time

4. **Standardized Access Patterns**: More consistent ways to access this information across components

## Conclusion: A Simple Feature with Big Impact

The kubelet `/flagz` endpoint represents something I always appreciate in Kubernetes: a simple feature that solves a real operational pain point. For those of us who manage large-scale clusters, this endpoint eliminates hours of debugging and provides much-needed transparency into our infrastructure.

While it might seem like a minor addition, the real value comes from the operational clarity it provides. No more guessing what flags are active, no more SSH sessions just to check configuration, and no more uncertainty about why nodes behave differently. Just a simple HTTP endpoint giving you the ground truth about your kubelet's configuration.

As Kubernetes continues to mature, features like `/flagz` show that the project is addressing not just the cutting-edge use cases but also the day-to-day operational challenges that administrators face. This kind of thoughtful, practical enhancement is what keeps Kubernetes effective at scale.

Have you started testing Kubernetes v1.33 features? What other operational improvements would you like to see in future releases? Let me know in the comments below!