---
title: "Kubernetes Rook Ceph Dashboard: Operations and Monitoring for Production Ceph Clusters"
date: 2031-05-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Rook", "Ceph", "Storage", "Monitoring", "Prometheus", "Dashboard", "Object Storage"]
categories:
- Kubernetes
- Storage
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to enabling and operating the Ceph dashboard in Rook-managed clusters, including TLS configuration, RGW management, Prometheus alerting, capacity planning, and disaster recovery procedures."
more_link: "yes"
url: "/kubernetes-rook-ceph-dashboard-operations-monitoring-production/"
---

Production Ceph clusters require deep operational visibility. The Ceph dashboard, when properly configured with TLS, Prometheus integration, and alerting rules, provides the observability foundation needed for enterprise storage operations. This guide covers every layer of Ceph dashboard management from initial enablement through capacity planning and disaster recovery.

<!--more-->

# Kubernetes Rook Ceph Dashboard: Operations and Monitoring for Production Ceph Clusters

## Section 1: Architecture Overview and Prerequisites

Rook orchestrates Ceph on Kubernetes, managing the full lifecycle of OSDs, monitors, managers, and metadata servers. The Ceph dashboard is served by the Manager daemon (ceph-mgr) and requires specific configuration to be production-ready.

### Cluster Architecture

A production Rook Ceph deployment consists of:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                            │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │   Monitor Pod   │  │   Monitor Pod   │  │   Monitor Pod   │ │
│  │   (ceph-mon)    │  │   (ceph-mon)    │  │   (ceph-mon)    │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐                      │
│  │  Manager Pod    │  │  Manager Pod    │  (active/standby)    │
│  │  (ceph-mgr)     │  │  (ceph-mgr)     │                      │
│  │  + Dashboard    │  │  + Dashboard    │                      │
│  └─────────────────┘  └─────────────────┘                      │
│                                                                  │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐       │
│  │ OSD  │ │ OSD  │ │ OSD  │ │ OSD  │ │ OSD  │ │ OSD  │       │
│  │  0   │ │  1   │ │  2   │ │  3   │ │  4   │ │  5   │       │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘       │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐                      │
│  │   MDS Pod       │  │   RGW Pod       │                      │
│  │   (CephFS)      │  │  (Object Store) │                      │
│  └─────────────────┘  └─────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

### Prerequisites

```bash
# Verify Rook operator is running
kubectl -n rook-ceph get pods -l app=rook-ceph-operator

# Check CephCluster status
kubectl -n rook-ceph get cephcluster rook-ceph -o yaml | grep -A 10 "status:"

# Verify all components healthy
kubectl -n rook-ceph get pods --field-selector=status.phase=Running | wc -l

# Rook version check
kubectl -n rook-ceph get deploy rook-ceph-operator -o jsonpath='{.spec.template.spec.containers[0].image}'
```

### Required Versions

This guide targets:
- Rook: v1.13+
- Ceph: Reef (18.x) or Quincy (17.x)
- Kubernetes: 1.27+

## Section 2: Enabling the Ceph Dashboard

### CephCluster Dashboard Configuration

The dashboard is configured within the CephCluster custom resource:

```yaml
# cephcluster-with-dashboard.yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v18.2.1
    allowUnsupported: false
  dataDirHostPath: /var/lib/rook
  skipUpgradeChecks: false
  continueUpgradeAfterChecksEvenIfNotHealthy: false
  waitTimeoutForHealthyOSDInMinutes: 10

  mon:
    count: 3
    allowMultiplePerNode: false

  mgr:
    count: 2
    allowMultiplePerNode: false
    modules:
      - name: pg_autoscaler
        enabled: true
      - name: dashboard
        enabled: true
      - name: prometheus
        enabled: true
      - name: balancer
        enabled: true
      - name: iostat
        enabled: true

  dashboard:
    enabled: true
    # Use HTTPS (recommended for production)
    ssl: true
    # Custom port (default 8443 for SSL, 7000 for non-SSL)
    port: 8443
    # Serve on localhost only, use Ingress for external access
    urlPrefix: /
    # Object Gateway port for dashboard S3 API access
    objectGatewayAPIPort: 7480

  network:
    connections:
      encryption:
        enabled: true
      compression:
        enabled: false
      requireMsgr2: true

  crashCollector:
    disable: false
    daysToRetain: 30

  logCollector:
    enabled: true
    periodicity: daily
    maxLogSize: 500M

  cleanupPolicy:
    confirmation: ""
    sanitizeDisks:
      method: quick
      dataSource: zero
      iteration: 1
    allowUninstallWithVolumes: false

  monitoring:
    enabled: true
    # Interval for metrics collection
    metricsDisabled: false

  storage:
    useAllNodes: true
    useAllDevices: false
    deviceFilter: "^sd[b-z]"
    config:
      osdsPerDevice: "1"
      encryptedDevice: "false"
    storageClassDeviceSets:
      - name: set1
        count: 3
        portable: false
        tuneDeviceClass: true
        tuneFastDeviceClass: false
        encrypted: false
        placement:
          topologySpreadConstraints:
            - maxSkew: 1
              topologyKey: kubernetes.io/hostname
              whenUnsatisfiable: DoNotSchedule
              labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - rook-ceph-osd
        preparePlacement:
          podAntiAffinity:
            preferredDuringSchedulingIgnoredDuringExecution:
              - weight: 100
                podAffinityTerm:
                  labelSelector:
                    matchExpressions:
                      - key: app
                        operator: In
                        values:
                          - rook-ceph-osd-prepare
                  topologyKey: kubernetes.io/hostname
        resources:
          limits:
            cpu: "2"
            memory: "4Gi"
          requests:
            cpu: "1"
            memory: "2Gi"
        volumeClaimTemplates:
          - metadata:
              name: data
            spec:
              resources:
                requests:
                  storage: 1Ti
              storageClassName: local-storage
              volumeMode: Block
              accessModes:
                - ReadWriteOnce

  priorityClassNames:
    mon: system-node-critical
    osd: system-node-critical
    mgr: system-cluster-critical
    mds: system-cluster-critical

  disruptionManagement:
    managePodBudgets: true
    osdMaintenanceTimeout: 30
    pgHealthCheckTimeout: 0
    manageMachineDisruptionBudgets: false
    machineDisruptionBudgetNamespace: openshift-machine-api
```

Apply the configuration:

```bash
kubectl apply -f cephcluster-with-dashboard.yaml

# Monitor the operator reconciliation
kubectl -n rook-ceph logs -f deployment/rook-ceph-operator --tail=100
```

### Retrieving Dashboard Credentials

```bash
# Get the admin password (stored as a Kubernetes secret)
kubectl -n rook-ceph get secret rook-ceph-dashboard-password \
  -o jsonpath='{.data.password}' | base64 --decode

# Default username is 'admin'
# Store credentials securely
CEPH_DASHBOARD_PASS=$(kubectl -n rook-ceph get secret rook-ceph-dashboard-password \
  -o jsonpath='{.data.password}' | base64 --decode)
echo "Dashboard Password: ${CEPH_DASHBOARD_PASS}"
```

### Setting Custom Admin Password

```bash
# Create a secret with a custom password
kubectl -n rook-ceph create secret generic rook-ceph-dashboard-password \
  --from-literal=password='YourSecurePasswordHere' \
  --dry-run=client -o yaml | kubectl apply -f -

# Alternatively, use the Ceph CLI to set the password
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph dashboard set-login-credentials admin 'YourSecurePasswordHere'
```

## Section 3: TLS Configuration for the Dashboard

### Option 1: Using cert-manager with Let's Encrypt

```yaml
# dashboard-certificate.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ceph-dashboard-tls
  namespace: rook-ceph
spec:
  secretName: ceph-dashboard-tls-secret
  duration: 2160h  # 90 days
  renewBefore: 360h  # 15 days
  subject:
    organizations:
      - YourOrganization
  isCA: false
  privateKey:
    algorithm: RSA
    encoding: PKCS1
    size: 4096
  usages:
    - server auth
    - client auth
  dnsNames:
    - ceph.yourdomain.com
    - ceph-dashboard.yourdomain.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
    group: cert-manager.io
```

### Option 2: Self-Signed Certificate with cert-manager

```yaml
# self-signed-issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ceph-dashboard-selfsigned
  namespace: rook-ceph
spec:
  secretName: ceph-dashboard-tls-secret
  duration: 8760h  # 1 year
  renewBefore: 720h  # 30 days
  isCA: false
  privateKey:
    algorithm: ECDSA
    size: 256
  usages:
    - server auth
  dnsNames:
    - ceph.internal.yourdomain.com
  ipAddresses:
    - 10.96.0.0
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
```

### Configuring Rook to Use Custom TLS Certificate

```bash
# Apply the custom TLS certificate to the Ceph dashboard
# Extract cert and key from the cert-manager secret
CERT=$(kubectl -n rook-ceph get secret ceph-dashboard-tls-secret \
  -o jsonpath='{.data.tls\.crt}' | base64 --decode)
KEY=$(kubectl -n rook-ceph get secret ceph-dashboard-tls-secret \
  -o jsonpath='{.data.tls\.key}' | base64 --decode)

# Apply using the toolbox
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash -c "
  echo '${CERT}' > /tmp/dashboard.crt
  echo '${KEY}' > /tmp/dashboard.key
  ceph dashboard set-ssl-certificate -i /tmp/dashboard.crt
  ceph dashboard set-ssl-certificate-key -i /tmp/dashboard.key
  ceph mgr module disable dashboard
  ceph mgr module enable dashboard
"
```

