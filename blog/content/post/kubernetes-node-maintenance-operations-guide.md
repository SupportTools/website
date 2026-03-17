---
title: "Kubernetes Node Maintenance: Zero-Downtime Operations and Upgrades"
date: 2027-12-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Maintenance", "PodDisruptionBudget", "kured", "Upgrades", "Operations"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes node maintenance covering cordon/drain patterns, PodDisruptionBudgets, rolling and blue/green node upgrades, kured for automated reboots, node label and taint management, and cloud provider node group operations."
more_link: "yes"
url: "/kubernetes-node-maintenance-operations-guide/"
---

Node maintenance is the operational activity that most directly threatens application availability. A misconfigured drain, a missing PodDisruptionBudget, or an uncoordinated upgrade can cascade into service degradation or outright outages. Production Kubernetes environments require disciplined maintenance procedures that guarantee workload continuity regardless of the scale of the operation.

This guide covers the complete node maintenance lifecycle: configuring PodDisruptionBudgets, executing cordon and drain safely, automating kernel updates with kured, orchestrating rolling and blue/green node pool upgrades, managing node labels and taints for workload placement, and integrating with cloud provider node group operations.

<!--more-->

# Kubernetes Node Maintenance: Zero-Downtime Operations and Upgrades

## Section 1: PodDisruptionBudgets — Guaranteeing Availability During Maintenance

A PodDisruptionBudget (PDB) is the contract between the application team and the platform team. It defines the minimum availability requirements that the cluster must respect when voluntarily evicting pods (during drain, upgrades, or autoscaler scale-down).

### Creating PodDisruptionBudgets

```yaml
# pdb-payment-service.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  # Minimum 2 replicas must be available at all times
  minAvailable: 2
  selector:
    matchLabels:
      app: payment-service
---
# pdb-api-gateway.yaml — percentage-based
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-gateway-pdb
  namespace: production
spec:
  # Maximum 20% of pods can be disrupted simultaneously
  maxUnavailable: 20%
  selector:
    matchLabels:
      app: api-gateway
---
# pdb-etcd.yaml — strict single-node constraint
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: etcd-pdb
  namespace: kube-system
spec:
  minAvailable: 2  # For 3-node etcd, never evict more than 1
  selector:
    matchLabels:
      component: etcd
---
# pdb-statefulset-kafka.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: kafka-pdb
  namespace: kafka
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: kafka
      role: broker
```

### Checking PDB Status

```bash
# List all PDBs across namespaces
kubectl get pdb -A

# Detailed status showing disruption allowance
kubectl get pdb -A -o custom-columns="NAMESPACE:.metadata.namespace,NAME:.metadata.name,MIN-AVAILABLE:.spec.minAvailable,MAX-UNAVAILABLE:.spec.maxUnavailable,ALLOWED:.status.disruptionsAllowed,CURRENT:.status.currentHealthy,DESIRED:.status.desiredHealthy"

# Describe a specific PDB
kubectl describe pdb payment-service-pdb -n production

# Check if a node drain will be blocked by PDBs
kubectl drain node-01 --dry-run --delete-emptydir-data --ignore-daemonsets

# Find applications missing PDBs (important audit)
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
  echo "=== Namespace: $ns ==="
  kubectl get deployments -n $ns -o json | \
    jq -r '.items[] | select(.spec.replicas > 1) | .metadata.name' | \
    while read deploy; do
      pdb=$(kubectl get pdb -n $ns \
        -o jsonpath="{.items[?(@.spec.selector.matchLabels.app==\"$deploy\")].metadata.name}" 2>/dev/null)
      if [ -z "$pdb" ]; then
        echo "  MISSING PDB: $deploy (replicas: $(kubectl get deployment $deploy -n $ns -o jsonpath='{.spec.replicas}'))"
      fi
    done
done
```

### PDB Anti-Patterns to Avoid

```yaml
# BAD: This blocks all drains indefinitely if there's 1 replica
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: bad-pdb
spec:
  minAvailable: 1  # With 1 replica, this means 0 disruptions allowed
  selector:
    matchLabels:
      app: single-replica-service

# GOOD: Use maxUnavailable: 0 only for truly zero-downtime requirements
# and ensure replicas >= 2
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: good-pdb
spec:
  maxUnavailable: 1  # Always allows at least 1 disruption
  selector:
    matchLabels:
      app: payment-service
# Ensure Deployment has replicas: 3 to maintain availability
```

