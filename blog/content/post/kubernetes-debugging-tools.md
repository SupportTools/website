---
title: "Essential Tools for Debugging Kubernetes and Its Nodes"
date: 2025-02-07T00:00:00-00:00
draft: false
tags: ["kubernetes", "debugging", "monitoring", "devops", "troubleshooting", "observability"]
categories: ["Kubernetes Debugging"]
author: "Matthew Mattox"
description: "A comprehensive guide to essential tools and techniques for debugging Kubernetes clusters, nodes, and applications effectively."
url: "/post/kubernetes-debugging-tools/"
---

Debugging a Kubernetes cluster and its nodes can be a challenging task, especially when dealing with complex microservices architectures. In this comprehensive guide, we'll explore essential tools and techniques that can help diagnose and resolve issues in Kubernetes environments, from basic troubleshooting to advanced observability.

<!--more-->

# Table of Contents
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

## Conclusion
Effective debugging in Kubernetes requires a combination of the right tools, methodical approach, and understanding of the platform's architecture. By utilizing these tools and following best practices, you can quickly identify and resolve issues in your Kubernetes environment. Remember to always start with the basics (logs, events, describe) before moving to more advanced debugging techniques.

The key is to build a comprehensive observability strategy that combines metrics, logs, and traces to give you complete visibility into your cluster's behavior. Regular monitoring and proactive debugging can help prevent issues before they impact your applications.
