---
title: "Kubernetes Disaster Recovery with GitOps: RTO/RPO Planning and Runbook Automation"
date: 2027-07-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Disaster Recovery", "GitOps", "High Availability", "Runbook"]
categories:
- Kubernetes
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes disaster recovery with GitOps. Covers DR strategy tiers, RTO/RPO definition, GitOps-driven cluster rebuild, Velero integration, stateful application patterns, DNS failover, chaos engineering DR testing, and Argo Workflows runbook automation."
more_link: "yes"
url: "/kubernetes-disaster-recovery-gitops-guide/"
---

Kubernetes clusters fail. Control planes lose quorum. Regions go dark. Storage pools corrupt. What differentiates organizations that recover in minutes from those that spend days rebuilding is not luck — it is a pre-planned, tested, and automated disaster recovery posture. This guide covers the full spectrum of Kubernetes DR: from defining RTO/RPO targets and choosing an appropriate DR tier, to implementing GitOps-driven cluster rebuild, integrating Velero for stateful data, automating DNS failover, and validating readiness with chaos engineering and Argo Workflows runbooks.

<!--more-->

## DR Strategy Tiers

Not every workload requires the same level of protection. Tiering DR strategies by cost and recovery time allows platform teams to allocate spending appropriately.

### Tier Definitions

| Tier | Name | RTO Target | RPO Target | Cost | Use Case |
|---|---|---|---|---|---|
| 1 | Backup-Restore | Hours | Hours | Low | Dev/test, non-critical workloads |
| 2 | Pilot Light | 30–60 min | Minutes | Medium | Internal tools, staging |
| 3 | Warm Standby | 5–15 min | < 1 min | High | Business-critical applications |
| 4 | Hot Active | < 1 min | 0 | Very High | Revenue-generating, SLA-bound systems |

```
Tier 1: Backup-Restore
  Primary Cluster (running) ──backup──▶ S3/Object Store
  Recovery: restore from backup to new cluster
  No secondary cluster running

Tier 2: Pilot Light
  Primary Cluster (running) ──replicate──▶ DR Cluster (minimal — CRDs, RBAC, secrets only)
  Recovery: scale up DR cluster workloads

Tier 3: Warm Standby
  Primary Cluster (running) ──sync──▶ DR Cluster (running at reduced capacity)
  Recovery: scale up and cut over DNS

Tier 4: Hot Active/Active
  Region A Cluster ◀──traffic split──▶ Region B Cluster
  Recovery: weighted DNS shift, automatic
```

## RTO/RPO Definition and Measurement

### Defining Targets

RTO (Recovery Time Objective) and RPO (Recovery Point Objective) must be defined per workload tier, not per cluster:

```yaml
# service-dr-policy.yaml — document per-service DR requirements
apiVersion: v1
kind: ConfigMap
metadata:
  name: service-dr-policy
  namespace: platform
data:
  payments-service.yaml: |
    tier: 4
    rto: 60s
    rpo: 0s
    dataClass: financial
    backupFrequency: continuous-replication
    drRegion: us-west-2
  orders-service.yaml: |
    tier: 3
    rto: 900s
    rpo: 60s
    dataClass: transactional
    backupFrequency: every-1min
    drRegion: us-west-2
  analytics-service.yaml: |
    tier: 1
    rto: 4h
    rpo: 24h
    dataClass: analytical
    backupFrequency: daily
    drRegion: us-west-2
```

### Measuring Actual RTO

Instrument DR tests with time measurements:

```bash
#!/bin/bash
# measure-rto.sh — run during DR drill to capture actual timings
set -euo pipefail

DRILL_ID="dr-drill-$(date +%Y%m%d-%H%M)"
LOG_FILE="/tmp/${DRILL_ID}.log"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

# T0: simulated failure
T_FAILURE=$(date +%s)
log "T0: Simulating failure — cordon all primary nodes"

# T1: detection time
# (Alert fires at T1)
T_DETECT=$(date +%s)
log "T1: Alert fired ($(( T_DETECT - T_FAILURE ))s after failure)"

# T2: decision to failover
T_DECISION=$(date +%s)
log "T2: Failover decision made ($(( T_DECISION - T_FAILURE ))s)"

# T3: workloads healthy on DR cluster
# ... run restore steps ...
T_RESTORED=$(date +%s)
log "T3: All workloads healthy on DR cluster"

# T4: DNS cutover complete
T_DNS=$(date +%s)
log "T4: DNS cutover complete"

ACTUAL_RTO=$(( T_DNS - T_FAILURE ))
log "ACTUAL RTO: ${ACTUAL_RTO}s"

# Compare to SLO
RTO_TARGET=900
if [[ $ACTUAL_RTO -le $RTO_TARGET ]]; then
  log "PASS: RTO ${ACTUAL_RTO}s within target ${RTO_TARGET}s"
else
  log "FAIL: RTO ${ACTUAL_RTO}s exceeds target ${RTO_TARGET}s"
  exit 1
fi
```

