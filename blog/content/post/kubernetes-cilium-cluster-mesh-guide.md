---
title: "Kubernetes Multi-Cluster Service Discovery with Cilium Cluster Mesh"
date: 2028-04-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cilium", "Multi-Cluster", "Service Discovery", "eBPF"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to deploying Cilium Cluster Mesh for transparent multi-cluster service discovery, load balancing, and failover across Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-cilium-cluster-mesh-guide/"
---

Cilium Cluster Mesh extends eBPF-powered networking across multiple Kubernetes clusters, enabling services in one cluster to discover and call services in another cluster as if they were local. This guide covers cluster mesh architecture, deployment procedures, global service configuration, network policy enforcement across clusters, and production operational patterns.

<!--more-->

# Kubernetes Multi-Cluster Service Discovery with Cilium Cluster Mesh

## Why Multi-Cluster Service Discovery Matters

Enterprise Kubernetes deployments rarely stay within a single cluster. Organizations spread workloads across clusters for regulatory compliance, geographic distribution, blast radius reduction, independent upgrade cadences, and environment segregation. The challenge is connecting these clusters so that services can communicate without requiring every team to implement its own cross-cluster discovery logic.

Traditional approaches involve external DNS-based service discovery, API gateways at cluster boundaries, or manual endpoint registration. Each approach requires application awareness of cluster topology and adds operational complexity. Cilium Cluster Mesh solves this differently: the networking layer handles cross-cluster connectivity transparently, so applications use standard Kubernetes service names regardless of where the backing pods run.

Cilium Cluster Mesh uses the same eBPF dataplane that handles in-cluster traffic. Cross-cluster packets are encrypted with WireGuard or IPSec when traversing untrusted networks, and the control plane synchronizes service endpoints via a shared etcd cluster mesh control plane. The result is sub-millisecond service discovery with full network policy enforcement at both the sending and receiving cluster.

## Architecture Overview

Cluster Mesh consists of three components:

**clustermesh-apiserver**: A per-cluster component that exposes the local cluster's Cilium state (services, endpoints, identities) to peer clusters via a dedicated etcd instance. Peer clusters read this state to learn about remote endpoints.

**Cluster Mesh CA and certificates**: Each cluster gets a shared CA used to authenticate inter-cluster connections. Cilium agents in each cluster present certificates signed by this CA when connecting to peer clustermesh-apiservers.

**Global Services**: A Kubernetes Service annotation (`service.cilium.io/global: "true"`) causes Cilium to merge the local service endpoints with identically named and namespaced services from peer clusters. Traffic is load-balanced across all clusters.

```
Cluster A                              Cluster B
┌──────────────────────────────┐      ┌──────────────────────────────┐
│  Pod → Service "api"         │      │  Pod → Service "api"         │
│      ↓                       │      │      ↓                       │
│  Cilium eBPF (local eps)     │◄────►│  Cilium eBPF (local eps)     │
│      ↓                       │ mesh │      ↓                       │
│  clustermesh-apiserver       │      │  clustermesh-apiserver       │
│  (etcd, TLS)                 │      │  (etcd, TLS)                 │
└──────────────────────────────┘      └──────────────────────────────┘
```

## Prerequisites

Before deploying Cluster Mesh, verify the following:

- Cilium 1.14+ installed on all clusters
- Each cluster has a unique `cluster-id` (1–255) and `cluster-name`
- Pod CIDR ranges do not overlap across clusters
- Network connectivity between node IPs of all clusters (direct routing or VPN)
- Cilium installed with kube-proxy replacement enabled for consistent behavior

Check existing Cilium configuration:

```bash
cilium config view | grep -E "cluster-id|cluster-name|kube-proxy-replacement"
```

## Installing Cilium with Cluster Mesh Support