## Section 2: Cordon and Drain Patterns

### Cordon — Mark Node Unschedulable

Cordoning prevents new pods from being scheduled on a node without evicting existing pods. Use it when preparing for maintenance but not yet ready to migrate workloads.

```bash
# Cordon a node
kubectl cordon node-worker-01

# Verify node is cordoned
kubectl get node node-worker-01

# NAME              STATUS                     ROLES    AGE
# node-worker-01    Ready,SchedulingDisabled   worker   45d

# Cordon multiple nodes
kubectl cordon node-worker-01 node-worker-02 node-worker-03

# Cordon nodes matching a label selector
kubectl get nodes -l node-pool=gpu-pool -o name | \
  xargs kubectl cordon

# Uncordon (re-enable scheduling)
kubectl uncordon node-worker-01
```

### Drain — Evict Workloads from a Node

Draining combines cordoning with eviction of all evictable pods, respecting PodDisruptionBudgets.

```bash
# Standard drain with safety flags
kubectl drain node-worker-01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=300s \
  --grace-period=60

# Flags explained:
# --ignore-daemonsets: DaemonSet pods are managed by DaemonSet, not evicted
# --delete-emptydir-data: Allow eviction of pods using emptyDir (data lost)
# --timeout: Maximum time to wait for the drain to complete
# --grace-period: Override pod termination grace period (use caution)

# Dry-run to preview what will be evicted
kubectl drain node-worker-01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --dry-run

# Drain with output showing eviction progress
kubectl drain node-worker-01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=600s \
  2>&1 | tee /tmp/drain-node-worker-01-$(date +%Y%m%d-%H%M%S).log
```

### Handling Drain Failures

```bash
# Diagnose why drain is blocked
# 1. Check for pods without PDBs allowing eviction
kubectl get pods --field-selector spec.nodeName=node-worker-01 -A

# 2. Find pods blocking eviction due to PDB
kubectl get pods --field-selector spec.nodeName=node-worker-01 -A \
  -o custom-columns="NS:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase,OWNER:.metadata.ownerReferences[0].kind"

# 3. Check for mirror pods (cannot be evicted)
kubectl get pods --field-selector spec.nodeName=node-worker-01 -A \
  -o jsonpath='{range .items[?(@.metadata.annotations.kubernetes\.io/config\.mirror)]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'

# 4. Force drain (DANGER: bypasses PDB — use only for node failure scenarios)
kubectl drain node-worker-01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --force \
  --disable-eviction  # Bypasses PDB, uses delete instead of eviction API
```

### Drain Script for Maintenance Windows

```bash
#!/usr/bin/env bash
# safe-drain.sh — drain with pre-checks and post-verification

set -euo pipefail

NODE="$1"
NAMESPACE="${2:-production}"
LOG_FILE="/var/log/node-maintenance/drain-${NODE}-$(date +%Y%m%d-%H%M%S).log"

mkdir -p /var/log/node-maintenance

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "Starting drain for node: $NODE"

# Pre-check: verify node exists and is Ready
NODE_STATUS=$(kubectl get node "$NODE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
if [ "$NODE_STATUS" != "True" ]; then
  log "ERROR: Node $NODE is not Ready (status: $NODE_STATUS). Aborting."
  exit 1
fi

# Pre-check: count pods that will be affected
POD_COUNT=$(kubectl get pods --field-selector "spec.nodeName=$NODE" -A --no-headers 2>/dev/null | \
  grep -v "DaemonSet" | wc -l)
log "Pods to be evicted (approx): $POD_COUNT"

# Pre-check: check PDB status
BLOCKED_PDBS=$(kubectl get pdb -n "$NAMESPACE" \
  -o jsonpath='{range .items[?(@.status.disruptionsAllowed==0)]}{.metadata.name}{"\n"}{end}')
if [ -n "$BLOCKED_PDBS" ]; then
  log "WARNING: The following PDBs currently allow 0 disruptions:"
  echo "$BLOCKED_PDBS" | while read pdb; do
    log "  - $pdb"
  done
  log "Drain may block until these PDBs allow disruption. Continuing..."
fi

# Cordon the node
log "Cordoning node..."
kubectl cordon "$NODE"

# Drain the node
log "Draining node (timeout: 600s)..."
if kubectl drain "$NODE" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=600s \
  2>&1 | tee -a "$LOG_FILE"; then
  log "Drain completed successfully."
else
  log "ERROR: Drain failed. Node remains cordoned. Manual intervention required."
  kubectl get pods --field-selector "spec.nodeName=$NODE" -A | tee -a "$LOG_FILE"
  exit 1
fi

# Post-check: verify no workload pods remain
REMAINING=$(kubectl get pods --field-selector "spec.nodeName=$NODE" -A --no-headers 2>/dev/null | \
  grep -v "DaemonSet" | wc -l)
if [ "$REMAINING" -gt 0 ]; then
  log "WARNING: $REMAINING non-DaemonSet pods remain on node."
else
  log "All workload pods evacuated. Node ready for maintenance."
fi

log "Maintenance window open for: $NODE"
log "Remember to run: kubectl uncordon $NODE when maintenance is complete"
```

