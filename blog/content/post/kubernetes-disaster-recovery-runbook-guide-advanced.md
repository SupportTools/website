---
title: "Kubernetes Disaster Recovery: Runbooks for Common Failure Scenarios"
date: 2028-03-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Disaster Recovery", "etcd", "Runbooks", "Operations", "SRE", "Incident Response"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Kubernetes disaster recovery runbooks covering etcd quorum loss, control plane failures, mass worker node eviction, PVC recovery from snapshots, certificate expiry emergency renewal, namespace stuck-terminating resolution, OOMKilled cascade recovery, and network partition handling."
more_link: "yes"
url: "/kubernetes-disaster-recovery-runbook-guide-advanced/"
---

Kubernetes disaster recovery incidents share a common characteristic: they happen at the worst possible time, often involve cascading failures across multiple components, and require operators who may not be the ones who built the cluster. This guide provides step-by-step runbooks for the most common Kubernetes failure scenarios, written for execution under pressure with explicit decision trees, diagnostic commands, and recovery procedures.

<!--more-->

## Pre-Incident Preparation

Before any incident, ensure these prerequisites are in place:

```bash
# Verify etcd backup schedule and test restore procedure
# Backup locations should be documented in the runbook header

# etcd snapshot backup script (run via CronJob)
#!/bin/bash
ETCD_ENDPOINTS="https://127.0.0.1:2379"
BACKUP_DIR="/var/backups/etcd"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "${BACKUP_DIR}"

ETCDCTL_API=3 etcdctl \
  --endpoints="${ETCD_ENDPOINTS}" \
  --cacert="/etc/kubernetes/pki/etcd/ca.crt" \
  --cert="/etc/kubernetes/pki/etcd/server.crt" \
  --key="/etc/kubernetes/pki/etcd/server.key" \
  snapshot save "${BACKUP_DIR}/snapshot-${DATE}.db"

# Verify snapshot integrity
ETCDCTL_API=3 etcdctl snapshot status "${BACKUP_DIR}/snapshot-${DATE}.db"

# Retain 7 days of backups
find "${BACKUP_DIR}" -name "snapshot-*.db" -mtime +7 -delete

echo "Backup complete: ${BACKUP_DIR}/snapshot-${DATE}.db"
```

## Runbook 1: etcd Quorum Loss Recovery

### Symptoms
- `kubectl` commands hang or return `etcdserver: request timed out`
- `etcd cluster is unavailable` in API server logs
- Fewer than `(n/2)+1` etcd members are healthy

### Diagnosis

```bash
# Check etcd member list from a surviving member
ETCDCTL_API=3 etcdctl \
  --endpoints="https://127.0.0.1:2379" \
  --cacert="/etc/kubernetes/pki/etcd/ca.crt" \
  --cert="/etc/kubernetes/pki/etcd/healthcheck-client.crt" \
  --key="/etc/kubernetes/pki/etcd/healthcheck-client.key" \
  member list -w table

# Check health of all members
ETCDCTL_API=3 etcdctl \
  --endpoints="https://etcd-0:2379,https://etcd-1:2379,https://etcd-2:2379" \
  --cacert="/etc/kubernetes/pki/etcd/ca.crt" \
  --cert="/etc/kubernetes/pki/etcd/healthcheck-client.crt" \
  --key="/etc/kubernetes/pki/etcd/healthcheck-client.key" \
  endpoint health -w table

# Check etcd pod logs
journalctl -u etcd --since "1 hour ago" | grep -E "(error|warn|failed|quorum)" | tail -50
```

### Recovery: Single Member Failure (2 of 3 healthy)

```bash
# 1. Identify the failed member ID
ETCDCTL_API=3 etcdctl member list

# 2. Remove the failed member
ETCDCTL_API=3 etcdctl member remove <MEMBER_ID>

# 3. On the replacement node, stop existing etcd if running
systemctl stop etcd

# 4. Clear the old data directory
rm -rf /var/lib/etcd/member

# 5. Add the new member
ETCDCTL_API=3 etcdctl member add etcd-new \
  --peer-urls="https://<NEW_NODE_IP>:2380"

# 6. Start etcd with the new-member configuration
# Update /etc/kubernetes/manifests/etcd.yaml with:
# - --initial-cluster-state=existing
# - --initial-cluster=<existing-members>,etcd-new=https://<NEW_NODE_IP>:2380
systemctl start etcd

# 7. Verify cluster health
ETCDCTL_API=3 etcdctl endpoint health --cluster
```

