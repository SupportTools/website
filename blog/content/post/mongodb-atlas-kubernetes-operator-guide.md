---
title: "MongoDB Atlas Kubernetes Operator: Declarative Database Management at Scale"
date: 2027-06-27T00:00:00-05:00
draft: false
tags: ["MongoDB", "Kubernetes", "Database", "Atlas", "Operator"]
categories:
- MongoDB
- Kubernetes
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to the MongoDB Atlas Kubernetes Operator, covering AtlasProject and AtlasDeployment CRDs, network peering, IP access lists, database user RBAC, backup policies, connection string secret injection, multi-region clusters, Atlas Search index management, monitoring integration, and migration from self-hosted MongoDB."
more_link: "yes"
url: "/mongodb-atlas-kubernetes-operator-guide/"
---

The MongoDB Atlas Kubernetes Operator brings the Atlas control plane into the Kubernetes API, enabling teams to manage Atlas databases, users, network peering, backup policies, and search indexes through the same GitOps workflows used for application infrastructure. Rather than managing Atlas resources through the Atlas UI or CLI, the operator allows all Atlas configuration to live in version-controlled Kubernetes manifests — integrated with Argo CD, Flux, or any standard Kubernetes reconciliation toolchain. This guide covers the full operator lifecycle from installation to production operations.

<!--more-->

# MongoDB Atlas Kubernetes Operator: Declarative Database Management at Scale

## Section 1: Atlas Operator Architecture

The Atlas Kubernetes Operator runs as a Deployment in any namespace and manages resources across three scope levels:

- **Organization-level** — not currently managed by the operator (use the Atlas API or CLI)
- **Project-level** — `AtlasProject` CRD manages projects, IP access lists, network peering, and private endpoints
- **Cluster-level** — `AtlasDeployment` CRD manages cluster topology, tier, region, backup, and advanced configuration
- **User-level** — `AtlasDatabaseUser` CRD manages database users and their RBAC within a project

The operator authenticates to the Atlas API using an API key stored in a Kubernetes Secret. It reconciles CRD state against the Atlas API and writes connection string secrets back into the namespace for application consumption.

### Installation

```bash
# Install via Helm
helm repo add mongodb https://mongodb.github.io/helm-charts
helm repo update

helm upgrade --install mongodb-atlas-operator mongodb/mongodb-atlas-operator \
  --namespace mongodb-atlas-system \
  --create-namespace \
  --set operator.watchNamespaces="{atlas}" \
  --version 2.3.0

kubectl -n mongodb-atlas-system get pods
kubectl get crd | grep atlas.mongodb.com
```

### Atlas API Key Secret

```bash
# Create the API key secret (organization-level API key)
kubectl -n atlas create secret generic atlas-api-key \
  --from-literal=orgId="<your-atlas-org-id>" \
  --from-literal=publicApiKey="<your-public-key>" \
  --from-literal=privateApiKey="<your-private-key>"

kubectl -n atlas label secret atlas-api-key \
  atlas.mongodb.com/type=credentials
```

---

## Section 2: AtlasProject CRD

The `AtlasProject` resource creates or links to an Atlas project and manages all project-level configuration.

### Basic AtlasProject

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasProject
metadata:
  name: production
  namespace: atlas
spec:
  name: "Production Platform"
  connectionSecretRef:
    name: atlas-api-key
  projectIpAccessList:
  - comment: "VPC CIDR for k8s cluster"
    cidrBlock: "10.0.0.0/8"
  - comment: "CI/CD runner outbound IP"
    ipAddress: "203.0.113.45"
  settings:
    isCollectDatabaseSpecificsStatisticsEnabled: true
    isDataExplorerEnabled: false
    isPerformanceAdvisorEnabled: true
    isRealtimePerformancePanelEnabled: true
    isSchemaAdvisorEnabled: true
  withDefaultAlertsSettings: true
  alertConfigurationSyncEnabled: true
  alertConfigurations:
  - eventTypeName: REPLICATION_OPLOG_WINDOW_RUNNING_OUT
    enabled: true
    threshold:
      operator: LESS_THAN
      threshold: 1
      units: HOURS
    notifications:
    - typeName: EMAIL
      emailAddress: "ops-team@example.com"
      intervalMin: 60
      delayMin: 0
  - eventTypeName: NO_PRIMARY
    enabled: true
    notifications:
    - typeName: EMAIL
      emailAddress: "oncall@example.com"
      intervalMin: 5
      delayMin: 0
