---
title: "Rancher Backups and Disaster Recovery for RKE1"
date: 2024-06-30T23:18:00-05:00
draft: false
tags: ["rancher", "rancher-2.x", "backups", "disaster-recovery"]
categories:
- Rancher
- RKE1
author: "Matthew Mattox - mmattox@support.tools"
description: "Rancher backups and disaster recovery"
more_link: "yes"
---

Eventually, something will happen that requires restoring a Kubernetes cluster. That's not a question of if but when.

In the case of Kubernetes, this means regularly backing up the etcd datastore.

How regular? The choice is yours. It is up to you how much data you are willing to lose.

For example, a highly active cluster may take snapshots every fifteen minutes or even every five minutes. In the case of a cluster that does not receive a lot of activity, a snapshot of the cluster might be taken daily.

You can never be fired for having too many backups.

As a default, RKE takes a snapshot every six hours and keeps it for one day, but you can change the settings in the `cluster.yaml`.

Any time you wish, you can run a snapshot by executing the command `rke etcd snapshot-save` and passing it the name of the backup and the location of `cluster.yml`. This command will write a snapshot of all the etcd hosts to `/opt/rke/etcd-snapshots`. It is possible to mount an NFS volume there, or you can configure RKE to copy the snapshot to S3 to restore it.

<!--more-->
# [Configure RKE1](#configure-rke1)

RKE can also be configured to make recurring snapshots regularly and automatically. It is possible to configure that in the backup_configkey of the etcd service, where the following configurations can be made:

- `interval_hours`, which is how often a snapshot is taken
- `retention period`, which is how long a snapshot should remain on the system
- `s3backupconfig` contains the information that RKE needs to copy the snapshot to S3.

Example cluster.yaml:
```yaml
services:
  etcd:
    backup_config:
      enabled: true       # enables recurring etcd snapshots
      interval_hours: 3   # time increment between snapshots
      retention: 72       # time in days before snapshot purge
      # Optional S3
      s3backupconfig:
        access_key: "AKIAIOSFODNN7EXAMPLE"
        secret_key:  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
        bucket_name: "etcd"
        folder: "rancher.support.tools" # Available as of v2.3.0
        endpoint: "s3.us-west-1.wasabisys.com"
        region: "us-west-1"
```

On hosts running the etcd role, the recurring snapshot service launches a container that logs the log data for the `etcd-rolling-snapshots` container. The output of the docker logs for that container is available in the output of the docker logs for that node.

It is still possible to store your backup files on S3 even if your RKE cluster does not reside on AWS. If you are looking for a service that doesn't rely on Amazon, you can use something like Minio that is compatible with S3.

Suppose you have Minio behind a self-signed certificate or a certificate from a CA unknown to you. In that case, you must add the signing certificate to the custom_cakey section of the s3 backup configuration section of cluster.yml.

# [Restoring From a Backup](#restoring-from-a-backup)
Whenever snapshots are taken, they are saved locally and can be sent out to S3. With rke etcd snapshot-restore, if you provide the name of the snapshot, you can restore it if you have a copy of the snapshot on your local computer.

Ensure you run this command from the same directory as `cluster.yml` and `cluster.rkestate` and that the snapshot is in `/opt/rke/etcd-snapshots` on one of the nodes.

Alternatively, you can provide the S3 credentials for where the snapshot was stored, and RKE will pull the snapshot from S3 and apply it.

The process of restoring a snapshot is a destructive one. As a result, the current cluster will be deleted, and a new cluster will be created from the RKE snapshot file. If you would like to restore a snapshot into an existing cluster, we recommend creating a snapshot of the cluster state.

# [Documentation](#documentation)
- Backups and Disaster Recovery : [https://rancher.com/docs/rke/latest/en/etcd-snapshots/](https://rancher.com/docs/rke/latest/en/etcd-snapshots/)
- Rancher Master class: [Recovering from a disaster with Rancher and Kubernetes](https://github.com/mattmattox/Kubernetes-Master-Class/tree/main/disaster-recovery)