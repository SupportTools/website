---
title: "Kubernetes Disaster Recovery Runbooks: Tested Procedures for Common Failure Scenarios"
date: 2030-10-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Disaster Recovery", "etcd", "Runbooks", "Incident Response", "SRE"]
categories:
- Kubernetes
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Kubernetes DR runbook guide covering etcd quorum loss recovery, control plane node replacement, certificate expiry recovery, accidental namespace deletion recovery, PVC data recovery, and building and testing DR procedures with chaos engineering."
more_link: "yes"
url: "/kubernetes-disaster-recovery-runbooks-tested-failure-scenarios/"
---

The difference between a cluster outage that lasts ten minutes and one that lasts four hours is whether the runbook was written and tested before the incident. Kubernetes failure modes—etcd quorum loss, control plane node failure, expired certificates, accidental deletions—each require a specific recovery sequence that cannot be improvised under pressure.

<!--more-->

This guide provides tested, production-validated runbooks for the most common Kubernetes failure scenarios. Every procedure includes verification steps and rollback options.

## Section 1: Runbook Framework and Prerequisites

### Runbook Structure

Each runbook in this guide follows a consistent structure:

1. **Symptom identification** — observable signals that trigger this runbook
2. **Impact assessment** — what is broken, what is still working
3. **Prerequisites** — tools and access required before starting
4. **Recovery procedure** — numbered steps with verification at each stage
5. **Post-recovery validation** — confirming the cluster is healthy
6. **Timeline and escalation** — when to escalate if the runbook is not progressing

### Required Tools and Access

Before any incident occurs, verify these are in place:

```bash
# Verify kubectl access and context
kubectl config get-contexts
kubectl cluster-info

# Verify etcdctl is available on control plane nodes
ssh control-plane-01 "etcdctl version"

# Verify backup locations are accessible
aws s3 ls s3://your-cluster-etcd-backups/ | tail -5

# Verify Velero is installed for workload backup/restore
velero version

# Verify you have SSH access to all control plane nodes
for node in control-plane-01 control-plane-02 control-plane-03; do
    ssh -o ConnectTimeout=5 "$node" hostname && echo "OK: $node" || echo "FAIL: $node"
done
```

## Section 2: Runbook — etcd Quorum Loss Recovery

### Symptom Identification

```
- kubectl commands return: "etcdserver: request timed out" or "context deadline exceeded"
- API server logs show: "etcd cluster is unavailable"
- etcd pods are in CrashLoopBackOff or not running
- Three-node etcd cluster has lost two or more members
```

### Impact Assessment

With quorum loss (fewer than (N/2)+1 members healthy), the Kubernetes API server cannot write state. Existing workloads continue running but no new scheduling decisions can be made.

### Recovery Procedure: Restore from Backup

**Step 1: Identify the most recent valid etcd snapshot**

```bash
# List available backups sorted by date
aws s3 ls s3://your-cluster-etcd-backups/ --recursive | sort -k1,2 | tail -10

# Download the latest snapshot
aws s3 cp s3://your-cluster-etcd-backups/etcd-snapshot-2030-10-25T14:00:00Z.db \
  /tmp/etcd-snapshot.db

# Verify snapshot integrity
ETCDCTL_API=3 etcdctl snapshot status /tmp/etcd-snapshot.db \
  --write-out=table
```

Expected output:
```
+----------+----------+------------+------------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
+----------+----------+------------+------------+
| 9a583b96 |   892341 |       1423 |     8.4 MB |
+----------+----------+------------+------------+
```

**Step 2: Stop all etcd instances**

```bash
# On each control plane node
for node in control-plane-01 control-plane-02 control-plane-03; do
    ssh "$node" "systemctl stop etcd || true"
    ssh "$node" "mv /etc/kubernetes/manifests/etcd.yaml /tmp/etcd.yaml.bak 2>/dev/null || true"
done
```

For kubeadm clusters, the etcd pod is managed by the static pod manifest. Move it out of the manifests directory to stop it:

```bash
# On each control plane node
ssh control-plane-01 "mv /etc/kubernetes/manifests/etcd.yaml /tmp/"
# Wait for kubelet to stop the etcd container
ssh control-plane-01 "crictl ps | grep etcd"  # Should show no etcd container
```

**Step 3: Copy snapshot to all control plane nodes**

```bash
for node in control-plane-01 control-plane-02 control-plane-03; do
    scp /tmp/etcd-snapshot.db "${node}:/tmp/etcd-snapshot.db"
done
```

**Step 4: Restore the snapshot on each control plane node**

Run on each node, substituting the correct node-specific values:

```bash
# On control-plane-01
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-snapshot.db \
  --name=control-plane-01 \
  --initial-cluster="control-plane-01=https://192.168.1.11:2380,control-plane-02=https://192.168.1.12:2380,control-plane-03=https://192.168.1.13:2380" \
  --initial-cluster-token=etcd-cluster-prod \
  --initial-advertise-peer-urls=https://192.168.1.11:2380 \
  --data-dir=/var/lib/etcd-restored

# Move restored data to etcd data directory
mv /var/lib/etcd /var/lib/etcd-backup-$(date +%Y%m%d)
mv /var/lib/etcd-restored /var/lib/etcd
chown -R etcd:etcd /var/lib/etcd
```

```bash
# On control-plane-02
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-snapshot.db \
  --name=control-plane-02 \
  --initial-cluster="control-plane-01=https://192.168.1.11:2380,control-plane-02=https://192.168.1.12:2380,control-plane-03=https://192.168.1.13:2380" \
  --initial-cluster-token=etcd-cluster-prod \
  --initial-advertise-peer-urls=https://192.168.1.12:2380 \
  --data-dir=/var/lib/etcd-restored

mv /var/lib/etcd /var/lib/etcd-backup-$(date +%Y%m%d)
mv /var/lib/etcd-restored /var/lib/etcd
chown -R etcd:etcd /var/lib/etcd
```

**Step 5: Restore the static pod manifests and verify**

```bash
for node in control-plane-01 control-plane-02 control-plane-03; do
    ssh "$node" "mv /tmp/etcd.yaml.bak /etc/kubernetes/manifests/etcd.yaml"
done

# Wait for etcd pods to start (60-120 seconds)
sleep 90

# Verify etcd cluster health
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints=https://192.168.1.11:2379,https://192.168.1.12:2379,https://192.168.1.13:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

Expected output:
```
https://192.168.1.11:2379 is healthy: successfully committed proposal: took = 2.34ms
https://192.168.1.12:2379 is healthy: successfully committed proposal: took = 3.12ms
https://192.168.1.13:2379 is healthy: successfully committed proposal: took = 2.89ms
```

**Step 6: Restart API servers and verify cluster**

```bash
for node in control-plane-01 control-plane-02 control-plane-03; do
    ssh "$node" "mv /tmp/kube-apiserver.yaml.bak /etc/kubernetes/manifests/ 2>/dev/null || true"
done

kubectl cluster-info
kubectl get nodes
kubectl get pods --all-namespaces | grep -v Running | grep -v Completed
```

### Recovery Procedure: Single Member Replacement

When only one etcd member is lost:

```bash
# 1. Check current cluster membership
ETCDCTL_API=3 etcdctl member list \
  --endpoints=https://192.168.1.11:2379,https://192.168.1.12:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# 2. Remove the failed member (note the member ID from step 1)
ETCDCTL_API=3 etcdctl member remove <member-id> \
  --endpoints=https://192.168.1.11:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# 3. Add the replacement member
ETCDCTL_API=3 etcdctl member add control-plane-03-new \
  --peer-urls=https://192.168.1.13:2380 \
  --endpoints=https://192.168.1.11:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# 4. On the replacement node, start etcd with INITIAL_CLUSTER_STATE=existing
# (update the etcd static pod manifest or systemd unit with the new member list)
```

## Section 3: Runbook — Control Plane Node Replacement

### Symptom Identification

```
- kubectl get nodes shows one control plane node as NotReady
- Node is unreachable via SSH
- API server may be degraded if using single control plane
```

### Recovery Procedure

**Step 1: Cordon and drain the failed node (if still accessible)**

```bash
kubectl cordon control-plane-03
kubectl drain control-plane-03 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --force \
  --timeout=60s
