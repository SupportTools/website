---
title: "Building Multi-Tenant Observability with Prometheus Agent"
date: 2027-03-04T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Observability", "Multi-tenancy", "Monitoring"]
categories:
- Kubernetes
- Observability
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to implement a scalable, multi-tenant metrics solution using Prometheus Agent mode for efficient metric collection across multiple Kubernetes clusters"
more_link: "yes"
url: "/multi-tenant-metrics-prometheus-agent/"
---

As organizations scale their Kubernetes footprint across multiple clusters and teams, the challenge of providing centralized observability while maintaining tenant isolation becomes increasingly complex. Prometheus Agent offers a lightweight solution for metric collection that can help solve this problem.

<!--more-->

# [Introduction: The Multi-Cluster Monitoring Challenge](#introduction)

If you're managing multiple Kubernetes clusters for different teams, projects, or environments, you're likely familiar with the challenge of providing consistent monitoring capabilities. Each cluster needs metrics collection for basic resource usage (CPU, memory, etc.), application-specific metrics, and potentially custom metrics to enable autoscaling and alerting.

The standard approach would be to deploy a full Prometheus stack in each cluster, often using solutions like kube-prometheus or the Prometheus Operator. However, this approach comes with significant drawbacks:

1. **Resource overhead**: Each Prometheus instance consumes cluster resources (CPU, memory, storage)
2. **Operational complexity**: Managing dozens or hundreds of Prometheus deployments becomes unwieldy
3. **Fragmented visibility**: No centralized view across all clusters
4. **Storage limitations**: Edge or small clusters may not have sufficient resources for long-term storage

## [Available Approaches for Centralized Metrics](#available-approaches)

Before diving into our solution, let's review the three main approaches for centralizing Prometheus metrics:

### 1. Federation

Prometheus Federation allows a central Prometheus server to scrape selected metrics from other Prometheus servers:

```yaml
scrape_configs:
  - job_name: 'federated-prometheus'
    scrape_interval: 30s
    honor_labels: true
    metrics_path: '/federate'
    params:
      'match[]': 
        - '{job="kubernetes-pods"}'
    static_configs:
      - targets:
        - 'prometheus-cluster1:9090'
        - 'prometheus-cluster2:9090'
```

**Pros:**
- Simple to set up
- No additional components required
- Selective metric collection

**Cons:**
- Requires network connectivity from central instance to federated instances
- Creates additional load on federated Prometheus servers
- Can miss data during scrape intervals
- Security concerns with exposing Prometheus endpoints

### 2. Remote Read

With Remote Read, a central Thanos instance can query data from distributed Prometheus servers:

```yaml
remote_read:
  - url: "http://thanos-sidecar-cluster1:19090/api/v1/read"
    read_recent: true
  - url: "http://thanos-sidecar-cluster2:19090/api/v1/read"
    read_recent: true
```

**Pros:**
- Good for ad-hoc querying across clusters
- No data duplication
- Lower storage requirements on central instance

**Cons:**
- Network bandwidth intensive for large queries
- Requires all source Prometheus instances to be available
- Query performance degrades with more sources

### 3. Remote Write

Remote Write enables Prometheus to forward metrics to a central endpoint:

```yaml
remote_write:
  - url: "http://central-prometheus/api/v1/write"
    write_relabel_configs:
      - source_labels: [__name__]
        regex: 'job:.*'
        action: keep
```

**Pros:**
- Push-based, works with network restrictions
- Reliable data transfer, even with network interruptions
- Reduced query load on source clusters
- Near real-time central visibility

**Cons:**
- Data duplication
- Increased storage requirements on central instance
- Requires scaling central storage as clusters grow

For our multi-tenant metrics solution, **Remote Write** is the most suitable approach, especially when combined with the lightweight Prometheus Agent mode.

# [Prometheus Agent Mode: A Game Changer](#prometheus-agent)

Introduced in Prometheus 2.32, Agent mode is a significant enhancement for distributed metric collection. When operating in Agent mode, Prometheus runs without:

- Query functionality (no API for querying metrics)
- Alert evaluation
- Local persistent storage (except for the Write-Ahead Log)

This results in a lightweight process focused solely on scraping and forwarding metrics.

## [Key Benefits of Prometheus Agent](#agent-benefits)

1. **Resource efficiency**: Up to 80% less memory usage compared to full Prometheus
2. **Horizontal scalability**: Multiple agents can scrape different targets in the same cluster
3. **Reduced operational overhead**: No need to manage local storage or retention policies
4. **Reliability**: Write-Ahead Log (WAL) ensures metrics are cached during network outages
5. **Compatibility**: Works with existing ServiceMonitor and PodMonitor resources

