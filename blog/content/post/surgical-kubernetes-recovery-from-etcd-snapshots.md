---
title: "Surgical Kubernetes Recovery: Extracting Individual Objects from etcd Snapshots"
date: 2027-05-13T09:00:00-05:00
draft: false
tags: ["Kubernetes", "etcd", "Disaster Recovery", "ConfigMap", "Backup", "Restore", "Operations", "Data Recovery"]
categories:
- Kubernetes
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools"
description: "A detailed, hands-on guide to recovering individual Kubernetes objects from etcd snapshots without cluster downtime, including step-by-step commands and real-world recovery scenarios"
more_link: "yes"
url: "/surgical-kubernetes-recovery-from-etcd-snapshots/"
---

One of the most stressful situations I've faced as a Kubernetes administrator was getting that 3 AM call: "Something's deleted in production." While every administrator knows they should take regular etcd snapshots, the standard recovery process often means rolling back the entire cluster—potentially losing hours of legitimate changes just to recover a single object. After several painful incidents, I developed a surgical approach to extract and restore specific resources from etcd backups without disturbing the rest of the cluster. This technique has saved my team countless hours and prevented numerous maintenance windows.

<!--more-->

## The Problem with Full etcd Restores

A full etcd restore is like using a sledgehammer to place a thumbtack. Yes, it works, but the collateral damage can be significant:

- The entire cluster state reverts to a previous point in time
- You lose all changes made since the backup, not just the deleted resource
- Services experience disruption as controllers reconcile the sudden state change
- Custom resources may become orphaned or inconsistent
- The cluster can take minutes or even hours to reach stability again

I learned this the hard way when I once restored an entire production cluster just to recover a deleted Secret, only to realize we had also rolled back critical ConfigMaps that had been legitimately updated. The subsequent scramble to reapply those changes was both unnecessary and risky.

## A Surgical Alternative: Individual Object Recovery

Instead of restoring the entire etcd database, we can extract just the objects we need from a snapshot, without impacting anything else in the cluster. This approach:

1. Maintains cluster stability
2. Preserves recent legitimate changes
3. Requires no downtime
4. Provides precise control over what gets restored
5. Works even in complex environments with custom resources

Let's walk through the step-by-step process I've refined over dozens of recovery operations.

## Prerequisites: Tools You'll Need

Before we begin, make sure you have these tools available:

- `etcd` and `etcdctl` (v3.4+)
- [`auger`](https://github.com/jpbetz/auger) - A tool for decoding etcd values into Kubernetes YAML
- `kubectl` - For applying the recovered objects
- `jq` (optional) - For formatting and filtering JSON output
- A recent etcd snapshot - Let's assume it's named `etcd-snapshot.db`

If you don't already have a snapshot, and your cluster is still running, create one immediately:

```bash
# For non-TLS etcd
etcdctl snapshot save etcd-snapshot.db

# For TLS-enabled etcd (typical in production)
etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save etcd-snapshot.db
```

## Step 1: Create a Local etcd Environment

First, we'll restore the snapshot to a temporary directory:

```bash
mkdir -p ~/etcd-recovery
etcdctl snapshot restore etcd-snapshot.db --data-dir=~/etcd-recovery/data
```

This creates a local copy of the etcd database without touching your live cluster.

## Step 2: Start a Temporary etcd Server

Next, launch a local etcd instance that reads from this restored data:

```bash
etcd --data-dir=~/etcd-recovery/data \
  --listen-client-urls http://localhost:2379 \
  --advertise-client-urls http://localhost:2379 \
  --listen-peer-urls http://localhost:2380 > ~/etcd-recovery/etcd.log 2>&1 &
```

Verify the server is running:

```bash
etcdctl --endpoints=localhost:2379 endpoint health
```

You should see `localhost:2379 is healthy`.

## Step 3: Find Your Missing Object

The challenge now is locating your deleted object in etcd's hierarchical key structure. Kubernetes stores objects using a predictable pattern:

```
/registry/<resource-type>/<namespace>/<name>
```

If you know the exact object you're looking for, you can construct the key directly. For example, to find a ConfigMap named `app-config` in the `default` namespace:

```bash
etcdctl --endpoints=localhost:2379 get /registry/configmaps/default/app-config
```

If you need to browse available keys, use the `--prefix` flag:

```bash
# List all ConfigMaps in the default namespace
etcdctl --endpoints=localhost:2379 get --prefix /registry/configmaps/default --keys-only

# List all Secrets in the kube-system namespace
etcdctl --endpoints=localhost:2379 get --prefix /registry/secrets/kube-system --keys-only
```

For objects with multi-segment names (like CRDs), the pattern is slightly different:

```bash
# For CRDs: /registry/<group>/<resource>/<namespace>/<name>
etcdctl --endpoints=localhost:2379 get --prefix /registry/monitoring.coreos.com/prometheuses --keys-only
```

## Step 4: Extract and Decode the Object

Once you've found your object's key, extract and decode it:

```bash
# Extract the raw object
etcdctl --endpoints=localhost:2379 get /registry/configmaps/default/app-config --print-value-only > app-config.bin

# Decode it to YAML using auger
auger decode --file app-config.bin > app-config.yaml
```

The resulting YAML file should contain your complete Kubernetes object definition.

## Step 5: Clean Up the YAML (Optional)

Before applying, you might want to clean up the YAML to remove system-managed fields:

```bash
# Using yq (a YAML processor)
cat app-config.yaml | yq eval 'del(.metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .metadata.generation, .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"])' - > app-config-clean.yaml
```

Removing these fields ensures a clean application without conflicts.

## Step 6: Apply the Recovered Object

Now apply the recovered object to your live cluster:

```bash
# First, perform a dry-run to ensure it's valid
kubectl apply -f app-config-clean.yaml --dry-run=server

# If everything looks good, apply it
kubectl apply -f app-config-clean.yaml
```

And that's it! You've successfully recovered your object without disrupting the cluster.

## Step 7: Clean Up

Don't forget to shut down your temporary etcd server:

```bash
pkill -f "etcd --data-dir=~/etcd-recovery/data"
rm -rf ~/etcd-recovery
```

## Real-World Recovery Scenarios

Let's cover some common recovery scenarios I've encountered in production.

### Scenario 1: Recovering a Deleted Secret

One of our most common recovery needs is for accidentally deleted Secrets:

```bash
# Find the secret
etcdctl --endpoints=localhost:2379 get --prefix /registry/secrets/prod/database-credentials --keys-only

# Extract and decode
etcdctl --endpoints=localhost:2379 get /registry/secrets/prod/database-credentials --print-value-only > db-secret.bin
auger decode --file db-secret.bin > db-secret.yaml

# Clean and apply
cat db-secret.yaml | yq eval 'del(.metadata.resourceVersion, .metadata.uid)' - | kubectl apply -f -
```

### Scenario 2: Recovering a Deployment with Proper Ownership

Deployments are trickier because they own ReplicaSets, which own Pods. If you just restore the Deployment, it might fight with existing ReplicaSets:

```bash
# Extract the deployment
etcdctl --endpoints=localhost:2379 get /registry/deployments/apps/prod/api-server --print-value-only > deployment.bin
auger decode --file deployment.bin > deployment.yaml

# Important: Delete ownerReferences to avoid conflicts
cat deployment.yaml | yq eval 'del(.metadata.ownerReferences, .metadata.resourceVersion, .metadata.uid, .metadata.generation)' - > deployment-clean.yaml

# Apply the deployment
kubectl apply -f deployment-clean.yaml
```

### Scenario 3: Recovering Custom Resources

For CRDs like Prometheus instances managed by operators:

```bash
# Find the Prometheus CRs
etcdctl --endpoints=localhost:2379 get --prefix /registry/monitoring.coreos.com/prometheuses --keys-only

# Extract a specific one
etcdctl --endpoints=localhost:2379 get /registry/monitoring.coreos.com/prometheuses/monitoring/cluster-monitoring --print-value-only > prometheus.bin
auger decode --file prometheus.bin > prometheus.yaml

# Clean and apply
cat prometheus.yaml | yq eval 'del(.metadata.resourceVersion, .metadata.uid, .metadata.generation, .status)' - > prometheus-clean.yaml
kubectl apply -f prometheus-clean.yaml
```

The key here is removing the `.status` field, which is managed by the operator.

## Advanced Techniques

### Recovering to a Different Namespace

Sometimes you want to restore an object to a different namespace, perhaps to validate it before applying to production:

```bash
cat app-config.yaml | yq eval '.metadata.namespace = "staging"' - > app-config-staging.yaml
kubectl apply -f app-config-staging.yaml
```

### Bulk Recovery of All Objects in a Namespace

If an entire namespace of objects was accidentally deleted:

```bash
# Create a directory for extracted objects
mkdir -p ~/etcd-recovery/objects

# Extract all ConfigMaps from the deleted namespace
for key in $(etcdctl --endpoints=localhost:2379 get --prefix /registry/configmaps/deleted-namespace --keys-only); do
  object_name=$(basename "$key")
  etcdctl --endpoints=localhost:2379 get "$key" --print-value-only > ~/etcd-recovery/objects/${object_name}.bin
  auger decode --file ~/etcd-recovery/objects/${object_name}.bin > ~/etcd-recovery/objects/${object_name}.yaml
done

# Repeat for other resource types (secrets, deployments, etc.)
# Then apply them as needed
```

### Handling Encrypted etcd Data

If your etcd data is encrypted (common in production clusters), you'll need the encryption keys to decode it:

```bash
# You'll need to mount or copy the encryption config from your apiserver
ENCRYPTION_CONFIG=/etc/kubernetes/encryption-config.yaml

# Use auger with the encryption config
auger decode --file secret.bin --encryption-config $ENCRYPTION_CONFIG > secret.yaml
```

## Avoiding Recovery Altogether: Best Practices

While surgical recovery is valuable, ideally you want to prevent accidental deletions:

1. **Use Admission Controllers**: Implement policies with OPA Gatekeeper or Kyverno that prevent deletion of critical resources

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPreventDeletion
metadata:
  name: prevent-critical-configmap-deletion
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["ConfigMap"]
    namespaces: ["prod"]
  parameters:
    names: ["app-config", "database-credentials"]
```

2. **Implement GitOps**: With tools like ArgoCD or Flux, deleted objects will be automatically reconciled from Git

3. **Use RBAC Properly**: Limit who can delete resources in production namespaces

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: no-delete-role
  namespace: prod
rules:
- apiGroups: [""]
  resources: ["configmaps", "secrets"]
  verbs: ["get", "list", "watch", "create", "update", "patch"] # Note: no "delete"
```

4. **Consider Namespace-Scoped Velero Backups**: For critical namespaces, take frequent application-consistent backups

## When Full Restore Is Necessary

Despite these techniques, sometimes a full restore is still the best option:

- When multiple interdependent objects were deleted
- When you need to recover the exact state at a point in time
- When database transactions or other stateful components require consistency

In those cases, follow your cluster's full restore procedure, but try to schedule it during a maintenance window.

## Conclusion: Adding This to Your Toolkit

The ability to surgically extract and restore individual Kubernetes objects from etcd snapshots is an invaluable skill for any platform engineer or SRE. I've used these techniques countless times to recover from accidental deletions without disrupting the entire cluster.

Keep in mind that while this approach is powerful, it should be practiced in a test environment before using it in production. The etcd database is the heart of your Kubernetes cluster, and you should always handle snapshots with appropriate caution.

By adding this surgical recovery method to your operational toolkit, you'll be able to respond to incidents more precisely and with minimal impact on your users.

Have you had to recover objects from etcd? What approaches worked for you? I'd be interested to hear your experiences in the comments below.