```

**Step 2: Remove the node from the cluster**

```bash
kubectl delete node control-plane-03

# Remove etcd member if using stacked etcd
ETCDCTL_API=3 etcdctl member remove <member-id> \
  --endpoints=https://192.168.1.11:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

**Step 3: Provision replacement node and rejoin**

```bash
# On the existing control plane, generate a new bootstrap token
kubeadm token create --print-join-command

# Get the certificate key for control plane join
kubeadm init phase upload-certs --upload-certs
# Note the certificateKey output

# On the new control plane node
kubeadm join 192.168.1.10:6443 \
  --token <bootstrap-token> \
  --discovery-token-ca-cert-hash sha256:<ca-cert-hash> \
  --control-plane \
  --certificate-key <certificate-key>
```

**Step 4: Verify the new control plane node**

```bash
kubectl get nodes -o wide
kubectl get pods -n kube-system | grep control-plane-03

# Verify etcd cluster membership
ETCDCTL_API=3 etcdctl member list \
  --endpoints=https://192.168.1.11:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

## Section 4: Runbook — Certificate Expiry Recovery

### Symptom Identification

```
- kubectl returns: "x509: certificate has expired or is not yet valid"
- API server logs: "TLS handshake error from ...: tls: failed to verify certificate"
- Nodes show NotReady status
- kubelet logs: "Failed to connect to apiserver: certificate signed by unknown authority"
```

### Check Certificate Expiry Status

```bash
# Check all kubeadm-managed certificates
kubeadm certs check-expiration

# Manual check for specific certificates
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -text | grep -A2 "Validity"
openssl x509 -in /etc/kubernetes/pki/etcd/server.crt -noout -text | grep -A2 "Validity"

# Check kubelet certificates on worker nodes
ssh worker-01 "openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates"
```

### Recovery Procedure: Renew All Certificates (kubeadm)

```bash
# Renew all control plane certificates
kubeadm certs renew all

# Restart control plane components to load new certificates
for component in kube-apiserver kube-controller-manager kube-scheduler; do
    # Moving the manifest out and back in restarts the static pod
    mv /etc/kubernetes/manifests/${component}.yaml /tmp/
    sleep 5
    mv /tmp/${component}.yaml /etc/kubernetes/manifests/
done

# Restart etcd
mv /etc/kubernetes/manifests/etcd.yaml /tmp/
sleep 5
mv /tmp/etcd.yaml /etc/kubernetes/manifests/

# Update kubeconfig with new credentials
cp /etc/kubernetes/admin.conf ~/.kube/config
```

**Verify certificate renewal:**

```bash
kubeadm certs check-expiration
kubectl cluster-info
kubectl get nodes
```

### Recovery Procedure: Worker Node Certificate Renewal

```bash
# On each worker node, rotate the kubelet client certificate
# If certificate-based bootstrapping is configured, this happens automatically
# If not, generate a new certificate signing request

ssh worker-01 << 'EOF'
# Delete the current client certificate to force re-bootstrapping
rm -f /var/lib/kubelet/pki/kubelet-client-current.pem

# Restart kubelet — it will generate a new CSR
systemctl restart kubelet
EOF

# On the control plane, approve the pending CSR
kubectl get csr
kubectl certificate approve <csr-name>
```

### Automated Certificate Monitoring

```bash
#!/usr/bin/env bash
# /usr/local/bin/cert-expiry-check.sh
# Run as a CronJob or monitoring check

WARN_DAYS=30
CRITICAL_DAYS=7
EXIT_CODE=0