### Ingress Configuration for Dashboard Access

```yaml
# dashboard-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: rook-ceph-mgr-dashboard
  namespace: rook-ceph
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - ceph.yourdomain.com
      secretName: ceph-dashboard-ingress-tls
  rules:
    - host: ceph.yourdomain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: rook-ceph-mgr-dashboard
                port:
                  number: 8443
```

```bash
# Verify the dashboard service
kubectl -n rook-ceph get svc rook-ceph-mgr-dashboard
# NAME                      TYPE        CLUSTER-IP      PORT(S)    AGE
# rook-ceph-mgr-dashboard   ClusterIP   10.96.45.210    8443/TCP   2d

# Port-forward for local access
kubectl -n rook-ceph port-forward svc/rook-ceph-mgr-dashboard 8443:8443 &
echo "Dashboard available at: https://localhost:8443"
```

## Section 4: Object Storage (RGW) Management

### CephObjectStore Configuration

```yaml
# ceph-objectstore.yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata:
  name: my-store
  namespace: rook-ceph
spec:
  metadataPool:
    failureDomain: host
    replicated:
      size: 3
      requireSafeReplicaSize: true
    parameters:
      compression_mode: passive
  dataPool:
    failureDomain: host
    erasureCoded:
      dataChunks: 4
      codingChunks: 2
    parameters:
      compression_mode: passive
  preservePoolsOnDelete: true
  gateway:
    # SSLCertificateRef: my-ssl-certificate-secret
    port: 80
    securePort: 443
    instances: 2
    priorityClassName: system-cluster-critical
    resources:
      limits:
        cpu: "2"
        memory: "4Gi"
      requests:
        cpu: "500m"
        memory: "1Gi"
    placement:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: rook-ceph-rgw
              topologyKey: kubernetes.io/hostname
  healthCheck:
    bucket:
      disabled: false
      interval: 60s
```

### Creating Object Store Users

```yaml
# rgw-user.yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: my-user
  namespace: rook-ceph
spec:
  store: my-store
  displayName: "My S3 User"
  capabilities:
    user: "*"
    bucket: "*"
  quotas:
    maxBuckets: 100
    maxSize: 10Gi
    maxObjects: 1000000
```

```bash
# Get user credentials after creation
kubectl -n rook-ceph get secret rook-ceph-object-user-my-store-my-user \
  -o jsonpath='{.data.AccessKey}' | base64 --decode
kubectl -n rook-ceph get secret rook-ceph-object-user-my-store-my-user \
  -o jsonpath='{.data.SecretKey}' | base64 --decode

# Verify RGW endpoint
kubectl -n rook-ceph get svc rook-ceph-rgw-my-store

# Test with AWS CLI (using placeholder credentials)
AWS_ACCESS_KEY_ID=<aws-access-key-id> \
AWS_SECRET_ACCESS_KEY=<aws-secret-access-key> \
aws s3 ls --endpoint-url http://rook-ceph-rgw-my-store.rook-ceph.svc:80
```

### Managing RGW Through the Dashboard

```bash
# Enable RGW management in dashboard
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph dashboard set-rgw-api-access-key -i /tmp/access-key
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph dashboard set-rgw-api-secret-key -i /tmp/secret-key
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph dashboard set-rgw-api-host rook-ceph-rgw-my-store.rook-ceph.svc
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph dashboard set-rgw-api-port 80
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph dashboard set-rgw-api-scheme http

# Verify RGW configuration
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph dashboard get-rgw-api-host
```

### RGW Performance Monitoring Commands

```bash
# Check RGW performance counters
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph daemon osd.0 perf dump 2>/dev/null | jq '.rgw'

# RGW stats per user
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  radosgw-admin user stats --uid=my-user

# Bucket statistics
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  radosgw-admin bucket stats --bucket=my-bucket

# List all buckets across users
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  radosgw-admin bucket list

# Check for orphan objects
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  radosgw-admin orphans find --pool=.rgw.root --job-id=orphan-check-001
```

## Section 5: CephBlockPool and CephFilesystem Health Metrics

### CephBlockPool Configuration

```yaml
# ceph-blockpool.yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  failureDomain: host
  replicated:
    size: 3
    requireSafeReplicaSize: true
    hybridStorage:
      primaryDeviceClass: nvme
      secondaryDeviceClass: hdd
  parameters:
    # Enable compression
    compression_mode: passive
    # Target object size
    target_size_ratio: ".5"
    # Enable pg autoscaling
    pg_autoscale_mode: on
    bulk: "false"
  mirroring:
    enabled: false
    mode: image
  quotas:
    maxSize: 100Ti
    maxObjects: 0
  statusCheck:
    mirror:
      disabled: false
      interval: 60s
```