### Cluster A Installation

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --set cluster.name=cluster-a \
  --set cluster.id=1 \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<CLUSTER_A_API_SERVER_IP> \
  --set k8sServicePort=6443 \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.replicas=2 \
  --set clustermesh.apiserver.service.type=LoadBalancer \
  --set encryption.enabled=true \
  --set encryption.type=wireguard \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true
```

### Cluster B Installation

```bash
helm install cilium cilium/cilium \
  --version 1.16.0 \
  --namespace kube-system \
  --set cluster.name=cluster-b \
  --set cluster.id=2 \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=<CLUSTER_B_API_SERVER_IP> \
  --set k8sServicePort=6443 \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.replicas=2 \
  --set clustermesh.apiserver.service.type=LoadBalancer \
  --set encryption.enabled=true \
  --set encryption.type=wireguard \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true
```

### Verifying Cilium Status

```bash
# On each cluster
cilium status --wait

# Expected output
KVStore:                 Ok   Disabled
Kubernetes:              Ok   1.30 (v1.30.0)
Kubernetes APIs:         ["cilium/v2::CiliumClusterwideNetworkPolicy", "cilium/v2::CiliumEndpoint", ...]
Cluster Mesh:            Ok
...
```

## Enabling Cluster Mesh

The `cilium clustermesh enable` command configures the clustermesh-apiserver and generates the necessary certificates and etcd endpoints.

### Enable on Cluster A

```bash
# Switch context to cluster A
kubectl config use-context cluster-a

cilium clustermesh enable \
  --service-type LoadBalancer \
  --create-ca

# Wait for the mesh API server to be ready
cilium clustermesh status --wait
```

### Enable on Cluster B

```bash
kubectl config use-context cluster-b

cilium clustermesh enable \
  --service-type LoadBalancer \
  --create-ca

cilium clustermesh status --wait
```

### Connect the Clusters

```bash
# Connect cluster-b to cluster-a (run with context pointing to cluster-a)
# This exchanges credentials between both clusters bidirectionally
cilium clustermesh connect \
  --context cluster-a \
  --destination-context cluster-b

# Verify the connection
cilium clustermesh status --context cluster-a
```

Expected output after successful connection:

```
ClusterMesh:             Ok
✅ Cluster Connections:
  - cluster-b: ready, endpoints=3
```

## Configuring Global Services

A Global Service merges endpoints from matching services across all connected clusters. Cilium routes traffic to the nearest healthy endpoints but can distribute across clusters based on policy.

### Basic Global Service

Apply identical manifests to both clusters:

```yaml
# global-service.yaml - apply to BOTH clusters
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/shared: "true"
spec:
  selector:
    app: api
  ports:
    - port: 8080
      targetPort: 8080
  type: ClusterIP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: myregistry/api:v2.1.0
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
```

```bash
kubectl apply -f global-service.yaml --context cluster-a
kubectl apply -f global-service.yaml --context cluster-b
```

### Verifying Global Service Endpoint Merging

```bash
# Check that Cilium sees endpoints from both clusters
kubectl exec -n kube-system -it cilium-xxxxx -- \
  cilium service list | grep api-service

# View merged endpoints
kubectl exec -n kube-system -it cilium-xxxxx -- \
  cilium endpoint list
```

## Topology-Aware Load Balancing

Cluster Mesh supports several traffic distribution models:

### Local-Preferred Routing

By default, Cilium prefers local endpoints. Traffic only crosses cluster boundaries when local endpoints are unavailable (zero healthy local pods).

```yaml
annotations:
  service.cilium.io/global: "true"
  service.cilium.io/shared: "true"
  # No affinity annotation = local preferred
```

### Weighted Cross-Cluster Load Balancing

Distribute traffic based on cluster weights. Useful for canary deployments or capacity-based routing:

```yaml
# cluster-a service - receives 80% of traffic
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/affinity: "local"
    # Weight relative to total capacity
spec:
  selector:
    app: api
  ports:
    - port: 8080
      targetPort: 8080
