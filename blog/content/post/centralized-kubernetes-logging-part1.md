---
title: "Building a Centralized Multi-Tenant Kubernetes Logging Architecture: Part 1"
date: 2025-11-04T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Logging", "FluentBit", "FluentD", "OpenSearch", "Multi-tenancy", "Observability"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing a scalable, multi-tenant logging architecture for Kubernetes clusters using FluentBit, FluentD, and OpenSearch"
more_link: "yes"
url: "/centralized-kubernetes-logging-part1/"
---

Managing logs across multiple Kubernetes clusters presents a significant operational challenge, especially in multi-tenant environments where data isolation is critical. In this three-part series, I'll share a battle-tested architecture for implementing centralized, multi-tenant logging using FluentBit, FluentD, and OpenSearch. This first installment covers the foundational architecture and implementation details to get your logging pipeline established.

<!--more-->

## The Multi-Tenant Kubernetes Logging Challenge

Consider this common scenario: You're managing 15+ Kubernetes clusters (tenants) running microservices that generate terabytes of logs. Developers need access to their specific application logs without seeing other teams' data, and operations needs visibility across everything. How do you build a logging solution that is:

1. **Scalable** - Works across many clusters with minimal overhead
2. **Secure** - Maintains strict tenant isolation
3. **Efficient** - Minimizes resource consumption
4. **Maintainable** - Centralizes management and configuration

After experimenting with various architectures, I've found that a forwarder/aggregator pattern provides the best balance of these requirements.

## Architecture Overview: The Forwarder/Aggregator Pattern

The solution I've implemented consists of three main components:

1. **FluentBit** - Lightweight log forwarders deployed on each tenant cluster
2. **FluentD** - A centralized aggregator for processing, filtering, and routing logs
3. **OpenSearch** - The storage and visualization layer (an open-source alternative to Elasticsearch)

Here's a high-level view of the architecture:

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│                     │  │                     │  │                     │
│  Tenant Cluster 1   │  │  Tenant Cluster 2   │  │  Tenant Cluster 3   │
│  ┌─────────────┐   │  │  ┌─────────────┐   │  │  ┌─────────────┐   │
│  │  FluentBit  │───┼──┼─▶│  FluentBit  │───┼──┼─▶│  FluentBit  │───┼──┐
│  └─────────────┘   │  │  └─────────────┘   │  │  └─────────────┘   │  │
│                     │  │                     │  │                     │  │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘  │
                                                                          │
                                                                          ▼
                          ┌───────────────────────────────────────────────┐
                          │                                               │
                          │             Central Logging Cluster          │
                          │                                               │
                          │  ┌─────────────┐       ┌─────────────────┐   │
                          │  │             │       │                 │   │
                          │  │   FluentD   │──────▶│   OpenSearch   │   │
                          │  │             │       │                 │   │
                          │  └─────────────┘       └─────────────────┘   │
                          │                                               │
                          └───────────────────────────────────────────────┘
```

This architecture offers several advantages:

- **Lightweight footprint** on tenant clusters (FluentBit has minimal resource requirements)
- **Centralized configuration management** in FluentD
- **Scalable aggregation** that can handle logs from dozens of clusters
- **Separate concerns** between log collection, processing, and storage

## Implementation: Setting Up the Components

Let's walk through the implementation, starting with the tenant clusters and moving to the central logging cluster.

### 1. FluentBit Setup on Tenant Clusters

FluentBit runs as a DaemonSet on each tenant cluster, capturing logs and forwarding them to the central FluentD service.

Here's a configuration that captures application logs from a specific namespace:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
  namespace: logging
  labels:
    k8s-app: fluent-bit
data:
  # Configuration files: server, input, filters and output
  fluent-bit.conf: |
    [SERVICE]
        Flush         1
        Log_Level     info
        Daemon        off
        Parsers_File  parsers.conf
        HTTP_Server   On
        HTTP_Listen   0.0.0.0
        HTTP_Port     2020

    @INCLUDE input-kubernetes.conf
    @INCLUDE filter-kubernetes.conf
    @INCLUDE output-forward.conf    

  input-kubernetes.conf: |
    [INPUT]
        Name              tail
        Tag               kube.*
        Path              /var/log/containers/*_tenant-namespace_*.log
        Parser            cri
        DB                /var/log/flb_kube-tenant.db
        Mem_Buf_Limit     60MB
        Skip_Long_Lines   On
        Refresh_Interval  10    

  filter-kubernetes.conf: |
    [FILTER]
        Name                kubernetes
        Match               kube.*
        Kube_URL            https://kubernetes.default.svc:443
        Kube_CA_File        /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        Kube_Token_File     /var/run/secrets/kubernetes.io/serviceaccount/token
        Kube_Tag_Prefix     kube.var.log.containers.
        Merge_Log           On
        Keep_Log            Off
        K8S-Logging.Parser  On
        K8S-Logging.Exclude Off    

  output-forward.conf: |
    [OUTPUT]
        Name forward
        Match *
        Host central-logging.example.com
        Port 24224
        tls on
        tls.verify on
        tls.ca_file /fluent-bit/ssl/ca.crt
        tls.crt_file /fluent-bit/ssl/tls.crt
        tls.key_file /fluent-bit/ssl/tls.key
        Shared_Key my_shared_key
        
  parsers.conf: |
    [PARSER]
        Name        cri
        Format      regex
        Regex       ^(?<time>[^ ]+) (?<stream>stdout|stderr) (?<logtag>[^ ]*) (?<log>.*)$
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%L%z
```