### CephFilesystem Configuration

```yaml
# ceph-filesystem.yaml
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: myfs
  namespace: rook-ceph
spec:
  metadataPool:
    replicated:
      size: 3
      requireSafeReplicaSize: true
    parameters:
      compression_mode: none
  dataPools:
    - name: replicated
      failureDomain: host
      replicated:
        size: 3
        requireSafeReplicaSize: true
      parameters:
        compression_mode: passive
    - name: ec-pool
      failureDomain: host
      erasureCoded:
        dataChunks: 4
        codingChunks: 2
  preserveFilesystemOnDelete: true
  metadataServer:
    activeCount: 1
    activeStandby: true
    placement:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: rook-ceph-mds
              topologyKey: kubernetes.io/hostname
    priorityClassName: system-cluster-critical
    resources:
      limits:
        cpu: "4"
        memory: "8Gi"
      requests:
        cpu: "1"
        memory: "4Gi"
```

### Health Check Commands

```bash
# Overall cluster health
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph status

# Detailed health warnings
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph health detail

# Pool statistics
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph df detail

# PG distribution
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph pg dump_pools_json | jq '.[] | {pool: .poolid, pgs: .pg_stats_sum.num_pgs}'

# OSD utilization
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd df tree

# Check for degraded PGs
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph pg ls degraded 2>/dev/null | head -20

# MDS status
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph mds stat

# Check filesystem health
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph fs status myfs
```

## Section 6: Prometheus Alert Rules for Ceph

### PrometheusRule Configuration

