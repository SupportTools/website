---
title: "Kubernetes Multi-Region Deployments: Traffic Routing, Data Sync, and Failover"
date: 2027-07-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Region", "High Availability", "Traffic Management", "Architecture"]
categories:
- Kubernetes
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to multi-region Kubernetes deployments. Covers global load balancing, Cluster API federation, KubeFed vs GitOps, CockroachDB and Vitess database replication, cross-region Istio and Cilium Cluster Mesh, latency-based routing, and DNS health checks."
more_link: "yes"
url: "/kubernetes-multi-region-deployment-guide/"
---

Running Kubernetes workloads in a single region is a single point of failure at the infrastructure level. Multi-region deployments eliminate that risk by distributing compute, storage, and network across geographically separated data centers. The challenge is that multi-region architecture introduces distributed systems complexity at every layer: traffic routing, data consistency, secret synchronization, service discovery, and failover automation. This guide addresses each of those layers with concrete patterns and production-tested configuration.

<!--more-->

## Multi-Region Architecture Patterns

Before selecting tools, the architecture pattern must match the workload's consistency and availability requirements.

### Pattern Comparison

```
Pattern 1: Active-Passive (Failover)
┌────────────────────┐      ┌────────────────────┐
│ Region A (primary) │      │ Region B (standby)  │
│ ✓ Serving traffic  │ sync │ ✗ Not serving       │
│ ✓ Read/Write DB    │─────▶│ ✓ Replica DB only   │
└────────────────────┘      └────────────────────┘
DNS health check triggers automatic failover to B.
RPO: seconds to minutes (replication lag).

Pattern 2: Active-Active (Geographic Sharding)
┌────────────────────┐      ┌────────────────────┐
│ Region A           │      │ Region B           │
│ Users: Americas    │ sync │ Users: EMEA        │
│ ✓ Read/Write DB    │◀────▶│ ✓ Read/Write DB    │
└────────────────────┘      └────────────────────┘
Each region owns a shard of the user base.
RPO: 0 for shard-owned data; eventual consistency for cross-shard.

Pattern 3: Active-Active (Distributed)
┌────────────────────┐      ┌────────────────────┐
│ Region A           │      │ Region B           │
│ ✓ All users        │◀────▶│ ✓ All users        │
│ ✓ Read/Write DB    │      │ ✓ Read/Write DB    │
└────────────────────┘      └────────────────────┘
Requires distributed database (CockroachDB, Spanner, Vitess).
RPO: 0. Highest operational complexity.
```

## Cluster API for Federated Provisioning

Cluster API (CAPI) provides a declarative interface for provisioning and managing multiple Kubernetes clusters across regions.

### Management Cluster Setup

```bash
# Install clusterctl
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.8.5/clusterctl-linux-amd64 \
  -o /usr/local/bin/clusterctl
chmod +x /usr/local/bin/clusterctl

# Initialize the management cluster
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=REPLACE_WITH_ACCESS_KEY
export AWS_SECRET_ACCESS_KEY=REPLACE_WITH_SECRET_KEY
export AWS_SESSION_TOKEN=""

clusterctl init \
  --infrastructure aws \
  --bootstrap kubeadm \
  --control-plane kubeadm

# Verify providers
clusterctl describe provider --core cluster-api
clusterctl describe provider --infrastructure aws
```

### Workload Cluster Definition

```yaml
# cluster-us-east-1.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: prod-us-east-1
  namespace: clusters
  labels:
    region: us-east-1
    tier: production
spec:
  clusterNetwork:
    pods:
      cidrBlocks: ["10.10.0.0/16"]
    services:
      cidrBlocks: ["10.20.0.0/16"]
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: prod-us-east-1
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: prod-us-east-1-control-plane
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: prod-us-east-1
  namespace: clusters
spec:
  region: us-east-1
  sshKeyName: platform-keypair
  network:
    vpc:
      cidrBlock: "10.10.0.0/16"
    subnets:
      - availabilityZone: us-east-1a
        cidrBlock: "10.10.0.0/24"
        isPublic: false
      - availabilityZone: us-east-1b
        cidrBlock: "10.10.1.0/24"
        isPublic: false
      - availabilityZone: us-east-1c
        cidrBlock: "10.10.2.0/24"
        isPublic: false
```