```

### IP Access List Management

The `projectIpAccessList` field controls Atlas's IP access list. For dynamic environments, use CIDR blocks rather than individual IPs:

```yaml
spec:
  projectIpAccessList:
  - comment: "EKS worker nodes - us-east-1"
    cidrBlock: "10.20.0.0/16"
  - comment: "EKS worker nodes - us-west-2"
    cidrBlock: "10.30.0.0/16"
  - comment: "VPN gateway"
    ipAddress: "198.51.100.10"
  - comment: "Allow all (NOT recommended for production)"
    # cidrBlock: "0.0.0.0/0"  # Only use for testing
```

---

## Section 3: Network Peering Configuration

For production deployments, connect Kubernetes clusters to Atlas via VPC peering rather than public internet access. This keeps database traffic private and eliminates the need for IP allowlisting worker node CIDRs.

### AWS VPC Peering

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasProject
metadata:
  name: production
  namespace: atlas
spec:
  name: "Production Platform"
  connectionSecretRef:
    name: atlas-api-key
  networkPeers:
  - providerName: AWS
    accepterRegionName: us-east-1
    awsAccountId: "123456789012"
    routeTableCidrBlock: "10.20.0.0/16"
    vpcId: vpc-0a1b2c3d4e5f6g7h8
    atlasCidrBlock: "192.168.248.0/21"
    containerId: ""   # Set by operator after container creation
```

After the operator creates the peering connection, accept it from the AWS side:

```bash
# Get the Atlas-side peering connection ID
kubectl -n atlas get atlasproject production -o jsonpath=\
  '{.status.networkPeers[0].connectionId}'

# Accept the peering connection via AWS CLI
aws ec2 accept-vpc-peering-connection \
  --vpc-peering-connection-id <atlas-peering-connection-id> \
  --region us-east-1

# Add route to the Atlas CIDR in VPC route tables
aws ec2 create-route \
  --route-table-id rtb-0123456789abcdef0 \
  --destination-cidr-block 192.168.248.0/21 \
  --vpc-peering-connection-id <peering-connection-id>
```

### GCP VPC Peering

```yaml
spec:
  networkPeers:
  - providerName: GCP
    gcpProjectId: my-gcp-project
    networkName: my-vpc-network
    atlasCidrBlock: "192.168.244.0/22"
```

### Azure VNet Peering

```yaml
spec:
  networkPeers:
  - providerName: AZURE
    azureSubscriptionId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    azureDirectoryId: "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
    resourceGroupName: my-resource-group
    vnetName: my-vnet
    atlasCidrBlock: "192.168.252.0/22"
```

---

## Section 4: AtlasDeployment CRD

The `AtlasDeployment` CRD manages the Atlas cluster (replica set or sharded cluster) lifecycle. The operator creates, updates, and deletes clusters through the Atlas API.

### Dedicated Replica Set

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasDeployment
metadata:
  name: prod-cluster
  namespace: atlas
spec:
  projectRef:
    name: production
  serverlessSpec: null   # null = dedicated cluster
  deploymentSpec:
    name: prod-cluster
    mongoDBMajorVersion: "7.0"
    clusterType: REPLICASET
    replicationSpecs:
    - numShards: 1
      regionConfigs:
      - regionName: US_EAST_1
        providerName: AWS
        backingProviderName: AWS
        electableSpecs:
          instanceSize: M30
          nodeCount: 3
        readOnlySpecs:
          instanceSize: M30
          nodeCount: 0
        analyticsSpecs:
          instanceSize: M30
          nodeCount: 1
        priority: 7
        autoScaling:
          compute:
            enabled: true
            scaleDownEnabled: true
            minInstanceSize: M20
            maxInstanceSize: M60
          diskGB:
            enabled: true
    labels:
    - key: environment
      value: production
    - key: team
      value: platform
    tags:
    - key: cost-center
      value: "12345"
    versionReleaseSystem: LTS
    encryptionAtRestProvider: AWS
    backupEnabled: true
    pitEnabled: true
    diskSizeGB: 100
    biConnector:
      enabled: false
    connectionStrings: {}
    advancedSettings:
      defaultReadConcern: "majority"
      defaultWriteConcern: "majority"
      oplogSizeMB: 2048
      sampleSizeBIConnector: 110
      sampleRefreshIntervalBIConnector: 310
      minimumEnabledTlsProtocol: TLS1_2
      noTableScan: false
      failIndexKeyTooLong: true
      javascriptEnabled: true
      tlsCipherConfigMode: DEFAULT