```yaml
# ceph-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ceph-storage-alerts
  namespace: rook-ceph
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: ceph.cluster
      interval: 30s
      rules:
        - alert: CephHealthCritical
          expr: ceph_health_status == 2
          for: 5m
          labels:
            severity: critical
            team: storage
          annotations:
            summary: "Ceph cluster health is CRITICAL"
            description: "Ceph cluster {{ $labels.cluster }} is in HEALTH_ERR state for more than 5 minutes."
            runbook: "https://wiki.yourdomain.com/runbooks/ceph-health-critical"

        - alert: CephHealthWarning
          expr: ceph_health_status == 1
          for: 15m
          labels:
            severity: warning
            team: storage
          annotations:
            summary: "Ceph cluster health is WARNING"
            description: "Ceph cluster {{ $labels.cluster }} is in HEALTH_WARN state for more than 15 minutes."

        - alert: CephOSDDown
          expr: ceph_osd_up == 0
          for: 5m
          labels:
            severity: critical
            team: storage
          annotations:
            summary: "Ceph OSD is down"
            description: "Ceph OSD {{ $labels.ceph_daemon }} on cluster {{ $labels.cluster }} is down for more than 5 minutes."

        - alert: CephOSDNearFull
          expr: >
            (ceph_osd_stat_bytes_used / ceph_osd_stat_bytes) * 100 > 80
          for: 10m
          labels:
            severity: warning
            team: storage
          annotations:
            summary: "Ceph OSD near full"
            description: "OSD {{ $labels.ceph_daemon }} usage is {{ $value | humanizePercentage }}. Action required before hitting full threshold."

        - alert: CephOSDFull
          expr: >
            (ceph_osd_stat_bytes_used / ceph_osd_stat_bytes) * 100 > 95
          for: 1m
          labels:
            severity: critical
            team: storage
          annotations:
            summary: "Ceph OSD is full"
            description: "OSD {{ $labels.ceph_daemon }} is at {{ $value | humanizePercentage }} utilization. Immediate action required."

        - alert: CephMonQuorumLost
          expr: ceph_mon_quorum_count < 3
          for: 2m
          labels:
            severity: critical
            team: storage
          annotations:
            summary: "Ceph monitor quorum at risk"
            description: "Only {{ $value }} monitors in quorum. Minimum 2 required for safe operation, 3 for redundancy."

        - alert: CephPGsUnhealthy
          expr: >
            ceph_pg_active == 0
              or
            ceph_pg_degraded > 0
              or
            ceph_pg_incomplete > 0
          for: 10m
          labels:
            severity: warning
            team: storage
          annotations:
            summary: "Ceph placement groups unhealthy"
            description: "Unhealthy PGs detected: Active={{ $labels.ceph_pg_active }}, Degraded={{ $labels.ceph_pg_degraded }}."

        - alert: CephPoolNearFull
          expr: >
            (ceph_pool_stored / (ceph_pool_stored + ceph_pool_max_avail)) * 100 > 75
          for: 10m
          labels:
            severity: warning
            team: storage
          annotations:
            summary: "Ceph pool is near full"
            description: "Pool {{ $labels.name }} is at {{ $value | humanizePercentage }} utilization."

        - alert: CephPoolFull
          expr: >
            (ceph_pool_stored / (ceph_pool_stored + ceph_pool_max_avail)) * 100 > 90
          for: 1m
          labels:
            severity: critical
            team: storage
          annotations:
            summary: "Ceph pool is full"
            description: "Pool {{ $labels.name }} is at {{ $value | humanizePercentage }}. Write operations may fail."

        - alert: CephSlowOps
          expr: ceph_osd_op_latency_count > 0 and ceph_osd_op_process_latency_sum / ceph_osd_op_process_latency_count > 2
          for: 5m
          labels:
            severity: warning
            team: storage
          annotations:
            summary: "Ceph slow operations detected"
            description: "OSD {{ $labels.ceph_daemon }} has slow operations. Average latency exceeds 2 seconds."

        - alert: CephMgrModuleFailure
          expr: ceph_mgr_module_can_run == 0
          for: 5m
          labels:
            severity: warning
            team: storage
          annotations:
            summary: "Ceph manager module failure"
            description: "Ceph manager module {{ $labels.name }} cannot run on cluster {{ $labels.cluster }}."

    - name: ceph.capacity
      interval: 60s
      rules:
        - alert: CephClusterCapacityWarning
          expr: >
            (sum(ceph_osd_stat_bytes_used) / sum(ceph_osd_stat_bytes)) * 100 > 70
          for: 30m
          labels:
            severity: warning
            team: storage
          annotations:
            summary: "Ceph cluster capacity warning"
            description: "Cluster {{ $labels.cluster }} total storage usage is at {{ $value | humanizePercentage }}."

        - alert: CephClusterCapacityCritical
          expr: >
            (sum(ceph_osd_stat_bytes_used) / sum(ceph_osd_stat_bytes)) * 100 > 85
          for: 15m
          labels:
            severity: critical
            team: storage
          annotations:
            summary: "Ceph cluster capacity critical"
            description: "Cluster {{ $labels.cluster }} is at {{ $value | humanizePercentage }} capacity. Add OSDs immediately."

        - alert: CephRGWHighLatency
          expr: >
            rate(ceph_rgw_get_initial_lat_sum[5m]) / rate(ceph_rgw_get_initial_lat_count[5m]) > 1
          for: 10m
          labels:
            severity: warning
            team: storage
          annotations:
            summary: "Ceph RGW high latency"
            description: "RGW GET latency is {{ $value }}s. Investigate RGW performance."

    - name: ceph.mds
      interval: 30s
      rules:
        - alert: CephMDSDown
          expr: ceph_mds_metadata{state!="up:active"} == 1
          for: 5m
          labels:
            severity: critical
            team: storage
          annotations:
            summary: "Ceph MDS is not active"
            description: "CephFS MDS {{ $labels.ceph_daemon }} is in state {{ $labels.state }}."

        - alert: CephMDSHighLoad
          expr: ceph_mds_inodes > 1000000
          for: 15m
          labels:
            severity: warning
            team: storage
          annotations:
            summary: "CephFS high inode count"
            description: "CephFS MDS {{ $labels.ceph_daemon }} managing {{ $value }} inodes. Performance may degrade."
```

### Grafana Dashboard ConfigMap

```yaml
# ceph-grafana-dashboard.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ceph-cluster-overview
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
    app: grafana
data:
  ceph-overview.json: |
    {
      "title": "Ceph Cluster Overview",
      "uid": "ceph-cluster-overview",
      "panels": [
        {
          "id": 1,
          "title": "Cluster Health",
          "type": "stat",
          "targets": [{
            "expr": "ceph_health_status",
            "legendFormat": "{{cluster}}"
          }],
          "fieldConfig": {
            "defaults": {
              "mappings": [
                {"type": "value", "value": 0, "text": "HEALTHY", "color": "green"},
                {"type": "value", "value": 1, "text": "WARNING", "color": "yellow"},
                {"type": "value", "value": 2, "text": "ERROR", "color": "red"}
              ]
            }
          }
        },
        {
          "id": 2,
          "title": "Total Capacity",
          "type": "gauge",
          "targets": [{
            "expr": "(sum(ceph_osd_stat_bytes_used) / sum(ceph_osd_stat_bytes)) * 100",
            "legendFormat": "Used %"
          }]
        }
      ]
    }
```

## Section 7: Capacity Planning with Ceph OSD Tree

### OSD Tree Analysis