```yaml
# cluster-us-west-2.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: prod-us-west-2
  namespace: clusters
  labels:
    region: us-west-2
    tier: production
spec:
  clusterNetwork:
    pods:
      cidrBlocks: ["10.30.0.0/16"]
    services:
      cidrBlocks: ["10.40.0.0/16"]
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: prod-us-west-2
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: prod-us-west-2-control-plane
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: prod-us-west-2
  namespace: clusters
spec:
  region: us-west-2
  sshKeyName: platform-keypair
  network:
    vpc:
      cidrBlock: "10.30.0.0/16"
```

### ClusterClass for DRY Cluster Templates

```yaml
# clusterclass-production.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: ClusterClass
metadata:
  name: production-aws
  namespace: clusters
spec:
  controlPlane:
    ref:
      apiVersion: controlplane.cluster.x-k8s.io/v1beta1
      kind: KubeadmControlPlaneTemplate
      name: production-control-plane-template
    machineInfrastructure:
      ref:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-control-plane-machine
  workers:
    machineDeployments:
      - class: default-worker
        template:
          bootstrap:
            ref:
              apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
              kind: KubeadmConfigTemplate
              name: production-worker-bootstrap
          infrastructure:
            ref:
              apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
              kind: AWSMachineTemplate
              name: production-worker-machine
  variables:
    - name: region
      required: true
      schema:
        openAPIV3Schema:
          type: string
    - name: workerCount
      required: false
      schema:
        openAPIV3Schema:
          type: integer
          default: 3
```

## KubeFed vs GitOps for Multi-Cluster Config

### KubeFed (Kubernetes Federation v2)

KubeFed propagates resource templates to multiple clusters from a central control plane:

```yaml
# federated-deployment.yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedDeployment
metadata:
  name: payments-api
  namespace: production
spec:
  template:
    metadata:
      labels:
        app: payments-api
    spec:
      replicas: 3
      selector:
        matchLabels:
          app: payments-api
      template:
        metadata:
          labels:
            app: payments-api
        spec:
          containers:
            - name: api
              image: example/payments-api:v2.3.1
              ports:
                - containerPort: 8080
  placement:
    clusters:
      - name: prod-us-east-1
      - name: prod-us-west-2
      - name: prod-eu-west-1
  overrides:
    - clusterName: prod-eu-west-1
      clusterOverrides:
        - path: "/spec/template/spec/containers/0/env"
          value:
            - name: REGION
              value: eu-west-1
            - name: DATA_ENDPOINT
              value: https://db.eu-west-1.internal
```

### GitOps Multi-Cluster with ArgoCD ApplicationSets

The GitOps approach with ApplicationSets is generally preferred over KubeFed for operational simplicity and auditability:

```yaml
# applicationset-multi-region.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-api-multi-region
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - clusters:
        selector:
          matchLabels:
            tier: production
        values:
          region: "{{.metadata.labels.region}}"
  template:
    metadata:
      name: "payments-api-{{.name}}"
      labels:
        cluster: "{{.name}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/example/gitops-config
        targetRevision: HEAD
        path: "apps/payments-api/overlays/{{.values.region}}"
      destination:
        server: "{{.server}}"
        namespace: production
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

```
Kustomize overlay structure:
apps/payments-api/
├── base/
│   ├── deployment.yaml
│   ├── service.yaml
│   └── kustomization.yaml
└── overlays/
    ├── us-east-1/
    │   ├── kustomization.yaml
    │   └── region-patch.yaml
    ├── us-west-2/
    │   ├── kustomization.yaml
    │   └── region-patch.yaml
    └── eu-west-1/
        ├── kustomization.yaml
        └── region-patch.yaml
```

### Comparison

| Criterion | KubeFed | ArgoCD ApplicationSets |
|---|---|---|
| Propagation model | Push (control plane to clusters) | Pull (clusters pull from Git) |
| Override granularity | Field-level | File-level (Kustomize/Helm) |
| Observability | Limited | Full diff/sync history in ArgoCD |
| Operational complexity | Higher (extra control plane) | Lower (ArgoCD already in use) |
| Cluster connectivity | Requires API access to all clusters | Each cluster only needs Git access |

## Global Load Balancing

### AWS Global Accelerator

```bash
# Create a Global Accelerator pointing to load balancers in each region
aws globalaccelerator create-accelerator \
  --name production-global \
  --ip-address-type IPV4 \
  --enabled \
  --region us-west-2

