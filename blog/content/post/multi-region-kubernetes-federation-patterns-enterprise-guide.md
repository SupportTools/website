---
title: "Multi-Region Kubernetes Federation Patterns: Enterprise Architecture Guide"
date: 2026-09-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Region", "Federation", "High Availability", "Disaster Recovery", "Global Infrastructure"]
categories: ["Cloud Architecture", "Kubernetes", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing multi-region Kubernetes federation patterns for enterprise deployments, covering global load balancing, cross-cluster service discovery, data replication, and disaster recovery strategies."
more_link: "yes"
url: "/multi-region-kubernetes-federation-patterns-enterprise-guide/"
---

Building globally distributed Kubernetes infrastructure requires sophisticated federation patterns that span multiple regions, cloud providers, and data centers. Multi-region Kubernetes deployments provide high availability, disaster recovery capabilities, and improved user experience through geographic proximity. This comprehensive guide explores enterprise-grade federation architectures, implementation patterns, and operational strategies for managing distributed Kubernetes environments at scale.

<!--more-->

# Multi-Region Architecture Patterns

## Active-Active Global Deployment

Active-active architectures distribute traffic across multiple regions simultaneously, providing optimal performance and resilience:

```yaml
# Global deployment manifest with region-specific configurations
---
apiVersion: v1
kind: Namespace
metadata:
  name: global-app
  labels:
    app: global-service
    federation: enabled
---
# ConfigMap for region-specific configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: region-config
  namespace: global-app
data:
  # These values vary by region
  region: "us-east-1"
  availability-zones: "us-east-1a,us-east-1b,us-east-1c"
  data-residency: "US"
  cdn-endpoint: "https://cdn-us-east.example.com"
  backup-region: "us-west-2"
---
# Application deployment replicated across regions
apiVersion: apps/v1
kind: Deployment
metadata:
  name: global-frontend
  namespace: global-app
  labels:
    app: frontend
    tier: web
    topology.kubernetes.io/region: us-east-1
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 50%
      maxUnavailable: 0
  selector:
    matchLabels:
      app: frontend
      tier: web
  template:
    metadata:
      labels:
        app: frontend
        tier: web
        topology.kubernetes.io/region: us-east-1
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: frontend
      - maxSkew: 2
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: frontend
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: frontend
              topologyKey: kubernetes.io/hostname
      containers:
      - name: frontend
        image: gcr.io/project/frontend:v2.1.5
        ports:
        - containerPort: 8080
          name: http
          protocol: TCP
        - containerPort: 9090
          name: metrics
          protocol: TCP
        env:
        - name: REGION
          valueFrom:
            configMapKeyRef:
              name: region-config
              key: region
        - name: BACKUP_REGION
          valueFrom:
            configMapKeyRef:
              name: region-config
              key: backup-region
        - name: DATABASE_ENDPOINT
          value: "postgres-us-east.internal:5432"
        - name: CACHE_ENDPOINT
          value: "redis-us-east.internal:6379"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
---
# Service with cross-region annotations
apiVersion: v1
kind: Service
metadata:
  name: frontend-service
  namespace: global-app
  labels:
    app: frontend
  annotations:
    service.kubernetes.io/topology-aware-hints: auto
    cloud.google.com/neg: '{"ingress": true}'
    external-dns.alpha.kubernetes.io/hostname: us-east.example.com
spec:
  type: LoadBalancer
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
  selector:
    app: frontend
    tier: web
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
    name: http
```

## Active-Passive Disaster Recovery

Active-passive configurations maintain standby capacity in secondary regions for failover scenarios:

```yaml
# Primary region deployment (active)
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: primary-api
  namespace: production
  labels:
    region: primary
    dr-role: active
spec:
  replicas: 20
  selector:
    matchLabels:
      app: api-service
      region: primary
  template:
    metadata:
      labels:
        app: api-service
        region: primary
        dr-role: active
    spec:
      containers:
      - name: api
        image: api-service:v3.2.1
        env:
        - name: DR_MODE
          value: "active"
        - name: REPLICATION_TARGETS
          value: "dr-region-1,dr-region-2"
        resources:
          requests:
            memory: "1Gi"
            cpu: "1000m"
---
# DR region deployment (passive, scaled to minimum)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dr-api
  namespace: production
  labels:
    region: dr
    dr-role: passive
spec:
  replicas: 2  # Minimal replicas, scaled up during failover
  selector:
    matchLabels:
      app: api-service
      region: dr
  template:
    metadata:
      labels:
        app: api-service
        region: dr
        dr-role: passive
    spec:
      containers:
      - name: api
        image: api-service:v3.2.1
        env:
        - name: DR_MODE
          value: "passive"
        - name: PRIMARY_REGION
          value: "us-east-1"
        - name: SYNC_FROM_PRIMARY
          value: "true"
        resources:
          requests:
            memory: "1Gi"
            cpu: "1000m"
---
# HorizontalPodAutoscaler for DR failover
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: dr-api-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: dr-api
  minReplicas: 2
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0  # Immediate scale-up during DR
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 10
        periodSeconds: 15
      selectPolicy: Max
```

# Global Load Balancing and Traffic Management

## DNS-Based Global Load Balancing

```yaml
# External DNS configuration for multi-region routing
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-dns
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: external-dns
rules:
- apiGroups: [""]
  resources: ["services", "endpoints", "pods"]
  verbs: ["get", "watch", "list"]
- apiGroups: ["extensions", "networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "watch", "list"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: external-dns-viewer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: external-dns
subjects:
- kind: ServiceAccount
  name: external-dns
  namespace: kube-system
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
  namespace: kube-system
spec:
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: external-dns
  template:
    metadata:
      labels:
        app: external-dns
    spec:
      serviceAccountName: external-dns
      containers:
      - name: external-dns
        image: registry.k8s.io/external-dns/external-dns:v0.14.0
        args:
        - --source=service
        - --source=ingress
        - --domain-filter=example.com
        - --provider=aws
        - --policy=sync
        - --aws-zone-type=public
        - --registry=txt
        - --txt-owner-id=us-east-cluster
        - --txt-prefix=_external-dns-
        env:
        - name: AWS_DEFAULT_REGION
          value: us-east-1
---
# Service with geo-routing annotations
apiVersion: v1
kind: Service
metadata:
  name: global-api
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: api.example.com
    external-dns.alpha.kubernetes.io/aws-geolocation-continent-code: NA
    external-dns.alpha.kubernetes.io/set-identifier: us-east-1
    external-dns.alpha.kubernetes.io/aws-weight: "100"
spec:
  type: LoadBalancer
  selector:
    app: api-service
  ports:
  - protocol: TCP
    port: 443
    targetPort: 8443
```

## Service Mesh Global Traffic Management

```yaml
# Istio VirtualService for cross-region traffic splitting
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: global-service
  namespace: production
spec:
  hosts:
  - api.example.com
  gateways:
  - global-gateway
  http:
  - match:
    - headers:
        x-user-region:
          exact: "us"
    route:
    - destination:
        host: api-service.us-east.global
        subset: v2
      weight: 90
    - destination:
        host: api-service.us-west.global
        subset: v2
      weight: 10
    retries:
      attempts: 3
      perTryTimeout: 2s
      retryOn: 5xx,reset,connect-failure,refused-stream
  - match:
    - headers:
        x-user-region:
          exact: "eu"
    route:
    - destination:
        host: api-service.eu-west.global
        subset: v2
      weight: 100
    timeout: 10s
    retries:
      attempts: 3
      perTryTimeout: 2s
  - route:  # Default route with geographic distribution
    - destination:
        host: api-service.us-east.global
        subset: v2
      weight: 40
    - destination:
        host: api-service.us-west.global
        subset: v2
      weight: 30
    - destination:
        host: api-service.eu-west.global
        subset: v2
      weight: 30
    fault:
      delay:
        percentage:
          value: 0.1
        fixedDelay: 5s
---
# DestinationRule for cross-region traffic policies
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: api-service-global
  namespace: production
spec:
  host: "*.global"
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 1000
      http:
        http2MaxRequests: 1000
        maxRequestsPerConnection: 10
    loadBalancer:
      consistentHash:
        httpHeaderName: x-user-id
    outlierDetection:
      consecutiveErrors: 5
      interval: 30s
      baseEjectionTime: 60s
      maxEjectionPercent: 50
      minHealthPercent: 40
  subsets:
  - name: v2
    labels:
      version: v2
    trafficPolicy:
      connectionPool:
        tcp:
          maxConnections: 2000
---
# ServiceEntry for cross-cluster service discovery
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: api-service-us-east
  namespace: production
spec:
  hosts:
  - api-service.us-east.global
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_INTERNAL
  resolution: DNS
  endpoints:
  - address: istio-ingressgateway.us-east-1.example.com
    labels:
      region: us-east-1
      cluster: prod-us-east
---
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: api-service-us-west
  namespace: production
spec:
  hosts:
  - api-service.us-west.global
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_INTERNAL
  resolution: DNS
  endpoints:
  - address: istio-ingressgateway.us-west-2.example.com
    labels:
      region: us-west-2
      cluster: prod-us-west
---
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: api-service-eu-west
  namespace: production
spec:
  hosts:
  - api-service.eu-west.global
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_INTERNAL
  resolution: DNS
  endpoints:
  - address: istio-ingressgateway.eu-west-1.example.com
    labels:
      region: eu-west-1
      cluster: prod-eu-west
```

# Cross-Cluster Service Discovery

## Kubernetes Multi-Cluster Services (MCS) API

```yaml
# ServiceExport to make service available across clusters
---
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: backend-api
  namespace: production
---
# ServiceImport created automatically by MCS controller
# Represents aggregated service from multiple clusters
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: backend-api
  namespace: production
spec:
  type: ClusterSetIP
  ports:
  - port: 8080
    protocol: TCP
  sessionAffinity: None
---
# Application consuming multi-cluster service
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
      - name: frontend
        image: frontend:v1.0
        env:
        - name: BACKEND_URL
          # Use clusterset.local domain for multi-cluster service
          value: "http://backend-api.production.svc.clusterset.local:8080"
```

## Consul Service Mesh Multi-Datacenter

```yaml
# Consul Helm values for multi-datacenter deployment
---
global:
  name: consul
  datacenter: us-east-1
  federation:
    enabled: true
    createFederationSecret: true
  tls:
    enabled: true
    enableAutoEncrypt: true
  acls:
    manageSystemACLs: true
    createReplicationToken: true
  gossipEncryption:
    secretName: consul-gossip-encryption-key
    secretKey: key

server:
  replicas: 5
  bootstrapExpect: 5
  exposeGossipAndRPCPorts: true
  extraConfig: |
    {
      "connect": {
        "enabled": true,
        "enable_mesh_gateway_wan_federation": true
      },
      "primary_datacenter": "us-east-1"
    }

meshGateway:
  enabled: true
  replicas: 3
  wanAddress:
    source: "Service"
    port: 443
  service:
    type: LoadBalancer
    annotations:
      external-dns.alpha.kubernetes.io/hostname: consul-mesh-us-east.example.com

connectInject:
  enabled: true
  default: true
  transparentProxy:
    defaultEnabled: true

dns:
  enabled: true
  enableRedirection: true
---
# Service with cross-datacenter intentions
apiVersion: consul.hashicorp.com/v1alpha1
kind: ServiceIntentions
metadata:
  name: backend-api-intentions
  namespace: production
spec:
  destination:
    name: backend-api
  sources:
  - name: frontend
    action: allow
    permissions:
    - http:
        pathExact: /api/v1/data
        methods: ["GET", "POST"]
  - name: frontend
    action: allow
    datacenter: us-west-2  # Allow from different datacenter
---
# ProxyDefaults for cross-datacenter routing
apiVersion: consul.hashicorp.com/v1alpha1
kind: ProxyDefaults
metadata:
  name: global
  namespace: production
spec:
  meshGateway:
    mode: local
  config:
    protocol: http
    envoy_prometheus_bind_addr: "0.0.0.0:9102"
```

# Data Replication and Consistency

## Multi-Region Database Replication

```yaml
# PostgreSQL with streaming replication across regions
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-primary-config
  namespace: database
data:
  postgresql.conf: |
    listen_addresses = '*'
    max_connections = 200
    shared_buffers = 2GB
    effective_cache_size = 6GB
    maintenance_work_mem = 512MB
    checkpoint_completion_target = 0.9
    wal_buffers = 16MB
    default_statistics_target = 100
    random_page_cost = 1.1
    effective_io_concurrency = 200
    work_mem = 10MB
    min_wal_size = 1GB
    max_wal_size = 4GB

    # Replication settings
    wal_level = replica
    max_wal_senders = 10
    max_replication_slots = 10
    hot_standby = on

  pg_hba.conf: |
    local   all             all                                     trust
    host    all             all             127.0.0.1/32            trust
    host    all             all             ::1/128                 trust
    host    replication     replicator      0.0.0.0/0               md5
    host    all             all             0.0.0.0/0               md5
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-primary
  namespace: database
  labels:
    app: postgres
    role: primary
    region: us-east-1
spec:
  serviceName: postgres-primary
  replicas: 1
  selector:
    matchLabels:
      app: postgres
      role: primary
  template:
    metadata:
      labels:
        app: postgres
        role: primary
    spec:
      containers:
      - name: postgres
        image: postgres:15.3
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
        - name: POSTGRES_USER
          value: "admin"
        - name: POSTGRES_DB
          value: "production"
        - name: PGDATA
          value: "/var/lib/postgresql/data/pgdata"
        volumeMounts:
        - name: postgres-storage
          mountPath: /var/lib/postgresql/data
        - name: config
          mountPath: /etc/postgresql
        resources:
          requests:
            memory: "4Gi"
            cpu: "2000m"
          limits:
            memory: "8Gi"
            cpu: "4000m"
      volumes:
      - name: config
        configMap:
          name: postgres-primary-config
  volumeClaimTemplates:
  - metadata:
      name: postgres-storage
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 500Gi
---
# PostgreSQL replica in DR region
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-replica
  namespace: database
  labels:
    app: postgres
    role: replica
    region: us-west-2
spec:
  serviceName: postgres-replica
  replicas: 2
  selector:
    matchLabels:
      app: postgres
      role: replica
  template:
    metadata:
      labels:
        app: postgres
        role: replica
    spec:
      initContainers:
      - name: setup-replication
        image: postgres:15.3
        command:
        - bash
        - -c
        - |
          if [ ! -f /var/lib/postgresql/data/pgdata/PG_VERSION ]; then
            echo "Setting up replication..."
            PGPASSWORD=$REPLICATION_PASSWORD pg_basebackup \
              -h postgres-primary.database.svc.cluster.local \
              -D /var/lib/postgresql/data/pgdata \
              -U replicator \
              -Fp -Xs -P -R
          fi
        env:
        - name: REPLICATION_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: replication-password
        volumeMounts:
        - name: postgres-storage
          mountPath: /var/lib/postgresql/data
      containers:
      - name: postgres
        image: postgres:15.3
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
        - name: PGDATA
          value: "/var/lib/postgresql/data/pgdata"
        volumeMounts:
        - name: postgres-storage
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            memory: "4Gi"
            cpu: "2000m"
          limits:
            memory: "8Gi"
            cpu: "4000m"
  volumeClaimTemplates:
  - metadata:
      name: postgres-storage
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 500Gi
```

## Distributed Cache with Redis

```yaml
# Redis cluster with cross-region replication
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-config
  namespace: cache
data:
  redis.conf: |
    bind 0.0.0.0
    protected-mode no
    port 6379
    tcp-backlog 511
    timeout 0
    tcp-keepalive 300

    # Persistence
    save 900 1
    save 300 10
    save 60 10000

    # Replication
    min-replicas-to-write 1
    min-replicas-max-lag 10

    # Memory management
    maxmemory 4gb
    maxmemory-policy allkeys-lru

    # AOF persistence
    appendonly yes
    appendfilename "appendonly.aof"
    appendfsync everysec
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-primary
  namespace: cache
  labels:
    app: redis
    role: primary
spec:
  serviceName: redis-primary
  replicas: 3
  selector:
    matchLabels:
      app: redis
      role: primary
  template:
    metadata:
      labels:
        app: redis
        role: primary
    spec:
      containers:
      - name: redis
        image: redis:7.2
        command:
        - redis-server
        - /conf/redis.conf
        - --cluster-enabled
        - "yes"
        - --cluster-config-file
        - /data/nodes.conf
        - --cluster-node-timeout
        - "5000"
        ports:
        - containerPort: 6379
          name: client
        - containerPort: 16379
          name: gossip
        volumeMounts:
        - name: conf
          mountPath: /conf
        - name: data
          mountPath: /data
        resources:
          requests:
            memory: "4Gi"
            cpu: "1000m"
          limits:
            memory: "8Gi"
            cpu: "2000m"
      volumes:
      - name: conf
        configMap:
          name: redis-config
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 50Gi
```

# Disaster Recovery Automation

## Automated Failover Controller

```python
#!/usr/bin/env python3
"""
Multi-region disaster recovery controller
Monitors cluster health and performs automated failover
"""

import time
import logging
from kubernetes import client, config
from prometheus_api_client import PrometheusConnect
import boto3
from typing import Dict, List

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class DisasterRecoveryController:
    def __init__(self):
        self.regions = {
            'primary': {
                'name': 'us-east-1',
                'cluster': 'prod-us-east',
                'context': 'arn:aws:eks:us-east-1:123456789012:cluster/prod-us-east',
                'weight': 100
            },
            'dr1': {
                'name': 'us-west-2',
                'cluster': 'prod-us-west',
                'context': 'arn:aws:eks:us-west-2:123456789012:cluster/prod-us-west',
                'weight': 0
            },
            'dr2': {
                'name': 'eu-west-1',
                'cluster': 'prod-eu-west',
                'context': 'arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu-west',
                'weight': 0
            }
        }

        self.route53 = boto3.client('route53')
        self.prometheus_url = 'http://prometheus.monitoring.svc.cluster.local:9090'

    def check_cluster_health(self, region_config: Dict) -> bool:
        """Check if cluster is healthy"""
        try:
            config.load_kube_config(context=region_config['context'])
            v1 = client.CoreV1Api()

            # Check node status
            nodes = v1.list_node()
            ready_nodes = sum(1 for node in nodes.items
                            if any(condition.type == "Ready" and condition.status == "True"
                                   for condition in node.status.conditions))

            total_nodes = len(nodes.items)
            if ready_nodes / total_nodes < 0.75:
                logger.warning(f"Cluster {region_config['name']}: Only {ready_nodes}/{total_nodes} nodes ready")
                return False

            # Check critical workloads
            apps_v1 = client.AppsV1Api()
            deployments = apps_v1.list_deployment_for_all_namespaces(
                label_selector="criticality=high"
            )

            unhealthy_deployments = []
            for deployment in deployments.items:
                if deployment.status.available_replicas < deployment.spec.replicas * 0.75:
                    unhealthy_deployments.append(deployment.metadata.name)

            if unhealthy_deployments:
                logger.warning(f"Cluster {region_config['name']}: Unhealthy deployments: {unhealthy_deployments}")
                return False

            # Check Prometheus metrics
            prom = PrometheusConnect(url=self.prometheus_url, disable_ssl=True)

            # API latency check
            latency_query = 'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))'
            latency_result = prom.custom_query(latency_query)

            if latency_result and float(latency_result[0]['value'][1]) > 1.0:
                logger.warning(f"Cluster {region_config['name']}: High API latency")
                return False

            # Error rate check
            error_query = 'rate(http_requests_total{status=~"5.."}[5m])'
            error_result = prom.custom_query(error_query)

            if error_result and float(error_result[0]['value'][1]) > 0.01:
                logger.warning(f"Cluster {region_config['name']}: High error rate")
                return False

            logger.info(f"Cluster {region_config['name']}: Healthy")
            return True

        except Exception as e:
            logger.error(f"Health check failed for {region_config['name']}: {str(e)}")
            return False

    def update_dns_weights(self, weights: Dict[str, int]):
        """Update Route53 weighted routing policy"""
        hosted_zone_id = 'Z1234567890ABC'
        domain = 'api.example.com'

        for region, weight in weights.items():
            region_config = self.regions[region]

            # Get load balancer endpoint
            config.load_kube_config(context=region_config['context'])
            v1 = client.CoreV1Api()

            service = v1.read_namespaced_service(
                name='frontend-service',
                namespace='production'
            )

            if service.status.load_balancer.ingress:
                lb_hostname = service.status.load_balancer.ingress[0].hostname

                # Update Route53 record
                change_batch = {
                    'Changes': [{
                        'Action': 'UPSERT',
                        'ResourceRecordSet': {
                            'Name': domain,
                            'Type': 'CNAME',
                            'SetIdentifier': region_config['name'],
                            'Weight': weight,
                            'TTL': 60,
                            'ResourceRecords': [{'Value': lb_hostname}]
                        }
                    }]
                }

                self.route53.change_resource_record_sets(
                    HostedZoneId=hosted_zone_id,
                    ChangeBatch=change_batch
                )

                logger.info(f"Updated DNS weight for {region_config['name']} to {weight}")

    def perform_failover(self, failed_region: str, target_region: str):
        """Perform failover from failed region to target region"""
        logger.warning(f"Initiating failover from {failed_region} to {target_region}")

        target_config = self.regions[target_region]
        config.load_kube_config(context=target_config['context'])

        # Scale up DR deployments
        apps_v1 = client.AppsV1Api()
        deployments = apps_v1.list_deployment_for_all_namespaces(
            label_selector="dr-role=passive"
        )

        for deployment in deployments.items:
            # Scale to primary capacity
            target_replicas = deployment.metadata.annotations.get('dr-target-replicas', '10')
            deployment.spec.replicas = int(target_replicas)

            apps_v1.patch_namespaced_deployment(
                name=deployment.metadata.name,
                namespace=deployment.metadata.namespace,
                body=deployment
            )

            logger.info(f"Scaled deployment {deployment.metadata.name} to {target_replicas} replicas")

        # Update DNS weights
        new_weights = {
            'primary': 0,
            'dr1': 100 if target_region == 'dr1' else 0,
            'dr2': 100 if target_region == 'dr2' else 0
        }

        self.update_dns_weights(new_weights)

        # Send alert
        self.send_alert(f"Failover completed: {failed_region} -> {target_region}")

        logger.info(f"Failover to {target_region} completed")

    def send_alert(self, message: str):
        """Send alert via SNS"""
        sns = boto3.client('sns')
        sns.publish(
            TopicArn='arn:aws:sns:us-east-1:123456789012:dr-alerts',
            Subject='DR Failover Alert',
            Message=message
        )

    def run(self):
        """Main control loop"""
        logger.info("Starting disaster recovery controller")

        consecutive_failures = {'primary': 0, 'dr1': 0, 'dr2': 0}
        failover_threshold = 3

        while True:
            try:
                # Check health of all regions
                health_status = {}
                for region, config in self.regions.items():
                    is_healthy = self.check_cluster_health(config)
                    health_status[region] = is_healthy

                    if not is_healthy:
                        consecutive_failures[region] += 1
                    else:
                        consecutive_failures[region] = 0

                # Check if primary region needs failover
                if consecutive_failures['primary'] >= failover_threshold:
                    # Find healthy DR region
                    if health_status['dr1']:
                        self.perform_failover('primary', 'dr1')
                        consecutive_failures['primary'] = 0
                    elif health_status['dr2']:
                        self.perform_failover('primary', 'dr2')
                        consecutive_failures['primary'] = 0
                    else:
                        logger.error("All regions unhealthy! Cannot perform failover")
                        self.send_alert("CRITICAL: All regions unhealthy")

                # Wait before next check
                time.sleep(30)

            except Exception as e:
                logger.error(f"Error in control loop: {str(e)}")
                time.sleep(60)

if __name__ == '__main__':
    controller = DisasterRecoveryController()
    controller.run()
```

# Monitoring and Observability

## Multi-Region Metrics Aggregation

```yaml
# Thanos deployment for global metrics aggregation
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: thanos-objstore-config
  namespace: monitoring
data:
  objstore.yml: |
    type: S3
    config:
      bucket: thanos-metrics
      endpoint: s3.amazonaws.com
      region: us-east-1
      access_key: ${AWS_ACCESS_KEY_ID}
      secret_key: ${AWS_SECRET_ACCESS_KEY}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app: thanos-query
  template:
    metadata:
      labels:
        app: thanos-query
    spec:
      containers:
      - name: thanos
        image: thanosio/thanos:v0.34.0
        args:
        - query
        - --http-address=0.0.0.0:10902
        - --grpc-address=0.0.0.0:10901
        - --store=dnssrv+_grpc._tcp.thanos-store-us-east.monitoring.svc.cluster.local
        - --store=dnssrv+_grpc._tcp.thanos-store-us-west.monitoring.svc.cluster.local
        - --store=dnssrv+_grpc._tcp.thanos-store-eu-west.monitoring.svc.cluster.local
        - --query.replica-label=replica
        - --query.replica-label=prometheus_replica
        ports:
        - name: http
          containerPort: 10902
        - name: grpc
          containerPort: 10901
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
---
# Grafana dashboard for multi-region overview
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboard-multiregion
  namespace: monitoring
data:
  multi-region.json: |
    {
      "dashboard": {
        "title": "Multi-Region Overview",
        "panels": [
          {
            "title": "Requests by Region",
            "targets": [{
              "expr": "sum(rate(http_requests_total[5m])) by (region)"
            }]
          },
          {
            "title": "Error Rate by Region",
            "targets": [{
              "expr": "sum(rate(http_requests_total{status=~\"5..\"}[5m])) by (region) / sum(rate(http_requests_total[5m])) by (region)"
            }]
          },
          {
            "title": "Cross-Region Latency",
            "targets": [{
              "expr": "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, source_region, target_region))"
            }]
          }
        ]
      }
    }
```

# Conclusion

Multi-region Kubernetes federation requires careful planning and implementation of sophisticated patterns for traffic management, service discovery, data replication, and disaster recovery. The architectures and tools presented in this guide provide a foundation for building globally distributed Kubernetes infrastructure that delivers high availability, optimal performance, and robust disaster recovery capabilities.

Key implementation principles:

- **Architecture Selection**: Choose active-active or active-passive based on requirements
- **Global Load Balancing**: Implement geo-aware traffic distribution
- **Service Discovery**: Use MCS API or service mesh for cross-cluster communication
- **Data Consistency**: Plan replication strategies for stateful workloads
- **Automated Failover**: Implement health monitoring and automated DR procedures
- **Observability**: Deploy comprehensive monitoring across all regions

By following these patterns and best practices, organizations can build enterprise-grade multi-region Kubernetes deployments that provide the reliability, performance, and resilience required for mission-critical applications.