### Recovery: Majority Failure (Restore from Snapshot)

When quorum is lost and cannot be recovered by adding members, restore from snapshot:

```bash
#!/bin/bash
# restore-etcd.sh - Run on each etcd node
# CRITICAL: Run this on ALL etcd nodes before starting any of them

SNAPSHOT="/var/backups/etcd/snapshot-latest.db"
RESTORE_DIR="/var/lib/etcd-restore"
ETCD_NAME="${1}"  # e.g., etcd-0
INITIAL_CLUSTER="${2}"  # e.g., "etcd-0=https://10.0.0.1:2380,etcd-1=https://10.0.0.2:2380,etcd-2=https://10.0.0.3:2380"
INITIAL_ADVERTISE_PEER_URLS="${3}"  # e.g., "https://10.0.0.1:2380"

# Stop etcd on ALL nodes before restoring
systemctl stop etcd || true

# Restore the snapshot
ETCDCTL_API=3 etcdctl snapshot restore "${SNAPSHOT}" \
  --name="${ETCD_NAME}" \
  --initial-cluster="${INITIAL_CLUSTER}" \
  --initial-cluster-token="etcd-cluster-restored-$(date +%s)" \
  --initial-advertise-peer-urls="${INITIAL_ADVERTISE_PEER_URLS}" \
  --data-dir="${RESTORE_DIR}"

# Backup old data directory
mv /var/lib/etcd /var/lib/etcd-old-$(date +%s)

# Move restored data into place
mv "${RESTORE_DIR}" /var/lib/etcd

# Start etcd
systemctl start etcd

echo "etcd restore complete on ${ETCD_NAME}"
echo "IMPORTANT: Start etcd on ALL nodes before verifying cluster health"
```

## Runbook 2: Control Plane Node Failure

### Single Control Plane Node Failure (HA Cluster)

```bash
# 1. Verify API server is still reachable via other control plane nodes
kubectl get nodes --request-timeout=5s

# 2. Check which control plane is serving requests
for cp in $(kubectl get nodes -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[*].metadata.name}'); do
    echo -n "${cp}: "
    kubectl get --raw /healthz --server="https://${cp}:6443" --insecure-skip-tls-verify 2>/dev/null || echo "unreachable"
done

# 3. Cordon the failed node (prevent scheduling on recovery)
kubectl cordon <FAILED_NODE>

# 4. If the node is permanently lost, remove it from etcd membership
# First identify its etcd peer URL
ETCDCTL_API=3 etcdctl member list

# Remove from etcd
ETCDCTL_API=3 etcdctl member remove <MEMBER_ID>

# 5. Delete the failed node object
kubectl delete node <FAILED_NODE>

# 6. Provision replacement control plane node
# Follow your cluster provisioning runbook (kubeadm join or cloud-init)
# For kubeadm:
kubeadm token create --print-join-command
# Use the --control-plane flag and provide the certificate key

# 7. Verify new control plane is healthy
kubectl get nodes
ETCDCTL_API=3 etcdctl member list
```

### All Control Plane Nodes Unresponsive

```bash
# 1. SSH directly to control plane nodes
# 2. Check API server process
systemctl status kube-apiserver
# Or for static pods:
crictl ps | grep kube-apiserver

# 3. Check for disk full (common cause)
df -h /var/lib/etcd
# If full: find large files and clean up
find /var/lib/etcd -size +100M

# 4. Check API server and etcd logs
journalctl -u kubelet --since "30 min ago" | grep -E "(apiserver|etcd)" | tail -100
crictl logs $(crictl ps -q --name kube-apiserver 2>/dev/null) 2>&1 | tail -100

# 5. Try restarting static pods by touching manifest files
touch /etc/kubernetes/manifests/kube-apiserver.yaml
# Kubelet will restart the static pod

# 6. Verify connectivity between control plane nodes
for node in etcd-0 etcd-1 etcd-2; do
    nc -zv ${node} 2379 2>&1
    nc -zv ${node} 2380 2>&1
done
```

## Runbook 3: Worker Node Mass Eviction Recovery

### Symptoms
- Many pods in `Pending` state with `Insufficient cpu/memory` events
- Multiple nodes in `NotReady` or `SchedulingDisabled` state
- PodDisruptionBudget violations

