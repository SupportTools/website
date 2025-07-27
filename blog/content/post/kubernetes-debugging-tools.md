---
title: "Kubernetes Debugging Tools: Complete Guide to Cluster Troubleshooting"
date: 2025-02-07T00:00:00-00:00
draft: false
tags: ["kubernetes", "debugging", "monitoring", "devops", "troubleshooting", "observability", "k8s", "cluster-management", "kubectl", "kubernetes-monitoring"]
categories: ["Kubernetes", "DevOps", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Kubernetes debugging with our comprehensive guide covering kubectl, k9s, Prometheus, and essential troubleshooting tools. Learn advanced techniques for debugging pods, nodes, networking issues, and monitoring cluster health."
keywords: ["kubernetes debugging", "k8s troubleshooting", "kubectl commands", "kubernetes monitoring", "cluster debugging", "kubernetes observability", "k9s tool", "prometheus grafana kubernetes", "kubernetes network debugging", "pod troubleshooting"]
url: "/kubernetes-debugging-tools/"
---

Debugging Kubernetes clusters effectively is crucial for maintaining reliable container orchestration in production environments. Whether you're troubleshooting pod crashes, investigating network connectivity issues, or optimizing cluster performance, having the right debugging tools and knowledge is essential. This comprehensive guide covers the most powerful Kubernetes debugging tools and techniques used by DevOps professionals and Site Reliability Engineers (SREs).

<!--more-->

## Quick Navigation
- [Essential Command-line Tools](#essential-command-line-tools)
- [Observability Stack](#observability-stack)
- [Network Debugging Tools](#network-debugging-tools)
- [System-level Debugging](#system-level-debugging)
- [Cloud Provider Tools](#cloud-provider-tools)
- [Common Debugging Scenarios](#common-debugging-scenarios)
- [Best Practices](#best-practices)

# Essential Command-line Tools

## kubectl
`kubectl` remains the primary command-line tool for interacting with Kubernetes clusters. Here are some advanced debugging commands:

```sh
# Get detailed information about cluster nodes
kubectl get nodes -o wide
kubectl describe node <node-name>

# Debug pods
kubectl get pods -A -o wide --field-selector status.phase!=Running
kubectl describe pod <pod-name> -n <namespace>
kubectl logs <pod-name> -n <namespace> --previous  # Get logs from previous container instance
kubectl logs -f <pod-name> -n <namespace> -c <container-name>  # Stream logs from specific container
kubectl exec -it <pod-name> -n <namespace> -- /bin/sh  # Interactive shell

# Check events
kubectl get events --sort-by=.metadata.creationTimestamp -n <namespace>

# Resource usage
kubectl top pods -n <namespace>
kubectl top nodes
```

## Useful kubectl Plugins
Enhance kubectl with these powerful plugins:

### kubectl-neat
Cleans up Kubernetes YAML and JSON output to make it more readable:
```sh
kubectl krew install neat
kubectl get pod <pod-name> -o yaml | kubectl neat
```

### kubectl-tree
Explore ownership relationships between Kubernetes objects:
```sh
kubectl krew install tree
kubectl tree deployment <deployment-name>
```

### kubectl-sniff
Capture network traffic from a pod:
```sh
kubectl krew install sniff
kubectl sniff <pod-name> -n <namespace>
```

### kubectl-node-shell
Get a shell on any node:
```sh
kubectl krew install node-shell
kubectl node-shell <node-name>
```

## Useful bash/zsh Aliases
Add these aliases to your shell configuration file for quick access to kubectl commands:

```sh
alias k8s-show-ns="kubectl api-resources --verbs=list --namespaced -o name  | xargs -n 1 kubectl get --show-kind --ignore-not-found  -n"
alias k8s-delete-ns="kubectl api-resources --verbs=list --namespaced -o name | xargs -n 1 -I {} kubectl delete {} --ignore-not-found -n"
alias k8s-watch='watch "kubectl cluster-info; kubectl get nodes -o wide 2>/dev/null; kubectl get pods -A -o wide 2>/dev/null | grep -v Running | grep -v Completed"'
alias k8s-watch-top='watch "kubectl cluster-info; kubectl top nodes; kubectl get nodes -o wide 2>/dev/null; kubectl get pods -A -o wide 2>/dev/null | grep -v Running | grep -v Completed"'
```

k8s-show-ns: Show all resources in a namespace including custom resources which are not listed by kubectl get all.

k8s-delete-ns: Delete all resources in a namespace including custom resources without deleting the namespace itself.

k8s-watch: Is a watch that shows you a `kubectl get nodes -o wide` and a list of all pods that in a non Running/Completed state. This is useful during recovery or troubleshooting as you can see the cluster state in real-time.

k8s-watch-top: Similar to k8s-watch but also includes `kubectl top nodes` to show you the resource usage of the nodes. NOTE: This command requires the metrics-server to be installed in the cluster.


## k9s
`k9s` provides a terminal-based UI for managing Kubernetes clusters with real-time updates and powerful filtering capabilities.

Install `k9s`:
```sh
# macOS
brew install derailed/k9s/k9s

# Linux
curl -sS https://webinstall.dev/k9s | bash

# Using Go
go install github.com/derailed/k9s@latest
```

Useful k9s shortcuts:
- `:pod` - List pods
- `:deploy` - List deployments
- `:svc` - List services
- `ctrl-d` - Delete resource
- `/` - Start filtering
- `d` - Describe resource
- `l` - View logs

## Stern
`stern` allows you to tail logs from multiple pods simultaneously with color coding:

```sh
# Install
brew install stern  # macOS
sudo snap install stern  # Ubuntu

# Usage examples
stern "app-.*" --tail 50  # Tail all pods starting with "app-"
stern -n monitoring "prometheus.*|grafana.*"  # Monitor multiple patterns
stern <pod-pattern> -s 5m  # Show logs from last 5 minutes
```

# Observability Stack

## OpenTelemetry
OpenTelemetry provides a complete observability framework for cloud-native applications:

```yaml
# Example OpenTelemetry Collector configuration
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: demo-collector
spec:
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
          http:
    processors:
      batch:
    exporters:
      logging:
        loglevel: debug
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [logging]
```

## Jaeger
Jaeger provides distributed tracing to track requests across microservices:

```sh
# Install Jaeger using Helm
helm repo add jaegertracing https://jaegertracing.github.io/helm-charts
helm install jaeger jaegertracing/jaeger

# Port forward to access UI
kubectl port-forward svc/jaeger-query 16686:16686
```

## Prometheus & Grafana
Modern metrics collection and visualization:

```sh
# Install using Helm
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack

# Access Grafana
kubectl port-forward svc/prometheus-grafana 3000:80

# Useful PromQL queries
# High CPU usage pods
sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) by (pod)

# Memory usage
sum(container_memory_working_set_bytes{container!=""}) by (pod)

# Network errors
sum(rate(container_network_receive_errors_total[5m])) by (pod)
```

## Loki
Scalable log aggregation system that pairs well with Grafana:

```sh
# Install Loki stack
helm repo add grafana https://grafana.github.io/helm-charts
helm install loki grafana/loki-stack \
  --set grafana.enabled=true,prometheus.enabled=true

# Example LogQL queries
{app="nginx"} |= "error"
{namespace="production"} |~ "exception.*" | json
```

# Network Debugging Tools

## Network Policy Validator
Test your NetworkPolicies:

```sh
# Install
kubectl krew install np-viewer

# View policies
kubectl np-viewer

# Simulate traffic
kubectl np-viewer simulate \
  --source-pod nginx-7b95f57f97-abc12 \
  --destination-pod web-85b9bf9cbd-def34 \
  --port 80
```

## DNS Debugging
Common DNS troubleshooting commands:

```sh
# Check CoreDNS pods
kubectl get pods -n kube-system -l k8s-app=kube-dns

# DNS debugging pod
kubectl run dnsutils --image=gcr.io/kubernetes-e2e-test-images/dnsutils --restart=Never

# Run DNS queries
kubectl exec -it dnsutils -- nslookup kubernetes.default
kubectl exec -it dnsutils -- dig @10.43.0.10 kubernetes.default.svc.cluster.local
```

# System-level Debugging

## BPF Tools
Advanced kernel tracing tools:

```sh
# Install BCC tools
sudo apt-get install bpfcc-tools linux-headers-$(uname -r)

# Trace syscalls
sudo execsnoop-bpfcc

# Monitor TCP connections
sudo tcpconnect-bpfcc

# Track slow disk I/O
sudo biolatency-bpfcc
```

## Performance Analysis

### iostat
Monitor I/O performance:
```sh
iostat -xz 1  # Extended disk statistics every second
iostat -m  # Show statistics in megabytes
```

### vmstat
Memory and CPU statistics:
```sh
vmstat -w 1  # Wide output, updated every second
vmstat -s  # Memory statistics summary
```

### Network Tools
```sh
# Check network interfaces
ip addr show

# Monitor network traffic
iftop -i eth0

# Capture specific traffic
tcpdump -i any port 80 -w capture.pcap
```

# Cloud Provider Tools

## AWS EKS
```sh
# Install eksctl
curl --silent --location "https://github.com/weaveworks/eksctl/releases/latest/download/eksctl_$(uname -s)_amd64.tar.gz" | tar xz -C /tmp
sudo mv /tmp/eksctl /usr/local/bin

# Get cluster info
eksctl get cluster
aws eks describe-cluster --name cluster-name

# Update kubeconfig
aws eks update-kubeconfig --name cluster-name
```

## GKE
```sh
# Install gcloud
curl https://sdk.cloud.google.com | bash

# Get cluster credentials
gcloud container clusters get-credentials cluster-name --zone zone-name

# View cluster details
gcloud container clusters describe cluster-name
```

## Azure AKS
```sh
# Install Azure CLI
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Get credentials
az aks get-credentials --resource-group myResourceGroup --name myAKSCluster

# View cluster health
az aks show --resource-group myResourceGroup --name myAKSCluster
```

# Common Debugging Scenarios

## Pod Stuck in Pending State
```sh
# Check node resources
kubectl describe node <node-name> | grep -A 5 "Allocated resources"

# Check events
kubectl get events --sort-by=.metadata.creationTimestamp | grep <pod-name>

# Verify PVC status if using persistent storage
kubectl get pvc -n <namespace>
```

## Pod Stuck in CrashLoopBackOff
```sh
# Check logs
kubectl logs <pod-name> --previous

# Check pod details
kubectl describe pod <pod-name>

# Check resource limits
kubectl get pod <pod-name> -o yaml | grep -A 5 resources:
```

## Service Connectivity Issues
```sh
# Verify service
kubectl get svc <service-name>
kubectl describe svc <service-name>

# Check endpoints
kubectl get endpoints <service-name>

# Test from debug pod
kubectl run curl --image=curlimages/curl -i --tty -- sh
```

## Summary of Key Debugging Tools

Here's a quick reference of the essential Kubernetes debugging tools covered in this guide:

1. **kubectl** - The primary CLI tool for cluster interaction and basic debugging
2. **k9s** - Terminal-based UI for real-time cluster management
3. **Stern** - Multi-pod log tailing with powerful filtering
4. **OpenTelemetry** - Complete observability framework
5. **Prometheus & Grafana** - Metrics collection and visualization
6. **Loki** - Log aggregation and analysis
7. **Network Policy Validator** - Network policy testing and validation
8. **BPF Tools** - Advanced kernel-level debugging

## Related Resources

- [Backup Kubernetes Cluster with Velero](/backup-kubernetes-cluster-aws-s3-velero/)
- [Deep Dive into etcd](/deep-dive-etcd-kubernetes/)
- [CoreDNS Troubleshooting Guide](/coredns-nodelocaldns-troubleshooting-monitoring/)
- [Cilium Troubleshooting](/cilium-troubleshooting/)

## Conclusion

Mastering Kubernetes debugging requires understanding both the tools available and when to use them effectively. This guide has covered essential debugging tools and techniques, from basic kubectl commands to advanced observability stacks. Remember these key takeaways:

1. Start with basic debugging tools (kubectl, logs, events) before moving to advanced techniques
2. Implement a comprehensive observability strategy combining metrics, logs, and traces
3. Use specialized tools for specific debugging scenarios (network issues, performance problems)
4. Regular monitoring and proactive debugging prevent production issues
5. Keep your debugging tools updated and readily available

By following these practices and utilizing the right tools, you can effectively diagnose and resolve Kubernetes issues, ensuring your clusters remain healthy and performant.
