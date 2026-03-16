---
title: "DaemonSet Resource Optimization Strategies: Production-Ready Patterns for Node-Level Workloads"
date: 2026-08-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "DaemonSet", "Resource Management", "Performance", "Monitoring", "Node Management"]
categories: ["Kubernetes", "DevOps", "Performance Optimization"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to optimizing Kubernetes DaemonSets for production environments with resource management, scheduling strategies, and performance tuning techniques."
more_link: "yes"
url: "/kubernetes-daemonset-resource-optimization/"
---

DaemonSets ensure that specific pods run on all (or selected) nodes in a Kubernetes cluster, making them ideal for node-level services like logging agents, monitoring exporters, network proxies, and storage daemons. However, poorly configured DaemonSets can significantly impact node performance and cluster stability. This comprehensive guide explores production-ready resource optimization strategies for DaemonSets.

<!--more-->

## Understanding DaemonSet Resource Impact

DaemonSets consume resources on every node, making resource optimization critical for:

- **Cluster Scalability**: Resource-heavy DaemonSets limit available capacity for application workloads
- **Node Stability**: Excessive resource consumption can cause node pressure and evictions
- **Cost Efficiency**: DaemonSet resources scale linearly with cluster size
- **Performance**: Poorly tuned DaemonSets can impact application performance

## Resource Request and Limit Optimization

### Baseline Monitoring DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
  labels:
    app: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9100"
    spec:
      hostNetwork: true
      hostPID: true
      hostIPC: false
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.7.0
        args:
        - --path.procfs=/host/proc
        - --path.sysfs=/host/sys
        - --path.rootfs=/host/root
        - --collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)
        - --no-collector.ipvs
        ports:
        - containerPort: 9100
          protocol: TCP
          name: metrics
        resources:
          requests:
            memory: "50Mi"
            cpu: "50m"
          limits:
            memory: "100Mi"
            cpu: "200m"
        volumeMounts:
        - name: proc
          mountPath: /host/proc
          readOnly: true
        - name: sys
          mountPath: /host/sys
          readOnly: true
        - name: root
          mountPath: /host/root
          mountPropagation: HostToContainer
          readOnly: true
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 65534
      volumes:
      - name: proc
        hostPath:
          path: /proc
      - name: sys
        hostPath:
          path: /sys
      - name: root
        hostPath:
          path: /
      tolerations:
      - effect: NoSchedule
        operator: Exists
      - effect: NoExecute
        operator: Exists
      priorityClassName: system-node-critical