### Diagnosis and Recovery

```bash
# 1. Assess scope
kubectl get nodes -o wide
kubectl get nodes --no-headers | grep -v Ready | wc -l

# 2. Check why nodes are unavailable
for node in $(kubectl get nodes --no-headers | grep -v Ready | awk '{print $1}'); do
    echo "=== ${node} ==="
    kubectl describe node "${node}" | grep -A 10 "Conditions:"
done

# 3. Check for resource pressure events
kubectl get events --all-namespaces --field-selector reason=EvictedPod \
  --sort-by='.lastTimestamp' | tail -30

# 4. Identify pods waiting to be rescheduled
kubectl get pods --all-namespaces --field-selector=status.phase=Pending \
  -o custom-columns=\
"NS:.metadata.namespace,NAME:.metadata.name,\
NODE:.spec.nodeName,REASON:.status.conditions[0].reason"

# 5. If nodes are recoverable: uncordon them
kubectl uncordon <NODE_NAME>

# 6. If nodes are permanently lost: delete them to release pod ownership
kubectl delete node <NODE_NAME>

# 7. Force-delete pods stuck in Terminating on lost nodes
kubectl get pods --all-namespaces --field-selector=status.phase=Failed \
  -o json | jq -r '.items[] | select(.spec.nodeName=="<LOST_NODE>") |
  "\(.metadata.namespace) \(.metadata.name)"' \
  | while read ns name; do
      kubectl delete pod "$name" -n "$ns" --force --grace-period=0
    done

# 8. Verify PodDisruptionBudgets are not blocking recovery
kubectl get pdb --all-namespaces
kubectl get pdb --all-namespaces -o json | jq '
  .items[] |
  select(.status.disruptionsAllowed == 0) |
  {ns: .metadata.namespace, name: .metadata.name,
   desired: .status.desiredHealthy, current: .status.currentHealthy}
'
```

## Runbook 4: PVC Data Recovery from Snapshots

```bash
# 1. Identify the PVC and its associated VolumeSnapshot
kubectl get pvc -n <namespace>
kubectl get volumesnapshot -n <namespace>

# 2. Check VolumeSnapshotContent (cluster-scoped)
kubectl get volumesnapshotcontent
kubectl describe volumesnapshot <SNAPSHOT_NAME> -n <namespace>

# 3. Create a new PVC from the snapshot
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: recovered-data-pvc
  namespace: <namespace>
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
  storageClassName: <storage-class-name>
  dataSource:
    name: <SNAPSHOT_NAME>
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
EOF

# 4. Wait for PVC to be bound
kubectl wait pvc/recovered-data-pvc -n <namespace> \
  --for=condition=Bound --timeout=5m

# 5. Mount the recovered PVC in a temporary pod for verification
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: data-recovery-pod
  namespace: <namespace>
spec:
  restartPolicy: Never
  containers:
    - name: recovery
      image: busybox:latest
      command: ["sleep", "3600"]
      volumeMounts:
        - name: recovered-data
          mountPath: /data
  volumes:
    - name: recovered-data
      persistentVolumeClaim:
        claimName: recovered-data-pvc
EOF

# 6. Inspect recovered data
kubectl exec -it data-recovery-pod -n <namespace> -- ls -la /data
kubectl exec -it data-recovery-pod -n <namespace> -- du -sh /data/*

# 7. Copy specific files if needed
kubectl cp data-recovery-pod:/data/important-file.sql \
  -n <namespace> ./important-file.sql

# 8. Patch the application deployment to use the recovered PVC
kubectl patch deployment <APP_NAME> -n <namespace> \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/template/spec/volumes/0/persistentVolumeClaim/claimName","value":"recovered-data-pvc"}]'

# 9. Cleanup the recovery pod
kubectl delete pod data-recovery-pod -n <namespace>
```

## Runbook 5: Certificate Expiry Emergency Renewal

### Detection

```bash
# Check all certificates expiring in the next 30 days
for cert in /etc/kubernetes/pki/*.crt; do
    expiry=$(openssl x509 -noout -enddate -in "${cert}" 2>/dev/null | cut -d= -f2)
    days=$(( ($(date -d "${expiry}" +%s) - $(date +%s)) / 86400 ))
    echo "${days} days: ${cert} (${expiry})"
done | sort -n

# Check kubeadm-managed certificates
kubeadm certs check-expiration

# Check cert-manager certificates
kubectl get certificates --all-namespaces -o json | jq -r '
  .items[] |
  select(.status.notAfter != null) |
  [
    (((.status.notAfter | fromdateiso8601) - now) / 86400 | floor),
    .metadata.namespace,
    .metadata.name,
    .status.notAfter
  ] |
  @tsv
' | sort -n | head -20
```

