---
title: "Backup Kubernetes Cluster Resources to AWS S3 with Velero"  
date: 2025-02-13T09:37:00-05:00  
draft: false  
tags: ["Kubernetes", "Backup", "Velero", "AWS S3", "Cloud"]  
categories:  
- Kubernetes  
- Backup  
- Cloud  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to use Velero to back up Kubernetes cluster resources to AWS S3, ensuring data resilience and disaster recovery."  
more_link: "yes"  
url: "/backup-kubernetes-cluster-aws-s3-velero/"
socialMedia:  
  buffer: true
---

Ensuring the safety and recoverability of your Kubernetes cluster is critical, especially in production environments. Velero, a powerful open-source tool, simplifies the process of backing up Kubernetes cluster resources to cloud storage, such as AWS S3. In this guide, we'll walk through how to set up Velero to back up your Kubernetes cluster resources to an AWS S3 bucket.

<!--more-->

### What is Velero?

Velero is an open-source tool used to safely back up, restore, and migrate Kubernetes cluster resources and persistent volumes. With its support for cloud providers like AWS, GCP, and Azure, Velero can back up your cluster data to cloud storage, ensuring your resources are protected in case of disaster.

### Pre-requisites

Before setting up Velero, ensure the following:

- A Kubernetes cluster is running and accessible.
- You have AWS credentials (Access Key and Secret Key) with permissions to create and manage S3 buckets.
- `kubectl` installed and configured to manage your Kubernetes cluster.

### Step 1: Install Velero CLI

First, download and install the Velero CLI on your local machine. You can install Velero by running the following commands:

```bash
VELERO_VERSION=v1.12.1
wget https://github.com/vmware-tanzu/velero/releases/download/${VELERO_VERSION}/velero-${VELERO_VERSION}-linux-amd64.tar.gz
tar -xvf velero-${VELERO_VERSION}-linux-amd64.tar.gz
sudo mv velero-${VELERO_VERSION}-linux-amd64/velero /usr/local/bin/
```

Verify the installation by running:

```bash
velero version
```

### Step 2: Create an AWS S3 Bucket for Velero Backups

Log in to your AWS Management Console and create a new S3 bucket where Velero will store your backups.

1. Go to the S3 service and click **Create bucket**.
2. Choose a name for your bucket (e.g., `my-k8s-backups`) and select a region.
3. Configure your bucket settings as needed and click **Create**.

After creating the bucket, take note of the bucket name and region for the next steps.

### Step 3: Create an IAM User and Policy

To allow Velero to interact with your S3 bucket, create an IAM user with the necessary permissions.

1. In the AWS Console, go to **IAM > Users** and click **Add user**.
2. Name the user (e.g., `velero-backup`) and grant **Programmatic access**.
3. Attach the following policy, allowing access to your S3 bucket:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:ListBucket",
                "s3:GetBucketLocation",
                "s3:AbortMultipartUpload",
                "s3:ListMultipartUploadParts",
                "s3:ListBucketMultipartUploads"
            ],
            "Resource": [
                "arn:aws:s3:::my-k8s-backups",
                "arn:aws:s3:::my-k8s-backups/*"
            ]
        }
    ]
}
```

Replace `my-k8s-backups` with the name of your S3 bucket. Save the Access Key ID and Secret Access Key for the next steps.

### Step 4: Install Velero in Your Kubernetes Cluster

Now that Velero is configured, we'll install it on the Kubernetes cluster using the following command:

```bash
velero install \
    --provider aws \
    --bucket my-k8s-backups \
    --secret-file ./credentials-velero \
    --backup-location-config region=<your-region> \
    --snapshot-location-config region=<your-region> \
    --plugins velero/velero-plugin-for-aws:v1.8.0 \
    --use-volume-snapshots=false \
    --use-restic
```

Ensure that the `credentials-velero` file contains your AWS Access Key and Secret Key in the following format:

```plaintext
[default]
aws_access_key_id=<Your Access Key ID>
aws_secret_access_key=<Your Secret Access Key>
```

Replace `<your-region>` with your AWS region (e.g., `us-east-1`).

### Step 5: Perform a Backup

Now that Velero is installed and configured, you can create your first backup. Run the following command to back up all resources in the `default` namespace:

```bash
velero backup create my-first-backup --include-namespaces default
```

This command will create a backup and store it in your AWS S3 bucket. You can monitor the progress by running:

```bash
velero backup describe my-first-backup --details
```

### Step 6: Schedule Regular Backups

For production environments, it's recommended to schedule regular backups. You can create a backup schedule using the following command:

```bash
velero schedule create daily-backup \
    --schedule="0 1 * * *" \
    --include-namespaces default \
    --ttl 168h
```

This creates a daily backup at 1 AM and retains backups for 7 days (168 hours). You can view your schedules with:

```bash
velero schedule get
```

### Step 7: Restore from Backup

In the event of data loss or disaster, you can restore the backup with the following command:

```bash
velero restore create --from-backup my-first-backup
```

This will restore the Kubernetes resources from the backup stored in AWS S3.

### Troubleshooting

Here are some common issues and their solutions:

1. **Backup Failing**
   ```bash
   velero backup logs <backup-name>
   ```
   This command shows detailed logs of the backup process.

2. **Permission Issues**
   Verify your AWS credentials and IAM policy are correct:
   ```bash
   velero backup describe <backup-name>
   ```
   Look for permission-related errors in the output.

3. **Restic Issues**
   If using Restic for volume backups:
   ```bash
   kubectl logs -n velero -l component=velero
   kubectl logs -n velero -l component=restic
   ```

4. **Backup Validation**
   To verify backup contents:
   ```bash
   velero backup describe <backup-name> --details
   ```

### Final Thoughts

Velero is a powerful tool for Kubernetes disaster recovery, allowing you to easily back up and restore your cluster resources. By integrating with AWS S3, you can ensure that your Kubernetes data is safely stored offsite, providing peace of mind and protection against data loss. Regular backup scheduling and validation are crucial for maintaining a robust disaster recovery strategy.