check_cert() {
    local cert_path="$1"
    local cert_name="$2"

    if [[ ! -f "$cert_path" ]]; then
        echo "UNKNOWN: Certificate file not found: $cert_path"
        return 3
    fi

    local expiry_date
    expiry_date=$(openssl x509 -in "$cert_path" -noout -enddate 2>/dev/null | cut -d= -f2)
    local expiry_epoch
    expiry_epoch=$(date -d "$expiry_date" +%s)
    local now_epoch
    now_epoch=$(date +%s)
    local days_remaining
    days_remaining=$(( (expiry_epoch - now_epoch) / 86400 ))

    if [[ $days_remaining -le $CRITICAL_DAYS ]]; then
        echo "CRITICAL: $cert_name expires in $days_remaining days ($expiry_date)"
        EXIT_CODE=2
    elif [[ $days_remaining -le $WARN_DAYS ]]; then
        echo "WARNING: $cert_name expires in $days_remaining days ($expiry_date)"
        EXIT_CODE=$((EXIT_CODE < 1 ? 1 : EXIT_CODE))
    else
        echo "OK: $cert_name expires in $days_remaining days"
    fi
}

check_cert /etc/kubernetes/pki/apiserver.crt "API Server"
check_cert /etc/kubernetes/pki/etcd/server.crt "etcd Server"
check_cert /etc/kubernetes/pki/front-proxy-client.crt "Front Proxy Client"
check_cert /var/lib/kubelet/pki/kubelet-client-current.pem "Kubelet Client"

exit $EXIT_CODE
```

## Section 5: Runbook — Accidental Namespace Deletion Recovery

### Symptom Identification

```
- kubectl get namespace <name> returns "namespaces not found"
- Workloads that were running are gone
- PVCs associated with deleted namespace may still exist
```

### Prevention: Namespace Deletion Protection

Before an incident occurs, add finalizers to protect critical namespaces:

```bash
# Add a custom finalizer to prevent deletion
kubectl patch namespace production -p \
  '{"metadata":{"finalizers":["support.tools/deletion-protection"]}}'

# To eventually remove the namespace, first remove the finalizer
kubectl patch namespace production -p \
  '{"metadata":{"finalizers":[]}}'
```

### Recovery Procedure: Restore from Velero Backup

```bash
# List available backups
velero backup get

# Describe a specific backup to verify its scope
velero backup describe production-namespace-backup-2030-10-25 --details

# Restore the namespace from backup
velero restore create --from-backup production-namespace-backup-2030-10-25 \
  --include-namespaces production \
  --restore-volumes true

# Monitor restore progress
velero restore describe production-namespace-backup-2030-10-25 --details

# Check restore status
kubectl get restore -n velero
```

### Recovery Procedure: Restore from GitOps State

If all workloads are managed via GitOps (ArgoCD, Flux), recreating the namespace and re-syncing is often faster than a Velero restore:

```bash
# Recreate the namespace
kubectl create namespace production

# For ArgoCD: trigger a hard refresh of all apps in that namespace
argocd app list | grep production | awk '{print $1}' | \
  xargs -I{} argocd app sync {} --force

# For Flux: resume the Flux reconciliation
flux reconcile source git flux-system
flux reconcile kustomization --all
```

### Recovering PVCs After Namespace Deletion

PVCs and their underlying PVs may survive namespace deletion if the reclaim policy is `Retain`:

```bash
# Find orphaned PVs
kubectl get pv | grep Released

# Re-claim a Released PV by removing its claimRef
kubectl patch pv pvc-abc123 -p \
  '{"spec":{"claimRef":null}}'

# Create a PVC that explicitly binds to this PV
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: database-data
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  volumeName: pvc-abc123
  storageClassName: gp3-encrypted
EOF
```

## Section 6: Runbook — PVC Data Recovery

### Scenario: Database Pod Crashed and PVC Has Corrupt Data

**Step 1: Stop the workload without deleting the PVC**

```bash
kubectl scale deployment postgres -n production --replicas=0
# Or for StatefulSets
kubectl scale statefulset postgres -n production --replicas=0
```

**Step 2: Mount the PVC in a recovery pod**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: data-recovery
  namespace: production
spec:
  restartPolicy: Never
  containers:
    - name: recovery
      image: ubuntu:24.04
      command: ["/bin/bash", "-c", "sleep infinity"]
      volumeMounts:
        - name: data
          mountPath: /data
      resources:
        requests:
          cpu: 100m
          memory: 256Mi
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: postgres-data
```