## Section 3: kured — Automated Kernel Update Reboots

Kured (KUbernetes REboot Daemon) watches for the `/var/run/reboot-required` sentinel file (written by unattended-upgrades on Ubuntu) and orchestrates node reboots one at a time, respecting PodDisruptionBudgets.

### Deploy kured

```yaml
# kured-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kured
  namespace: kube-system
  labels:
    app: kured
spec:
  selector:
    matchLabels:
      app: kured
  updateStrategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: kured
    spec:
      serviceAccountName: kured
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
        - key: node-role.kubernetes.io/master
          effect: NoSchedule
      hostPID: true  # Required to execute reboot
      restartPolicy: Always
      containers:
        - name: kured
          image: ghcr.io/kubereboot/kured:1.15.0
          imagePullPolicy: IfNotPresent
          securityContext:
            privileged: true
          env:
            - name: KURED_NODE_ID
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          ports:
            - containerPort: 8080
              name: metrics
          command:
            - /usr/bin/kured
            - --reboot-sentinel=/var/run/reboot-required
            - --reboot-days=mon,tue,wed,thu,fri
            - --start-time=02:00          # Reboot window: 2 AM
            - --end-time=05:00            # to 5 AM UTC
            - --time-zone=UTC
            - --reboot-delay=120s         # Wait 2 min between node reboots
            - --drain-timeout=300s
            - --period=1h                 # Check for reboot-required every hour
            - --lock-release-delay=30s
            - --log-format=json
            - --prometheus-url=http://prometheus.monitoring.svc.cluster.local:9090
            - --alert-filter-regexp=^(RebootRequired|KuredRebootRequired)$
            - --notify-url=slack://T0000000/B0000000/placeholder-webhook-url
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kured
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kured
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list", "delete", "get"]
  - apiGroups: ["apps"]
    resources: ["daemonsets"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods/eviction"]
    verbs: ["create"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "create", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kured
subjects:
  - kind: ServiceAccount
    name: kured
    namespace: kube-system
roleRef:
  kind: ClusterRole
  name: kured
  apiGroup: rbac.authorization.k8s.io
```

### kured Operations

```bash
# Check kured status
kubectl get daemonset kured -n kube-system
kubectl logs -n kube-system daemonset/kured | grep -E "(reboot|drain|cordon|lock)"

# Check which nodes have reboot-required set
for node in $(kubectl get nodes -o name | sed 's|node/||'); do
  REBOOT=$(kubectl get node $node \
    -o jsonpath='{.metadata.annotations.weave\.works/kured-reboot-in-progress}' 2>/dev/null || echo "")
  if [ -n "$REBOOT" ]; then
    echo "Rebooting: $node"
  fi
done

# Pause kured reboot activity (e.g., during incidents)
kubectl annotate node --all weave.works/kured-reboot-sentinel=false

# Resume kured
kubectl annotate node --all weave.works/kured-reboot-sentinel-

# Force reboot-required on a specific node (for testing)
kubectl debug node/node-worker-01 -it --image=ubuntu:22.04 -- \
  bash -c "touch /host/var/run/reboot-required"
```

## Section 4: Node Upgrade Strategies

### Rolling Node Upgrade (Default)

Rolling upgrades replace nodes one at a time. Existing workloads are drained before each node is replaced.