## GitOps-Driven Cluster Rebuild from Scratch

The most powerful DR pattern for Kubernetes infrastructure is treating the entire cluster configuration as code. With ArgoCD and a Git repository as the source of truth, a destroyed cluster can be rebuilt in minutes.

### Repository Structure

```
gitops-cluster-config/
├── bootstrap/
│   ├── argocd/               # ArgoCD install manifests
│   ├── cert-manager/         # cert-manager CRDs and operator
│   ├── external-secrets/     # External Secrets Operator
│   └── velero/               # Velero install
├── clusters/
│   ├── prod-us-east-1/
│   │   ├── apps/             # Application AppProjects and Applications
│   │   ├── infrastructure/   # Infrastructure components
│   │   └── namespaces/       # Namespace definitions
│   └── dr-us-west-2/
│       ├── apps/
│       ├── infrastructure/
│       └── namespaces/
├── apps/
│   ├── payments/
│   ├── orders/
│   └── analytics/
└── infrastructure/
    ├── monitoring/
    ├── ingress/
    └── storage/
```

### Bootstrap Script

```bash
#!/bin/bash
# bootstrap-cluster.sh
# Usage: ./bootstrap-cluster.sh <cluster-name> <git-repo-url>
set -euo pipefail

CLUSTER_NAME="${1:?Cluster name required}"
REPO_URL="${2:?Git repo URL required}"
ARGOCD_VERSION="v2.13.3"

echo "==> Bootstrapping cluster: ${CLUSTER_NAME}"

# Step 1: Install ArgoCD
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n argocd \
  -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"

echo "==> Waiting for ArgoCD to be ready..."
kubectl wait --for=condition=available deployment/argocd-server \
  -n argocd --timeout=300s

# Step 2: Apply the bootstrap App-of-Apps
kubectl apply -f - <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: bootstrap
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: ${REPO_URL}
    targetRevision: HEAD
    path: bootstrap
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
EOF

echo "==> Bootstrap application created. ArgoCD will now sync all cluster config."
echo "==> Monitor progress: kubectl get applications -n argocd -w"
```

### App-of-Apps Bootstrap Structure

```yaml
# bootstrap/argocd/app-of-apps.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cluster-infrastructure
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/example/gitops-cluster-config
    targetRevision: HEAD
    path: clusters/prod-us-east-1/infrastructure
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

## Velero + GitOps for Complete DR

GitOps restores the cluster control plane and workload definitions. Velero restores the stateful data. Together they provide full cluster recovery.

### DR Runbook: Full Cluster Loss

```bash
#!/bin/bash
# dr-full-restore.sh
set -euo pipefail

PRIMARY_CLUSTER="prod-us-east-1"
DR_CLUSTER="dr-us-west-2"
GIT_REPO="https://github.com/example/gitops-cluster-config"
VELERO_BACKUP="full-daily-$(date -d 'yesterday' +%Y%m%d)000000"

echo "==> DR Event: Full cluster loss for ${PRIMARY_CLUSTER}"
echo "==> Target DR cluster: ${DR_CLUSTER}"

# Step 1: Switch kubeconfig context to DR cluster
kubectl config use-context "${DR_CLUSTER}"

# Step 2: Bootstrap GitOps (if not already seeded)
./bootstrap-cluster.sh "${DR_CLUSTER}" "${GIT_REPO}"

# Step 3: Wait for critical infrastructure components
echo "==> Waiting for cert-manager..."
kubectl wait --for=condition=available deployment/cert-manager \
  -n cert-manager --timeout=300s

echo "==> Waiting for external-secrets..."
kubectl wait --for=condition=available deployment/external-secrets \
  -n external-secrets --timeout=300s

echo "==> Waiting for Velero..."
kubectl wait --for=condition=available deployment/velero \
  -n velero --timeout=300s

# Step 4: Restore application data from Velero backup
echo "==> Restoring from backup: ${VELERO_BACKUP}"
velero restore create "dr-restore-$(date +%Y%m%d%H%M)" \
  --from-backup "${VELERO_BACKUP}" \
  --exclude-namespaces kube-system,kube-public,cert-manager,external-secrets,argocd,velero \
  --restore-volumes=true \
  --wait