```bash
kubectl apply -f data-recovery-pod.yaml
kubectl exec -it data-recovery -n production -- /bin/bash

# Inside the pod, inspect the data
ls -la /data/
# Run database-specific recovery tools
# For PostgreSQL:
# pg_dumpall -h /data/var/run/postgresql > /tmp/dump.sql
```

**Step 3: Create a volume snapshot for a consistent recovery point**

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-data-recovery-snapshot
  namespace: production
spec:
  volumeSnapshotClassName: csi-aws-vsc
  source:
    persistentVolumeClaimName: postgres-data
```

```bash
kubectl apply -f snapshot.yaml
kubectl get volumesnapshot -n production

# Restore from snapshot to a new PVC
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-restored
  namespace: production
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
  dataSource:
    name: postgres-data-recovery-snapshot
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  storageClassName: gp3-encrypted
EOF
```

## Section 7: Runbook — Node Disk Pressure and Pod Eviction Storm

### Symptom Identification

```
- Nodes show condition DiskPressure=True
- Pods are being evicted with reason: "The node was low on resource: ephemeral-storage"
- kubectl describe node shows disk usage near 100%
```

### Immediate Triage

```bash
# Identify nodes under pressure
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,\
STATUS:.status.conditions[-1].type,\
DISK:.status.conditions[?(@.type=="DiskPressure")].status

# Check what's consuming disk on the node
kubectl debug node/worker-01 -it --image=ubuntu -- bash
# Inside the debug pod
df -h /host
du -sh /host/var/lib/containerd/
du -sh /host/var/log/pods/

# Find large container images
crictl images | sort -k4 -h
```

### Recovery Steps

```bash
# Remove unused container images
crictl rmi --prune

# Remove evicted pod directories
kubectl get pods --all-namespaces --field-selector=status.phase=Failed \
  -o json | kubectl delete -f -

# Truncate large log files (if log rotation is misconfigured)
find /var/log/pods -name "*.log" -size +500M -exec truncate --size=100M {} \;

# Check for large temporary files
find /tmp -size +100M -mtime +1

# If disk is critically full, cordon the node
kubectl cordon worker-01
# Drain and replace if disk cannot be freed
kubectl drain worker-01 --ignore-daemonsets --delete-emptydir-data
```

### Long-Term Fix

```yaml
# Configure eviction thresholds in kubelet (add to kubelet config)
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"
evictionSoftGracePeriod:
  memory.available: "1m30s"
  nodefs.available: "1m30s"
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
```

## Section 8: Testing DR Procedures with Chaos Engineering

### LitmusChaos for Controlled Failure Injection

```yaml
# ChaosEngine: inject etcd pod failure
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: etcd-pod-kill-test
  namespace: litmus
spec:
  appinfo:
    appns: kube-system
    applabel: "component=etcd"
    appkind: pod
  engineState: active
  annotationCheck: false
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
            - name: PODS_AFFECTED_PERC
              value: "33"  # Kill 1 of 3 etcd pods
```

### GameDay Checklist

Run GameDay exercises quarterly to keep runbooks current:

```markdown
## Kubernetes DR GameDay Checklist

### Pre-GameDay
- [ ] Notify stakeholders of maintenance window
- [ ] Verify all runbooks are up to date
- [ ] Verify backup jobs ran successfully within last 24 hours
- [ ] Verify recovery environment is ready (separate cluster or namespace)
- [ ] Assign roles: incident commander, executor, observer/documenter

### Scenarios to Test
- [ ] Single etcd member failure (stop one etcd pod)
- [ ] Control plane node failure (terminate one node instance)
- [ ] Certificate renewal procedure (test in lower environment)
- [ ] Namespace deletion and restore (test in dedicated test namespace)
- [ ] Worker node failure with stateful workload (kill node, verify PVC reattachment)
- [ ] Large-scale pod eviction (fill node disk to trigger eviction)