This configuration:

1. **Tails container logs** from specific namespaces
2. **Enriches logs** with Kubernetes metadata
3. **Forwards logs** securely to the central FluentD service with TLS encryption

The DaemonSet configuration is standard, with a few important details:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
spec:
  selector:
    matchLabels:
      k8s-app: fluent-bit
  template:
    metadata:
      labels:
        k8s-app: fluent-bit
    spec:
      serviceAccountName: fluent-bit
      containers:
      - name: fluent-bit
        image: fluent/fluent-bit:1.9.3
        volumeMounts:
        - name: varlog
          mountPath: /var/log
        - name: varlibdockercontainers
          mountPath: /var/lib/docker/containers
          readOnly: true
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc/
        - name: fluent-bit-ssl
          mountPath: /fluent-bit/ssl/
        resources:
          limits:
            memory: 500Mi
          requests:
            cpu: 100m
            memory: 200Mi
      volumes:
      - name: varlog
        hostPath:
          path: /var/log
      - name: varlibdockercontainers
        hostPath:
          path: /var/lib/docker/containers
      - name: fluent-bit-config
        configMap:
          name: fluent-bit-config
      - name: fluent-bit-ssl
        secret:
          secretName: fluent-bit-tls
```

### 2. Setting Up the Central Logging Cluster

The central logging cluster hosts both FluentD for log aggregation and OpenSearch for storage and visualization. Let's set these up one by one.

#### Configuring the Ingress for FluentD

First, we need to expose FluentD to receive logs from tenant clusters. I use Nginx Ingress Controller configured to handle TCP traffic:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tcp-services
  namespace: ingress-nginx
data:
  24224: "logging/fluentd:24224"
```

Update the Nginx Ingress controller deployment to use this config:

```yaml
spec:
  template:
    spec:
      containers:
      - name: controller
        args:
        - /nginx-ingress-controller
        - --tcp-services-configmap=$(POD_NAMESPACE)/tcp-services
        # ... other args
```

And update the service to expose the port:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  ports:
  - name: proxied-tcp-24224
    port: 24224
    protocol: TCP
    targetPort: 24224
  # ... other ports
```

#### Implementing FluentD for Log Aggregation

FluentD needs special handling for OpenSearch compatibility. I use a custom Docker image:

```dockerfile
FROM fluent/fluentd:v1.14-debian-1

USER root