### Emergency Renewal with kubeadm

```bash
# Renew all kubeadm-managed certificates
kubeadm certs renew all

# Or renew specific certificates
kubeadm certs renew apiserver
kubeadm certs renew apiserver-kubelet-client
kubeadm certs renew front-proxy-client
kubeadm certs renew scheduler.conf
kubeadm certs renew controller-manager.conf
kubeadm certs renew admin.conf
kubeadm certs renew kubelet.conf

# Verify renewal
kubeadm certs check-expiration

# Restart control plane components to pick up new certificates
# For static pods (kubeadm clusters):
for manifest in /etc/kubernetes/manifests/*.yaml; do
    touch "${manifest}"
done

# Wait for components to restart
sleep 30

# Verify API server is accessible
kubectl get nodes
kubectl cluster-info

# If using kubeconfig from /etc/kubernetes/admin.conf:
cp /etc/kubernetes/admin.conf ~/.kube/config
```

### Force cert-manager Renewal

```bash
# Trigger immediate renewal for a specific certificate
kubectl annotate certificate <CERT_NAME> -n <NAMESPACE> \
  cert-manager.io/issueTime="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# Wait for renewal
kubectl wait certificate/<CERT_NAME> -n <NAMESPACE> \
  --for=condition=Ready --timeout=5m

# Check renewal events
kubectl describe certificate <CERT_NAME> -n <NAMESPACE> | grep -A 20 Events
```

## Runbook 6: Namespace Stuck in Terminating

```bash
# 1. Identify what is blocking deletion
NAMESPACE="stuck-namespace"

# Check for resources with finalizers
kubectl api-resources --verbs=list --namespaced -o name | \
  xargs -I{} kubectl get {} -n "${NAMESPACE}" --no-headers 2>/dev/null | \
  grep -v "^$" | head -20

# Find resources with pending finalizers
kubectl get all -n "${NAMESPACE}" -o json | \
  jq '.items[] | select(.metadata.finalizers != null and .metadata.finalizers != []) |
    {kind: .kind, name: .metadata.name, finalizers: .metadata.finalizers}'

# 2. Remove finalizers from stuck resources
# For each resource with a finalizer:
kubectl patch <RESOURCE_TYPE> <RESOURCE_NAME> -n "${NAMESPACE}" \
  --type=json \
  -p='[{"op":"remove","path":"/metadata/finalizers"}]'

# 3. If namespace itself has finalizers
kubectl get namespace "${NAMESPACE}" -o json | \
  jq '.spec.finalizers = []' | \
  kubectl replace --raw "/api/v1/namespaces/${NAMESPACE}/finalize" -f -

# 4. Force-delete lingering pods
kubectl get pods -n "${NAMESPACE}" -o name | \
  xargs kubectl delete -n "${NAMESPACE}" --force --grace-period=0

# 5. Verify namespace is gone
kubectl get namespace "${NAMESPACE}"

# Alternative: API server direct call for namespace finalize
NAMESPACE_JSON=$(kubectl get namespace "${NAMESPACE}" -o json)
echo "${NAMESPACE_JSON}" | jq '.spec.finalizers = []' > /tmp/namespace-patch.json
kubectl replace --raw "/api/v1/namespaces/${NAMESPACE}/finalize" \
  -f /tmp/namespace-patch.json
```

## Runbook 7: OOMKilled Cascade Failure Response

### Immediate Triage