# Step 5: Verify application pods
echo "==> Verifying application health..."
kubectl get pods --all-namespaces | grep -E "(Error|CrashLoop|Pending)" || true

echo "==> DR restore complete. Proceed to DNS cutover."
```

## Stateful Application DR Patterns

### PostgreSQL with Streaming Replication

```yaml
# postgres-patroni-dr.yaml — Primary/Standby across regions
apiVersion: "acid.zalan.do/v1"
kind: postgresql
metadata:
  name: postgres-cluster
  namespace: production
spec:
  teamId: "platform"
  volume:
    size: 100Gi
    storageClass: longhorn
  numberOfInstances: 3
  postgresql:
    version: "16"
    parameters:
      wal_level: logical
      max_wal_senders: "10"
      wal_keep_size: "1GB"
  standby:
    enabled: false    # Enable on DR cluster: true
    s3_wal_path: "s3://postgres-wal-archive/prod-cluster"
  clone:
    cluster: ""
    s3_wal_path: ""
  patroni:
    slots:
      dr_replica:
        type: physical
        database: "*"
```

### Redis with Velero Hooks

```yaml
# redis-deployment-dr-hooks.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: production
  annotations:
    pre.hook.backup.velero.io/command: >-
      ["/bin/bash", "-c", "redis-cli BGSAVE && sleep 2"]
    pre.hook.backup.velero.io/container: redis
    pre.hook.backup.velero.io/on-error: Fail
    pre.hook.backup.velero.io/timeout: 30s
```

### Kafka with Cross-Region Mirroring

```yaml
# kafka-mirrormaker2.yaml — replicate topics to DR cluster
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaMirrorMaker2
metadata:
  name: kafka-dr-mirror
  namespace: kafka
spec:
  version: 3.7.0
  replicas: 3
  connectCluster: "dr-cluster"
  clusters:
    - alias: "source"
      bootstrapServers: kafka.production.svc.cluster.local:9092
    - alias: "dr-cluster"
      bootstrapServers: kafka-dr.dr-region.svc.cluster.local:9092
      config:
        ssl.enabled.protocols: "TLSv1.2,TLSv1.3"
  mirrors:
    - sourceCluster: "source"
      targetCluster: "dr-cluster"
      sourceConnector:
        config:
          replication.factor: "3"
          offset-syncs.topic.replication.factor: "3"
          refresh.topics.interval.seconds: "60"
          sync.topic.acls.enabled: "false"
      heartbeatConnector:
        config:
          heartbeats.topic.replication.factor: "3"
      checkpointConnector:
        config:
          checkpoints.topic.replication.factor: "3"
          sync.group.offsets.enabled: "true"
          sync.group.offsets.interval.seconds: "60"
      topicsPattern: ".*"
      groupsPattern: ".*"
```

## DNS Failover Automation

### External DNS with Health Checks

```yaml
# external-dns-dr.yaml
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
```

### Route 53 Health Check-Based Failover

```bash
# Create health checks for primary and DR endpoints
aws route53 create-health-check \
  --caller-reference "primary-$(date +%s)" \
  --health-check-config '{
    "Type": "HTTPS",
    "FullyQualifiedDomainName": "primary-lb.us-east-1.elb.amazonaws.com",
    "Port": 443,
    "ResourcePath": "/health",
    "FailureThreshold": 3,
    "RequestInterval": 10
  }'