### Post-GameDay
- [ ] Document actual recovery times vs expected
- [ ] Update runbooks with any discovered gaps
- [ ] File tickets for missing automation
- [ ] Schedule follow-up for unresolved gaps
```

### Automated Backup Verification

```bash
#!/usr/bin/env bash
# /usr/local/bin/verify-etcd-backup.sh
# Run daily via CronJob

set -euo pipefail

BACKUP_BUCKET="s3://your-cluster-etcd-backups"
MAX_AGE_HOURS=25  # Alert if backup is older than 25 hours

# Find latest backup
LATEST=$(aws s3 ls "${BACKUP_BUCKET}/" | sort | tail -1 | awk '{print $4}')
if [[ -z "$LATEST" ]]; then
    echo "CRITICAL: No backups found in ${BACKUP_BUCKET}"
    exit 2
fi

# Check backup age
LATEST_DATE=$(aws s3 ls "${BACKUP_BUCKET}/${LATEST}" | awk '{print $1 " " $2}')
LATEST_EPOCH=$(date -d "$LATEST_DATE" +%s)
NOW_EPOCH=$(date +%s)
AGE_HOURS=$(( (NOW_EPOCH - LATEST_EPOCH) / 3600 ))

if [[ $AGE_HOURS -gt $MAX_AGE_HOURS ]]; then
    echo "CRITICAL: Latest backup is ${AGE_HOURS}h old (${LATEST})"
    exit 2
fi

# Download and validate the backup
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

aws s3 cp "${BACKUP_BUCKET}/${LATEST}" "${TEMP_DIR}/snapshot.db"

# Validate snapshot integrity
ETCDCTL_API=3 etcdctl snapshot status "${TEMP_DIR}/snapshot.db" --write-out=json | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('hash') and data.get('revision') > 0:
    print(f'OK: Backup valid - revision={data[\"revision\"]}, keys={data[\"totalKey\"]}')
    sys.exit(0)
else:
    print('CRITICAL: Backup validation failed')
    sys.exit(2)
"
```

### CronJob to Schedule Backup Verification

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: etcd-backup-verify
  namespace: kube-system
spec:
  schedule: "0 6 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: etcd-backup-verify
          restartPolicy: Never
          containers:
            - name: verify
              image: amazon/aws-cli:latest
              command: ["/bin/bash", "/scripts/verify-etcd-backup.sh"]
              env:
                - name: AWS_REGION
                  value: us-east-1
              volumeMounts:
                - name: scripts
                  mountPath: /scripts
          volumes:
            - name: scripts
              configMap:
                name: etcd-backup-scripts
                defaultMode: 0755
```

## Section 9: Post-Incident Verification Checklist

After any recovery procedure, verify cluster health systematically:

```bash
#!/usr/bin/env bash
# /usr/local/bin/cluster-health-check.sh

echo "=== Cluster Health Check ==="
echo ""

echo "--- Node Status ---"
kubectl get nodes -o wide
echo ""

echo "--- Control Plane Component Health ---"
kubectl get componentstatuses 2>/dev/null || \
  kubectl get pods -n kube-system -l tier=control-plane -o wide
echo ""

echo "--- etcd Cluster Health ---"
ETCDCTL_API=3 etcdctl endpoint health \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key 2>/dev/null || echo "etcd check skipped (not on control plane)"
echo ""

echo "--- Certificate Expiry ---"
kubeadm certs check-expiration 2>/dev/null || echo "kubeadm not available"
echo ""

echo "--- System Pod Health ---"
kubectl get pods -n kube-system --no-headers | \
  awk '$4 != "Running" && $4 != "Completed" {print "ISSUE: " $0}'
echo ""

echo "--- Recent Events (Warnings) ---"
kubectl get events --all-namespaces \
  --field-selector=type=Warning \
  --sort-by='.lastTimestamp' | tail -20
echo ""

echo "=== Health Check Complete ==="
```

DR runbooks are living documents. Every incident that deviates from the written procedure should result in an immediate update to the runbook. The cost of maintaining them is trivially small compared to the cost of an extended outage caused by improvising procedures under pressure.