# Add a listener
aws globalaccelerator create-listener \
  --accelerator-arn arn:aws:globalaccelerator::123456789012:accelerator/REPLACE_WITH_ACCELERATOR_ID \
  --protocol TCP \
  --port-ranges FromPort=443,ToPort=443 \
  --region us-west-2

# Add endpoint groups per region
aws globalaccelerator create-endpoint-group \
  --listener-arn arn:aws:globalaccelerator::123456789012:accelerator/REPLACE/listener/REPLACE \
  --endpoint-group-region us-east-1 \
  --traffic-dial-percentage 50 \
  --health-check-protocol HTTPS \
  --health-check-path /health \
  --health-check-interval-seconds 10 \
  --threshold-count 3 \
  --endpoint-configurations '[{
    "EndpointId": "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/prod-nlb/REPLACE",
    "Weight": 100,
    "ClientIPPreservationEnabled": true
  }]' \
  --region us-west-2
```

### Cloudflare Load Balancing with Health Checks

```yaml
# cloudflare-load-balancer-config.yaml
# (Managed via Terraform or Cloudflare API)

# Origin pools per region
pool_us_east_1:
  name: prod-us-east-1
  origins:
    - name: nlb-us-east-1
      address: nlb.us-east-1.example.com
      weight: 1
      enabled: true
  health_check:
    type: https
    path: /health
    interval: 10
    timeout: 5
    retries: 2

pool_us_west_2:
  name: prod-us-west-2
  origins:
    - name: nlb-us-west-2
      address: nlb.us-west-2.example.com
      weight: 1
      enabled: true
  health_check:
    type: https
    path: /health
    interval: 10
    timeout: 5
    retries: 2

# Load balancer
load_balancer:
  name: api.example.com
  default_pool_ids:
    - prod-us-east-1
    - prod-us-west-2
  fallback_pool_id: prod-us-west-2
  steering_policy: geo        # latency | geo | random | dynamic_latency
  session_affinity: none
  region_pools:
    ENAM:                     # Eastern North America
      - prod-us-east-1
      - prod-us-west-2
    WNAM:                     # Western North America
      - prod-us-west-2
      - prod-us-east-1
    WEU:                      # Western Europe
      - prod-eu-west-1
      - prod-us-east-1
```

### Latency-Based Routing with Route 53

```bash
# Create latency-based records for each region
for REGION in us-east-1 us-west-2 eu-west-1; do
  aws route53 change-resource-record-sets \
    --hosted-zone-id REPLACE_WITH_HOSTED_ZONE_ID \
    --change-batch "{
      \"Changes\": [{
        \"Action\": \"UPSERT\",
        \"ResourceRecordSet\": {
          \"Name\": \"api.example.com\",
          \"Type\": \"A\",
          \"SetIdentifier\": \"${REGION}\",
          \"Region\": \"${REGION}\",
          \"HealthCheckId\": \"REPLACE_WITH_HEALTH_CHECK_${REGION}\",
          \"AliasTarget\": {
            \"HostedZoneId\": \"REPLACE_WITH_ELB_HOSTED_ZONE_ID\",
            \"DNSName\": \"nlb.${REGION}.example.com\",
            \"EvaluateTargetHealth\": true
          }
        }
      }]
    }"
done
```

## Database Replication Across Regions

### CockroachDB Multi-Region

CockroachDB is designed for multi-region deployments with automatic data distribution:

```yaml
# cockroachdb-cluster.yaml
apiVersion: crdb.cockroachlabs.com/v1alpha1
kind: CrdbCluster
metadata:
  name: crdb-multi-region
  namespace: cockroachdb
spec:
  dataStore:
    pvc:
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 200Gi
        storageClassName: rook-ceph-block
  resources:
    requests:
      cpu: "4"
      memory: 8Gi
    limits:
      cpu: "8"
      memory: 16Gi
  cockroachDBVersion: v24.1.5
  automaticVersionUpgrade: false
  nodes: 9      # 3 per region
  additionalArgs:
    - "--locality=region=us-east-1,zone=us-east-1a"   # Override per node
  tlsEnabled: true
```

#### Configure Multi-Region Database

```sql
-- After cluster is running, configure multi-region
ALTER DATABASE app_db PRIMARY REGION "us-east-1";
ALTER DATABASE app_db ADD REGION "us-west-2";
ALTER DATABASE app_db ADD REGION "eu-west-1";