```bash
# 1. Identify all OOMKilled containers across the cluster
kubectl get pods --all-namespaces -o json | jq -r '
  .items[] |
  . as $pod |
  .status.containerStatuses[]? |
  select(.lastState.terminated.reason == "OOMKilled") |
  [$pod.metadata.namespace, $pod.metadata.name, .name,
   (.lastState.terminated.finishedAt // "unknown")] |
  @tsv
' | sort -k4 | tail -20

# 2. Check node memory pressure
kubectl top nodes --sort-by=memory
kubectl get nodes -o json | jq '
  .items[] |
  {name: .metadata.name,
   conditions: .status.conditions | map(select(.type == "MemoryPressure")) | .[0]}
'

# 3. Find top memory consumers
kubectl top pods --all-namespaces --sort-by=memory | head -20

# 4. Check if any namespace is over its LimitRange
kubectl get limitrange --all-namespaces
kubectl get resourcequota --all-namespaces

# 5. Temporary mitigation: increase memory limits for affected deployments
kubectl set resources deployment <DEPLOYMENT_NAME> -n <NAMESPACE> \
  --limits=memory=1Gi \
  --requests=memory=512Mi

# 6. Add/update VPA recommendation (if VPA is installed)
kubectl get vpa -n <NAMESPACE>
kubectl describe vpa <VPA_NAME> -n <NAMESPACE> | grep -A 20 "Container Recommendations"
```

### Preventing Cascade

```bash
# Apply emergency PodDisruptionBudget to protect critical services
cat <<EOF | kubectl apply -f -
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: emergency-pdb
  namespace: production
spec:
  minAvailable: 1
  selector:
    matchLabels:
      tier: critical
EOF

# Identify and restart repeatedly-OOMKilled deployments with updated limits
kubectl get pods --all-namespaces -o json | jq -r '
  .items[] |
  select(.status.containerStatuses != null) |
  . as $pod |
  .status.containerStatuses[] |
  select(.restartCount > 5 and .lastState.terminated.reason == "OOMKilled") |
  [$pod.metadata.namespace, $pod.metadata.name] |
  @tsv
' | while read ns name; do
    deploy=$(kubectl get pod "${name}" -n "${ns}" -o jsonpath='{.metadata.ownerReferences[0].name}')
    echo "Deployment ${ns}/${deploy} has OOMKilled pods"
done
```

## Runbook 8: Network Partition Recovery

### Diagnosis

```bash
# 1. Identify node communication failures
for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
    echo -n "${node}: "
    kubectl get node "${node}" -o jsonpath='{.status.conditions[?(@.type=="NetworkUnavailable")].status}'
    echo ""
done

# 2. Test cross-node connectivity with a debug DaemonSet
cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: network-debug
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: network-debug
  template:
    metadata:
      labels:
        app: network-debug
    spec:
      hostNetwork: true
      tolerations:
        - operator: Exists
      containers:
        - name: debug
          image: nicolaka/netshoot:latest
          command: ["sleep", "3600"]
          securityContext:
            privileged: true
EOF

# 3. Test connectivity between nodes
NODE_A_POD=$(kubectl get pods -n kube-system -l app=network-debug -o jsonpath='{.items[0].metadata.name}')
NODE_B_IP=$(kubectl get node <NODE_B> -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')

kubectl exec -n kube-system "${NODE_A_POD}" -- ping -c 3 "${NODE_B_IP}"
kubectl exec -n kube-system "${NODE_A_POD}" -- nc -zv "${NODE_B_IP}" 6443

# 4. Check CNI plugin status
kubectl get pods -n kube-system -l k8s-app=calico-node
kubectl get pods -n kube-system -l k8s-app=cilium

# 5. Restart CNI pods on affected nodes
kubectl rollout restart daemonset calico-node -n kube-system
```

## Runbook 9: Argo Workflows for Runbook Automation

Automate common recovery steps as Argo Workflows:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: etcd-health-check
  namespace: platform-ops