```bash
# Get full OSD tree
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd tree

# Example output:
# ID   CLASS  WEIGHT    TYPE NAME               STATUS  REWEIGHT  PRI-AFF
# -1          86.47299  root default
# -3          28.82433      host node-01
#  0    nvme   3.63699          osd.0             up     1.00000  1.00000
#  1    nvme   3.63699          osd.1             up     1.00000  1.00000
#  6    hdd    7.27599          osd.6             up     1.00000  1.00000

# Get OSD utilization detail
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd df tree format json-pretty

# Identify imbalanced OSDs
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash -c "
  ceph osd df | awk 'NR>1 && /osd/ {
    if (\$6 > 80) print \"WARNING: OSD\", \$1, \"at\", \$6\"%\"
    else if (\$6 > 70) print \"INFO: OSD\", \$1, \"at\", \$6\"%\"
  }'
"

# Check PG distribution per OSD
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph pg dump pgs_brief 2>/dev/null | awk '{print $NF}' | \
  tr ',' '\n' | sort | uniq -c | sort -rn | head -20
```

### Capacity Planning Script

```bash
#!/bin/bash
# ceph-capacity-report.sh - Generate capacity planning report

NAMESPACE="rook-ceph"
TOOLBOX_POD=$(kubectl -n ${NAMESPACE} get pod -l app=rook-ceph-tools \
  -o jsonpath='{.items[0].metadata.name}')

generate_capacity_report() {
    echo "====================================="
    echo "Ceph Capacity Planning Report"
    echo "Generated: $(date)"
    echo "====================================="

    # Raw capacity
    echo ""
    echo "--- Raw Capacity ---"
    kubectl -n ${NAMESPACE} exec ${TOOLBOX_POD} -- \
        ceph df 2>/dev/null | head -20

    # OSD utilization
    echo ""
    echo "--- OSD Utilization ---"
    kubectl -n ${NAMESPACE} exec ${TOOLBOX_POD} -- \
        ceph osd df 2>/dev/null | awk 'NR<=1 || /osd/ || /TOTAL/'

    # Pool breakdown
    echo ""
    echo "--- Pool Breakdown ---"
    kubectl -n ${NAMESPACE} exec ${TOOLBOX_POD} -- \
        ceph df detail 2>/dev/null | grep -A 100 "POOLS:"

    # Growth rate estimation (requires historical data)
    echo ""
    echo "--- Growth Estimation ---"
    TOTAL_BYTES=$(kubectl -n ${NAMESPACE} exec ${TOOLBOX_POD} -- \
        ceph df --format json 2>/dev/null | jq '.stats.total_bytes')
    USED_BYTES=$(kubectl -n ${NAMESPACE} exec ${TOOLBOX_POD} -- \
        ceph df --format json 2>/dev/null | jq '.stats.total_used_bytes')
    AVAIL_BYTES=$(kubectl -n ${NAMESPACE} exec ${TOOLBOX_POD} -- \
        ceph df --format json 2>/dev/null | jq '.stats.total_avail_bytes')

    USED_PCT=$(echo "scale=2; ${USED_BYTES} * 100 / ${TOTAL_BYTES}" | bc)
    AVAIL_GB=$(echo "scale=2; ${AVAIL_BYTES} / 1073741824" | bc)

    echo "Total: $(echo "scale=2; ${TOTAL_BYTES} / 1099511627776" | bc) TiB"
    echo "Used: ${USED_PCT}%"
    echo "Available: ${AVAIL_GB} GiB"

    # Recommend actions
    echo ""
    echo "--- Recommendations ---"
    if (( $(echo "${USED_PCT} > 80" | bc -l) )); then
        echo "CRITICAL: Add OSDs immediately. Consider:"
        echo "  1. Adding new OSD nodes"
        echo "  2. Expanding existing OSD volumes"
        echo "  3. Deleting unused data/snapshots"
    elif (( $(echo "${USED_PCT} > 70" | bc -l) )); then
        echo "WARNING: Plan OSD expansion. Target 80% threshold in:"
        echo "  - Estimate days to 80%: TBD (requires growth rate data)"
    else
        echo "OK: Capacity utilization is within acceptable limits"
    fi
}

generate_capacity_report
```

### Rebalancing and OSD Weight Management

```bash
# Check current CRUSH map
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd crush dump | jq '.buckets[] | {name: .name, items: .items}'

# Adjust OSD weight for rebalancing
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd crush reweight osd.5 2.0

# Reweight all OSDs based on utilization
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd reweight-by-utilization

# Check balancer status
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph balancer status

# Enable balancer with upmap mode for better distribution
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph balancer mode upmap
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph balancer on
```

## Section 8: Disaster Recovery Procedures

### Scenario 1: Recovering from Total Monitor Loss