```

```yaml
# cluster-b service - receives 20% of traffic (fewer replicas)
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/affinity: "none"  # Accept remote traffic
spec:
  selector:
    app: api
  ports:
    - port: 8080
      targetPort: 8080
```

### Cluster-Local Services (Disable Global Sharing)

Sometimes you want a service visible to remote clusters but not actively sharing its endpoints (e.g., a database primary that should not receive cross-cluster writes):

```yaml
annotations:
  service.cilium.io/global: "true"
  service.cilium.io/shared: "false"  # Visible but not shared
```

## Network Policies Across Clusters

Cluster Mesh respects Cilium NetworkPolicy with cluster-aware identity selectors. Security policies are enforced at both ends of the connection.

### Allow Cross-Cluster Traffic from Specific Cluster

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-cluster-b-api
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: database
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: api
            # Cilium adds cluster identity labels automatically
            # io.cilium.k8s.policy.cluster: cluster-b
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
```

### Cross-Cluster mTLS with Cilium Identity

Cilium automatically assigns security identities to all endpoints. Cross-cluster traffic carries these identities and the receiving cluster's Cilium agent enforces policy based on them. No additional certificate management is required for mTLS between services.

```yaml
apiVersion: cilium.io/v2
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: deny-cross-cluster-by-default
spec:
  endpointSelector: {}
  ingress:
    - fromEntities:
        - cluster  # Only allow same-cluster by default
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-frontend-from-any-cluster
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: frontend
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: ingress-controller
      toPorts:
        - ports:
            - port: "80"
              protocol: TCP
```

## Cluster Mesh Failover Scenarios

### Automatic Failover on Pod Failure

When all pods in the local cluster fail their readiness probes, Cilium automatically shifts traffic to remote clusters. No application changes or DNS TTL delays are involved.

```bash
# Simulate local cluster failure
kubectl scale deployment api --replicas=0 --context cluster-a

# Traffic automatically routes to cluster-b
# Verify with Hubble
hubble observe --follow --namespace production --type l7
```

### Service Health Monitoring

Cilium uses Kubernetes readiness probes to determine endpoint health. Configure meaningful probes:

```yaml
readinessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
  successThreshold: 1
livenessProbe:
  httpGet:
    path: /livez
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 15
  failureThreshold: 5
```

### Testing Failover

```bash
# Terminal 1: Watch traffic distribution
watch -n 1 "hubble observe --namespace production --last 50 --output json | \
  jq -r '.flow.source.pod_name' | sort | uniq -c"

# Terminal 2: Kill local pods
kubectl scale deployment api --replicas=0 --context cluster-a

# Observe traffic shifting to cluster-b in Terminal 1
# Restore
kubectl scale deployment api --replicas=3 --context cluster-a
```

## Hubble Multi-Cluster Observability

Hubble provides flow-level visibility across the cluster mesh. The Hubble Relay aggregates flows from all clusters.

### Deploy Multi-Cluster Hubble Relay

```bash
# On the management cluster
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,icmp,http}"
```

### Querying Cross-Cluster Flows

```bash
# Install hubble CLI
curl -L --fail --remote-name-all \
  https://github.com/cilium/hubble/releases/download/v0.13.0/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz
mv hubble /usr/local/bin/

# Port-forward relay
kubectl port-forward -n kube-system svc/hubble-relay 4245:80

# Observe all flows including cross-cluster
hubble observe --all-namespaces --follow

# Filter cross-cluster drops
hubble observe --verdict DROPPED --follow

# Service map
hubble observe --namespace production --type l7 --output json | \
  jq -r '[.flow.source.pod_name, .flow.destination.pod_name, .flow.l7.http.url] | @csv'
```

## Production Configuration: High Availability

### clustermesh-apiserver HA

The clustermesh-apiserver should run with multiple replicas and persistent storage for its etcd:

```yaml
# values-clustermesh-ha.yaml
clustermesh:
  useAPIServer: true
  apiserver:
    replicas: 3
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
    etcd:
      resources:
        requests:
          cpu: 100m
          memory: 256Mi
        limits:
          cpu: 500m
          memory: 512Mi
    service:
      type: LoadBalancer
      annotations:
        # AWS NLB for stable cross-cluster connectivity
        service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
        service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
```

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  -f values-clustermesh-ha.yaml
```

### Certificate Rotation

Cilium Cluster Mesh certificates have a 10-year validity by default. For compliance-sensitive environments, configure shorter TTLs:

```bash
# Rotate clustermesh certificates
cilium clustermesh disconnect --context cluster-a --destination-context cluster-b

# Regenerate CA and certificates
cilium clustermesh enable --context cluster-a --create-ca --force-regenerate
cilium clustermesh enable --context cluster-b --create-ca --force-regenerate

# Reconnect
cilium clustermesh connect --context cluster-a --destination-context cluster-b
```

## DNS and Service Name Resolution

Pods in Cluster A can reach services in Cluster B using the standard `<service>.<namespace>.svc.cluster.local` name because Cilium merges endpoints at the eBPF level. The service ClusterIP in Cluster A resolves to local endpoints which then transparently include remote endpoints.

For services that exist only in a remote cluster, use ExternalName services as a bridge:

```yaml
# In cluster-a: proxy requests to cluster-b-only service
apiVersion: v1
kind: Service
metadata:
  name: analytics-service
  namespace: production
spec:
  type: ExternalName
  externalName: analytics-service.production.svc.cluster-b.local
```

Alternatively, configure CoreDNS stub zones:

```yaml
# CoreDNS ConfigMap patch for cluster-b stub zone
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
          pods insecure
          fallthrough in-addr.arpa ip6.arpa
        }
        # Stub zone for cluster-b services
        forward cluster-b.local <CLUSTER_B_DNS_SERVICE_IP>
        prometheus :9153
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
```

## Monitoring Cluster Mesh Health

### Prometheus Metrics

Cilium exports cluster mesh metrics that should be included in alerting rules:

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cilium-clustermesh
  namespace: monitoring
spec:
  groups:
    - name: cilium.clustermesh
      interval: 30s
      rules:
        - alert: ClusterMeshConnectionDown
          expr: |
            cilium_clustermesh_remote_clusters{state="ready"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Cluster Mesh connection lost"
            description: "No remote clusters are in ready state on {{ $labels.pod }}"

        - alert: ClusterMeshEndpointSyncLag
          expr: |
            rate(cilium_clustermesh_remote_cluster_last_failure_ts[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cluster Mesh endpoint sync failing"
            description: "Remote cluster {{ $labels.cluster_name }} sync is failing"

        - alert: CiliumDropsIncreasing
          expr: |
            rate(cilium_drop_count_total[5m]) > 10
          for: 3m
          labels:
            severity: warning
          annotations:
            summary: "Cilium drop rate elevated"
            description: "Drop rate on {{ $labels.pod }} is {{ $value | humanize }} drops/sec"
```

### Grafana Dashboard Queries

Key PromQL queries for cluster mesh dashboards:

```promql
# Cross-cluster traffic rate (bytes/sec)
rate(cilium_forward_bytes_total{direction="egress"}[5m])

# Endpoint sync status per remote cluster
cilium_clustermesh_remote_clusters by (cluster_name, state)

# Policy verdict distribution
sum by (verdict) (rate(cilium_policy_verdict_total[5m]))

# Service load distribution across clusters
sum by (cluster) (cilium_services_events_total{action="add"})
```

## Troubleshooting

### Connection Issues

```bash
# Check clustermesh-apiserver is reachable from peers
cilium clustermesh status --wait --context cluster-a

# Verify etcd connectivity
kubectl exec -n kube-system -it clustermesh-apiserver-xxx -- \
  etcdctl --endpoints=localhost:2379 endpoint health

# Check TLS certificate validity
kubectl get secret cilium-clustermesh -n kube-system -o jsonpath='{.data.ca\.crt}' | \
  base64 -d | openssl x509 -noout -dates

# Inspect Cilium agent logs for mesh errors
kubectl logs -n kube-system -l k8s-app=cilium --since=5m | \
  grep -i "clustermesh\|remote cluster"
```