# [Implementing Prometheus Agent](#implementing-agent)

Let's walk through the implementation of a multi-tenant metrics solution using Prometheus Agent.

## [Deploying Prometheus Agent in Tenant Clusters](#deploying-agent)

First, we'll configure Prometheus in Agent mode on each tenant cluster. We'll use the Prometheus Operator to simplify deployment:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus-agent
  namespace: monitoring
  labels:
    app.kubernetes.io/name: prometheus-agent
spec:
  image: quay.io/prometheus/prometheus:v2.42.0
  replicas: 1
  serviceAccountName: prometheus
  containers:    
  - name: prometheus
    args:
    - '--config.file=/etc/prometheus/config_out/prometheus.env.yaml'
    - '--storage.agent.path=/prometheus'
    - '--enable-feature=agent'  # Enable Agent mode
    - '--web.enable-lifecycle'
  podMetadata:
    labels:
      app.kubernetes.io/name: prometheus-agent
  resources:
    requests:
      cpu: 200m
      memory: 400Mi
    limits:
      cpu: 500m
      memory: 800Mi
  retention: 1h  # Minimal retention, just for WAL buffer
  serviceMonitorSelector: {}
  serviceMonitorNamespaceSelector: {}
  podMonitorSelector: {}
  podMonitorNamespaceSelector: {}
  remoteWrite:
  - url: "https://central-prometheus.example.com/api/v1/write"
    headers:
      X-Scope-OrgID: "tenant-a"  # Useful for Cortex/Mimir multi-tenancy
    writeRelabelConfigs:
      # Drop high-cardinality metrics to reduce storage requirements
      - sourceLabels: [__name__]
        regex: 'container_network_tcp_usage_total|go_.*'
        action: drop
  externalLabels:
    cluster: "cluster-1"
    tenant: "tenant-a"
    environment: "production"
```

Notice these key configurations:

1. The `--enable-feature=agent` flag activates Agent mode
2. `externalLabels` adds tenant and cluster identifiers to all metrics
3. `remoteWrite` configures the central Prometheus endpoint
4. `writeRelabelConfigs` allows filtering metrics before sending them
5. Minimal resource requests compared to full Prometheus

## [Setting Up the Central Prometheus](#central-prometheus)

Now, let's set up the central Prometheus instance that will receive and store metrics from all tenant clusters:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: central-prometheus
  namespace: monitoring
spec:
  image: quay.io/prometheus/prometheus:v2.42.0
  replicas: 2
  retention: 15d
  enableFeatures:
    - 'remote-write-receiver'  # Enable receiving remote write
  serviceAccountName: prometheus
  securityContext:
    fsGroup: 2000
    runAsNonRoot: true
    runAsUser: 1000
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: premium-ssd
        resources:
          requests:
            storage: 500Gi
  resources:
    requests:
      cpu: 1
      memory: 8Gi
    limits:
      cpu: 2
      memory: 16Gi
```

The critical configuration here is `enableFeatures: ['remote-write-receiver']`, which allows this Prometheus instance to accept metrics from remote sources.

## [Exposing the Central Prometheus Endpoint](#exposing-prometheus)

We'll expose the central Prometheus via an Ingress to make it accessible to tenant clusters:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: central-prometheus
  namespace: monitoring
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - central-prometheus.example.com
    secretName: prometheus-tls
  rules:
  - host: central-prometheus.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: central-prometheus
            port:
              name: web