```

### Optimized Logging DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluentd
  namespace: logging
  labels:
    app: fluentd
spec:
  selector:
    matchLabels:
      app: fluentd
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: fluentd
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "24231"
    spec:
      serviceAccountName: fluentd
      containers:
      - name: fluentd
        image: fluent/fluentd-kubernetes-daemonset:v1.16-debian-elasticsearch8-1
        env:
        - name: FLUENT_ELASTICSEARCH_HOST
          value: "elasticsearch.logging.svc.cluster.local"
        - name: FLUENT_ELASTICSEARCH_PORT
          value: "9200"
        - name: FLUENT_ELASTICSEARCH_SCHEME
          value: "http"
        - name: FLUENT_UID
          value: "0"
        # Buffer configuration for memory optimization
        - name: FLUENT_BUFFER_CHUNK_LIMIT_SIZE
          value: "2M"
        - name: FLUENT_BUFFER_QUEUE_LIMIT_LENGTH
          value: "8"
        - name: FLUENT_BUFFER_TOTAL_LIMIT_SIZE
          value: "512M"
        - name: FLUENT_BUFFER_OVERFLOW_ACTION
          value: "drop_oldest_chunk"
        resources:
          requests:
            memory: "200Mi"
            cpu: "100m"
          limits:
            memory: "500Mi"
            cpu: "500m"
        volumeMounts:
        - name: varlog
          mountPath: /var/log
          readOnly: true
        - name: varlibdockercontainers
          mountPath: /var/lib/docker/containers
          readOnly: true
        - name: fluentd-config
          mountPath: /fluentd/etc/fluent.conf
          subPath: fluent.conf
        - name: buffer
          mountPath: /var/log/fluentd-buffers
        livenessProbe:
          httpGet:
            path: /metrics
            port: 24231
          initialDelaySeconds: 30
          periodSeconds: 30
          timeoutSeconds: 5
        readinessProbe:
          httpGet:
            path: /metrics
            port: 24231
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
        securityContext:
          privileged: false
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
            add:
            - DAC_OVERRIDE
            - CHOWN
            - FOWNER
      volumes:
      - name: varlog
        hostPath:
          path: /var/log
      - name: varlibdockercontainers
        hostPath:
          path: /var/lib/docker/containers
      - name: fluentd-config
        configMap:
          name: fluentd-config
      - name: buffer
        emptyDir: {}
      tolerations:
      - key: node-role.kubernetes.io/master
        effect: NoSchedule
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      priorityClassName: system-node-critical
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluentd-config
  namespace: logging
data:
  fluent.conf: |
    <system>
      log_level info
      workers 2
    </system>

    <source>
      @type tail
      @id in_tail_container_logs
      path /var/log/containers/*.log
      pos_file /var/log/fluentd-containers.log.pos
      tag kubernetes.*
      read_from_head true
      <parse>
        @type json
        time_format %Y-%m-%dT%H:%M:%S.%NZ
      </parse>
      # Optimize read performance
      read_lines_limit 1000
      read_bytes_limit_per_second 8388608  # 8MB/s
      skip_refresh_on_startup true
    </source>

    <filter kubernetes.**>
      @type kubernetes_metadata
      @id filter_kube_metadata
      # Optimize API calls
      cache_size 10000
      cache_ttl 3600
      skip_labels true
      skip_container_metadata false
      skip_master_url true
      skip_namespace_metadata false
    </filter>

    <match kubernetes.**>
      @type elasticsearch
      @id out_es
      host "#{ENV['FLUENT_ELASTICSEARCH_HOST']}"
      port "#{ENV['FLUENT_ELASTICSEARCH_PORT']}"
      scheme "#{ENV['FLUENT_ELASTICSEARCH_SCHEME']}"

      # Buffer configuration
      <buffer>
        @type file
        path /var/log/fluentd-buffers/kubernetes.system.buffer
        flush_mode interval
        flush_interval 10s
        flush_at_shutdown true
        retry_type exponential_backoff
        retry_timeout 1h
        retry_max_interval 30s
        chunk_limit_size "#{ENV['FLUENT_BUFFER_CHUNK_LIMIT_SIZE']}"
        queue_limit_length "#{ENV['FLUENT_BUFFER_QUEUE_LIMIT_LENGTH']}"
        total_limit_size "#{ENV['FLUENT_BUFFER_TOTAL_LIMIT_SIZE']}"
        overflow_action "#{ENV['FLUENT_BUFFER_OVERFLOW_ACTION']}"
      </buffer>

      # Performance optimization
      bulk_message_request_threshold 1048576  # 1MB
      compress_json true
    </match>
```

## Node Selection and Affinity

### Selective Node Targeting

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: gpu-device-plugin
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: gpu-device-plugin
  template:
    metadata:
      labels:
        app: gpu-device-plugin
    spec:
      # Only run on nodes with GPUs
      nodeSelector:
        accelerator: nvidia-gpu
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values:
                - p3.2xlarge
                - p3.8xlarge
                - p3.16xlarge
                - p4d.24xlarge
      containers:
      - name: nvidia-device-plugin
        image: nvidia/k8s-device-plugin:v0.14.3
        resources:
          requests:
            memory: "50Mi"
            cpu: "50m"
          limits:
            memory: "100Mi"
            cpu: "100m"
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        volumeMounts:
        - name: device-plugin
          mountPath: /var/lib/kubelet/device-plugins
      volumes:
      - name: device-plugin
        hostPath:
          path: /var/lib/kubelet/device-plugins
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
```

### Zone-Aware DaemonSet Deployment

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: zone-aware-monitor
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: zone-aware-monitor
  template:
    metadata:
      labels:
        app: zone-aware-monitor
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values:
                - us-east-1a
                - us-east-1b
                - us-east-1c
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: node-role.kubernetes.io/worker
                operator: Exists
      containers:
      - name: monitor
        image: monitoring/zone-aware-monitor:v1.0
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: NODE_ZONE
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['topology.kubernetes.io/zone']
        resources:
          requests:
            memory: "100Mi"
            cpu: "100m"
          limits:
            memory: "200Mi"
            cpu: "200m"
```