```

### Multi-Region Replica Set

For geo-distributed deployments with read locality:

```yaml
spec:
  deploymentSpec:
    clusterType: REPLICASET
    replicationSpecs:
    - numShards: 1
      regionConfigs:
      - regionName: US_EAST_1
        providerName: AWS
        backingProviderName: AWS
        electableSpecs:
          instanceSize: M30
          nodeCount: 3
        priority: 7
      - regionName: EU_WEST_1
        providerName: AWS
        backingProviderName: AWS
        electableSpecs:
          instanceSize: M30
          nodeCount: 2
        readOnlySpecs:
          instanceSize: M30
          nodeCount: 1
        priority: 6
      - regionName: AP_SOUTHEAST_1
        providerName: AWS
        backingProviderName: AWS
        readOnlySpecs:
          instanceSize: M30
          nodeCount: 1
        priority: 0
```

### Sharded Cluster

```yaml
spec:
  deploymentSpec:
    clusterType: SHARDED
    replicationSpecs:
    - numShards: 3
      regionConfigs:
      - regionName: US_EAST_1
        providerName: AWS
        backingProviderName: AWS
        electableSpecs:
          instanceSize: M30
          nodeCount: 3
        priority: 7
    diskSizeGB: 200
```

---

## Section 5: Database User RBAC

The `AtlasDatabaseUser` CRD creates and manages database users within an Atlas project.

### Application User with Scoped Access

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasDatabaseUser
metadata:
  name: app-user
  namespace: atlas
spec:
  projectRef:
    name: production
  username: app-user
  passwordSecretRef:
    name: app-user-password
  roles:
  - roleName: readWrite
    databaseName: appdb
  - roleName: read
    databaseName: analytics
  scopes:
  - name: prod-cluster
    type: CLUSTER
```

### Read-Only Analytics User

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasDatabaseUser
metadata:
  name: analytics-user
  namespace: atlas
spec:
  projectRef:
    name: production
  username: analytics-user
  passwordSecretRef:
    name: analytics-user-password
  roles:
  - roleName: read
    databaseName: appdb
  - roleName: read
    databaseName: analytics
  scopes:
  - name: prod-cluster
    type: CLUSTER
  deleteAfterDate: "2027-12-31T23:59:59Z"   # Temporary access
```

### Custom Role

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasDatabaseUser
metadata:
  name: custom-role-user
  namespace: atlas
spec:
  projectRef:
    name: production
  username: service-account
  passwordSecretRef:
    name: service-account-password
  roles:
  - roleName: readWriteAnyDatabase
    databaseName: admin
  customRoles:
  - actions:
    - action: FIND
      resources:
      - collection: ""
        database: appdb
    - action: INSERT
      resources:
      - collection: orders
        database: appdb
    - action: UPDATE
      resources:
      - collection: orders
        database: appdb
    roleName: orders-write-role
```

### Password Secrets

```bash
kubectl -n atlas create secret generic app-user-password \
  --from-literal=password="$(openssl rand -base64 32)"

kubectl -n atlas label secret app-user-password \
  atlas.mongodb.com/type=credentials
```

---

## Section 6: Connection String Secret Injection

The operator automatically creates connection string secrets in the Kubernetes namespace when an `AtlasDeployment` and `AtlasDatabaseUser` are ready. Applications reference these secrets directly without managing Atlas credentials.

### Connection Secret Structure

The operator creates a secret named `<project-name>-<cluster-name>-<username>` containing:

```yaml
# Example secret created by the operator
apiVersion: v1
kind: Secret
metadata:
  name: production-prod-cluster-app-user
  namespace: atlas
type: Opaque
stringData:
  connectionStringStandard: "mongodb://app-user:<password>@ac-xxxxx.mongodb.net:27017/?ssl=true&authSource=admin"
  connectionStringStandardSrv: "mongodb+srv://app-user:<password>@prod-cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority"
  connectionStringPrivate: "mongodb://app-user:<password>@pl-0.xxxxx.atlas-<peering>.amazonaws.com:27017/?ssl=true"
  connectionStringPrivateSrv: "mongodb+srv://app-user:<password>@prod-cluster-private.xxxxx.mongodb.net/?retryWrites=true&w=majority"
  username: "app-user"
  password: "<generated-password>"
```