```bash
# For cloud-managed node groups (EKS, GKE, AKS), use provider-specific upgrade
# For self-managed clusters, use this rolling pattern:

NODES=$(kubectl get nodes -l node-pool=workers -o jsonpath='{.items[*].metadata.name}')

for NODE in $NODES; do
  echo "=== Upgrading node: $NODE ==="

  # Cordon and drain
  kubectl cordon "$NODE"
  kubectl drain "$NODE" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=300s

  # Upgrade node OS/kernel (provider-specific)
  # For AWS: terminate instance, ASG launches replacement
  aws ec2 terminate-instances \
    --instance-ids $(kubectl get node "$NODE" -o jsonpath='{.spec.providerID}' | cut -d'/' -f5)

  # Wait for replacement node to join
  echo "Waiting for replacement node to become Ready..."
  kubectl wait --for=condition=Ready node \
    --selector=node-pool=workers \
    --timeout=600s

  # Verify cluster health before continuing
  READY=$(kubectl get nodes -l node-pool=workers \
    --field-selector status.conditions.Ready=True --no-headers | wc -l)
  TOTAL=$(kubectl get nodes -l node-pool=workers --no-headers | wc -l)
  echo "Nodes ready: $READY / $TOTAL"

  # Sleep between nodes to allow workloads to rebalance
  sleep 60
done
```

### Blue/Green Node Pool Upgrade

Blue/green node pool upgrades create a new node pool with the target configuration and migrate workloads before decommissioning the old pool.

```bash
#!/usr/bin/env bash
# blue-green-node-upgrade.sh

set -euo pipefail

OLD_POOL_LABEL="node-pool=workers-v1"
NEW_POOL_LABEL="node-pool=workers-v2"
NAMESPACE="production"

echo "Phase 1: Verify new node pool is healthy"
kubectl wait --for=condition=Ready nodes \
  --selector="$NEW_POOL_LABEL" \
  --timeout=600s

NEW_NODE_COUNT=$(kubectl get nodes -l "$NEW_POOL_LABEL" --no-headers | wc -l)
echo "New pool nodes: $NEW_NODE_COUNT"

echo "Phase 2: Taint old pool to prevent new pod scheduling"
kubectl get nodes -l "$OLD_POOL_LABEL" -o name | \
  xargs -I{} kubectl taint {} \
  node-pool-draining=true:NoSchedule \
  --overwrite

echo "Phase 3: Verify workloads are rescheduling to new pool"
# Trigger rolling restart to move pods to new pool
kubectl rollout restart deployment -n "$NAMESPACE"
kubectl rollout status deployment -n "$NAMESPACE" --timeout=10m

echo "Phase 4: Cordon old pool nodes"
kubectl get nodes -l "$OLD_POOL_LABEL" -o name | \
  xargs kubectl cordon

echo "Phase 5: Drain old pool nodes sequentially"
for NODE in $(kubectl get nodes -l "$OLD_POOL_LABEL" -o jsonpath='{.items[*].metadata.name}'); do
  echo "Draining: $NODE"
  kubectl drain "$NODE" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --timeout=300s
  echo "Drained: $NODE. Sleeping 30s..."
  sleep 30
done

echo "Phase 6: Delete old node pool (cloud-provider specific)"
# AWS EKS:
# eksctl delete nodegroup --cluster=my-cluster --name=workers-v1
# GKE:
# gcloud container node-pools delete workers-v1 --cluster=my-cluster --zone=us-central1-a

echo "Blue/green upgrade complete. Old pool: $OLD_POOL_LABEL decommissioned."
```

### kubeadm Node Upgrade (Self-Managed)

```bash
#!/usr/bin/env bash
# upgrade-worker-node.sh — upgrade a self-managed kubeadm worker node

set -euo pipefail

NODE="$1"
TARGET_VERSION="${2:-1.30.1}"  # e.g., 1.30.1

echo "=== Upgrading worker node $NODE to Kubernetes $TARGET_VERSION ==="

# Step 1: Cordon and drain from management host
kubectl cordon "$NODE"
kubectl drain "$NODE" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=300s

# Step 2: SSH to node and upgrade kubeadm
ssh "ubuntu@${NODE}" bash << EOF
set -euo pipefail

# Update package list
sudo apt-get update

# Install target kubeadm version
sudo apt-mark unhold kubeadm
sudo apt-get install -y kubeadm=${TARGET_VERSION}-1.1
sudo apt-mark hold kubeadm

# Verify kubeadm version
kubeadm version

# Run kubeadm upgrade
sudo kubeadm upgrade node

# Upgrade kubelet and kubectl
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=${TARGET_VERSION}-1.1 kubectl=${TARGET_VERSION}-1.1
sudo apt-mark hold kubelet kubectl

# Restart kubelet
sudo systemctl daemon-reload
sudo systemctl restart kubelet

echo "Kubelet version: $(kubelet --version)"
EOF

# Step 3: Wait for node to become Ready
echo "Waiting for node $NODE to become Ready..."
kubectl wait --for=condition=Ready node/"$NODE" --timeout=300s

# Step 4: Uncordon
kubectl uncordon "$NODE"

echo "Node $NODE upgraded to $TARGET_VERSION successfully"
kubectl get node "$NODE"
```