```bash
# CRITICAL: Only proceed if all monitors are down
# This procedure forces a new quorum with a single monitor

# Step 1: Identify OSD hosts with monitor data
kubectl -n rook-ceph get pods -l app=rook-ceph-mon -o wide

# Step 2: Access the monitor data on a surviving node
# Assuming mon data is on hostpath /var/lib/rook
ls /var/lib/rook/mon-a/data/

# Step 3: Create emergency monitor recovery pod
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: mon-recovery
  namespace: rook-ceph
spec:
  hostNetwork: true
  nodeSelector:
    kubernetes.io/hostname: "node-with-mon-data"
  containers:
  - name: recovery
    image: quay.io/ceph/ceph:v18.2.1
    command: ["sleep", "infinity"]
    volumeMounts:
    - name: mon-data
      mountPath: /var/lib/ceph/mon
  volumes:
  - name: mon-data
    hostPath:
      path: /var/lib/rook/mon-a/data
EOF

# Step 4: Force a single-monitor quorum
kubectl -n rook-ceph exec -it mon-recovery -- \
  ceph-mon --mkfs --cluster ceph --id a --monmap /var/lib/ceph/mon/ceph-a/monmap

# Step 5: Restart the operator to re-reconcile
kubectl -n rook-ceph rollout restart deployment rook-ceph-operator
```

### Scenario 2: Recovering Corrupted OSD

```bash
# Mark OSD as out before recovery
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd out osd.3

# Stop the OSD pod
kubectl -n rook-ceph scale deploy rook-ceph-osd-3 --replicas=0

# Wipe the OSD disk if needed (DESTRUCTIVE)
# kubectl -n rook-ceph exec -it <node-pod> -- \
#   sgdisk --zap-all /dev/sdc

# Remove the OSD from CRUSH map
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd crush remove osd.3

# Remove the auth key
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph auth del osd.3

# Remove the OSD
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph osd rm osd.3

# Delete the OSD deployment
kubectl -n rook-ceph delete deploy rook-ceph-osd-3

# Delete the OSD's PVC if applicable
kubectl -n rook-ceph delete pvc <osd-3-pvc-name>

# Rook operator will automatically provision a new OSD
# Monitor recovery progress
watch kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph status
```

### Scenario 3: Recovering Stuck PGs

```bash
# Identify stuck PGs
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph pg dump stuck | head -30

# Force a specific PG to recover
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph pg repair 2.1f

# Force recovery of all stale PGs
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash -c "
  for pg in \$(ceph pg dump stuck stale 2>/dev/null | grep -v 'ok' | awk '{print \$1}' | grep '^[0-9]'); do
    echo \"Forcing recovery of PG: \${pg}\"
    ceph pg repair \${pg}
  done
"

# Adjust recovery settings to speed up recovery
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash -c "
  # Increase recovery priority during maintenance
  ceph osd set recovery_max_active 3
  ceph config set osd osd_recovery_max_single_start 5
  ceph config set osd osd_recovery_sleep 0
  # Remember to reset after recovery
"

# Monitor PG recovery progress
watch kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph pg stat
```

### Scenario 4: Full Cluster Recovery from Backup

```bash
# Restore Rook CephCluster configuration
kubectl apply -f cephcluster-backup.yaml

# Wait for operator to initialize monitors
kubectl -n rook-ceph wait --for=condition=Ready pod \
  -l app=rook-ceph-mon --timeout=300s

# Import RADOS objects from backup (if using object backup)
# This assumes you have S3 backup via Velero or similar
kubectl apply -f velero-restore.yaml

# Verify cluster state after restore
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph status

# Check all pools are accessible
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- \
  ceph df
```

## Section 9: Dashboard API Integration

### Using the Dashboard REST API

```bash
# Login and get JWT token
TOKEN=$(curl -sk -X POST https://ceph.yourdomain.com/api/auth \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "yourpassword"}' \
  | jq -r '.token')

# Get cluster status
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  https://ceph.yourdomain.com/api/health/full | jq '.'

# List OSDs
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  https://ceph.yourdomain.com/api/osd | jq '.[].id'

# Get pool list
curl -sk -H "Authorization: Bearer ${TOKEN}" \
  https://ceph.yourdomain.com/api/pool | jq '.[].pool_name'

# Create a pool via API
curl -sk -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "pool": "my-new-pool",
    "pg_num": 32,
    "pool_type": "replicated",
    "size": 3
  }' \
  https://ceph.yourdomain.com/api/pool
```

### Automating Dashboard Health Checks