### Consuming Connection Secrets in Applications

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: application
spec:
  template:
    spec:
      containers:
      - name: api
        image: my-api:v1.2.3
        env:
        - name: MONGODB_URI
          valueFrom:
            secretKeyRef:
              name: production-prod-cluster-app-user
              key: connectionStringPrivateSrv
        - name: MONGODB_USERNAME
          valueFrom:
            secretKeyRef:
              name: production-prod-cluster-app-user
              key: username
```

### Cross-Namespace Secret Sync

If applications live in a different namespace from Atlas resources, use the External Secrets Operator or a simple sync job:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: mongodb-connection
  namespace: application
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: kubernetes-secret-store
    kind: ClusterSecretStore
  target:
    name: mongodb-connection
  data:
  - secretKey: connectionString
    remoteRef:
      key: production-prod-cluster-app-user
      property: connectionStringPrivateSrv
```

---

## Section 7: Backup Policies

Atlas provides automated cloud backups with configurable retention policies and on-demand snapshot capabilities.

### Backup Policy Configuration

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasBackupPolicy
metadata:
  name: production-backup
  namespace: atlas
spec:
  items:
  - frequencyType: hourly
    frequencyInterval: 6
    retentionUnit: days
    retentionValue: 7
  - frequencyType: daily
    frequencyInterval: 1
    retentionUnit: days
    retentionValue: 30
  - frequencyType: weekly
    frequencyInterval: 1   # Sunday
    retentionUnit: weeks
    retentionValue: 12
  - frequencyType: monthly
    frequencyInterval: 1   # First day of month
    retentionUnit: months
    retentionValue: 12
```

### AtlasBackupSchedule CRD

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasBackupSchedule
metadata:
  name: prod-cluster-backup
  namespace: atlas
spec:
  clusterRef:
    name: prod-cluster
  policyRef:
    name: production-backup
    namespace: atlas
  referenceHourOfDay: 3
  referenceMinuteOfHour: 0
  restoreWindowDays: 7
  updateSnapshots: true
  export:
    exportBucketId: ""   # Set to enable snapshot export to S3
    frequencyType: monthly
  copySettings:
  - cloudProvider: AWS
    regionName: US_WEST_2
    shouldCopyOplogs: true
    frequencies:
    - HOURLY
    - DAILY
    replicationSpecId: ""   # Set from cluster replication spec
```

### On-Demand Snapshot via AtlasBackupSnapshot

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasBackupSnapshot
metadata:
  name: pre-migration-snapshot
  namespace: atlas
spec:
  clusterRef:
    name: prod-cluster
  description: "Pre-migration snapshot 2027-06-27"
  retentionInDays: 30
```

---

## Section 8: Atlas Search Index Management

Atlas Search provides full-text search capabilities built on Apache Lucene, managed directly on the Atlas cluster. The operator manages search indexes through the `AtlasSearchIndexConfig` CRD.

### AtlasSearchIndexConfig CRD

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasSearchIndexConfig
metadata:
  name: orders-search-index
  namespace: atlas
spec:
  clusterRef:
    name: prod-cluster
  projectRef:
    name: production
  type: search
  name: orders_default
  database: appdb
  collectionName: orders
  searchAnalyzer: lucene.standard
  analyzer: lucene.standard
  mappings:
    dynamic: false
    fields:
      customerId:
        type: string
        analyzer: lucene.keyword
      orderDate:
        type: date
        representation: epoch_millis
      status:
        type: string
        analyzer: lucene.keyword
      totalAmount:
        type: number
        representation: double
      items:
        type: embeddedDocuments
        dynamic: true
      description:
        type: string
        analyzer: lucene.standard
        multi:
          keywordAnalyzer:
            type: string
            analyzer: lucene.keyword
  storedSource:
    include:
    - customerId
    - orderDate
    - status
    - totalAmount
  synonyms:
  - analyzer: lucene.standard
    name: product_synonyms
    source:
      collection: search_synonyms
```

### Vector Search Index

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasSearchIndexConfig
metadata:
  name: product-vector-index
  namespace: atlas
spec:
  clusterRef:
    name: prod-cluster
  type: vectorSearch
  name: product_vectors
  database: appdb
  collectionName: products
  fields:
  - type: vector
    path: embedding
    numDimensions: 1536
    similarity: cosine
  - type: filter
    path: category
  - type: filter
    path: inStock
