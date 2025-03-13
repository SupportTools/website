---
title: "Migrating from RKE1 to RKE2 Using pv-migrate: A Targeted Storage Migration Tool"
date: 2025-03-13T01:49:00-05:00
draft: false
tags: ["Kubernetes", "RKE1", "RKE2", "Migration", "pv-migrate", "Storage", "PVC"]
categories:
- Kubernetes
- Migration
- Storage
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to migrating persistent volumes from RKE1 to RKE2 using pv-migrate, a specialized tool for Kubernetes storage migration."
more_link: "yes"
url: "/migrating-rke1-to-rke2-pv-migrate/"
---

With RKE1 reaching end-of-life on July 31, 2025, organizations need efficient solutions for migrating their persistent data to RKE2 clusters. For teams focused specifically on storage migration, pv-migrate offers a specialized, lightweight approach for transferring Persistent Volume Claims (PVCs) across clusters.

<!--more-->

## Why Use pv-migrate for RKE1 to RKE2 Storage Migration?

Unlike full backup/restore solutions, pv-migrate focuses exclusively on moving persistent volume data:

- **Storage-Focused Migration:** Designed specifically for moving PVC data between clusters.
- **Multiple Migration Strategies:** Supports various strategies including mount-both (mnt2), service (svc), load balancer service (lbsvc), and local transfer.
- **Cluster-to-Cluster Migration:** Works seamlessly across different Kubernetes distributions.
- **No Intermediary Storage Required:** Direct PVC-to-PVC transfer without object storage.
- **Simple CLI Interface:** Easy to use with minimal setup and configuration.
- **Secure Data Transfer:** Uses SSH tunneling for secure migration across networks.

## Prerequisites for Migration

Before beginning the migration process, ensure you have:

1. **pv-migrate CLI Tool:** Installed on a system with access to both clusters.
2. **kubectl Access:** Configured for both source and target clusters.
3. **Network Connectivity:** Between source and target clusters.
4. **Compatible Storage Classes:** In both RKE1 and RKE2 clusters, preferably using the same CSI driver.
5. **Node Access:** SSH access to at least one node in each cluster if using Rsync strategy.

## Step-by-Step Migration Process

### 1. Install pv-migrate CLI

First, download and install the pv-migrate tool on your local system:

```bash
# Download the latest release
curl -L -o pv-migrate.tar.gz https://github.com/utkuozdemir/pv-migrate/releases/latest/download/pv-migrate_linux_x86_64.tar.gz

# Extract the binary
tar -xzf pv-migrate.tar.gz

# Move to a directory in your PATH
sudo mv pv-migrate /usr/local/bin/
sudo chmod +x /usr/local/bin/pv-migrate

# Verify installation
pv-migrate version
```

### 2. Configure Kubernetes Contexts for Both Clusters

pv-migrate uses your kubeconfig to access both clusters:

```bash
# Verify you have access to both clusters
kubectl config get-contexts

# Note the context names for both RKE1 and RKE2 clusters
# Example context names:
# - rke1-cluster
# - rke2-cluster
```

Ensure both contexts are properly configured with the appropriate permissions.

### 3. Prepare for Migration

Before migrating, identify the PVCs you need to move and ensure target namespaces exist:

```bash
# List PVCs in RKE1 source namespace
kubectl --context=rke1-cluster get pvc -n source-namespace

# Create the target namespace in RKE2 if it doesn't exist
kubectl --context=rke2-cluster create namespace target-namespace
```

### 4. Migrate a Single PVC

To migrate a PVC from RKE1 to RKE2:

```bash
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-context=rke2-cluster \
  --dest-namespace=target-namespace \
  --dest=target-pvc-name
```

By default, this creates a new PVC in the target cluster with the same size and access mode.

### 5. Advanced PVC Migration Options

For more control over the migration:

```bash
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-context=rke2-cluster \
  --dest-namespace=target-namespace \
  --dest=target-pvc-name \
  --strategies=lbsvc \
  --helm-set="rsync.extraArgs=--info=progress2" \
  --compress=true \
  --dest-delete-extraneous-files
```

This command:
- Uses the load balancer service strategy
- Adds custom rsync options for the data transfer
- Enables compression during transfer
- Removes extraneous files at the destination that don't exist in the source