## Section 5: Node Labels and Taints Management

### Node Labels for Workload Placement

```bash
# Label nodes by hardware capability
kubectl label node node-gpu-01 accelerator=nvidia-a100
kubectl label node node-gpu-01 nvidia.com/gpu.product=A100-SXM4-80GB
kubectl label node node-storage-01 storage-class=nvme

# Label nodes by topology
kubectl label node node-worker-01 topology.kubernetes.io/zone=us-east-1a
kubectl label node node-worker-01 topology.kubernetes.io/region=us-east-1

# Label nodes by maintenance status
kubectl label node node-worker-01 maintenance=scheduled
kubectl label node node-worker-01 maintenance-window=2027-12-29T02:00:00Z

# Query nodes by label
kubectl get nodes -l accelerator=nvidia-a100
kubectl get nodes -l "topology.kubernetes.io/zone in (us-east-1a,us-east-1b)"

# Remove a label
kubectl label node node-worker-01 maintenance-
```

### Node Taints for Dedicated Workloads

```bash
# Taint GPU nodes for GPU workloads only
kubectl taint node node-gpu-01 \
  nvidia.com/gpu=present:NoSchedule

# Taint for maintenance (evict existing pods)
kubectl taint node node-worker-01 \
  maintenance=scheduled:NoExecute

# Taint control plane nodes (standard)
kubectl taint node control-plane-01 \
  node-role.kubernetes.io/control-plane:NoSchedule

# Remove a taint
kubectl taint node node-worker-01 maintenance-

# List all node taints
kubectl get nodes -o custom-columns="NAME:.metadata.name,TAINTS:.spec.taints"

# Apply taint to multiple nodes
kubectl get nodes -l node-pool=spot-pool -o name | \
  xargs -I{} kubectl taint {} \
  cloud.google.com/gke-spot=true:NoSchedule \
  --overwrite
```

### NodeSelector and Affinity in Deployments

```yaml
# deployment-with-affinity.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gpu-inference-service
  namespace: production
spec:
  replicas: 4
  selector:
    matchLabels:
      app: gpu-inference-service
  template:
    metadata:
      labels:
        app: gpu-inference-service
    spec:
      # Require GPU nodes
      nodeSelector:
        accelerator: nvidia-a100
      # Prefer nodes with low GPU utilization
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: accelerator
                    operator: In
                    values:
                      - nvidia-a100
                  - key: maintenance
                    operator: DoesNotExist
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: topology.kubernetes.io/zone
                    operator: In
                    values:
                      - us-east-1a
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: gpu-inference-service
              topologyKey: kubernetes.io/hostname
      tolerations:
        - key: nvidia.com/gpu
          operator: Equal
          value: present
          effect: NoSchedule
      containers:
        - name: inference
          image: gcr.io/corp-registry/gpu-inference:v2.0.0
          resources:
            limits:
              nvidia.com/gpu: "1"
```

## Section 6: Graceful Shutdown Hooks

### Pre-Stop Hooks for Zero-Downtime Drains

```yaml
# deployment-graceful-shutdown.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: api-server
          image: gcr.io/corp-registry/api-server:v1.5.0
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - |
                    # Signal application to stop accepting new connections
                    kill -SIGTERM 1
                    # Wait for in-flight requests to complete
                    sleep 15
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            failureThreshold: 1
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
```

### Node Shutdown Graceful Period

```yaml
# kubelet-config.yaml — graceful node shutdown
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
shutdownGracePeriod: 120s                   # Total shutdown time
shutdownGracePeriodCriticalPods: 30s        # Time reserved for critical pods
nodeStatusUpdateFrequency: "10s"
nodeStatusReportFrequency: "5m"
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"
evictionSoftGracePeriod:
  memory.available: "90s"
  nodefs.available: "90s"
```