```

---

## Section 9: Monitoring Integration

### Atlas Alerts and Third-Party Integration

Configure Atlas to forward alerts and metrics to external monitoring systems:

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasProject
metadata:
  name: production
  namespace: atlas
spec:
  name: "Production Platform"
  connectionSecretRef:
    name: atlas-api-key
  alertConfigurations:
  - eventTypeName: QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED
    enabled: true
    threshold:
      operator: GREATER_THAN
      threshold: 1000
      units: RAW
    notifications:
    - typeName: DATADOG
      datadogApiKey: ""   # Set via secret reference
      datadogRegion: US
      intervalMin: 60
      delayMin: 0
  - eventTypeName: DISK_PERCENT_USED
    enabled: true
    threshold:
      operator: GREATER_THAN
      threshold: 80
      units: RAW
    notifications:
    - typeName: EMAIL
      emailAddress: "ops-team@example.com"
      intervalMin: 60
      delayMin: 0
  integrations:
  - type: DATADOG
    apiKeyRef:
      name: datadog-api-key
      namespace: atlas
    region: US
```

### Prometheus Metrics via Atlas Monitoring API

Atlas exposes hardware metrics (disk I/O, CPU, memory) via the Atlas Monitoring API. Use the `mongodb/mongodb-atlas-kubernetes` Prometheus integration or the Atlas operator's own metrics endpoint:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: atlas-operator-metrics
  namespace: mongodb-atlas-system
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: mongodb-atlas-operator
  endpoints:
  - port: metrics
    interval: 60s
    path: /metrics
```

### Key Operator Metrics

```
# Reconciliation health
atlas_operator_reconciliation_total
atlas_operator_reconciliation_errors_total
atlas_operator_reconciliation_duration_seconds

# Resource status
atlas_operator_atlasdeployment_ready
atlas_operator_atlasproject_ready
atlas_operator_atlasdatabaseuser_ready
```

---

## Section 10: Migration from Self-Hosted MongoDB

### Pre-Migration Assessment

```bash
# Check MongoDB version compatibility
mongosh "mongodb://admin:password@self-hosted-mongo:27017/admin" \
  --eval "db.version()"

# Get collection and index statistics
mongosh "mongodb://admin:password@self-hosted-mongo:27017" \
  --eval "
  db.adminCommand({listDatabases: 1}).databases.forEach(d => {
    db = db.getSiblingDB(d.name);
    db.getCollectionNames().forEach(c => {
      stats = db[c].stats();
      print(d.name + '.' + c + ': ' +
            stats.count + ' docs, ' +
            Math.round(stats.size/1024/1024) + ' MB');
    });
  });"

# Export indexes for all collections
mongosh "mongodb://admin:password@self-hosted-mongo:27017" \
  --eval "
  db.adminCommand({listDatabases: 1}).databases.forEach(d => {
    if (d.name !== 'admin' && d.name !== 'config' && d.name !== 'local') {
      db = db.getSiblingDB(d.name);
      db.getCollectionNames().forEach(c => {
        print('DB: ' + d.name + ', Collection: ' + c);
        db[c].getIndexes().forEach(i => printjson(i));
      });
    }
  });"
```

### Live Migration with mongomirror

For zero-downtime migrations from self-hosted MongoDB (3.6+) to Atlas:

```bash
# mongomirror replicates in real-time while the source remains active
mongomirror \
  --host "rs0/mongo-1:27017,mongo-2:27017,mongo-3:27017" \
  --username admin \
  --password "REPLACE_WITH_SOURCE_PASSWORD" \
  --ssl \
  --destination "mongodb+srv://migrator:REPLACE_WITH_DEST_PASSWORD@prod-cluster.xxxxx.mongodb.net" \
  --destinationUsername migrator \
  --destinationPassword "REPLACE_WITH_DEST_PASSWORD" \
  --noIndexRestore=false \
  --numParallelCollections 4 \
  --readPreference secondaryPreferred \
  --httpStatusPort 27020
```

### Creating the AtlasDeployment for Migration Target

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasDeployment
metadata:
  name: migration-target
  namespace: atlas
spec:
  projectRef:
    name: production
  deploymentSpec:
    name: migration-target
    mongoDBMajorVersion: "7.0"
    clusterType: REPLICASET
    replicationSpecs:
    - numShards: 1
      regionConfigs:
      - regionName: US_EAST_1
        providerName: AWS
        backingProviderName: AWS
        electableSpecs:
          instanceSize: M30
          nodeCount: 3
        priority: 7
    backupEnabled: true
    pitEnabled: true
```