-- Set survival goal (cluster can lose one region)
ALTER DATABASE app_db SURVIVE REGION FAILURE;

-- Optimize a table for regional reads
ALTER TABLE users SET LOCALITY REGIONAL BY ROW;
ALTER TABLE orders SET LOCALITY REGIONAL BY ROW;

-- Global table (replicated to all regions for fast reads everywhere)
ALTER TABLE product_catalog SET LOCALITY GLOBAL;
```

### Vitess for MySQL at Scale

```yaml
# vitess-cluster.yaml
apiVersion: planetscale.com/v2
kind: VitessCluster
metadata:
  name: production-db
  namespace: vitess
spec:
  globalLockserver:
    etcd:
      replicas: 3
  cells:
    - name: us-east-1
      lockserver:
        etcd:
          replicas: 3
      gateway:
        replicas: 2
        resources:
          requests:
            cpu: "1"
            memory: 1Gi
    - name: us-west-2
      lockserver:
        etcd:
          replicas: 3
      gateway:
        replicas: 2
        resources:
          requests:
            cpu: "1"
            memory: 1Gi
  keyspaces:
    - name: commerce
      durabilityPolicy: semi_sync
      partitionings:
        - equal:
            parts: 2
            shardTemplate:
              databaseInitScriptSecret:
                name: commerce-init-script
              replication:
                enforceSemiSync: true
              tabletPools:
                - cell: us-east-1
                  type: replica
                  replicas: 3
                  vttablet:
                    extraFlags:
                      db-credentials-file: /vt/secrets/db-credentials.json
                  mysqld:
                    resources:
                      requests:
                        cpu: "2"
                        memory: 4Gi
                - cell: us-west-2
                  type: rdonly
                  replicas: 2
                  vttablet:
                    extraFlags:
                      db-credentials-file: /vt/secrets/db-credentials.json
```

### Eventual Consistency Patterns

For workloads that can tolerate eventual consistency, CQRS (Command Query Responsibility Segregation) with event sourcing works well across regions:

```yaml
# event-bridge-config.yaml — AWS EventBridge for cross-region event replication
apiVersion: v1
kind: ConfigMap
metadata:
  name: event-bus-config
  namespace: production
data:
  config.yaml: |
    primary_bus:
      region: us-east-1
      bus_name: production-events
    replica_buses:
      - region: us-west-2
        bus_name: production-events
        rule_arn: arn:aws:events:us-east-1:123456789012:rule/cross-region-replication
      - region: eu-west-1
        bus_name: production-events
        rule_arn: arn:aws:events:us-east-1:123456789012:rule/cross-region-eu
```

## Cross-Region Service Mesh

### Istio Multi-Primary Multi-Cluster

```bash
# Install Istio on both clusters with shared root CA
# Generate root CA
mkdir -p certs && pushd certs
make -f /usr/local/istio/tools/certs/Makefile.selfsigned.mk root-ca

# Generate intermediate certs per cluster
make -f /usr/local/istio/tools/certs/Makefile.selfsigned.mk \
  cluster1-cacerts CLUSTER_NAME=prod-us-east-1
make -f /usr/local/istio/tools/certs/Makefile.selfsigned.mk \
  cluster2-cacerts CLUSTER_NAME=prod-us-west-2
popd

# Apply certs to each cluster
kubectl create secret generic cacerts -n istio-system \
  --from-file=certs/prod-us-east-1/ca-cert.pem \
  --from-file=certs/prod-us-east-1/ca-key.pem \
  --from-file=certs/prod-us-east-1/root-cert.pem \
  --from-file=certs/prod-us-east-1/cert-chain.pem \
  --context prod-us-east-1

kubectl create secret generic cacerts -n istio-system \
  --from-file=certs/prod-us-west-2/ca-cert.pem \
  --from-file=certs/prod-us-west-2/ca-key.pem \
  --from-file=certs/prod-us-west-2/root-cert.pem \
  --from-file=certs/prod-us-west-2/cert-chain.pem \
  --context prod-us-west-2
```

```yaml
# istio-multicluster-us-east-1.yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: istio
  namespace: istio-system