# Install plugins
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential ruby-dev && \
    gem install elasticsearch-api -v 7.13.3 && \
    gem install elasticsearch-transport -v 7.13.3 && \
    gem install elasticsearch -v 7.13.3 && \
    gem install fluent-plugin-elasticsearch -v 5.1.0 && \
    apt-get purge -y --auto-remove build-essential ruby-dev && \
    rm -rf /var/lib/apt/lists/*

# Create buffer directory
RUN mkdir -p /var/log/fluentd-buffers/ && \
    chown -R fluent /var/log/fluentd-buffers/

USER fluent
```

Now, let's configure FluentD to process logs and identify tenant sources:

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: fluentd-config
  namespace: logging
data:
  fluent.conf: |-
    # Accept logs from FluentBit forwarders
    <source>
      @type forward
      port 24224
      bind 0.0.0.0
      
      # Enable TLS
      <transport tls>
        cert_path /fluentd/ssl/tls.crt
        private_key_path /fluentd/ssl/tls.key
        ca_path /fluentd/ssl/ca.crt
      </transport>
      
      <security>
        shared_key my_shared_key
        self_hostname "#{ENV['HOSTNAME']}"
      </security>
    </source>

    # Clean up unneeded Kubernetes metadata
    <filter kube.**>
      @type record_transformer
      remove_keys $.kubernetes.annotations, $.kubernetes.labels, $.kubernetes.pod_id, $.kubernetes.docker_id, logtag
    </filter>

    # Add tenant identification
    <filter kube.tenant-1.**>
      @type record_transformer
      <record>
        tenant_id "tenant-1"
      </record>
    </filter>

    <filter kube.tenant-2.**>
      @type record_transformer
      <record>
        tenant_id "tenant-2"
      </record>
    </filter>

    # Include additional configuration files
    @include /fluentd/etc/prometheus.conf
    @include /fluentd/etc/tenant-outputs.conf
```

And the tenant-specific output configuration:

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: fluentd-tenant-outputs
  namespace: logging
data:
  tenant-outputs.conf: |-
    # Output configuration for tenant 1
    <match kube.tenant-1.**>
      @type elasticsearch
      @id out_es_tenant1
      @log_level info
      include_tag_key true
      host "#{ENV['OPENSEARCH_HOST']}"
      port "#{ENV['OPENSEARCH_PORT']}"
      user "#{ENV['OPENSEARCH_USER']}"
      password "#{ENV['OPENSEARCH_PASSWORD']}"
      scheme https
      ssl_verify false
      logstash_prefix tenant1-logs
      logstash_dateformat %Y.%m.%d
      logstash_format true
      type_name _doc
      suppress_type_name true
      
      <buffer>
        @type file
        path /var/log/fluentd-buffers/tenant-1/kubernetes.buffer
        flush_thread_count 2
        flush_interval 5s
        chunk_limit_size 8M
        queue_limit_length 512
        retry_forever true
        retry_max_interval 30
      </buffer>
    </match>

    # Output configuration for tenant 2
    <match kube.tenant-2.**>
      @type elasticsearch
      @id out_es_tenant2
      @log_level info
      include_tag_key true
      host "#{ENV['OPENSEARCH_HOST']}"
      port "#{ENV['OPENSEARCH_PORT']}"
      user "#{ENV['OPENSEARCH_USER']}"
      password "#{ENV['OPENSEARCH_PASSWORD']}"
      scheme https
      ssl_verify false
      logstash_prefix tenant2-logs
      logstash_dateformat %Y.%m.%d
      logstash_format true
      type_name _doc
      suppress_type_name true
      
      <buffer>
        @type file
        path /var/log/fluentd-buffers/tenant-2/kubernetes.buffer
        flush_thread_count 2
        flush_interval 5s
        chunk_limit_size 8M
        queue_limit_length 512
        retry_forever true
        retry_max_interval 30
      </buffer>
    </match>
```

Deploy FluentD with appropriate resource limits and security context:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fluentd
  namespace: logging
spec:
  replicas: 2
  selector:
    matchLabels:
      app: fluentd
  template:
    metadata:
      labels:
        app: fluentd
    spec:
      serviceAccountName: fluentd
      containers:
      - name: fluentd
        image: my-registry/custom-fluentd:v1.14
        ports:
        - containerPort: 24224
          name: forward
          protocol: TCP
        - containerPort: 24231
          name: metrics
          protocol: TCP
        env:
        - name: OPENSEARCH_HOST
          value: opensearch-cluster-master
        - name: OPENSEARCH_PORT
          value: "9200"
        - name: OPENSEARCH_USER
          valueFrom:
            secretKeyRef:
              name: opensearch-credentials
              key: username
        - name: OPENSEARCH_PASSWORD
          valueFrom:
            secretKeyRef:
              name: opensearch-credentials
              key: password
        volumeMounts:
        - name: fluentd-config
          mountPath: /fluentd/etc/fluent.conf
          subPath: fluent.conf
        - name: fluentd-tenant-outputs
          mountPath: /fluentd/etc/tenant-outputs.conf
          subPath: tenant-outputs.conf
        - name: fluentd-prometheus
          mountPath: /fluentd/etc/prometheus.conf
          subPath: prometheus.conf
        - name: fluentd-buffer
          mountPath: /var/log/fluentd-buffers
        - name: fluentd-ssl
          mountPath: /fluentd/ssl
        resources:
          limits:
            cpu: 1000m
            memory: 1Gi
          requests:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: fluentd-config
        configMap:
          name: fluentd-config
      - name: fluentd-tenant-outputs
        configMap:
          name: fluentd-tenant-outputs
      - name: fluentd-prometheus
        configMap:
          name: fluentd-prometheus
      - name: fluentd-buffer
        persistentVolumeClaim:
          claimName: fluentd-buffer-pvc
      - name: fluentd-ssl
        secret:
          secretName: fluentd-tls
```

#### Setting up OpenSearch

For OpenSearch, I recommend using the official Helm chart with some customizations. Here's a sample `values.yaml`:

```yaml
# OpenSearch values.yaml
clusterName: "logging-cluster"
nodeGroup: "master"

# Master nodes - 3 for production
masterService: "opensearch-cluster-master"
replicas: 3

# Resource allocation
resources:
  requests:
    cpu: "1"
    memory: "2Gi"
  limits:
    cpu: "2"
    memory: "4Gi"

# Storage configuration
persistence:
  enabled: true
  storageClass: "standard"
  accessModes:
    - ReadWriteOnce
  size: 100Gi

# OpenSearch configuration
opensearchJavaOpts: "-Xmx2g -Xms2g"
config:
  opensearch.yml:
    cluster.name: logging-cluster
    node.name: "${HOSTNAME}"
    network.host: 0.0.0.0
    discovery.seed_hosts: "opensearch-cluster-master"
    cluster.initial_master_nodes: "opensearch-cluster-master-0,opensearch-cluster-master-1,opensearch-cluster-master-2"

    # Security settings
    plugins.security.ssl.transport.pemcert_filepath: "/usr/share/opensearch/config/node.crt"
    plugins.security.ssl.transport.pemkey_filepath: "/usr/share/opensearch/config/node.key"
    plugins.security.ssl.transport.pemtrustedcas_filepath: "/usr/share/opensearch/config/ca.crt"
    plugins.security.ssl.http.enabled: true
    plugins.security.ssl.http.pemcert_filepath: "/usr/share/opensearch/config/node.crt"
    plugins.security.ssl.http.pemkey_filepath: "/usr/share/opensearch/config/node.key"
    plugins.security.ssl.http.pemtrustedcas_filepath: "/usr/share/opensearch/config/ca.crt"
    plugins.security.allow_default_init_securityindex: true
    plugins.security.authcz.admin_dn:
      - "CN=opensearch-admin,OU=OpenSearch,O=Organization,L=Location,C=US"
    plugins.security.nodes_dn:
      - "CN=opensearch-node,OU=OpenSearch,O=Organization,L=Location,C=US"
    plugins.security.audit.type: internal_opensearch
    plugins.security.restapi.roles_enabled: ["all_access", "security_rest_api_access"]

# OpenSearch Dashboards
dashboards:
  enabled: true
  replicas: 1
  service:
    type: ClusterIP
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "1"
      memory: "2Gi"
```

Install OpenSearch with:

```bash
helm repo add opensearch https://opensearch-project.github.io/helm-charts/
helm install opensearch opensearch/opensearch -f values.yaml -n logging
```

## Testing the Setup

Once all components are deployed, you can validate your setup:

1. **Check FluentBit logs** on tenant clusters to ensure they're forwarding to FluentD:
   ```bash
   kubectl logs -n logging -l k8s-app=fluent-bit --tail=100
   ```

2. **Verify FluentD is receiving and processing logs**:
   ```bash
   kubectl logs -n logging -l app=fluentd --tail=100
   ```

3. **Confirm logs are reaching OpenSearch** by checking index creation:
   ```bash
   curl -u admin:admin -k "https://opensearch-cluster-master:9200/_cat/indices?v"
   ```

4. **Access OpenSearch Dashboards** to view logs and create visualizations:
   ```bash
   kubectl port-forward svc/opensearch-dashboards 5601:5601 -n logging
   ```

## Next Steps

In this first part, we've established the foundation of our multi-tenant logging architecture:

1. **FluentBit** on tenant clusters to forward logs
2. **FluentD** in the central cluster to process and route logs
3. **OpenSearch** for storage and visualization

In [Part 2](/centralized-kubernetes-logging-part2/), we'll explore how to implement true multi-tenancy in OpenSearch using a shared index pattern with document-level security. This approach will improve efficiency while maintaining strict tenant isolation.

We'll also cover:

- Efficient index management and lifecycle policies
- Implementing role-based access control
- Optimizing OpenSearch for multi-tenant workloads

Stay tuned for the next installment!

## Troubleshooting Common Issues

Before wrapping up, let's address some common issues you might encounter:

### FluentBit Not Forwarding Logs

- Check network connectivity to the FluentD service
- Verify TLS certificates are correctly mounted
- Ensure the shared key matches between FluentBit and FluentD

### FluentD Buffer Issues

- Increase `chunk_limit_size` for larger log volumes
- Add more buffer threads with `flush_thread_count`
- Use a faster storage class for the buffer PVC

### OpenSearch Cluster Not Starting

- Check JVM heap settings (should be 50% of container memory)
- Verify the discovery configuration is correct
- Ensure certificates are properly mounted

By implementing this architecture, you'll have a solid foundation for centralized logging that can scale with your Kubernetes environment while maintaining tenant isolation. In the next part, we'll build on this foundation to implement more advanced multi-tenancy features.