## Advanced Resource Management

### QoS-Aware DaemonSet Configuration

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: qos-optimized-daemonset
  namespace: system
spec:
  selector:
    matchLabels:
      app: qos-optimized
  template:
    metadata:
      labels:
        app: qos-optimized
    spec:
      # Guaranteed QoS - requests equal limits
      containers:
      - name: critical-service
        image: critical/service:v1.0
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "256Mi"
            cpu: "250m"
      # System-critical priority
      priorityClassName: system-node-critical
      tolerations:
      - effect: NoSchedule
        operator: Exists
      - effect: NoExecute
        operator: Exists
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: burstable-daemonset
  namespace: system
spec:
  selector:
    matchLabels:
      app: burstable-service
  template:
    metadata:
      labels:
        app: burstable-service
    spec:
      # Burstable QoS - limits > requests
      containers:
      - name: monitoring-agent
        image: monitoring/agent:v1.0
        resources:
          requests:
            memory: "100Mi"
            cpu: "50m"
          limits:
            memory: "500Mi"
            cpu: "1000m"
      priorityClassName: system-cluster-critical
```

### CPU Management Policies

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: cpu-pinned-daemonset
  namespace: system
spec:
  selector:
    matchLabels:
      app: cpu-pinned
  template:
    metadata:
      labels:
        app: cpu-pinned
      annotations:
        # Request specific CPU policy
        cpu-manager.kubernetes.io/policy: "static"
    spec:
      containers:
      - name: latency-sensitive-app
        image: latency/sensitive:v1.0
        resources:
          requests:
            memory: "1Gi"
            cpu: "2000m"  # Must be whole number for CPU pinning
          limits:
            memory: "1Gi"
            cpu: "2000m"
        securityContext:
          capabilities:
            add:
            - SYS_NICE
      nodeSelector:
        cpu-manager-policy: static
      priorityClassName: system-node-critical
```

## Memory Optimization Strategies

### Memory-Efficient Caching DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: caching-proxy
  namespace: system
spec:
  selector:
    matchLabels:
      app: caching-proxy
  template:
    metadata:
      labels:
        app: caching-proxy
    spec:
      containers:
      - name: proxy
        image: haproxy:2.8-alpine
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        volumeMounts:
        - name: config
          mountPath: /usr/local/etc/haproxy
        - name: cache
          mountPath: /var/cache/haproxy
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
      # Memory limits for cache volume
      volumes:
      - name: config
        configMap:
          name: haproxy-config
      - name: cache
        emptyDir:
          sizeLimit: 1Gi  # Limit cache size
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: haproxy-config
  namespace: system
data:
  haproxy.cfg: |
    global
      maxconn 2000
      # Memory tuning
      tune.bufsize 16384
      tune.maxrewrite 1024

    defaults
      mode http
      timeout connect 5s
      timeout client 50s
      timeout server 50s

    frontend http_front
      bind *:80
      default_backend http_back

    backend http_back
      balance roundrobin
      # Enable caching
      http-request cache-use cache
      http-response cache-store cache

    cache cache
      total-max-size 512m
      max-object-size 1m
      max-age 300