spec:
  values:
    global:
      meshID: prod-mesh
      multiCluster:
        clusterName: prod-us-east-1
      network: us-east-1-network
  components:
    ingressGateways:
      - name: istio-eastwestgateway
        label:
          istio: eastwestgateway
          app: istio-eastwestgateway
          topology.istio.io/network: us-east-1-network
        enabled: true
        k8s:
          env:
            - name: ISTIO_META_REQUESTED_NETWORK_VIEW
              value: us-east-1-network
          service:
            ports:
              - name: status-port
                port: 15021
                targetPort: 15021
              - name: tls
                port: 15443
                targetPort: 15443
              - name: tls-istiod
                port: 15012
                targetPort: 15012
              - name: tls-webhook
                port: 15017
                targetPort: 15017
```

### Cilium Cluster Mesh

Cilium Cluster Mesh provides cross-cluster networking without a separate service mesh data plane:

```bash
# Enable Cluster Mesh on both clusters
cilium clustermesh enable \
  --context prod-us-east-1 \
  --service-type LoadBalancer

cilium clustermesh enable \
  --context prod-us-west-2 \
  --service-type LoadBalancer

# Connect the two clusters
cilium clustermesh connect \
  --context prod-us-east-1 \
  --destination-context prod-us-west-2

# Verify connectivity
cilium clustermesh status \
  --context prod-us-east-1 \
  --wait
```

#### Global Service for Cross-Cluster Load Balancing

```yaml
# global-service.yaml — service accessible from both clusters
apiVersion: v1
kind: Service
metadata:
  name: payments-api
  namespace: production
  annotations:
    service.cilium.io/global: "true"           # expose to all clusters in the mesh
    service.cilium.io/shared: "true"            # include local endpoints in global LB
    service.cilium.io/affinity: "local"         # prefer local cluster endpoints
spec:
  selector:
    app: payments-api
  ports:
    - port: 8080
      targetPort: 8080
  type: ClusterIP
```

#### Global Service Failover Policy

```yaml
# Fail over to remote cluster only when local endpoints are unhealthy
apiVersion: v1
kind: Service
metadata:
  name: payments-api-ha
  namespace: production
  annotations:
    service.cilium.io/global: "true"
    service.cilium.io/affinity: "local"
    service.cilium.io/topology-aware-hints: "auto"
spec:
  selector:
    app: payments-api
  ports:
    - port: 8080
      targetPort: 8080
```

## Global DNS Health Checks

### Route 53 Health Check Configuration

```bash
# Create health checks for each regional endpoint
for REGION in us-east-1 us-west-2 eu-west-1; do
  ENDPOINT="api.${REGION}.example.com"

  aws route53 create-health-check \
    --caller-reference "${REGION}-$(date +%s)" \
    --health-check-config "{
      \"Type\": \"HTTPS\",
      \"FullyQualifiedDomainName\": \"${ENDPOINT}\",
      \"Port\": 443,
      \"ResourcePath\": \"/health/ready\",
      \"FailureThreshold\": 3,
      \"RequestInterval\": 10,
      \"MeasureLatency\": true,
      \"EnableSNI\": true
    }"
done

# Create CloudWatch alarm for each health check
aws cloudwatch put-metric-alarm \
  --alarm-name "r53-health-us-east-1" \
  --metric-name HealthCheckStatus \
  --namespace AWS/Route53 \
  --statistic Minimum \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 1 \
  --comparison-operator LessThanThreshold \
  --dimensions Name=HealthCheckId,Value=REPLACE_WITH_HEALTH_CHECK_ID \
  --alarm-actions arn:aws:sns:us-east-1:123456789012:platform-alerts
```

### External DNS for Automated Record Management

```yaml
# external-dns-multi-region.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
  namespace: external-dns
spec:
  template:
    spec:
      containers:
        - name: external-dns
          image: registry.k8s.io/external-dns/external-dns:v0.15.0
          args:
            - --source=service
            - --source=ingress
            - --provider=aws
            - --aws-zone-type=public
            - --registry=txt
            - --txt-owner-id=prod-us-east-1
            - --policy=sync
            - --aws-prefer-cname=false
            - --annotation-filter=external-dns.alpha.kubernetes.io/hostname
```

## Secret Synchronization Across Clusters

### External Secrets with Multiple Backends

```yaml
# external-secrets-multi-cluster.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secretsmanager-primary
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
---
# ExternalSecret synced to both clusters (identical SecretStore config deployed on each)
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  refreshInterval: 1m
  secretStoreRef:
    name: aws-secretsmanager-primary
    kind: ClusterSecretStore
  target:
    name: db-credentials
    creationPolicy: Owner
    template:
      type: Opaque
  data:
    - secretKey: DB_HOST
      remoteRef:
        key: production/database
        property: host
    - secretKey: DB_PASSWORD
      remoteRef:
        key: production/database
        property: password