```

For production environments, add appropriate authentication and TLS termination to secure this endpoint.

# [Tenant Isolation: The Multi-Tenancy Challenge](#tenant-isolation)

Once we have metrics flowing from all tenant clusters into our central Prometheus, we face a new challenge: **How do we ensure tenants can only see their own metrics?**

## [Option 1: Dashboard-Level Filtering](#dashboard-filtering)

The simplest approach is to create tenant-specific dashboards with queries that include tenant filters:

```promql
# CPU usage for specific tenant
sum(rate(container_cpu_usage_seconds_total{tenant="tenant-a"}[5m])) by (pod, namespace)
```

To make this more maintainable, use Grafana template variables:

```
Variable Name: tenant
Type: Custom
Values: tenant-a, tenant-b, tenant-c
```

Then reference this variable in all queries:

```promql
sum(rate(container_cpu_usage_seconds_total{tenant="$tenant"}[5m])) by (pod, namespace)
```

**Limitation**: Users can easily modify the variable to see other tenants' data.

## [Option 2: Grafana Organizations](#grafana-organizations)

We can create separate Grafana organizations for each tenant and configure data source permissions:

1. Create a Grafana organization for each tenant
2. Create a Prometheus data source in each organization
3. Pre-configure dashboards with hardcoded tenant filters
4. Assign users to their respective organizations

**Limitation**: High maintenance overhead when managing many tenants.

## [Option 3: Prom Label Proxy](#prom-label-proxy)

A more robust solution is to use [prom-label-proxy](https://github.com/prometheus-community/prom-label-proxy), which enforces label matching at the proxy level:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tenant-a-proxy
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tenant-a-proxy
  template:
    metadata:
      labels:
        app: tenant-a-proxy
    spec:
      containers:
      - name: prom-label-proxy
        image: quay.io/prometheuscommunity/prom-label-proxy:v0.6.0
        args:
        - '--label=tenant'
        - '--value=tenant-a'
        - '--upstream=http://central-prometheus:9090'
        - '--insecure-listen-address=0.0.0.0:8080'
        ports:
        - name: http
          containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: tenant-a-proxy
  namespace: monitoring
spec:
  selector:
    app: tenant-a-proxy
  ports:
  - port: 8080
    targetPort: http
```

This proxy automatically injects the tenant label into every query, ensuring users can only query their own metrics regardless of how they construct their queries.

In Grafana, configure a data source pointing to the tenant-specific proxy:

```
Name: Prometheus Tenant A
URL: http://tenant-a-proxy:8080
```

**Advantages**:
- Strong enforcement of tenant boundaries
- Transparent to end users
- No query modification needed
- Dashboard portability across tenants

# [Advanced Configurations and Extensions](#advanced-config)

## [Optimizing Remote Write](#optimizing-remote-write)

To reduce bandwidth and storage requirements, consider these configurations:

```yaml
remoteWrite:
- url: "https://central-prometheus.example.com/api/v1/write"
  writeRelabelConfigs:
    # Keep only important metrics
    - sourceLabels: [__name__]
      regex: 'node_.*|kube_.*|container_.*'
      action: keep
  queueConfig:
    capacity: 100000
    maxSamplesPerSend: 10000
    batchSendDeadline: 30s
    maxShards: 10
  timeoutConfig:
    connectTimeout: 5s
```

## [High Availability Considerations](#high-availability)

For critical environments, deploy redundant Prometheus Agents:

```yaml
spec:
  replicas: 2
  shards: 2  # Distribute scraping load across instances
```

## [Integration with Thanos](#thanos-integration)

For longer retention or unlimited storage, consider integrating with Thanos Receiver:

```yaml
remoteWrite:
- url: "http://thanos-receive.monitoring:19291/api/v1/receive"
```

Thanos Receive can store metrics in object storage like S3, GCS, or Azure Blob Storage, enabling years of retention without local storage limitations.

# [Performance and Scaling Considerations](#performance)

As you add more tenant clusters, monitor these metrics on your central Prometheus:

1. **Remote write queue metrics**:
   ```
   prometheus_remote_storage_queue_highest_sent_timestamp_seconds - prometheus_remote_storage_queue_oldest_unshipped_sample_timestamp_seconds
   ```

2. **Sample ingestion rate**:
   ```
   rate(prometheus_remote_storage_samples_in_total[5m])
   ```

3. **Memory usage per tenant**:
   ```
   sum by (tenant) (container_memory_working_set_bytes{pod=~"prometheus-central.*"})
   ```

When your central Prometheus reaches resource limits, consider:

1. Implementing a sharded architecture
2. Migrating to a scalable system like Thanos, Cortex, or Mimir
3. Implementing more aggressive metric filtering

# [Conclusion and Next Steps](#conclusion)

Prometheus Agent mode provides an efficient approach for implementing multi-tenant monitoring across multiple Kubernetes clusters. By centralizing metric storage while keeping collection lightweight, we achieve:

- Reduced resource consumption in tenant clusters
- Centralized visibility across all environments
- Simplified management of the monitoring stack
- Better tenant isolation with proxy-based access control

While this solution works well for many use cases, larger deployments may benefit from more scalable systems like:

1. **Thanos**: For unlimited storage with object storage integration
2. **Cortex/Mimir**: For horizontally scalable, multi-tenant Prometheus
3. **Grafana Loki**: For complementary log aggregation using similar patterns

In a future post, we'll explore how to extend this architecture with Thanos to enable unlimited metric retention and improve query performance for large-scale deployments.