### Endpoint Not Visible in Remote Cluster

```bash
# On the source cluster - verify endpoint is exported
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium kvstore get --recursive cilium/state/services/v1/

# On the destination cluster - verify import
kubectl exec -n kube-system cilium-yyyyy -- \
  cilium kvstore get --recursive cilium/state/services/v1/

# Force Cilium agent to re-sync
kubectl rollout restart daemonset/cilium -n kube-system
```

### Policy Drops Across Clusters

```bash
# Use Hubble to identify drops
hubble observe --verdict DROPPED --namespace production --follow

# Decode the drop reason
hubble observe --verdict DROPPED --output json | \
  jq -r '.flow | [.source.pod_name, .destination.pod_name, .drop_reason_desc] | @tsv'

# Check policy verdicts in Cilium
kubectl exec -n kube-system cilium-xxxxx -- \
  cilium policy trace \
    --src-k8s-pod production/frontend-xxx \
    --dst-k8s-pod production/backend-yyy \
    --dport 8080 \
    --verbose
```

## Advanced: External Workloads in Cluster Mesh

Cluster Mesh can include non-Kubernetes workloads (VMs, bare metal) as first-class citizens. External workloads register with the mesh and participate in service discovery and network policy.

```bash
# Generate external workload join token
cilium clustermesh vm create \
  --name legacy-app-01 \
  --namespace external-workloads \
  --labels app=legacy-app,env=production

# On the external VM, install Cilium agent in external workload mode
CILIUM_TOKEN=<generated-token>
curl -sfL https://raw.githubusercontent.com/cilium/cilium/main/contrib/k8s/external-workloads/install.sh | \
  CILIUM_TOKEN=$CILIUM_TOKEN bash
```

```yaml
# Register external workload in Kubernetes
apiVersion: cilium.io/v2alpha1
kind: CiliumExternalWorkload
metadata:
  name: legacy-app-01
  namespace: external-workloads
spec:
  ipv4AllocCIDR: "192.168.100.0/30"
```

## Upgrade Considerations

When upgrading Cilium across a cluster mesh, follow a rolling approach:

1. Upgrade one cluster at a time
2. Verify mesh connectivity after each cluster upgrade
3. Keep Cilium versions within one minor version of each other during rolling upgrades
4. Test global service failover before upgrading the secondary cluster

```bash
# Pre-upgrade health check
cilium clustermesh status --wait
cilium connectivity test --multi-node

# Upgrade cluster-a first
helm upgrade cilium cilium/cilium \
  --version 1.17.0 \
  --namespace kube-system \
  --reuse-values

# Verify mesh health
cilium clustermesh status --wait --context cluster-a
cilium connectivity test --multi-node --context cluster-a

# Proceed to cluster-b
helm upgrade cilium cilium/cilium \
  --version 1.17.0 \
  --namespace kube-system \
  --reuse-values \
  --kube-context cluster-b
```

## Summary

Cilium Cluster Mesh delivers transparent multi-cluster service discovery with production-grade features: eBPF-accelerated data plane, automatic failover, encrypted cross-cluster traffic, and unified network policy enforcement. The key operational decisions are:

- Choose LoadBalancer service type for clustermesh-apiserver in cloud environments for stable endpoints
- Use WireGuard encryption for cross-cluster traffic on untrusted networks
- Design global services with explicit affinity annotations to control traffic distribution
- Monitor `cilium_clustermesh_remote_clusters` and drop counters with alerting
- Plan certificate rotation and upgrade procedures before production deployment

The combination of transparent service discovery with eBPF-level performance makes Cluster Mesh a compelling alternative to application-level cross-cluster routing patterns for organizations standardized on Cilium.
