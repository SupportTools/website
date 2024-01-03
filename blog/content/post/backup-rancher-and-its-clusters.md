---
title: "Comprehensive Guide to Backing Up Rancher and its Clusters"
date: 2024-01-03T10:00:00-00:00
draft: false
tags: ["Rancher", "Backup", "Kubernetes", "Data Protection"]
categories:
- Rancher
- Kubernetes
- Data Protection
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to effectively back up Rancher and its Kubernetes clusters, ensuring data safety and continuity."
more_link: "yes"
---

## Comprehensive Guide to Backing Up Rancher and its Clusters

Ensuring the safety and continuity of data in Rancher-managed Kubernetes clusters is paramount. This workshop aims to provide you with a thorough understanding and practical approach to back up Rancher and its clusters, safeguarding your data against potential losses.

## Understanding Rancher Backups

Rancher, a popular Kubernetes management platform, simplifies container orchestration. However, like any system, it's prone to data loss due to hardware failures, software bugs, or human errors. Regular backups are crucial.

### What to Back Up in Rancher

- **Rancher Server Data**: Includes configurations, settings, and state.
- **Kubernetes Cluster Data**: All data related to workloads running in the clusters.
- **ETCD Data**: Critical for Kubernetes, as it stores the cluster state.

## Backup Tools and Strategies

### Rancher Backup Operator

#### What is Rancher Backup Operator?

The Rancher Backup Operator is a tool created by Rancher Labs to backup and restore Rancher server data. It's available in Rancher v2.5 and above. With the basic idea being that it grabs all the crds used by Rancher and stores them in a tarball.

#### How to install Rancher Backup Operator?

Run the following command to install the backup operator on the local cluster:

```bash
helm repo add rancher-charts https://charts.rancher.io
helm repo update
helm install --wait --create-namespace -n cattle-resources-system rancher-backup-crd rancher-charts/rancher-backup-crd
helm install --wait -n cattle-resources-system rancher-backup rancher-charts/rancher-backup
```

#### How to configure Rancher Backup Operator?

The Rancher Backup Operator is configured using a set of CRDs and two main components:

- Backup Configurations: Defines the backup schedule, retention policy, etc.
- Storage Locations: Specifies the storage location for the backups IE S3, PVC, etc.

For on-going backups, it is recommended to use S3 as the storage location so that the backups are stored outside of the cluster.

S3 Storage Location Example using Wasabi:

First, create a secret with the Wasabi credentials:

```bash
kubectl create secret generic rancher-backup-s3 \
  --from-literal=accessKey=<access key> \
  --from-literal=secretKey=<secret key> \
  -n cattle-global-data
```

Next, create the backup configuration:

```yaml
apiVersion: resources.cattle.io/v1
kind: Backup
metadata:
  name: nightly
  namespace: cattle-resources-system
spec:
  resourceSetName: rancher-resource-set
  retentionCount: 30
  schedule: '@midnight'
  storageLocation:
    s3:
      bucketName: BACKUP_BUCKET_NAME
      credentialSecretName: rancher-backup-s3
      credentialSecretNamespace: cattle-global-data
      endpoint: s3.us-central-1.wasabisys.com
      folder: rancher.support.tools
      region: us-central-1
```

By default the backup operator will trigger a backup when the configuration is created. You can monitor the status of the backup by running:

```bash
kubectl -n cattle-resources-system logs -l app.kubernetes.io/name=rancher-backup
```

Example output:

```bash
2024-01-03T03:21:17.022069922-06:00 INFO[2024/01/03 09:21:17] Saving resourceSet used for backup CR nightly 
2024-01-03T03:21:17.023703862-06:00 INFO[2024/01/03 09:21:17] Compressing backup CR nightly                
2024-01-03T03:21:18.035326640-06:00 INFO[2024/01/03 09:21:18] invoking set s3 service client                insecure-tls-skip-verify=false s3-accessKey=REDACTED s3-bucketName=REDACTED s3-endpoint
=s3.us-central-1.wasabisys.com s3-endpoint-ca= s3-folder=rancher.support.tools s3-region=us-central-1
2024-01-03T03:21:18.209599142-06:00 INFO[2024/01/03 09:21:18] invoking uploading backup file [rancher.support.tools/nightly-6d93be57-658e-43fa-aaf1-e2b5a88755f2-2024-01-03T09-21-02Z.tar.gz] to s3 
2024-01-03T03:21:19.476951472-06:00 INFO[2024/01/03 09:21:19] Successfully uploaded [rancher.support.tools/nightly-6d93be57-658e-43fa-aaf1-e2b5a88755f2-2024-01-03T09-21-02Z.tar.gz] 
2024-01-03T03:21:19.656892294-06:00 INFO[2024/01/03 09:21:19] invoking set s3 service client                insecure-tls-skip-verify=false s3-accessKey=REDACTED s3-bucketName=REDACTED s3-endpoint=s3.us-central-1.wasabisys.com s3-endpoint-ca= s3-folder=rancher.support.tools s3-region=us-central-1
2024-01-03T03:21:19.772378953-06:00 INFO[2024/01/03 09:21:19] Done with backup                             
2024-01-03T03:21:19.776649966-06:00 INFO[2024/01/03 09:21:19] Processing backup nightly                    
2024-01-03T03:21:19.776695042-06:00 INFO[2024/01/03 09:21:19] Next snapshot is scheduled for: 2024-01-04T00:00:00Z, current time: 2024-01-03T09:21:19Z 
```