```

### OOM Prevention Configuration

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: oom-protected
  namespace: system
spec:
  selector:
    matchLabels:
      app: oom-protected
  template:
    metadata:
      labels:
        app: oom-protected
    spec:
      containers:
      - name: app
        image: app/protected:v1.0
        resources:
          requests:
            memory: "500Mi"
            cpu: "200m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        env:
        # Language-specific memory limits
        - name: GOMEMLIMIT
          value: "900MiB"  # Go memory limit (90% of container limit)
        - name: NODE_OPTIONS
          value: "--max-old-space-size=900"  # Node.js heap size in MB
        - name: JAVA_OPTS
          value: "-Xmx900m -Xms500m -XX:MaxMetaspaceSize=128m"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        # OOM score adjustment
        securityContext:
          allowPrivilegeEscalation: false
      # Use guaranteed QoS for critical DaemonSets
      priorityClassName: system-node-critical
```

## Network Optimization

### Network Policy for DaemonSets

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: daemonset-network-policy
  namespace: monitoring
spec:
  podSelector:
    matchLabels:
      app: node-exporter
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: monitoring
    - podSelector:
        matchLabels:
          app: prometheus
    ports:
    - protocol: TCP
      port: 9100
  egress:
  # Allow DNS
  - to:
    - namespaceSelector:
        matchLabels:
          name: kube-system
    ports:
    - protocol: UDP
      port: 53
  # Allow access to Kubernetes API
  - to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          component: apiserver
    ports:
    - protocol: TCP
      port: 6443
```

### Host Network Optimization

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: network-optimized
  namespace: system
spec:
  selector:
    matchLabels:
      app: network-optimized
  template:
    metadata:
      labels:
        app: network-optimized
    spec:
      # Use host network for maximum performance
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
      - name: network-agent
        image: network/agent:v1.0
        ports:
        - containerPort: 9999
          hostPort: 9999
          protocol: TCP
        resources:
          requests:
            memory: "100Mi"
            cpu: "100m"
          limits:
            memory: "200Mi"
            cpu: "500m"
        securityContext:
          capabilities:
            add:
            - NET_ADMIN
            - NET_RAW
          privileged: false
      tolerations:
      - effect: NoSchedule
        operator: Exists
```

## Storage Optimization

### Ephemeral Storage Management

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: storage-optimized
  namespace: system
spec:
  selector:
    matchLabels:
      app: storage-optimized
  template:
    metadata:
      labels:
        app: storage-optimized
    spec:
      containers:
      - name: app
        image: app/storage:v1.0
        resources:
          requests:
            memory: "200Mi"
            cpu: "100m"
            ephemeral-storage: "1Gi"
          limits:
            memory: "500Mi"
            cpu: "500m"
            ephemeral-storage: "5Gi"
        volumeMounts:
        - name: cache
          mountPath: /cache
        - name: tmp
          mountPath: /tmp
        - name: logs
          mountPath: /var/log/app
      volumes:
      - name: cache
        emptyDir:
          sizeLimit: 2Gi
      - name: tmp
        emptyDir:
          medium: Memory  # Use memory for temp files
          sizeLimit: 100Mi
      - name: logs
        hostPath:
          path: /var/log/daemonset/app
          type: DirectoryOrCreate
```

### Log Rotation for DaemonSets

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: logrotate-config
  namespace: system
data:
  logrotate.conf: |
    /var/log/app/*.log {
      daily
      rotate 7
      compress
      delaycompress
      missingok
      notifempty
      create 0640 nobody nogroup
      sharedscripts
      maxsize 100M
      postrotate
        killall -SIGUSR1 app || true
      endscript
    }
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: app-with-logrotate
  namespace: system
spec:
  selector:
    matchLabels:
      app: app-logrotate
  template:
    metadata:
      labels:
        app: app-logrotate
    spec:
      containers:
      - name: app
        image: app:v1.0
        resources:
          requests:
            memory: "200Mi"
            cpu: "100m"
          limits:
            memory: "500Mi"
            cpu: "500m"
        volumeMounts:
        - name: logs
          mountPath: /var/log/app
      - name: logrotate
        image: blacklabelops/logrotate:1.3
        env:
        - name: LOGS_DIRECTORIES
          value: "/var/log/app"
        - name: LOGROTATE_INTERVAL
          value: "hourly"
        resources:
          requests:
            memory: "10Mi"
            cpu: "10m"
          limits:
            memory: "50Mi"
            cpu: "50m"
        volumeMounts:
        - name: logs
          mountPath: /var/log/app
        - name: logrotate-config
          mountPath: /etc/logrotate.d
      volumes:
      - name: logs
        hostPath:
          path: /var/log/app
          type: DirectoryOrCreate
      - name: logrotate-config
        configMap:
          name: logrotate-config
```