### Application Cutover Checklist

```bash
# 1. Verify mongomirror lag is < 1 second
curl http://localhost:27020/

# 2. Create Atlas Search indexes on target
kubectl apply -f search-indexes.yaml

# 3. Verify all Atlas Search indexes are active
kubectl -n atlas get atlassearchindexconfig

# 4. Stop writes to source (maintenance mode)
mongosh "mongodb://admin:password@self-hosted-mongo:27017/admin" \
  --eval "db.adminCommand({fsync: 1, lock: true})"

# 5. Wait for mongomirror to confirm 0 lag
# 6. Update application MONGODB_URI to Atlas connection string
kubectl -n application set env deployment/api-service \
  MONGODB_URI="$(kubectl -n atlas get secret \
    production-migration-target-app-user \
    -o jsonpath='{.data.connectionStringPrivateSrv}' | base64 -d)"

# 7. Roll out the deployment
kubectl -n application rollout status deployment/api-service

# 8. Unlock source MongoDB
mongosh "mongodb://admin:password@self-hosted-mongo:27017/admin" \
  --eval "db.adminCommand({fsyncUnlock: 1})"
```

---

## Section 11: Serverless Atlas Deployments

For development environments or unpredictable workloads, use Atlas Serverless instances:

```yaml
apiVersion: atlas.mongodb.com/v1
kind: AtlasDeployment
metadata:
  name: dev-serverless
  namespace: atlas
spec:
  projectRef:
    name: production
  serverlessSpec:
    name: dev-serverless
    providerSettings:
      backingProviderName: AWS
      regionName: US_EAST_1
      providerName: SERVERLESS
```

Serverless instances scale to zero and charge per operation, making them ideal for development and staging environments.

---

## Section 12: Operational Runbooks

### Check AtlasProject and AtlasDeployment Status

```bash
# Check all Atlas resources
kubectl -n atlas get atlasproject,atlasdeployment,atlasdatabaseuser,atlasbackupschedule

# Get detailed status
kubectl -n atlas describe atlasdeployment prod-cluster

# Check operator reconciliation logs
kubectl -n mongodb-atlas-system logs deployment/mongodb-atlas-operator -f \
  | grep -E "ERROR|WARN|Reconcil"

# Verify connection secrets were created
kubectl -n atlas get secrets | grep "production-prod-cluster"
```

### Scaling a Cluster

```bash
# Scale up the instance size
kubectl -n atlas patch atlasdeployment prod-cluster \
  --type=json \
  -p='[{"op":"replace","path":"/spec/deploymentSpec/replicationSpecs/0/regionConfigs/0/electableSpecs/instanceSize","value":"M40"}]'

# Watch the scale-up progress
kubectl -n atlas get atlasdeployment prod-cluster -w
```

### Pausing and Resuming

```bash
# Pause the cluster (stops billing for compute, not storage)
kubectl -n atlas patch atlasdeployment prod-cluster \
  --type=merge -p '{"spec":{"deploymentSpec":{"paused":true}}}'

# Resume
kubectl -n atlas patch atlasdeployment prod-cluster \
  --type=merge -p '{"spec":{"deploymentSpec":{"paused":false}}}'
```

### Restoring from Backup

Atlas backup restore is initiated through the Atlas UI or API. The operator does not currently manage restore operations. After a restore completes:

1. Update the connection strings in application secrets if the cluster was replaced
2. Verify database user credentials are still valid
3. Rebuild Atlas Search indexes if they were not restored

### Deleting a Project

The operator's deletion protection prevents accidental resource deletion. To delete:

```bash
# Remove deletion protection annotation
kubectl -n atlas annotate atlasdeployment prod-cluster \
  mongodb.com/atlas-resource-policy-

# Delete the deployment (Atlas will delete the cluster)
kubectl -n atlas delete atlasdeployment prod-cluster

# Delete the project (only after all deployments are removed)
kubectl -n atlas delete atlasproject production
```

The MongoDB Atlas Kubernetes Operator enables full declarative lifecycle management of Atlas database infrastructure through Kubernetes — from cluster provisioning to user RBAC, backup policies, and search indexes. By encoding Atlas configuration as Kubernetes resources, teams gain reproducible infrastructure, GitOps compatibility, and tight integration with existing Kubernetes tooling for secrets management, RBAC, and policy enforcement.
