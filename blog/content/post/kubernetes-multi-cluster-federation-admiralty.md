---
title: "Multi-Cluster Kubernetes Federation with Admiralty: Enterprise Implementation Guide"
date: 2026-09-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Cluster", "Admiralty", "Federation", "Scheduling", "Cloud Native"]
categories: ["Kubernetes", "DevOps", "Cloud Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing multi-cluster Kubernetes federation using Admiralty, including cluster mesh configuration, workload scheduling, service discovery, and disaster recovery strategies."
more_link: "yes"
url: "/kubernetes-multi-cluster-federation-admiralty/"
---

Multi-cluster Kubernetes deployments enable high availability, disaster recovery, and geographic distribution of workloads. Admiralty provides sophisticated multi-cluster scheduling capabilities that seamlessly distribute workloads across federated clusters. This guide covers production implementation patterns and operational best practices.

<!--more-->

## Executive Summary

Admiralty extends Kubernetes with multi-cluster scheduling capabilities, allowing pods to be scheduled across multiple clusters transparently. Unlike traditional federation approaches, Admiralty uses a lightweight architecture based on virtual nodes and pod mutation, making it compatible with standard Kubernetes tooling and gitops workflows.

## Multi-Cluster Architecture Patterns

### Deployment Topologies

**Hub-and-Spoke Pattern:**

```yaml
# Hub cluster configuration
# Aggregates workloads from multiple spoke clusters
apiVersion: multicluster.admiralty.io/v1alpha1
kind: ClusterSummary
metadata:
  name: admiralty-hub
spec:
  role: hub
  clusters:
  - name: us-west-cluster
    region: us-west-2
    zone: us-west-2a
    weight: 100
    capabilities:
      - gpu
      - high-memory
  - name: us-east-cluster
    region: us-east-1
    zone: us-east-1b
    weight: 100
    capabilities:
      - general-purpose
  - name: eu-central-cluster
    region: eu-central-1
    zone: eu-central-1a
    weight: 100
    capabilities:
      - gdpr-compliant
  scheduling:
    strategy: cost-optimized
    constraints:
      - type: region-affinity
        preference: same-region
      - type: latency
        maxMilliseconds: 50
```

**Mesh Pattern:**

```yaml
# Peer-to-peer mesh configuration
# Each cluster can schedule to any other cluster
apiVersion: multicluster.admiralty.io/v1alpha1
kind: ClusterTopology
metadata:
  name: global-mesh
spec:
  topology: mesh
  members:
  - name: prod-us-west
    apiServer: https://us-west.k8s.example.com
    contexts:
      - production
      - us-region
  - name: prod-us-east
    apiServer: https://us-east.k8s.example.com
    contexts:
      - production
      - us-region
  - name: prod-eu-central
    apiServer: https://eu-central.k8s.example.com
    contexts:
      - production
      - eu-region
  - name: prod-ap-southeast
    apiServer: https://ap-southeast.k8s.example.com
    contexts:
      - production
      - ap-region
  networking:
    serviceDiscovery: true
    crossClusterTraffic: enabled
    encryption: required
```

## Installing and Configuring Admiralty

### Prerequisites and Installation

**Install Admiralty on Source Cluster:**

```bash
#!/bin/bash
set -e

# Install Admiralty using Helm
helm repo add admiralty https://charts.admiralty.io
helm repo update

# Create namespace
kubectl create namespace admiralty-system

# Install Admiralty agent (source cluster)
helm install admiralty-agent admiralty/multicluster-scheduler-agent \
  --namespace admiralty-system \
  --set clusterName=source-cluster \
  --set controllerManager.replicas=3 \
  --set controllerManager.resources.requests.cpu=200m \
  --set controllerManager.resources.requests.memory=256Mi \
  --set controllerManager.resources.limits.cpu=1000m \
  --set controllerManager.resources.limits.memory=512Mi

# Verify installation
kubectl get pods -n admiralty-system
```

**Install Admiralty on Target Clusters:**

```bash
#!/bin/bash
set -e

TARGET_CLUSTERS=("us-west" "us-east" "eu-central")

for cluster in "${TARGET_CLUSTERS[@]}"; do
  echo "Installing Admiralty on ${cluster}..."

  kubectl config use-context ${cluster}

  kubectl create namespace admiralty-system

  helm install admiralty-agent admiralty/multicluster-scheduler-agent \
    --namespace admiralty-system \
    --set clusterName=${cluster} \
    --set isTargetCluster=true \
    --set controllerManager.replicas=3

  echo "Admiralty installed on ${cluster}"
done
```

### Cluster Registration

**Create Source Configuration:**

```yaml
# source-config.yaml
apiVersion: multicluster.admiralty.io/v1alpha1
kind: Source
metadata:
  name: admiralty-source
  namespace: admiralty-system
spec:
  serviceAccountName: admiralty-agent
  targets:
  - name: us-west-target
    namespace: default
    clusterContext: us-west
    weight: 100
    constraints:
      nodeSelector:
        topology.kubernetes.io/zone: us-west-2a
    tolerations:
    - key: workload-type
      operator: Equal
      value: batch
      effect: NoSchedule
  - name: us-east-target
    namespace: default
    clusterContext: us-east
    weight: 100
    constraints:
      nodeSelector:
        topology.kubernetes.io/zone: us-east-1b
  - name: eu-central-target
    namespace: default
    clusterContext: eu-central
    weight: 50  # Lower priority for EU cluster
    constraints:
      nodeSelector:
        compliance: gdpr
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: admiralty-agent
  namespace: admiralty-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: admiralty-agent
rules:
- apiGroups: [""]
  resources: [pods, services, configmaps, secrets]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [apps]
  resources: [deployments, replicasets, statefulsets]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [multicluster.admiralty.io]
  resources: ["*"]
  verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: admiralty-agent
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admiralty-agent
subjects:
- kind: ServiceAccount
  name: admiralty-agent
  namespace: admiralty-system
```

**Create Target Configuration:**

```yaml
# target-config.yaml
apiVersion: multicluster.admiralty.io/v1alpha1
kind: Target
metadata:
  name: admiralty-target
  namespace: default
spec:
  serviceAccountName: admiralty-target
  clusters:
  - name: source-cluster
    context: source
    namespace: default
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: admiralty-target
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: admiralty-target
  namespace: default
rules:
- apiGroups: [""]
  resources: [pods, pods/status]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [""]
  resources: [pods/log]
  verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: admiralty-target
  namespace: default
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: admiralty-target
subjects:
- kind: ServiceAccount
  name: admiralty-target
  namespace: default
```

### Cluster Credentials Setup

**Export and Import Kubeconfig:**

```bash
#!/bin/bash
set -e

SOURCE_CLUSTER="source"
TARGET_CLUSTER="us-west"

echo "Exporting kubeconfig from target cluster..."
kubectl config use-context ${TARGET_CLUSTER}

# Create service account token
TARGET_SECRET=$(kubectl get serviceaccount admiralty-target -n default \
  -o jsonpath='{.secrets[0].name}')
TARGET_TOKEN=$(kubectl get secret ${TARGET_SECRET} -n default \
  -o jsonpath='{.data.token}' | base64 -d)
TARGET_CA=$(kubectl get secret ${TARGET_SECRET} -n default \
  -o jsonpath='{.data.ca\.crt}')
TARGET_ENDPOINT=$(kubectl config view -o jsonpath='{.clusters[?(@.name=="'${TARGET_CLUSTER}'")].cluster.server}')

# Switch to source cluster
kubectl config use-context ${SOURCE_CLUSTER}

# Create secret with target cluster credentials
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: ${TARGET_CLUSTER}-kubeconfig
  namespace: admiralty-system
type: Opaque
data:
  config: $(cat <<KUBECONFIG | base64 -w0
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: ${TARGET_CA}
    server: ${TARGET_ENDPOINT}
  name: ${TARGET_CLUSTER}
contexts:
- context:
    cluster: ${TARGET_CLUSTER}
    user: ${TARGET_CLUSTER}
  name: ${TARGET_CLUSTER}
current-context: ${TARGET_CLUSTER}
users:
- name: ${TARGET_CLUSTER}
  user:
    token: ${TARGET_TOKEN}
KUBECONFIG
)
EOF

echo "Target cluster credentials imported to source cluster"
```

## Workload Scheduling Strategies

### Pod Distribution Policies

**Basic Multi-Cluster Deployment:**

```yaml
# multi-cluster-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-application
  namespace: production
  annotations:
    # Enable multi-cluster scheduling
    multicluster.admiralty.io/elect: ""
spec:
  replicas: 9  # Will be distributed across clusters
  selector:
    matchLabels:
      app: web-application
  template:
    metadata:
      labels:
        app: web-application
      annotations:
        # Scheduling policy
        multicluster.admiralty.io/scheduling-policy: spread
    spec:
      containers:
      - name: web
        image: nginx:1.21
        ports:
        - containerPort: 80
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
---
# Scheduling constraints
apiVersion: multicluster.admiralty.io/v1alpha1
kind: PodSchedulingPolicy
metadata:
  name: web-application-policy
  namespace: production
spec:
  targetSelector:
    matchLabels:
      app: web-application
  clusterSelector:
    # Prefer clusters with available capacity
    matchExpressions:
    - key: capacity
      operator: In
      values: [high, medium]
  spreadConstraints:
  - maxSkew: 2
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
  - maxSkew: 3
    topologyKey: multicluster.admiralty.io/cluster-name
    whenUnsatisfiable: ScheduleAnyway
```

**Geo-Distributed Application:**

```yaml
# geo-distributed-app.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: production
  annotations:
    multicluster.admiralty.io/elect: ""
spec:
  replicas: 12
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
      annotations:
        multicluster.admiralty.io/scheduling-policy: geo-distributed
    spec:
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: topology.kubernetes.io/region
                operator: In
                values:
                - us-west-2
                - us-east-1
                - eu-central-1
      containers:
      - name: gateway
        image: api-gateway:v2.5.0
        env:
        - name: REGION
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['multicluster.admiralty.io/cluster-name']
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
---
# Regional distribution policy
apiVersion: multicluster.admiralty.io/v1alpha1
kind: ClusterSchedulingPolicy
metadata:
  name: regional-distribution
spec:
  regions:
  - name: us-west
    minReplicas: 4
    maxReplicas: 6
    clusters:
    - us-west-2a
    - us-west-2b
  - name: us-east
    minReplicas: 4
    maxReplicas: 6
    clusters:
    - us-east-1a
    - us-east-1b
  - name: eu-central
    minReplicas: 2
    maxReplicas: 4
    clusters:
    - eu-central-1a
  strategy: balanced
```

**Workload-Specific Scheduling:**

```yaml
# batch-workload.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing-job
  namespace: batch
  annotations:
    multicluster.admiralty.io/elect: ""
spec:
  parallelism: 50
  completions: 100
  template:
    metadata:
      annotations:
        multicluster.admiralty.io/scheduling-policy: cost-optimized
        multicluster.admiralty.io/cluster-selector: spot-enabled=true
    spec:
      restartPolicy: OnFailure
      containers:
      - name: processor
        image: data-processor:v1.0.0
        resources:
          requests:
            cpu: 2
            memory: 4Gi
        env:
        - name: BATCH_SIZE
          value: "1000"
      tolerations:
      - key: workload-type
        operator: Equal
        value: batch
        effect: NoSchedule
      - key: node.kubernetes.io/unreachable
        operator: Exists
        effect: NoExecute
        tolerationSeconds: 300
---
# Cost-optimized scheduling policy
apiVersion: multicluster.admiralty.io/v1alpha1
kind: CostOptimizationPolicy
metadata:
  name: batch-cost-policy
spec:
  preferences:
  - clusterSelector:
      matchLabels:
        pricing: spot
    weight: 100
  - clusterSelector:
      matchLabels:
        pricing: on-demand
    weight: 50
  - clusterSelector:
      matchLabels:
        pricing: reserved
    weight: 30
  fallbackStrategy: spillover
  maxCostPerHour: "50.00"
```

## Service Discovery and Networking

### Cross-Cluster Service Access

**Multi-Cluster Service Configuration:**

```yaml
# multi-cluster-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web-application
  namespace: production
  annotations:
    multicluster.admiralty.io/service-export: "true"
spec:
  type: ClusterIP
  selector:
    app: web-application
  ports:
  - port: 80
    targetPort: 80
    name: http
---
# Service import in each cluster
apiVersion: multicluster.admiralty.io/v1alpha1
kind: ServiceImport
metadata:
  name: web-application
  namespace: production
spec:
  type: ClusterSetIP
  ports:
  - port: 80
    protocol: TCP
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 3600
---
# Global load balancer configuration
apiVersion: multicluster.admiralty.io/v1alpha1
kind: GlobalService
metadata:
  name: web-application-global
  namespace: production
spec:
  selector:
    app: web-application
  ports:
  - port: 80
    targetPort: 80
  trafficPolicy:
    loadBalancer:
      strategy: round-robin
    locality:
      enabled: true
      failover:
      - from: us-west-2
        to: us-east-1
      - from: us-east-1
        to: eu-central-1
```

**Service Mesh Integration:**

```yaml
# istio-multicluster-service.yaml
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: web-application-multicluster
  namespace: production
spec:
  hosts:
  - web-application.production.global
  location: MESH_INTERNAL
  ports:
  - number: 80
    name: http
    protocol: HTTP
  resolution: DNS
  endpoints:
  - address: web-application.production.svc.cluster.local
    locality: us-west-2
    labels:
      cluster: us-west
  - address: web-application.production.svc.cluster.local
    locality: us-east-1
    labels:
      cluster: us-east
  - address: web-application.production.svc.cluster.local
    locality: eu-central-1
    labels:
      cluster: eu-central
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: web-application-multicluster
  namespace: production
spec:
  host: web-application.production.global
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
    loadBalancer:
      localityLbSetting:
        enabled: true
        distribute:
        - from: us-west-2/*
          to:
            us-west-2/*: 80
            us-east-1/*: 20
        - from: us-east-1/*
          to:
            us-east-1/*: 80
            us-west-2/*: 20
        failover:
        - from: us-west-2
          to: us-east-1
    outlierDetection:
      consecutiveErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
```

### DNS Configuration

**CoreDNS Multi-Cluster Setup:**

```yaml
# coredns-multicluster-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom
  namespace: kube-system
data:
  multicluster.server: |
    # Multi-cluster DNS resolution
    global:53 {
        errors
        cache 30
        forward . 10.100.0.10 10.100.0.11 {
            prefer_udp
        }
    }

    # Cluster-specific zones
    cluster.local:53 {
        errors
        cache 30
        reload
        loop
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
    }
---
# Multi-cluster DNS service
apiVersion: v1
kind: Service
metadata:
  name: multicluster-dns
  namespace: kube-system
spec:
  type: LoadBalancer
  selector:
    k8s-app: kube-dns
  ports:
  - port: 53
    targetPort: 53
    protocol: UDP
    name: dns-udp
  - port: 53
    targetPort: 53
    protocol: TCP
    name: dns-tcp
```

## Data Persistence and State Management

### Persistent Volume Management

**Multi-Cluster Storage Configuration:**

```yaml
# multi-cluster-storage.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: multicluster-ssd
  annotations:
    multicluster.admiralty.io/replicate: "true"
provisioner: kubernetes.io/aws-ebs
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
---
# StatefulSet with multi-cluster awareness
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: database-cluster
  namespace: production
  annotations:
    multicluster.admiralty.io/elect: ""
spec:
  serviceName: database
  replicas: 6  # Distributed across clusters
  selector:
    matchLabels:
      app: database
  template:
    metadata:
      labels:
        app: database
      annotations:
        multicluster.admiralty.io/scheduling-policy: stateful
    spec:
      containers:
      - name: postgres
        image: postgres:14
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: CLUSTER_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['multicluster.admiralty.io/cluster-name']
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ReadWriteOnce]
      storageClassName: multicluster-ssd
      resources:
        requests:
          storage: 100Gi
---
# Volume replication configuration
apiVersion: multicluster.admiralty.io/v1alpha1
kind: VolumeReplicationPolicy
metadata:
  name: database-replication
spec:
  sourceSelector:
    matchLabels:
      app: database
  replicationMode: async
  schedule: "*/5 * * * *"  # Every 5 minutes
  targets:
  - cluster: us-east
    storageClass: multicluster-ssd
  - cluster: eu-central
    storageClass: multicluster-ssd
  retentionPolicy:
    maxSnapshots: 10
```

## High Availability and Disaster Recovery

### Failover Configuration

**Automatic Failover Policy:**

```yaml
# failover-policy.yaml
apiVersion: multicluster.admiralty.io/v1alpha1
kind: FailoverPolicy
metadata:
  name: production-failover
  namespace: production
spec:
  selector:
    matchLabels:
      tier: frontend
  primaryCluster: us-west
  failoverClusters:
  - name: us-east
    priority: 1
    healthCheck:
      type: http
      httpGet:
        path: /healthz
        port: 8080
      initialDelaySeconds: 10
      periodSeconds: 5
      failureThreshold: 3
  - name: eu-central
    priority: 2
    healthCheck:
      type: http
      httpGet:
        path: /healthz
        port: 8080
      initialDelaySeconds: 10
      periodSeconds: 5
      failureThreshold: 3
  failoverStrategy:
    mode: automatic
    drainTimeout: 300s
    recoveryDelay: 60s
  notifications:
    webhooks:
    - url: https://alerts.example.com/webhook
      events:
      - FailoverStarted
      - FailoverCompleted
      - FailoverFailed
---
# Circuit breaker configuration
apiVersion: multicluster.admiralty.io/v1alpha1
kind: CircuitBreaker
metadata:
  name: cluster-health-monitor
spec:
  clusters:
  - us-west
  - us-east
  - eu-central
  healthChecks:
  - type: api-server
    timeout: 5s
    interval: 10s
  - type: node-ready
    minHealthyNodes: 3
  - type: pod-ready
    namespace: kube-system
    minHealthyPods: 10
  thresholds:
    errorRate: 0.5
    consecutiveFailures: 5
  recovery:
    successThreshold: 3
    evaluationPeriod: 60s
```

### Backup and Restore

**Multi-Cluster Backup Strategy:**

```bash
#!/bin/bash
# multi-cluster-backup.sh
set -e

CLUSTERS=("us-west" "us-east" "eu-central")
BACKUP_BUCKET="s3://backup-bucket"
DATE=$(date +%Y%m%d-%H%M%S)

for cluster in "${CLUSTERS[@]}"; do
  echo "Backing up cluster: ${cluster}"

  kubectl config use-context ${cluster}

  # Backup Admiralty configuration
  kubectl get sources,targets,podschedulingpolicies,clusterschedulingpolicies \
    --all-namespaces -o yaml > ${cluster}-admiralty-config-${DATE}.yaml

  # Backup application state
  velero backup create ${cluster}-backup-${DATE} \
    --include-namespaces production,staging \
    --snapshot-volumes \
    --ttl 720h

  # Upload to S3
  aws s3 cp ${cluster}-admiralty-config-${DATE}.yaml \
    ${BACKUP_BUCKET}/${cluster}/${DATE}/

  echo "Backup completed for ${cluster}"
done

# Backup global configuration
kubectl config use-context us-west
kubectl get crd -l multicluster.admiralty.io/config=global -o yaml \
  > global-config-${DATE}.yaml
aws s3 cp global-config-${DATE}.yaml ${BACKUP_BUCKET}/global/${DATE}/

echo "All cluster backups completed"
```

## Monitoring and Observability

### Metrics Collection

**Prometheus Configuration:**

```yaml
# prometheus-multicluster-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
      external_labels:
        cluster: '__CLUSTER_NAME__'
        region: '__REGION__'

    scrape_configs:
    # Admiralty controller metrics
    - job_name: 'admiralty-controller'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
          - admiralty-system
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: admiralty-controller
        action: keep
      - source_labels: [__meta_kubernetes_pod_container_port_name]
        regex: metrics
        action: keep

    # Multi-cluster workload metrics
    - job_name: 'multicluster-workloads'
      kubernetes_sd_configs:
      - role: pod
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_multicluster_admiralty_io_elect]
        action: keep
      - source_labels: [__meta_kubernetes_pod_annotation_multicluster_admiralty_io_cluster_name]
        target_label: source_cluster
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod

    # Federation from other clusters
    - job_name: 'federate-us-east'
      honor_labels: true
      metrics_path: '/federate'
      params:
        'match[]':
          - '{job=~"multicluster.*"}'
          - '{__name__=~"admiralty.*"}'
      static_configs:
      - targets:
        - 'prometheus.us-east.example.com:9090'

    - job_name: 'federate-eu-central'
      honor_labels: true
      metrics_path: '/federate'
      params:
        'match[]':
          - '{job=~"multicluster.*"}'
          - '{__name__=~"admiralty.*"}'
      static_configs:
      - targets:
        - 'prometheus.eu-central.example.com:9090'
---
# ServiceMonitor for Admiralty
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: admiralty-controller
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: admiralty-controller
  namespaceSelector:
    matchNames:
    - admiralty-system
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

**Grafana Dashboards:**

```json
{
  "dashboard": {
    "title": "Multi-Cluster Overview",
    "panels": [
      {
        "title": "Pods per Cluster",
        "targets": [
          {
            "expr": "count by (cluster) (kube_pod_info{namespace='production'})"
          }
        ]
      },
      {
        "title": "Cross-Cluster Scheduling Rate",
        "targets": [
          {
            "expr": "rate(admiralty_multicluster_scheduling_attempts_total[5m])"
          }
        ]
      },
      {
        "title": "Cluster Health Score",
        "targets": [
          {
            "expr": "admiralty_cluster_health_score"
          }
        ]
      },
      {
        "title": "Network Latency Between Clusters",
        "targets": [
          {
            "expr": "histogram_quantile(0.99, rate(admiralty_cluster_latency_seconds_bucket[5m]))"
          }
        ]
      }
    ]
  }
}
```

### Alerting Rules

**PrometheusRule Configuration:**

```yaml
# multicluster-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: multicluster-alerts
  namespace: monitoring
spec:
  groups:
  - name: admiralty
    interval: 30s
    rules:
    - alert: ClusterUnreachable
      expr: up{job="admiralty-controller"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Cluster {{ $labels.cluster }} is unreachable"
        description: "Admiralty controller in {{ $labels.cluster }} has been down for 5 minutes"

    - alert: HighSchedulingFailureRate
      expr: rate(admiralty_multicluster_scheduling_failures_total[5m]) > 0.1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High scheduling failure rate in {{ $labels.cluster }}"
        description: "Scheduling failure rate is {{ $value }} per second"

    - alert: ClusterCapacityLow
      expr: (1 - (admiralty_cluster_allocatable_cpu / admiralty_cluster_capacity_cpu)) > 0.85
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Low capacity in cluster {{ $labels.cluster }}"
        description: "Cluster {{ $labels.cluster }} CPU usage is above 85%"

    - alert: CrossClusterLatencyHigh
      expr: histogram_quantile(0.99, rate(admiralty_cluster_latency_seconds_bucket[5m])) > 0.5
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High latency between clusters"
        description: "P99 latency between {{ $labels.source_cluster }} and {{ $labels.target_cluster }} is {{ $value }}s"
```

## Security Considerations

### RBAC Configuration

**Multi-Cluster RBAC:**

```yaml
# multicluster-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: multicluster-admin
rules:
# Admiralty resources
- apiGroups: ["multicluster.admiralty.io"]
  resources: ["*"]
  verbs: ["*"]
# Standard resources for multi-cluster management
- apiGroups: [""]
  resources: [pods, services, configmaps, secrets]
  verbs: [get, list, watch, create, update, patch, delete]
- apiGroups: [apps]
  resources: [deployments, replicasets, statefulsets]
  verbs: [get, list, watch, create, update, patch, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: multicluster-viewer
rules:
- apiGroups: ["multicluster.admiralty.io"]
  resources: ["*"]
  verbs: [get, list, watch]
- apiGroups: [""]
  resources: [pods, services]
  verbs: [get, list, watch]
- apiGroups: [apps]
  resources: [deployments, replicasets, statefulsets]
  verbs: [get, list, watch]
---
# Cross-cluster service account
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cross-cluster-sa
  namespace: production
  annotations:
    multicluster.admiralty.io/replicate: "true"
---
apiVersion: v1
kind: Secret
metadata:
  name: cross-cluster-sa-token
  namespace: production
  annotations:
    kubernetes.io/service-account.name: cross-cluster-sa
type: kubernetes.io/service-account-token
```

### Network Policies

**Cross-Cluster Network Policies:**

```yaml
# cross-cluster-netpol.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-cross-cluster
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: web-application
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # Allow from pods in same namespace
  - from:
    - podSelector: {}
  # Allow from Admiralty controllers
  - from:
    - namespaceSelector:
        matchLabels:
          name: admiralty-system
    - podSelector:
        matchLabels:
          app: admiralty-controller
  # Allow cross-cluster traffic
  - from:
    - namespaceSelector:
        matchLabels:
          multicluster.admiralty.io/source-cluster: us-east
    - namespaceSelector:
        matchLabels:
          multicluster.admiralty.io/source-cluster: eu-central
    ports:
    - protocol: TCP
      port: 80
  egress:
  # Allow to same namespace
  - to:
    - podSelector: {}
  # Allow DNS
  - to:
    - namespaceSelector:
        matchLabels:
          name: kube-system
    - podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
  # Allow cross-cluster service access
  - to:
    - namespaceSelector:
        matchLabels:
          multicluster.admiralty.io/enabled: "true"
    ports:
    - protocol: TCP
      port: 80
    - protocol: TCP
      port: 443
```

## Troubleshooting Guide

### Common Issues and Resolution

**Diagnostic Script:**

```bash
#!/bin/bash
# multicluster-diagnostics.sh

echo "=== Multi-Cluster Diagnostics ==="

CLUSTERS=("us-west" "us-east" "eu-central")

for cluster in "${CLUSTERS[@]}"; do
  echo ""
  echo "=== Checking cluster: ${cluster} ==="
  kubectl config use-context ${cluster}

  echo "Admiralty components:"
  kubectl get pods -n admiralty-system

  echo "Source/Target configuration:"
  kubectl get sources,targets -A

  echo "Multi-cluster pods:"
  kubectl get pods -A -l multicluster.admiralty.io/controlled-by

  echo "Events:"
  kubectl get events -n admiralty-system --sort-by='.lastTimestamp' | tail -20

  echo "Controller logs (last 50 lines):"
  kubectl logs -n admiralty-system \
    -l app=admiralty-controller --tail=50
done

echo ""
echo "=== Cross-cluster connectivity test ==="
kubectl config use-context us-west
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- \
  bash -c "for cluster in us-east eu-central; do \
    echo Testing \$cluster...; \
    curl -v -m 5 http://admiralty-controller.admiralty-system.svc.\${cluster}.cluster.local:8080/healthz; \
  done"

echo ""
echo "=== Checking scheduling distribution ==="
for cluster in "${CLUSTERS[@]}"; do
  count=$(kubectl get pods -A -l multicluster.admiralty.io/controlled-by \
    --context ${cluster} --no-headers | wc -l)
  echo "${cluster}: ${count} pods"
done
```

## Best Practices

### Production Deployment Checklist

1. **Network Configuration**
   - Ensure low-latency connectivity between clusters
   - Configure network policies for cross-cluster traffic
   - Set up DNS for service discovery

2. **Resource Management**
   - Define resource quotas per cluster
   - Configure appropriate scheduling policies
   - Monitor resource utilization across clusters

3. **High Availability**
   - Deploy Admiralty controllers with replicas
   - Configure failover policies
   - Test disaster recovery procedures

4. **Security**
   - Use minimal RBAC permissions
   - Encrypt cross-cluster traffic
   - Regularly rotate service account tokens

5. **Monitoring**
   - Set up comprehensive metrics collection
   - Configure alerts for cluster health
   - Monitor cross-cluster latency

## Conclusion

Admiralty provides a powerful, lightweight approach to multi-cluster Kubernetes management that integrates seamlessly with existing workflows. By leveraging virtual node scheduling and transparent pod distribution, organizations can achieve geographic distribution, high availability, and cost optimization without sacrificing operational simplicity. Success requires careful planning of network topology, robust monitoring, and comprehensive disaster recovery procedures.

Key takeaways:
- Start with hub-and-spoke topology, evolve to mesh as needed
- Implement comprehensive monitoring from day one
- Test failover procedures regularly
- Optimize scheduling policies based on workload characteristics
- Maintain clear documentation of cluster dependencies