## Update Strategies

### Rolling Update with Max Unavailable

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: rolling-update-daemonset
  namespace: system
spec:
  selector:
    matchLabels:
      app: rolling-update
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 2  # Update 2 nodes at a time
      maxSurge: 0  # DaemonSets don't support surge
  template:
    metadata:
      labels:
        app: rolling-update
    spec:
      containers:
      - name: app
        image: app:v2.0
        resources:
          requests:
            memory: "200Mi"
            cpu: "100m"
          limits:
            memory: "500Mi"
            cpu: "500m"
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
          failureThreshold: 3
```

### Controlled Update with OnDelete

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ondelete-daemonset
  namespace: system
spec:
  selector:
    matchLabels:
      app: ondelete
  updateStrategy:
    type: OnDelete  # Manual control over updates
  template:
    metadata:
      labels:
        app: ondelete
    spec:
      containers:
      - name: app
        image: app:v2.0
        resources:
          requests:
            memory: "200Mi"
            cpu: "100m"
          limits:
            memory: "500Mi"
            cpu: "500m"
```

Update script for OnDelete strategy:

```bash
#!/bin/bash
# controlled-daemonset-update.sh

set -e

NAMESPACE="system"
DAEMONSET="ondelete-daemonset"
UPDATE_INTERVAL=30  # seconds between node updates

echo "Starting controlled DaemonSet update..."

# Get all pods
PODS=$(kubectl get pods -n $NAMESPACE -l app=ondelete -o jsonpath='{.items[*].metadata.name}')

for POD in $PODS; do
  NODE=$(kubectl get pod $POD -n $NAMESPACE -o jsonpath='{.spec.nodeName}')

  echo "Updating pod $POD on node $NODE..."

  # Delete pod to trigger update
  kubectl delete pod $POD -n $NAMESPACE

  # Wait for new pod to be ready
  echo "Waiting for new pod to be ready..."
  kubectl wait --for=condition=ready pod -l app=ondelete -n $NAMESPACE --field-selector spec.nodeName=$NODE --timeout=300s

  echo "Pod on node $NODE updated successfully"
  echo "Waiting $UPDATE_INTERVAL seconds before next update..."
  sleep $UPDATE_INTERVAL
done

echo "DaemonSet update complete!"
```

## Monitoring and Metrics

### DaemonSet Metrics Exporter

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: daemonset-metrics
  namespace: monitoring
data:
  collect-metrics.sh: |
    #!/bin/bash
    # Collect DaemonSet resource metrics

    while true; do
      NAMESPACE=${NAMESPACE:-system}
      DAEMONSET=${DAEMONSET}

      # Get DaemonSet status
      DESIRED=$(kubectl get daemonset $DAEMONSET -n $NAMESPACE -o jsonpath='{.status.desiredNumberScheduled}')
      CURRENT=$(kubectl get daemonset $DAEMONSET -n $NAMESPACE -o jsonpath='{.status.currentNumberScheduled}')
      READY=$(kubectl get daemonset $DAEMONSET -n $NAMESPACE -o jsonpath='{.status.numberReady}')
      AVAILABLE=$(kubectl get daemonset $DAEMONSET -n $NAMESPACE -o jsonpath='{.status.numberAvailable}')

      # Calculate resource usage across all pods
      TOTAL_CPU_REQUEST=0
      TOTAL_CPU_LIMIT=0
      TOTAL_MEM_REQUEST=0
      TOTAL_MEM_LIMIT=0

      PODS=$(kubectl get pods -n $NAMESPACE -l app=$DAEMONSET -o json)

      # Extract and sum resource values
      TOTAL_CPU_REQUEST=$(echo "$PODS" | jq -r '.items[].spec.containers[].resources.requests.cpu' | grep -v null | sed 's/m$//' | awk '{sum+=$1} END {print sum}')
      TOTAL_CPU_LIMIT=$(echo "$PODS" | jq -r '.items[].spec.containers[].resources.limits.cpu' | grep -v null | sed 's/m$//' | awk '{sum+=$1} END {print sum}')

      # Write Prometheus metrics
      cat <<EOF > /metrics/daemonset_metrics.prom