spec:
  entrypoint: check-etcd-health
  serviceAccountName: runbook-executor

  templates:
    - name: check-etcd-health
      steps:
        - - name: get-etcd-endpoints
            template: get-endpoints
        - - name: check-health
            template: check-member-health
            arguments:
              parameters:
                - name: endpoints
                  value: "{{steps.get-etcd-endpoints.outputs.result}}"
        - - name: notify-slack
            template: slack-notification
            when: "{{steps.check-health.outputs.result}} != healthy"
            arguments:
              parameters:
                - name: message
                  value: "etcd health check FAILED: {{steps.check-health.outputs.result}}"

    - name: get-endpoints
      script:
        image: bitnami/kubectl:latest
        command: [bash]
        source: |
          kubectl get pods -n kube-system -l component=etcd \
            -o jsonpath='{.items[*].status.podIP}' | tr ' ' '\n' | \
            sed 's/^/https:\/\//' | sed 's/$/:2379/' | \
            paste -sd','

    - name: check-member-health
      inputs:
        parameters:
          - name: endpoints
      script:
        image: bitnami/etcd:latest
        command: [bash]
        source: |
          ETCDCTL_API=3 etcdctl \
            --endpoints="{{inputs.parameters.endpoints}}" \
            --cacert=/etc/kubernetes/pki/etcd/ca.crt \
            --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
            --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
            endpoint health -w table && echo "healthy" || echo "unhealthy"
        volumeMounts:
          - name: etcd-certs
            mountPath: /etc/kubernetes/pki/etcd
      volumes:
        - name: etcd-certs
          hostPath:
            path: /etc/kubernetes/pki/etcd

    - name: slack-notification
      inputs:
        parameters:
          - name: message
      resource:
        action: create
        manifest: |
          apiVersion: batch/v1
          kind: Job
          metadata:
            generateName: slack-notify-
            namespace: platform-ops
          spec:
            template:
              spec:
                restartPolicy: Never
                containers:
                  - name: notify
                    image: curlimages/curl:latest
                    command:
                      - curl
                      - -X
                      - POST
                      - -H
                      - "Content-type: application/json"
                      - -d
                      - '{"text":"{{inputs.parameters.message}}"}'
                      - $(SLACK_WEBHOOK_URL)
                    env:
                      - name: SLACK_WEBHOOK_URL
                        valueFrom:
                          secretKeyRef:
                            name: slack-webhook
                            key: url
```

## Post-Incident Checklist

After any recovery:

```bash
#!/bin/bash
# post-incident-check.sh

echo "=== Kubernetes Cluster Health Check ==="
echo "Time: $(date -u)"

echo ""
echo "--- Node Status ---"
kubectl get nodes -o wide

echo ""
echo "--- Control Plane Component Status ---"
kubectl get componentstatuses 2>/dev/null || \
  kubectl get pods -n kube-system -l tier=control-plane

echo ""
echo "--- Pending Pods ---"
kubectl get pods --all-namespaces --field-selector=status.phase=Pending \
  | head -20

echo ""
echo "--- Failed Pods ---"
kubectl get pods --all-namespaces --field-selector=status.phase=Failed \
  | head -20

echo ""
echo "--- Recent Warning Events ---"
kubectl get events --all-namespaces \
  --field-selector=type=Warning \
  --sort-by='.lastTimestamp' \
  | tail -20

echo ""
echo "--- etcd Health ---"
ETCDCTL_API=3 etcdctl \
  --endpoints="https://127.0.0.1:2379" \
  --cacert="/etc/kubernetes/pki/etcd/ca.crt" \
  --cert="/etc/kubernetes/pki/etcd/healthcheck-client.crt" \
  --key="/etc/kubernetes/pki/etcd/healthcheck-client.key" \
  endpoint health 2>/dev/null

echo ""
echo "--- Certificate Expiry (< 30 days) ---"
kubeadm certs check-expiration 2>/dev/null | grep -E "(CERTIFICATE|EXPIRES|WARNING)" | head -20

echo ""
echo "=== Health check complete ==="
```

## Summary

These runbooks address the scenarios most likely to require emergency recovery in production Kubernetes clusters. The common thread across all of them: diagnose before acting, preserve evidence (logs, events, describe output) before making changes, and verify each step before proceeding to the next.

etcd is the single most critical component. Regular snapshot backups with verified restore procedures are non-negotiable. Every other failure scenario — certificate expiry, node loss, namespace termination — is recoverable without data loss if etcd is healthy.

Automation via Argo Workflows transforms runbooks from manual processes into executable, audited procedures. The workflow artifacts provide a complete record of every recovery action, which accelerates post-incident analysis.

## Runbook 10: Velero Backup and Restore for Namespace Recovery

When namespace-level data loss occurs and snapshots are not available, Velero provides application-consistent backup and restore:

```bash
# Install Velero CLI
curl -L https://github.com/vmware-tanzu/velero/releases/download/v1.13.0/velero-v1.13.0-linux-amd64.tar.gz \
  | tar -xz
mv velero-v1.13.0-linux-amd64/velero /usr/local/bin/

# Check backup status
velero backup get

# Describe a specific backup
velero backup describe <BACKUP_NAME> --details

# Create an on-demand backup before risky operations
velero backup create pre-migration-backup \
  --include-namespaces production \
  --storage-location default \
  --wait