PVC Storage Location Example:

NOTE: In this example, we are going to local-path-provisioner to create a PVC for the backup which will be stored on one of the local nodes in the cluster as a bind mount. This is not recommended for production use.

First, install the local-path-provisioner:

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.26/deploy/local-path-storage.yaml
```

Next, create a PVC for the backup:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: rancher-backup
  namespace: cattle-resources-system
spec:
    accessModes:
    - ReadWriteOnce
    resources:
        requests:
        storage: 10Gi
    storageClassName: local-path
```

Finally, create the backup configuration:

```yaml
apiVersion: resources.cattle.io/v1
kind: Backup
metadata:
  name: nightly
  namespace: cattle-resources-system
spec:
    resourceSetName: rancher-resource-set
    retentionCount: 30
    schedule: '@midnight'
    storageLocation:
        persistentVolumeClaim:
        claimName: rancher-backup
```

### ETCD Snapshots

#### What is ETCD Snapshots?

ETCD is a distributed key-value store that stores the state of the Kubernetes cluster. It's a critical component of Kubernetes, and backing it up is essential. ETCD snapshots are a simple way to back up the ETCD cluster.

#### How to take ETCD Snapshots?

For RKE1/RKE2 etcd snapshots are enabled by default. To take a snapshot, run the following command:

RKE1:

```bash
rke etcd snapshot-save --config cluster.yml
```

RKE2:

```bash
rke2 etcd snapshot-save
```

The snapshot will be saved in the /opt/rke/etcd-snapshots directory.

#### How to restore ETCD Snapshots?

To restore an ETCD snapshot, run the following command:

RKE1:

```bash
rke etcd snapshot-restore --config cluster.yml
```

RKE2:

```bash
rke2 etcd snapshot-restore
```

NOTE: It's important to understand that ETCD snapshots are for the whole cluster, not just Rancher IE rancher-monitoring, rancher-logging, etc. Also, ETCD snapshots are really designed for disaster recovery, not for restoring a single resource.

### Velero Backups

#### What is Velero?

Velero is an open-source tool that backs up and restores Kubernetes cluster resources and persistent volumes. It's a popular tool for backing up Kubernetes clusters.

#### How to install Velero?

To install Velero CLI, You can download it from the [releases page](https://github.com/vmware-tanzu/velero/releases).

Next, create a credentials file for the cloud storage provider:

```bash
cat <<EOF > credentials-velero
[default]
aws_access_key_id=YOUR_WASABI_ACCESS_KEY
aws_secret_access_key=YOUR_WASABI_SECRET_KEY
EOF
```

Next, install Velero:

```bash
velero install \
    --provider aws \
    --bucket mattox-velero \
    --secret-file ./credentials-velero \
    --backup-location-config region=us-central-1,s3ForcePathStyle="true",s3Url=https://s3.us-central-1.wasabisys.com \
    --snapshot-location-config region=us-central-1 \
    --plugins velero/velero-plugin-for-aws:v1.6.0,velero/velero-plugin-for-csi:v0.4.0 \
    --features EnableCSI
```

NOTE: The above command assumes that you are running a storage provider that supports the CSI snapshot API like Longhorn.

#### How to configure Velero?

To backup all namespaces, run the following command:

```bash
velero schedule create daily-everything-backup \
    --schedule "0 0 * * *" \
    --snapshot-volumes \
    --ttl 720h0m0s
```

NOTE: Harvester does not support CSI snapshots yet for nested clusters. Please [feature request](https://github.com/harvester/harvester/issues/3778) if you would like to see this feature added.

#### How to restore Velero?

To restore a backup, run the following command:

```bash
velero restore create --from-backup daily-everything-backup
```

## Conclusion

It's important to back up Rancher and its clusters to ensure data safety and continuity. It's also important to understand that Rancher and the downstream clusters are separate entities. Therefore, they need to be backed up separately. And it's important that you try to keep that in mind when designing your backup strategy. For example, if you create a new downstream cluster then restore the Rancher server backup, the new cluster will become orphaned. This is because the Rancher server backup does not contain any information about the new cluster. Therefore, it's important to have a backup strategy that includes both Rancher and its clusters. Also, it is recommended to use a backup tool like Velero that supports CSI snapshots for backing up the clusters as it will provide the ability to restore a volumes along with k8s resources.