# HELP daemonset_desired_pods Number of desired pods
# TYPE daemonset_desired_pods gauge
daemonset_desired_pods{namespace="$NAMESPACE",daemonset="$DAEMONSET"} $DESIRED

# HELP daemonset_current_pods Number of current pods
# TYPE daemonset_current_pods gauge
daemonset_current_pods{namespace="$NAMESPACE",daemonset="$DAEMONSET"} $CURRENT

# HELP daemonset_ready_pods Number of ready pods
# TYPE daemonset_ready_pods gauge
daemonset_ready_pods{namespace="$NAMESPACE",daemonset="$DAEMONSET"} $READY

# HELP daemonset_available_pods Number of available pods
# TYPE daemonset_available_pods gauge
daemonset_available_pods{namespace="$NAMESPACE",daemonset="$DAEMONSET"} $AVAILABLE

# HELP daemonset_cpu_requests_total Total CPU requests in millicores
# TYPE daemonset_cpu_requests_total gauge
daemonset_cpu_requests_total{namespace="$NAMESPACE",daemonset="$DAEMONSET"} ${TOTAL_CPU_REQUEST:-0}

# HELP daemonset_cpu_limits_total Total CPU limits in millicores
# TYPE daemonset_cpu_limits_total gauge
daemonset_cpu_limits_total{namespace="$NAMESPACE",daemonset="$DAEMONSET"} ${TOTAL_CPU_LIMIT:-0}
EOF

      sleep 30
    done
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: daemonset-monitor
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: daemonset-exporter
  endpoints:
  - port: metrics
    interval: 30s
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: daemonset-alerts
  namespace: monitoring
spec:
  groups:
  - name: daemonset
    interval: 30s
    rules:
    - alert: DaemonSetNotScheduled
      expr: |
        daemonset_desired_pods - daemonset_current_pods > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "DaemonSet {{ $labels.daemonset }} has unscheduled pods"
        description: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} has {{ $value }} pods not scheduled for more than 5 minutes."

    - alert: DaemonSetPodsNotReady
      expr: |
        (daemonset_desired_pods - daemonset_ready_pods) / daemonset_desired_pods > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "DaemonSet {{ $labels.daemonset }} has pods not ready"
        description: "{{ $value | humanizePercentage }} of DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} pods are not ready."

    - alert: DaemonSetHighCPUUsage
      expr: |
        rate(container_cpu_usage_seconds_total{pod=~".*daemonset.*"}[5m]) > 0.8
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "DaemonSet pod {{ $labels.pod }} has high CPU usage"
        description: "DaemonSet pod {{ $labels.namespace }}/{{ $labels.pod }} is using {{ $value | humanizePercentage }} of CPU."

    - alert: DaemonSetHighMemoryUsage
      expr: |
        container_memory_working_set_bytes{pod=~".*daemonset.*"} / container_spec_memory_limit_bytes{pod=~".*daemonset.*"} > 0.9
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "DaemonSet pod {{ $labels.pod }} has high memory usage"
        description: "DaemonSet pod {{ $labels.namespace }}/{{ $labels.pod }} is using {{ $value | humanizePercentage }} of memory limit."
```

## Resource Profiling Script

```bash
#!/bin/bash
# profile-daemonset-resources.sh

set -e

NAMESPACE=${1:-system}
DAEMONSET=${2:-node-exporter}
DURATION=${3:-300}  # 5 minutes