```

## Traffic Splitting and Canary Across Regions

### Progressive Regional Rollout

```yaml
# applicationset-progressive-rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-api-progressive
  namespace: argocd
spec:
  goTemplate: true
  strategy:
    type: RollingSync
    rollingSync:
      steps:
        - matchExpressions:
            - key: region
              operator: In
              values:
                - us-west-2    # Deploy to secondary region first
          maxUpdate: 100%
        - matchExpressions:
            - key: region
              operator: In
              values:
                - us-east-1    # Deploy to primary only after secondary is healthy
          maxUpdate: 100%
  generators:
    - clusters:
        selector:
          matchLabels:
            tier: production
  template:
    metadata:
      name: "payments-api-{{.name}}"
      labels:
        region: "{{.metadata.labels.region}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/example/gitops-config
        targetRevision: HEAD
        path: "apps/payments-api/overlays/{{.metadata.labels.region}}"
      destination:
        server: "{{.server}}"
        namespace: production
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Observability Across Regions

### Thanos for Multi-Region Metrics

```yaml
# thanos-query.yaml — federated query across regions
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
  namespace: monitoring
spec:
  template:
    spec:
      containers:
        - name: thanos-query
          image: quay.io/thanos/thanos:v0.35.1
          args:
            - query
            - --http-address=0.0.0.0:9090
            - --store=thanos-store-us-east-1.monitoring.svc:10901
            - --store=thanos-store-us-west-2.monitoring.svc:10901
            - --store=thanos-store-eu-west-1.monitoring.svc:10901
            - --query.replica-label=prometheus_replica
            - --query.auto-downsampling
          ports:
            - containerPort: 9090
              name: http
```

### Cross-Region Grafana Datasources

```yaml
# grafana-datasources.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  datasources.yaml: |
    apiVersion: 1
    datasources:
      - name: Thanos-Global
        type: prometheus
        url: http://thanos-query.monitoring.svc:9090
        isDefault: true
        jsonData:
          timeInterval: 30s
      - name: Prometheus-US-East-1
        type: prometheus
        url: https://prometheus.us-east-1.internal:9090
        jsonData:
          tlsAuth: true
      - name: Prometheus-US-West-2
        type: prometheus
        url: https://prometheus.us-west-2.internal:9090
        jsonData:
          tlsAuth: true
```

## Multi-Region Cost Optimization

### Traffic Affinity to Reduce Cross-Region Data Transfer

```yaml
# topology-aware-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: payments-internal
  namespace: production
  annotations:
    service.kubernetes.io/topology-mode: "Auto"
spec:
  selector:
    app: payments-api
  ports:
    - port: 8080
      targetPort: 8080
  # Kubernetes topology-aware routing keeps traffic within zones/regions
```

### Spot Instances for Non-Critical Regions

```yaml
# karpenter-spot-nodepool-dr.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: dr-spot-workers
spec:
  template:
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["m", "c", "r"]
      taints:
        - key: spot
          value: "true"
          effect: PreferNoSchedule
  limits:
    cpu: "100"
    memory: 400Gi
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
```

## Summary

Multi-region Kubernetes deployments require architectural decisions at every layer of the stack. Key production patterns:

- Choose an architecture tier (active-passive, geographic sharding, or active-active) based on workload consistency requirements
- Use Cluster API for declarative, GitOps-compatible multi-cluster provisioning
- Prefer ArgoCD ApplicationSets over KubeFed for configuration propagation — simpler, auditable, and pull-based
- Use AWS Global Accelerator or Cloudflare Load Balancing for anycast routing with sub-10ms failover
- Deploy CockroachDB or Vitess for workloads requiring multi-region read/write without manual sharding
- Use Cilium Cluster Mesh for cross-cluster service discovery with local-affinity routing
- Synchronize secrets via External Secrets Operator from a central vault (AWS Secrets Manager, HashiCorp Vault)
- Federate observability with Thanos query layer across regional Prometheus instances
- Implement progressive regional rollouts via ApplicationSet RollingSync to reduce blast radius during deployments
- Use topology-aware services to reduce cross-AZ/cross-region traffic costs

The operational investment in multi-region architecture is substantial, but for workloads where availability and latency directly impact revenue, the tradeoff is clear.