# Restore a namespace from backup
velero restore create \
  --from-backup pre-migration-backup \
  --include-namespaces production \
  --namespace-mappings production:production-restored \
  --wait

# Check restore status
velero restore get
velero restore describe <RESTORE_NAME>

# Restore specific resources only
velero restore create \
  --from-backup pre-migration-backup \
  --include-resources deployments,services,configmaps,secrets \
  --include-namespaces production \
  --restore-volumes=false \
  --wait
```

### Velero Schedule for Automated Backups

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-production-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 02:00 UTC daily
  template:
    includedNamespaces:
      - production
      - staging
    excludedResources:
      - events
      - events.events.k8s.io
    storageLocation: default
    volumeSnapshotLocations:
      - default
    ttl: 720h   # 30 days retention
    snapshotVolumes: true
    labelSelector:
      matchExpressions:
        - key: backup
          operator: NotIn
          values: ["excluded"]
```

## Runbook 11: Recovering from a Failed Helm Upgrade

A failed Helm upgrade can leave a release in a broken state that blocks future deployments:

```bash
# Check release status
helm list --all-namespaces
helm status <RELEASE_NAME> -n <NAMESPACE>

# View release history
helm history <RELEASE_NAME> -n <NAMESPACE>

# If release is in failed state, rollback to previous version
helm rollback <RELEASE_NAME> <PREVIOUS_REVISION> -n <NAMESPACE>

# Verify rollback succeeded
helm status <RELEASE_NAME> -n <NAMESPACE>

# If rollback fails (e.g., partially applied resources):
# 1. Force delete the release secret to clear Helm state
kubectl get secrets -n <NAMESPACE> -l owner=helm,name=<RELEASE_NAME> \
  --sort-by='.metadata.labels.version'

# 2. Delete the failed revision secret
kubectl delete secret sh.helm.release.v1.<RELEASE_NAME>.v<FAILED_REVISION> \
  -n <NAMESPACE>

# 3. Re-attempt rollback
helm rollback <RELEASE_NAME> <PREVIOUS_REVISION> -n <NAMESPACE>

# If all else fails: uninstall and reinstall
helm uninstall <RELEASE_NAME> -n <NAMESPACE>
helm install <RELEASE_NAME> <CHART> -f values.yaml -n <NAMESPACE>
```

## DR Testing Schedule

Untested runbooks are hypothetical. Schedule regular DR drills:

| Test | Frequency | Scope |
|---|---|---|
| etcd backup restore (staging) | Monthly | Restore from snapshot to staging cluster |
| Certificate emergency renewal | Quarterly | Expire and renew a non-critical cert manually |
| Node failure simulation | Monthly | Cordon and drain a worker node |
| Namespace restore from Velero | Quarterly | Restore a staging namespace from backup |
| Control plane failure (staging) | Bi-annually | Shut down one control plane node in HA cluster |
| Full cluster restore | Annually | Restore entire staging cluster from etcd snapshot |

```bash
# DR drill: verify etcd backup is restorable (run in staging)
#!/bin/bash
set -euo pipefail

BACKUP="${1:-/var/backups/etcd/snapshot-latest.db}"
TEMP_RESTORE="/tmp/etcd-dr-test-$(date +%s)"

echo "=== etcd Backup Restore Verification ==="
echo "Backup: ${BACKUP}"
echo "Temp dir: ${TEMP_RESTORE}"

# Verify backup integrity
echo "Verifying snapshot integrity..."
ETCDCTL_API=3 etcdctl snapshot status "${BACKUP}" --write-out=table

# Test restore (non-destructive: restore to temp dir)
echo "Testing restore..."
ETCDCTL_API=3 etcdctl snapshot restore "${BACKUP}" \
  --name=test-restore \
  --initial-cluster="test-restore=https://127.0.0.1:2380" \
  --initial-cluster-token="dr-test-$(date +%s)" \
  --initial-advertise-peer-urls="https://127.0.0.1:2380" \
  --data-dir="${TEMP_RESTORE}"

# Verify restored data is readable
RESTORE_SIZE=$(du -sh "${TEMP_RESTORE}" | cut -f1)
echo "Restore successful. Size: ${RESTORE_SIZE}"

# Cleanup
rm -rf "${TEMP_RESTORE}"

echo "=== DR test PASSED: backup is restorable ==="
```