echo "Profiling DaemonSet $NAMESPACE/$DAEMONSET for $DURATION seconds..."

# Create output directory
OUTPUT_DIR="/tmp/daemonset-profile-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

# Get all pods
PODS=$(kubectl get pods -n $NAMESPACE -l app=$DAEMONSET -o jsonpath='{.items[*].metadata.name}')

echo "Found pods: $PODS"

# Collect metrics for each pod
for POD in $PODS; do
  echo "Profiling pod $POD..."

  # Create pod directory
  POD_DIR="$OUTPUT_DIR/$POD"
  mkdir -p "$POD_DIR"

  # Collect resource usage over time
  (
    for i in $(seq 1 $((DURATION/10))); do
      timestamp=$(date +%s)

      # Get current usage
      cpu=$(kubectl top pod $POD -n $NAMESPACE --no-headers | awk '{print $2}')
      memory=$(kubectl top pod $POD -n $NAMESPACE --no-headers | awk '{print $3}')

      echo "$timestamp,$cpu,$memory" >> "$POD_DIR/usage.csv"

      sleep 10
    done
  ) &
done

# Wait for profiling to complete
echo "Collecting data for $DURATION seconds..."
wait

# Analyze results
echo "Generating report..."

REPORT="$OUTPUT_DIR/report.txt"
{
  echo "DaemonSet Resource Profile Report"
  echo "=================================="
  echo "Namespace: $NAMESPACE"
  echo "DaemonSet: $DAEMONSET"
  echo "Duration: $DURATION seconds"
  echo "Timestamp: $(date)"
  echo ""

  for POD in $PODS; do
    echo "Pod: $POD"
    echo "----------"

    if [ -f "$OUTPUT_DIR/$POD/usage.csv" ]; then
      # Calculate averages
      avg_cpu=$(awk -F, '{sum+=$2; count++} END {print sum/count}' "$OUTPUT_DIR/$POD/usage.csv")
      avg_mem=$(awk -F, '{sum+=$3; count++} END {print sum/count}' "$OUTPUT_DIR/$POD/usage.csv")

      # Calculate peaks
      peak_cpu=$(awk -F, '{if($2>max){max=$2}} END {print max}' "$OUTPUT_DIR/$POD/usage.csv")
      peak_mem=$(awk -F, '{if($3>max){max=$3}} END {print max}' "$OUTPUT_DIR/$POD/usage.csv")

      echo "Average CPU: $avg_cpu"
      echo "Peak CPU: $peak_cpu"
      echo "Average Memory: $avg_mem"
      echo "Peak Memory: $peak_mem"

      # Get resource requests/limits
      requests=$(kubectl get pod $POD -n $NAMESPACE -o json | jq -r '.spec.containers[0].resources.requests')
      limits=$(kubectl get pod $POD -n $NAMESPACE -o json | jq -r '.spec.containers[0].resources.limits')

      echo "Requests: $requests"
      echo "Limits: $limits"
    fi

    echo ""
  done

  # Cluster-wide impact
  echo "Cluster Impact"
  echo "=============="

  total_pods=$(echo "$PODS" | wc -w)
  echo "Total DaemonSet pods: $total_pods"

  # Calculate total resource usage
  total_cpu_request=$(kubectl get pods -n $NAMESPACE -l app=$DAEMONSET -o json | jq -r '[.items[].spec.containers[].resources.requests.cpu] | map(select(. != null)) | map(rtrimstr("m") | tonumber) | add')
  total_mem_request=$(kubectl get pods -n $NAMESPACE -l app=$DAEMONSET -o json | jq -r '[.items[].spec.containers[].resources.requests.memory] | map(select(. != null)) | map(rtrimstr("Mi") | tonumber) | add')

  echo "Total CPU requests: ${total_cpu_request}m"
  echo "Total Memory requests: ${total_mem_request}Mi"

  # Get cluster capacity
  total_cluster_cpu=$(kubectl get nodes -o json | jq '[.items[].status.capacity.cpu | tonumber] | add')
  total_cluster_mem=$(kubectl get nodes -o json | jq '[.items[].status.capacity.memory | rtrimstr("Ki") | tonumber] | add / 1024')

  echo "Cluster CPU capacity: ${total_cluster_cpu} cores"
  echo "Cluster Memory capacity: ${total_cluster_mem}Mi"

  # Calculate percentage
  cpu_percentage=$(echo "scale=2; ($total_cpu_request / 1000) / $total_cluster_cpu * 100" | bc)
  mem_percentage=$(echo "scale=2; $total_mem_request / $total_cluster_mem * 100" | bc)

  echo "DaemonSet CPU usage: ${cpu_percentage}% of cluster"
  echo "DaemonSet Memory usage: ${mem_percentage}% of cluster"

} | tee "$REPORT"

