---
title: "Using MinIO as a Backup Target for Rancher Longhorn"
date: 2024-10-26T11:45:00-05:00
draft: false
tags: ["Rancher", "Longhorn", "Kubernetes", "MinIO", "Backups"]
categories:
- Kubernetes
- Backups
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to configure MinIO as a backup target for Rancher Longhorn using the S3 protocol."
more_link: "yes"
url: "/minio-backup-target-longhorn/"
---

**Longhorn**, an open-source container-native storage system developed by Rancher, simplifies **persistent volume backups** by supporting **S3 and NFS** storage systems as backup targets. In this guide, we’ll walk through how to **configure MinIO** as an S3-compatible backup target for Longhorn, enabling reliable volume backups.

This post assumes that **Longhorn and MinIO are already installed**—for installation guides, refer to the official [Longhorn documentation](https://longhorn.io/) and [MinIO Quickstart Guide](https://min.io/docs/).

---

## Environment Overview  

- **MinIO version:** RELEASE.2021-08-17T20-53-08Z (deployed with Podman on SUSE SLES 15 SP2)  
- **Longhorn version:** 1.1.1 (installed via Rancher’s Application Catalog on an RKE cluster running Kubernetes 1.20.9-rancher1-1)

---

## Step 1: Configure MinIO for Longhorn Backups  

First, we’ll set up **MinIO storage** by creating a dedicated bucket, folder, user, and policy for Longhorn backups. Use MinIO’s command-line tool, `mc`, to manage these objects.

### Set up the `mc` Alias  

```bash
mc alias set myminio https://miniolab.rancher.one miniorootuser miniorootuserpassword
```

### Create a Bucket and Folder  

```bash
mc mb myminio/rancherbackups
mc mb myminio/rancherbackups/longhorn
```

### Add a User and Policy  

Create a new user and define a **backup-specific policy** to grant access to the bucket.

```bash
mc admin user add myminio rancherbackupsuser mypassword

cat > /tmp/rancher-backups-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": [
        "s3:PutBucketPolicy",
        "s3:GetBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:ListAllMyBuckets",
        "s3:ListBucket"
      ],
      "Effect": "Allow",
      "Resource": [
        "arn:aws:s3:::rancherbackups"
      ]
    },
    {
      "Action": [
        "s3:AbortMultipartUpload",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:ListMultipartUploadParts",
        "s3:PutObject"
      ],
      "Effect": "Allow",
      "Resource": [
        "arn:aws:s3:::rancherbackups/*"
      ]
    }
  ]
}
EOF

mc admin policy add myminio rancher-backups-policy /tmp/rancher-backups-policy.json
mc admin policy set myminio rancher-backups-policy user=rancherbackupsuser
```

---

## Step 2: Create a Secret for MinIO Credentials  

Now, create a **Kubernetes secret** in the `longhorn-system` namespace to store your MinIO credentials. We’ll use **base64 encoding** for the values.

```bash
echo -n https://miniolab.rancher.one:443 | base64  # aHR0cHM6Ly9taW5pb2xhYi5yYW5jaGVyLm9uZTo0NDM=
echo -n rancherbackupsuser | base64  # cmFuY2hlcmJhY2t1cHN1c2Vy
echo -n mypassword | base64  # bXlwYXNzd29yZA==
```

If your MinIO environment uses a **custom CA certificate**, encode the CA as well and include it in the secret.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: minio-secret
  namespace: longhorn-system
type: Opaque
data:
  AWS_ACCESS_KEY_ID: cmFuY2hlcmJhY2t1cHN1c2Vy
  AWS_SECRET_ACCESS_KEY: bXlwYXNzd29yZA==
  AWS_ENDPOINTS: aHR0cHM6Ly9taW5pb2xhYi5yYW5jaGVyLm9uZTo0NDM=
  #AWS_CERT: <your base64 encoded custom CA certificate>
```

---

## Step 3: Configure the Backup Target in Longhorn  

The **backup target URL** follows the format:  
`s3://<bucket_name>@<region>/<folder>`.  

In our example, the backup target URL is:  
`s3://rancherbackups@dummyregion/longhorn`.

Open the **Longhorn UI** and navigate to **Settings → Backup Target**. Enter the **URL and secret name** to configure the backup target.

---

## Step 4: Enable Backups in Longhorn  

Once the backup target is configured, backups will be available for **Longhorn volumes**. You can manage these backups directly from the **Longhorn UI**.

- **Create Backup Schedules:** Use the **Volume** menu to define backup schedules.
- **Monitor Backup Status:** View backup logs and status in the UI.

---

## Troubleshooting Common Issues  

If you encounter errors during setup, check the following:

1. **Base64 Encoding Issues:** Ensure values are correctly encoded with `echo -n` to avoid trailing newlines.
2. **Target URL Errors:** Verify the backup target URL is formatted correctly.
3. **MinIO Configuration Issues:** Use the **MinIO web console** or `mc` to troubleshoot access permissions.
4. **SSL Issues:** If using a reverse proxy (e.g., **Nginx**) for MinIO, ensure that `client_max_body_size` is configured to handle large file uploads.

---

## Conclusion  

Using **MinIO as a backup target** for **Longhorn** provides a reliable, scalable solution for managing volume snapshots and backups. With the steps outlined in this post, you can configure **S3-compatible storage** for seamless backups, monitor backup health, and troubleshoot common issues.

By following these practices, you’ll have confidence that your **persistent volumes** are backed up and recoverable in case of any failure.