## Section 7: Cloud Provider Node Group Operations

### AWS EKS Managed Node Groups

```bash
# Update managed node group AMI (rolling update)
aws eks update-nodegroup-version \
  --cluster-name production-cluster \
  --nodegroup-name workers-v1 \
  --release-version 1.29.3-20240207 \
  --region us-east-1

# Monitor update progress
aws eks describe-update \
  --cluster-name production-cluster \
  --nodegroup-name workers-v1 \
  --name <update-id>

# Force update even if PDB would block (NOT recommended)
aws eks update-nodegroup-version \
  --cluster-name production-cluster \
  --nodegroup-name workers-v1 \
  --force

# Scale node group
aws eks update-nodegroup-config \
  --cluster-name production-cluster \
  --nodegroup-name workers-v1 \
  --scaling-config minSize=3,maxSize=20,desiredSize=10
```

### GKE Node Pool Upgrade

```bash
# Upgrade node pool to specific version
gcloud container node-pools upgrade workers-v1 \
  --cluster production-cluster \
  --zone us-central1-a \
  --cluster-version 1.29.3-gke.1093000 \
  --max-surge-upgrade 1 \
  --max-unavailable-upgrade 0  # Zero-downtime

# Monitor upgrade
gcloud container operations list \
  --filter="operationType=UPGRADE_NODES" \
  --format="table(name,targetLink,status,startTime)"

# Resize node pool
gcloud container clusters resize production-cluster \
  --node-pool workers-v1 \
  --num-nodes 10 \
  --zone us-central1-a
```

### Azure AKS Node Pool

```bash
# Upgrade node pool
az aks nodepool upgrade \
  --resource-group production-rg \
  --cluster-name production-cluster \
  --name workers \
  --kubernetes-version 1.29.3 \
  --max-surge 1 \
  --no-wait

# Watch upgrade status
az aks nodepool show \
  --resource-group production-rg \
  --cluster-name production-cluster \
  --name workers \
  --query '{state:provisioningState,k8sVersion:orchestratorVersion}'
```

## Section 8: Maintenance Runbook Template

```bash
#!/usr/bin/env bash
# node-maintenance-runbook.sh
# Usage: ./node-maintenance-runbook.sh <node-name> <maintenance-reason>

NODE="$1"
REASON="${2:-scheduled-maintenance}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG="/var/log/maintenance/${NODE}-${TIMESTAMP}.log"

mkdir -p /var/log/maintenance

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*" | tee -a "$LOG"; }

# PRE-MAINTENANCE CHECKS
log "=== PRE-MAINTENANCE CHECKLIST ==="
log "Node: $NODE | Reason: $REASON"

# Record current state
log "Node status:"
kubectl get node "$NODE" -o wide | tee -a "$LOG"

log "Pods on node:"
kubectl get pods --field-selector "spec.nodeName=$NODE" -A \
  --no-headers | tee -a "$LOG"

log "PDB status:"
kubectl get pdb -A | tee -a "$LOG"

# Check for recent alerts (requires Prometheus/Alertmanager)
log "Active alerts (if any):"
curl -s 'http://alertmanager.monitoring.svc.cluster.local:9093/api/v2/alerts?active=true' \
  2>/dev/null | jq -r '.[].labels.alertname' 2>/dev/null | tee -a "$LOG" || true

# ANNOTATE NODE FOR AUDIT TRAIL
kubectl annotate node "$NODE" \
  "maintenance.corp.example.com/started-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "maintenance.corp.example.com/reason=$REASON" \
  "maintenance.corp.example.com/operator=$(whoami)" \
  --overwrite

log "=== CORDON AND DRAIN ==="
kubectl cordon "$NODE"
log "Node cordoned."

kubectl drain "$NODE" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --timeout=600s \
  2>&1 | tee -a "$LOG"

log "Node drained. Maintenance window is now open."
log "After maintenance, run: kubectl uncordon $NODE"

# POST-MAINTENANCE ACTIONS (run after maintenance is complete)
# kubectl uncordon "$NODE"
# kubectl annotate node "$NODE" \
#   "maintenance.corp.example.com/completed-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
#   --overwrite
```

This guide provides the operational procedures for safe, audited node maintenance in production Kubernetes clusters. The combination of PodDisruptionBudgets, disciplined drain procedures, automated kured reboots, and blue/green pool upgrades minimizes service disruption while maintaining cluster health.