echo ""
echo "Profile complete! Results saved to: $OUTPUT_DIR"
echo "Report: $REPORT"
```

## Best Practices

### 1. Right-Size Resources

```bash
#!/bin/bash
# calculate-optimal-resources.sh

NAMESPACE=$1
DAEMONSET=$2

if [ -z "$NAMESPACE" ] || [ -z "$DAEMONSET" ]; then
  echo "Usage: $0 <namespace> <daemonset>"
  exit 1
fi

echo "Analyzing resource usage for $NAMESPACE/$DAEMONSET..."

# Collect metrics from Prometheus (requires prometheus-adapter)
CPU_P95=$(kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/$NAMESPACE/pods" | \
  jq -r ".items[] | select(.metadata.labels.app==\"$DAEMONSET\") | .containers[].usage.cpu" | \
  sed 's/n$//' | sort -n | awk '{all[NR] = $0} END{print all[int(NR*0.95)]}')

MEM_P95=$(kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/$NAMESPACE/pods" | \
  jq -r ".items[] | select(.metadata.labels.app==\"$DAEMONSET\") | .containers[].usage.memory" | \
  sed 's/Ki$//' | sort -n | awk '{all[NR] = $0} END{print all[int(NR*0.95)]}')

# Add 20% buffer for requests
CPU_REQUEST=$(echo "scale=0; $CPU_P95 * 1.2 / 1000000" | bc)
MEM_REQUEST=$(echo "scale=0; $MEM_P95 * 1.2 / 1024" | bc)

# Add 50% buffer for limits
CPU_LIMIT=$(echo "scale=0; $CPU_P95 * 1.5 / 1000000" | bc)
MEM_LIMIT=$(echo "scale=0; $MEM_P95 * 1.5 / 1024" | bc)

echo "Recommended resource configuration:"
echo "requests:"
echo "  cpu: ${CPU_REQUEST}m"
echo "  memory: ${MEM_REQUEST}Mi"
echo "limits:"
echo "  cpu: ${CPU_LIMIT}m"
echo "  memory: ${MEM_LIMIT}Mi"
```

### 2. Priority Classes

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: daemonset-high-priority
value: 1000000
globalDefault: false
description: "High priority for critical DaemonSets"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: daemonset-medium-priority
value: 100000
globalDefault: false
description: "Medium priority for important DaemonSets"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: daemonset-low-priority
value: 10000
globalDefault: false
description: "Low priority for non-critical DaemonSets"
```

### 3. Resource Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: daemonset-quota
  namespace: system
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values:
      - daemonset-medium-priority
      - daemonset-low-priority
```

## Conclusion

Optimizing DaemonSet resources is crucial for maintaining cluster health and efficiency. Key takeaways:

- **Right-size resources** based on actual usage patterns with appropriate buffers
- **Use QoS classes** strategically: Guaranteed for critical services, Burstable for others
- **Implement selective scheduling** to run DaemonSets only where needed
- **Monitor continuously** and adjust resource allocations as workloads evolve
- **Test updates carefully** using controlled rollout strategies
- **Set appropriate priorities** to ensure critical DaemonSets aren't evicted

By following these patterns and best practices, you can ensure DaemonSets provide necessary node-level services without negatively impacting application workloads or cluster stability.