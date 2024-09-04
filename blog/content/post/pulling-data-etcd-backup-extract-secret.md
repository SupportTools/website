---
title: "Pulling Data from an etcd Backup: How to Extract a Secret from an etcd Snapshot Without Doing a Full Cluster Restore"  
date: 2024-10-18T19:26:00-05:00  
draft: false  
tags: ["etcd", "Kubernetes", "Backup", "Secrets", "Troubleshooting"]  
categories:  
- Kubernetes  
- Backup  
- etcd  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to extract a specific Kubernetes Secret from an etcd snapshot without the need to restore the full cluster."  
more_link: "yes"  
url: "/pulling-data-etcd-backup-extract-secret/"  
---

In Kubernetes, **etcd** serves as the backend data store for all cluster state, including secrets, configuration data, and application state. But what happens if you need to pull a specific secret from an **etcd snapshot** without doing a full cluster restore? Fortunately, there’s a way to extract specific data from an etcd backup without impacting the entire cluster.

In this post, we’ll walk through how to pull a secret from an etcd snapshot, saving you from the complexity of restoring the entire cluster.

<!--more-->

### Why Extract from an etcd Snapshot?

**etcd snapshots** are essential for disaster recovery, but restoring the entire etcd cluster just to retrieve a single piece of information, such as a Kubernetes Secret, can be overkill. Instead, you can directly interact with the snapshot to extract specific keys, saving time and reducing the risk of data disruption.

### Prerequisites

Before diving into extracting data from the snapshot, you need:

- An existing **etcd snapshot** file
- The **etcdctl** command-line tool (version 3.x or higher)
- Access to the encryption keys if your secrets are encrypted at rest

### Step 1: Set Up etcdctl to Work with the Snapshot

To extract data from an etcd snapshot, you need to point **etcdctl** to the snapshot file and run it in a temporary environment. Start by exporting the necessary environment variables to interact with the snapshot:

```bash
export ETCDCTL_API=3
```

Then, use the following command to tell `etcdctl` to use the snapshot file:

```bash
ETCDCTL_SNAPSHOT="/path/to/your/etcd-snapshot.db"
```

### Step 2: Explore the Snapshot

Once the snapshot is ready, you can explore its contents using `etcdctl`:

```bash
etcdctl --endpoints=unix://localhost:2379 --snapshot=$ETCDCTL_SNAPSHOT snapshot status
```

This will give you a summary of the snapshot, including its size and revision.

### Step 3: Extract the Secret’s Key from etcd

To extract the specific secret, you’ll need to identify the exact key where the secret is stored. In Kubernetes, secrets are usually stored under `/registry/secrets/<namespace>/<secret-name>`. Use the following command to explore the keys in the snapshot:

```bash
etcdctl --endpoints=unix://localhost:2379 --snapshot=$ETCDCTL_SNAPSHOT get /registry/secrets/ --prefix --keys-only
```

This command will output a list of all keys related to secrets. Find the key corresponding to the secret you want to extract.

### Step 4: Extract the Secret Data

Once you’ve located the key for the secret, you can extract the data for that key:

```bash
etcdctl --endpoints=unix://localhost:2379 --snapshot=$ETCDCTL_SNAPSHOT get /registry/secrets/<namespace>/<secret-name> -w json
```

This will output the JSON representation of the secret as stored in etcd. You can view the base64-encoded values of the secret in the output.

#### Example

```bash
etcdctl --endpoints=unix://localhost:2379 --snapshot=$ETCDCTL_SNAPSHOT get /registry/secrets/default/my-secret -w json
```

The output might look like this:

```json
{
  "header": {
    "cluster_id": 14841639068965178418,
    "member_id": 10276657743932975437,
    "revision": 6,
    "raft_term": 2
  },
  "kvs": [
    {
      "key": "L3JlZ2lzdHJ5L3NlY3JldHMvZGVmYXVsdC9teS1zZWNyZXQ=",
      "create_revision": 6,
      "mod_revision": 6,
      "version": 1,
      "value": "eyJhcGkiOiB7InZlcnNpb24iOiAidjEiLCAiZGF0YSI6IHsicGFzc3dvcmQiOiAiMTIzNDUifX19"
    }
  ],
  "count": 1
}
```

Here, the **value** field contains the base64-encoded secret data. You can decode it to retrieve the actual values.

### Step 5: Decode the Secret Data

Once you have the base64-encoded secret data, you need to decode it to view the actual secret values. Use the `base64` command to decode the secret:

```bash
echo "eyJhcGkiOiB7InZlcnNpb24iOiAidjEiLCAiZGF0YSI6IHsicGFzc3dvcmQiOiAiMTIzNDUifX19" | base64 --decode
```

The decoded output will reveal the original secret data:

```json
{
  "api": {
    "version": "v1",
    "data": {
      "password": "12345"
    }
  }
}
```

### Step 6: If Secrets Are Encrypted

If you have **encryption at rest** enabled in your Kubernetes cluster, the secrets stored in etcd will be encrypted. To decrypt these secrets, you’ll need access to the **encryption config** used by the Kubernetes API server.

You can locate the encryption configuration file (usually found under `/etc/kubernetes/`) and use it to decrypt the secret. The process involves using Kubernetes encryption keys to decode the encrypted secret data.

### Conclusion

Extracting a specific secret from an **etcd snapshot** is a valuable method for pulling critical data without the need to restore an entire cluster. By following these steps, you can efficiently retrieve Kubernetes secrets from etcd snapshots using `etcdctl`, saving time and reducing the complexity of your recovery process.