```python
#!/usr/bin/env python3
"""Ceph Dashboard health check script for monitoring integration."""

import requests
import json
import sys
import os

DASHBOARD_URL = os.environ.get("CEPH_DASHBOARD_URL", "https://ceph.yourdomain.com")
DASHBOARD_USER = os.environ.get("CEPH_DASHBOARD_USER", "admin")
DASHBOARD_PASS = os.environ.get("CEPH_DASHBOARD_PASS", "")


def get_token(session: requests.Session) -> str:
    """Authenticate and retrieve JWT token."""
    response = session.post(
        f"{DASHBOARD_URL}/api/auth",
        json={"username": DASHBOARD_USER, "password": DASHBOARD_PASS},
        verify=False,
        timeout=30
    )
    response.raise_for_status()
    return response.json()["token"]


def check_cluster_health(session: requests.Session, token: str) -> dict:
    """Get cluster health status."""
    response = session.get(
        f"{DASHBOARD_URL}/api/health/full",
        headers={"Authorization": f"Bearer {token}"},
        verify=False,
        timeout=30
    )
    response.raise_for_status()
    return response.json()


def check_osd_status(session: requests.Session, token: str) -> list:
    """Get all OSD statuses."""
    response = session.get(
        f"{DASHBOARD_URL}/api/osd",
        headers={"Authorization": f"Bearer {token}"},
        verify=False,
        timeout=30
    )
    response.raise_for_status()
    return response.json()


def main():
    session = requests.Session()

    try:
        token = get_token(session)
        health = check_cluster_health(session, token)
        osds = check_osd_status(session, token)

        # Check health status
        health_status = health.get("health", {}).get("status", "UNKNOWN")
        print(f"Cluster Health: {health_status}")

        if health_status == "HEALTH_ERR":
            print("ERROR: Cluster is in HEALTH_ERR state")
            for check in health.get("health", {}).get("checks", {}).values():
                print(f"  - {check.get('summary', {}).get('message', '')}")
            sys.exit(2)
        elif health_status == "HEALTH_WARN":
            print("WARNING: Cluster has health warnings")
            sys.exit(1)

        # Check OSDs
        down_osds = [o for o in osds if o.get("up", 1) == 0]
        if down_osds:
            print(f"WARNING: {len(down_osds)} OSDs are down: {[o['id'] for o in down_osds]}")
            sys.exit(1)

        print(f"OK: All {len(osds)} OSDs up, cluster healthy")
        sys.exit(0)

    except requests.RequestException as e:
        print(f"ERROR: Failed to connect to Ceph dashboard: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
```

## Section 10: Production Operational Runbook

### Daily Operations Checklist

```bash
#!/bin/bash
# ceph-daily-check.sh

NAMESPACE="rook-ceph"

echo "=== Ceph Daily Operations Check ==="
echo "Date: $(date)"
echo ""

# 1. Cluster health
echo "1. Cluster Health:"
kubectl -n ${NAMESPACE} exec deploy/rook-ceph-tools -- ceph health 2>/dev/null
echo ""

# 2. OSD count
echo "2. OSD Status:"
kubectl -n ${NAMESPACE} exec deploy/rook-ceph-tools -- \
  ceph osd stat 2>/dev/null
echo ""

# 3. Monitor quorum
echo "3. Monitor Quorum:"
kubectl -n ${NAMESPACE} exec deploy/rook-ceph-tools -- \
  ceph quorum_status --format json 2>/dev/null | \
  jq -r '"Quorum size: \(.quorum | length), Members: \(.quorum_names | join(", "))"'
echo ""

# 4. Capacity
echo "4. Capacity Summary:"
kubectl -n ${NAMESPACE} exec deploy/rook-ceph-tools -- \
  ceph df 2>/dev/null | grep -E "GLOBAL|TOTAL|RAW"
echo ""

# 5. Slow ops
echo "5. Slow Operations:"
SLOW_OPS=$(kubectl -n ${NAMESPACE} exec deploy/rook-ceph-tools -- \
  ceph health detail 2>/dev/null | grep -c "slow ops" || echo 0)
echo "Slow ops warnings: ${SLOW_OPS}"
echo ""

# 6. Recent events
echo "6. Recent Health Events (last 24h):"
kubectl -n ${NAMESPACE} exec deploy/rook-ceph-tools -- \
  ceph log last 20 2>/dev/null | grep -E "ERR|WRN" | tail -5
```

### Alert Response Procedures

| Alert | Severity | Initial Response |
|-------|----------|-----------------|
| CephHealthCritical | Critical | Check `ceph status`, identify failing component, page on-call |
| CephOSDDown | Critical | Verify OSD pod status, check node health, attempt restart |
| CephOSDNearFull | Warning | Plan capacity expansion within 48 hours |
| CephMonQuorumLost | Critical | Immediate escalation, risk of data unavailability |
| CephPGsUnhealthy | Warning | Monitor recovery, check for failing OSDs |
| CephSlowOps | Warning | Check underlying storage performance |

This guide provides a complete operational foundation for Ceph dashboard management in production Kubernetes environments. Regular execution of capacity planning scripts and maintenance of alerting rules ensures high storage availability.