# Primary DNS record (Failover PRIMARY)
aws route53 change-resource-record-sets \
  --hosted-zone-id REPLACE_WITH_HOSTED_ZONE_ID \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "primary",
        "Failover": "PRIMARY",
        "HealthCheckId": "REPLACE_WITH_HEALTH_CHECK_ID",
        "AliasTarget": {
          "HostedZoneId": "Z35SXDOTRQ7X7K",
          "DNSName": "primary-lb.us-east-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'

# DR DNS record (Failover SECONDARY — only receives traffic when primary is unhealthy)
aws route53 change-resource-record-sets \
  --hosted-zone-id REPLACE_WITH_HOSTED_ZONE_ID \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "dr",
        "Failover": "SECONDARY",
        "AliasTarget": {
          "HostedZoneId": "Z1H1FL5HABSF5",
          "DNSName": "dr-lb.us-west-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

### Automated DNS Cutover Script

```bash
#!/bin/bash
# dns-failover.sh — manual trigger for DR DNS cutover
set -euo pipefail

HOSTED_ZONE_ID="${HOSTED_ZONE_ID:?Set HOSTED_ZONE_ID}"
DR_LB_DNS="${DR_LB_DNS:?Set DR_LB_DNS}"
DR_HOSTED_ZONE_ID="${DR_HOSTED_ZONE_ID:?Set DR_HOSTED_ZONE_ID}"
DOMAIN="api.example.com"

echo "==> Initiating DNS failover for ${DOMAIN} to DR: ${DR_LB_DNS}"

# Lower TTL first (requires pre-planning — lower TTL 24h before potential DR)
aws route53 change-resource-record-sets \
  --hosted-zone-id "${HOSTED_ZONE_ID}" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"${DOMAIN}\",
        \"Type\": \"A\",
        \"SetIdentifier\": \"dr-manual\",
        \"Weight\": 100,
        \"AliasTarget\": {
          \"HostedZoneId\": \"${DR_HOSTED_ZONE_ID}\",
          \"DNSName\": \"${DR_LB_DNS}\",
          \"EvaluateTargetHealth\": true
        }
      }
    }]
  }"

echo "==> DNS cutover initiated. TTL propagation in progress."
echo "==> Test: dig +short ${DOMAIN}"
```

## DR Testing with Chaos Engineering

Regular DR testing through controlled failure injection validates runbooks and identifies gaps before real disasters occur.

### Chaos Mesh DR Scenario

```yaml
# chaos-kill-region.yaml — simulate region loss by disrupting all pods in critical namespaces
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: simulate-region-loss
  namespace: chaos-testing
spec:
  action: pod-kill
  mode: all
  selector:
    namespaces:
      - payments
      - orders
  scheduler:
    cron: "@yearly"   # Only run during scheduled DR drills
```

### Litmus Chaos DR Workflow

```yaml
# litmus-dr-test.yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: dr-test-storage
  namespace: litmus
spec:
  appinfo:
    appns: production
    applabel: app=postgres
    appkind: deployment
  engineState: active
  chaosServiceAccount: litmus-admin
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: "60"
            - name: CHAOS_INTERVAL
              value: "30"
            - name: FORCE
              value: "false"
    - name: disk-fill
      spec:
        components:
          env:
            - name: FILL_PERCENTAGE
              value: "80"
            - name: TOTAL_CHAOS_DURATION
              value: "120"
```

### DR Drill Checklist

```markdown
## DR Drill Checklist — Quarterly

### Pre-Drill (T-24h)
- [ ] Lower DNS TTL to 60s for all critical endpoints
- [ ] Notify stakeholders of scheduled maintenance window
- [ ] Verify latest Velero backup is available and complete
- [ ] Confirm DR cluster infrastructure is healthy
- [ ] Verify backup S3 bucket access from DR cluster

### During Drill (T0)
- [ ] Record start time for RTO measurement
- [ ] Execute failure simulation (scaled-down primary, not actual destruction)
- [ ] Start DR bootstrap script
- [ ] Monitor ArgoCD sync on DR cluster
- [ ] Execute Velero restore for stateful data
- [ ] Verify application health checks pass on DR cluster
- [ ] Execute DNS cutover script
- [ ] Verify external traffic reaches DR cluster
- [ ] Record end time — calculate actual RTO

### Post-Drill (T+1h)
- [ ] Revert DNS to primary cluster
- [ ] Restore primary cluster to normal state
- [ ] Document actual RTO/RPO measurements
- [ ] Identify gaps and create action items
- [ ] Update runbooks with lessons learned
```

## Argo Workflows Runbook Automation

Argo Workflows can execute DR runbooks as code, ensuring consistent execution and providing audit trails.

### DR Restore Workflow

```yaml
# argo-dr-restore-workflow.yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: dr-restore-workflow
  namespace: argo
spec:
  entrypoint: dr-restore
  serviceAccountName: argo-dr-sa
  templates:
    - name: dr-restore
      steps:
        - - name: check-backup-exists
            template: check-backup
            arguments:
              parameters:
                - name: backup-name
                  value: "{{workflow.parameters.backup-name}}"
        - - name: bootstrap-argocd
            template: run-script
            arguments:
              parameters:
                - name: script
                  value: |
                    kubectl apply -n argocd \
                      -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.13.3/manifests/install.yaml
                    kubectl wait --for=condition=available deployment/argocd-server \
                      -n argocd --timeout=300s
        - - name: wait-for-infrastructure
            template: run-script
            arguments:
              parameters:
                - name: script
                  value: |
                    kubectl wait --for=condition=available deployment/cert-manager \
                      -n cert-manager --timeout=300s
                    kubectl wait --for=condition=available deployment/velero \
                      -n velero --timeout=300s
        - - name: velero-restore
            template: run-script
            arguments:
              parameters:
                - name: script
                  value: |
                    velero restore create "dr-restore-$(date +%Y%m%d%H%M)" \
                      --from-backup {{workflow.parameters.backup-name}} \
                      --wait
        - - name: verify-pods
            template: run-script
            arguments:
              parameters:
                - name: script
                  value: |
                    FAILING=$(kubectl get pods --all-namespaces \
                      -o jsonpath='{range .items[?(@.status.phase!="Running")]}{.metadata.namespace}/{.metadata.name} {.status.phase}{"\n"}{end}')
                    if [[ -n "$FAILING" ]]; then
                      echo "FAILING PODS: $FAILING"
                      exit 1
                    fi
                    echo "All pods healthy"
        - - name: dns-cutover
            template: run-script
            arguments:
              parameters:
                - name: script
                  value: |
                    ./dns-failover.sh

    - name: check-backup
      inputs:
        parameters:
          - name: backup-name
      container:
        image: bitnami/kubectl:1.30
        command: [bash, -c]
        args:
          - |
            velero backup get {{inputs.parameters.backup-name}}
            STATUS=$(velero backup get {{inputs.parameters.backup-name}} \
              -o jsonpath='{.status.phase}')
            if [[ "$STATUS" != "Completed" ]]; then
              echo "Backup not in Completed state: $STATUS"
              exit 1
            fi

    - name: run-script
      inputs:
        parameters:
          - name: script
      container:
        image: bitnami/kubectl:1.30
        command: [bash, -c]
        args: ["{{inputs.parameters.script}}"]

  arguments:
    parameters:
      - name: backup-name
        value: "full-daily-20270727000000"
```

### Trigger the DR Workflow

```bash
argo submit dr-restore-workflow.yaml \
  -n argo \
  -p backup-name="full-daily-20270727000000" \
  --watch
```

## Postmortem-Driven DR Improvements

After every actual incident or DR drill, run a structured postmortem and feed findings back into DR improvements.

### Postmortem Template

```markdown
## DR Postmortem — [Date] — [Incident ID]

### Timeline
| Time | Event |
|------|-------|
| HH:MM | Failure detected |
| HH:MM | DR decision made |
| HH:MM | DR restore initiated |
| HH:MM | Traffic on DR cluster |
| HH:MM | Primary recovered |

### RTO/RPO Actual vs Target
| Metric | Target | Actual | Delta |
|--------|--------|--------|-------|
| RTO    | 15min  | 23min  | +8min |
| RPO    | 1min   | 3min   | +2min |

### What Went Well
-

### What Went Wrong
-

### Contributing Factors
-

### Action Items
| Item | Owner | Due Date | Priority |
|------|-------|----------|----------|
| Automate DNS cutover | platform-team | +2 weeks | P1 |
| Add backup verification step | platform-team | +1 week | P1 |
```

## DR Metrics and SLOs

```yaml
# dr-slo.yaml — SLO definitions for DR capabilities
apiVersion: sloth.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: dr-backup-freshness
  namespace: monitoring
spec:
  service: "velero-backup"
  labels:
    team: platform
  slos:
    - name: backup-freshness
      objective: 99.9
      description: "Daily backup completes within 25 hours"
      sli:
        events:
          errorQuery: |
            (time() - velero_backup_last_successful_timestamp{schedule="full-daily"}) > 90000
          totalQuery: |
            vector(1)
      alerting:
        name: DRBackupStale
        labels:
          severity: critical
        annotations:
          summary: "DR backup SLO breach — backup is stale"
        pageAlert:
          labels:
            severity: critical
        ticketAlert:
          labels:
            severity: warning
```

## Summary

Kubernetes disaster recovery requires layering multiple capabilities: GitOps for cluster configuration, Velero for stateful data, health check-driven DNS failover, and tested runbooks for human coordination. Key takeaways:

- Tier DR strategies by workload criticality — not every service needs active-active
- Treat cluster configuration as code; GitOps bootstrap reduces control-plane RTO to minutes
- Combine Velero backup restoration with GitOps sync for complete cluster recovery
- Implement database-specific DR patterns for PostgreSQL, Redis, and Kafka
- Automate DNS failover with Route 53 health checks and scripted cutover procedures
- Run quarterly DR drills with chaos engineering to validate actual RTO/RPO
- Codify DR runbooks as Argo Workflows for consistent, auditable execution
- Feed every incident and drill back into runbook improvements through structured postmortems

The goal is not a perfect DR plan — it is a tested, improving system that shrinks the gap between target and actual recovery capability over time.