### 6. Batch Migration with PVC Lists

For migrating multiple PVCs, you can create a script:

```bash
#!/bin/bash
# migrate-pvcs.sh

SOURCE_CONTEXT="rke1-cluster"
DEST_CONTEXT="rke2-cluster"
SOURCE_NS="source-namespace"
DEST_NS="target-namespace"

# Array of PVC names to migrate
PVCS=("data-pvc" "config-pvc" "logs-pvc")

for PVC in "${PVCS[@]}"; do
  echo "Migrating PVC: $PVC"
  pv-migrate \
    --source-context=$SOURCE_CONTEXT \
    --source-namespace=$SOURCE_NS \
    --source=$PVC \
    --dest-context=$DEST_CONTEXT \
    --dest-namespace=$DEST_NS \
    --dest=$PVC
  
  # Check exit status
  if [ $? -eq 0 ]; then
    echo "Successfully migrated $PVC"
  else
    echo "Failed to migrate $PVC"
  fi
done
```

Make the script executable and run it:

```bash
chmod +x migrate-pvcs.sh
./migrate-pvcs.sh
```

### 7. Monitor Migration Progress

pv-migrate provides status updates during migration. For more detailed logs:

```bash
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-context=rke2-cluster \
  --dest-namespace=target-namespace \
  --dest=target-pvc-name \
  --log-level=DEBUG
```

### 8. Verify the Migration

After migration, verify that the data has been correctly transferred:

```bash
# Create a temporary pod to check data
kubectl --context=rke2-cluster -n target-namespace run verify-pod \
  --image=busybox --rm -it --restart=Never \
  --overrides='{"spec": {"containers": [{"name": "verify-pod", "image": "busybox", "command": ["sh"], "stdin": true, "tty": true, "volumeMounts": [{"name": "data", "mountPath": "/data"}]}], "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "target-pvc-name"}}]}}' \
  -- sh
```

Inside the pod, you can check the contents of your migrated volume:

```
# Inside the pod
ls -la /data
```

## Advanced Configuration Options

### Using Different Migration Strategies

pv-migrate supports multiple strategies for the data transfer:

#### 1. Mount Both Strategy (mnt2)

Mounts both PVCs in a single pod and runs a regular rsync. This is the fastest method but only works when both PVCs are in the same namespace and cluster:

```bash
pv-migrate \
  --source-namespace=namespace \
  --source=source-pvc-name \
  --dest=dest-pvc-name \
  --strategies=mnt2
```

#### 2. Service Strategy (svc)

Runs rsync+ssh over a Kubernetes Service (ClusterIP). Only applicable when source and destination PVCs are in the same Kubernetes cluster:

```bash
pv-migrate \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-namespace=dest-namespace \
  --dest=dest-pvc-name \
  --strategies=svc
```

#### 3. Load Balancer Service Strategy (lbsvc)

Runs rsync+ssh over a Kubernetes Service of type LoadBalancer. This is useful for cross-cluster migrations:

```bash
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-context=rke2-cluster \
  --dest-namespace=target-namespace \
  --dest=dest-pvc-name \
  --strategies=lbsvc
```

#### 4. Local Transfer Strategy (experimental)

Uses a combination of kubectl port-forward and SSH reverse proxy to tunnel traffic through the client device:

```bash
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-context=rke2-cluster \
  --dest-namespace=target-namespace \
  --dest=dest-pvc-name \
  --strategies=local
```

#### 5. Multiple Strategies

You can specify multiple strategies in order of preference:

```bash
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-context=rke2-cluster \
  --dest-namespace=target-namespace \
  --dest=dest-pvc-name \
  --strategies=mnt2,svc,lbsvc
```

This tries each strategy in order, falling back to the next one if a strategy fails.

### Customizing Rsync Options

Fine-tune the rsync transfer with custom options:

```bash
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-context=rke2-cluster \
  --dest-namespace=target-namespace \
  --dest=dest-pvc-name \
  --helm-set="rsync.extraArgs=--partial --inplace --exclude='temp/*'"
```

### Custom SSH Options

You can customize SSH settings using the helm values:

```bash
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-context=rke2-cluster \
  --dest-namespace=target-namespace \
  --dest=dest-pvc-name \
  --ssh-key-algorithm=rsa \
  --helm-set="sshd.extraConfig=StrictHostKeyChecking=no"
```

### Using Custom Service Accounts

You can specify custom service accounts via Helm values:

```bash
# Create service account in RKE1
kubectl --context=rke1-cluster -n source-namespace create serviceaccount pv-migrate

# Create role and binding
kubectl --context=rke1-cluster -n source-namespace create role pv-migrate-role \
  --verb=get,list,watch,create,delete \
  --resource=pods,persistentvolumeclaims,pods/exec

kubectl --context=rke1-cluster -n source-namespace create rolebinding pv-migrate-binding \
  --role=pv-migrate-role \
  --serviceaccount=source-namespace:pv-migrate

# Repeat for RKE2 target cluster
kubectl --context=rke2-cluster -n target-namespace create serviceaccount pv-migrate
kubectl --context=rke2-cluster -n target-namespace create role pv-migrate-role \
  --verb=get,list,watch,create,delete \
  --resource=pods,persistentvolumeclaims,pods/exec
kubectl --context=rke2-cluster -n target-namespace create rolebinding pv-migrate-binding \
  --role=pv-migrate-role \
  --serviceaccount=target-namespace:pv-migrate
```

Then use these service accounts in your migration:

```bash
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=source-namespace \
  --source=source-pvc-name \
  --dest-context=rke2-cluster \
  --dest-namespace=target-namespace \
  --dest=dest-pvc-name \
  --helm-set="rsync.serviceAccount.create=false" \
  --helm-set="rsync.serviceAccount.name=pv-migrate" \
  --helm-set="sshd.serviceAccount.create=false" \
  --helm-set="sshd.serviceAccount.name=pv-migrate"
```

## Best Practices and Troubleshooting

### Pre-Migration Best Practices

- **Sizing:** Ensure target PVCs have equal or greater capacity than source PVCs
- **Application Shutdown:** Stop applications using the PVCs before migration
- **Test Run:** Perform a test migration with non-critical data first
- **Connectivity:** Verify network connectivity between clusters
- **Permissions:** Ensure appropriate RBAC permissions for pv-migrate

### Common Issues and Solutions

#### Connection Problems

**Issue:** Failed to establish connection between clusters  
**Solution:** Check network connectivity and firewall rules:

```bash
# Test connectivity from a pod in the source cluster to a node in the target cluster
kubectl --context=rke1-cluster -n default run test-connectivity \
  --image=busybox --rm -it --restart=Never \
  -- ping <target-cluster-node-ip>
```

Ensure that required ports (typically SSH port 22) are open between clusters.

#### Permission Denied

**Issue:** Unable to perform operations due to RBAC restrictions  
**Solution:** Verify and adjust RBAC permissions:

```bash
# Check if you can create and delete pods in both namespaces
kubectl --context=rke1-cluster auth can-i create pods -n source-namespace
kubectl --context=rke2-cluster auth can-i create pods -n target-namespace

# Check if you can use the exec capability on pods
kubectl --context=rke1-cluster auth can-i exec pods -n source-namespace
kubectl --context=rke2-cluster auth can-i exec pods -n target-namespace
```

#### Storage Class Issues

**Issue:** Unable to create PVC in target cluster  
**Solution:** Verify storage class availability and provisioner functionality:

```bash
# List available storage classes in target cluster
kubectl --context=rke2-cluster get storageclass

# Check if the storage class can provision volumes
kubectl --context=rke2-cluster create namespace test-sc
kubectl --context=rke2-cluster -n test-sc create -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: your-storage-class
EOF

kubectl --context=rke2-cluster -n test-sc get pvc test-pvc
kubectl --context=rke2-cluster -n test-sc delete pvc test-pvc
kubectl --context=rke2-cluster delete namespace test-sc
```

#### Data Verification Failures

**Issue:** Data appears to be missing or corrupted after migration  
**Solution:** Use checksums to verify data integrity:

```bash
# In source cluster
kubectl --context=rke1-cluster -n source-namespace run checksum-pod \
  --image=busybox --rm -it --restart=Never \
  --overrides='{"spec": {"containers": [{"name": "checksum-pod", "image": "busybox", "command": ["sh"], "stdin": true, "tty": true, "volumeMounts": [{"name": "data", "mountPath": "/data"}]}], "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "source-pvc-name"}}]}}' \
  -- sh -c "find /data -type f -exec md5sum {} \; | sort > /tmp/checksums.txt && cat /tmp/checksums.txt"

# In target cluster
kubectl --context=rke2-cluster -n target-namespace run checksum-pod \
  --image=busybox --rm -it --restart=Never \
  --overrides='{"spec": {"containers": [{"name": "checksum-pod", "image": "busybox", "command": ["sh"], "stdin": true, "tty": true, "volumeMounts": [{"name": "data", "mountPath": "/data"}]}], "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "target-pvc-name"}}]}}' \
  -- sh -c "find /data -type f -exec md5sum {} \; | sort > /tmp/checksums.txt && cat /tmp/checksums.txt"
```

Compare the output of both commands to verify data integrity.

## Complete Migration Workflow Example

Here's a complete workflow for migrating stateful applications from RKE1 to RKE2:

1. **Identify and document PVCs:**

```bash
kubectl --context=rke1-cluster get pvc -A > rke1-pvcs.txt
```

2. **Create target namespaces in RKE2:**

```bash
for NS in $(kubectl --context=rke1-cluster get ns -o custom-columns=NAME:.metadata.name --no-headers | grep -v kube-system | grep -v kube-public | grep -v kube-node-lease | grep -v default); do
  kubectl --context=rke2-cluster create namespace $NS --dry-run=client -o yaml | kubectl --context=rke2-cluster apply -f -
done
```

3. **Stop applications in RKE1:**

```bash
kubectl --context=rke1-cluster -n app-namespace scale deployment app-deployment --replicas=0
kubectl --context=rke1-cluster -n app-namespace scale statefulset app-statefulset --replicas=0
```

4. **Migrate PVCs for each application:**

```bash
# For each PVC in the application
pv-migrate \
  --source-context=rke1-cluster \
  --source-namespace=app-namespace \
  --source=app-data-pvc \
  --dest-context=rke2-cluster \
  --dest-namespace=app-namespace \
  --dest=app-data-pvc \
  --strategies=lbsvc \
  --log-level=DEBUG
```

5. **Export and apply application manifests:**

```bash
# Export deployments, statefulsets, services, etc.
kubectl --context=rke1-cluster -n app-namespace get deployment,statefulset,service -o yaml > app-manifests.yaml

# Modify manifests as needed (storage class references, etc.)
# ...

# Apply to RKE2
kubectl --context=rke2-cluster apply -f app-manifests.yaml
```

6. **Verify applications in RKE2:**

```bash
kubectl --context=rke2-cluster -n app-namespace get pods
kubectl --context=rke2-cluster -n app-namespace get pvc
```

7. **Update DNS/load balancers to point to RKE2 services**

## Post-Migration Steps

After successfully migrating:

1. **Validate Application Functionality:** Test all application features in the new RKE2 cluster.
2. **Update Access Configuration:** Update any external access points (load balancers, DNS, etc.).
3. **Schedule Decommissioning:** Plan for the safe shutdown of RKE1 after a verification period.
4. **Document Changes:** Record any configuration differences between clusters.
5. **Review Storage Configuration:** Optimize storage settings in RKE2 based on performance needs.

## Conclusion

Migrating from RKE1 to RKE2 using pv-migrate provides a targeted approach focused on persistent volume data. This method is particularly valuable for organizations that:

- Need to migrate only specific persistent volumes
- Want a lightweight, focused tool rather than a full backup/restore solution
- Prefer a direct PVC-to-PVC transfer approach
- Need fine-grained control over the migration process

By using pv-migrate, you can efficiently transfer your application data while maintaining full control over the migration process, with minimal dependencies and setup requirements.

---

### Additional Resources
- [pv-migrate GitHub Repository](https://github.com/utkuozdemir/pv-migrate)
- [RKE2 Documentation](https://docs.rke2.io/)
- [RKE1 to RKE2 Migration Strategy Overview](https://support.tools/migrating-rke1-to-rke2/)
- [SUSE RKE1 EOL Announcement](https://www.suse.com/support/kb/doc/?id=000021513)
