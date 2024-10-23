---
title: "KubeBackup: Automating Kubernetes Cluster Backups"
date: 2024-10-19T19:26:00-05:00
draft: false
tags: ["KubeBackup", "Kubernetes", "RKE2", "Backups"]
categories:
- Kubernetes
- RKE2
author: "Matthew Mattox - mmattox@support.tools"
description: "Discover how KubeBackup simplifies Kubernetes cluster backups by exporting YAML files and uploading them to S3."
more_link: "yes"
url: "/kubebackup/"
---

![KubeBackup Logo](https://github.com/mattmattox/kubebackup/raw/master/assets/kubebackup-logo.png)

Backing up your Kubernetes cluster is critical for disaster recovery and operational continuity. **KubeBackup** is a tool designed to simplify cluster backups by **exporting YAML configurations** and **uploading them to an S3 bucket**. With KubeBackup, you can automate backups, ensuring you have all necessary data to redeploy or restore your cluster quickly.

[![Build, Test and Publish](https://github.com/mattmattox/kubebackup/actions/workflows/build-and-publish.yml/badge.svg)](https://github.com/mattmattox/kubebackup/actions/workflows/build-and-publish.yml)  
[![Go Report Card](https://goreportcard.com/badge/github.com/mattmattox/kubebackup)](https://goreportcard.com/report/github.com/mattmattox/kubebackup)  
[![Docker Pulls](https://img.shields.io/docker/pulls/cube8021/kubebackup.svg)](https://hub.docker.com/r/cube8021/kubebackup)  
[![GitHub release (latest by date)](https://img.shields.io/github/v/release/mattmattox/kubebackup)](https://github.com/mattmattox/kubebackup/releases)  
[![License](https://img.shields.io/github/license/mattmattox/kubebackup)](https://github.com/mattmattox/kubebackup/blob/master/LICENSE)  

<!--more-->

## What is KubeBackup?

KubeBackup automates the process of **backing up your Kubernetes cluster** by accessing the **Kubernetes API** to export YAML files for every cluster and namespace resource. These backups are **compressed and uploaded to an S3 bucket**, making it easy to restore or redeploy your environment in case of an issue.

---

## How KubeBackup Works

- **YAML Export**: The tool connects to your cluster using in-cluster credentials or a provided kubeconfig file.
- **Directory Structure**:  
  - Namespace-scoped objects: `namespace-scoped/<namespace>/<object>`  
  - Cluster-scoped objects: `cluster-scoped/<object>`
- **S3 Upload**: All exported YAML files are compressed and uploaded to your **S3 bucket** for safekeeping.

This ensures that you have a complete, well-organized backup of all Kubernetes objects.

---

## Installation and Setup  

To install or upgrade **KubeBackup**, use the **Helm chart**:

```bash
helm repo add SupportTools https://charts.support.tools
helm repo update
helm upgrade --install kubebackup SupportTools/kubebackup \
  --set s3.region="us-east-2" \
  --set s3.bucket="my-bucket" \
  --set s3.folder="my-cluster" \
  --set s3.accessKey="S3_ACCESS_KEY_GOES_HERE" \
  --set s3.secretKey="S3_SECRET_KEY_GOES_HERE"
```

This command deploys a **KubeBackup pod** that connects to the Kubernetes API, exports YAML files, and uploads them to the specified **S3 bucket**.

---

## Configuration Options

| Parameter         | Description         | Default             |
|------------------|---------------------|---------------------|
| `image.repository` | Image repository | `cube8021/kubebackup` |
| `image.tag`        | Image tag        | `v1.1.0`            |
| `image.pullPolicy` | Image pull policy | `IfNotPresent`      |
| `s3.region`        | AWS Region       | `us-east-2`         |
| `s3.bucket`        | S3 Bucket        | `kubebackup`        |

These options give you flexibility in configuring the backup process to match your environment.

---

## Building KubeBackup from Source

If you prefer to build **KubeBackup** from source, ensure that **Go** and **Docker** are installed. Then, run the following commands:

```bash
git clone https://github.com/mattmattox/kubebackup
cd kubebackup
make build
```

This will create the KubeBackup binary, ready to be deployed.

---

## Why Use KubeBackup?

1. **Automated Backups**: Ensure backups run regularly with minimal manual intervention.
2. **Off-Cluster Storage**: Upload backups to **S3** to protect against cluster failures.
3. **Quick Restores**: Use YAML exports to redeploy resources quickly.
4. **Structured Data**: Organizes backups by **namespace** and **cluster scope** for easy management.
5. **Open Source**: KubeBackup is **open-source** and **community-driven**, ensuring ongoing support and updates.
6. **Object Restoration**: Restore individual objects or entire namespaces with ease without needing to restore the entire cluster.

---

## Best Practices

1. **Automate Backups**: Use **cron jobs** or automation pipelines to schedule regular backups.
2. **Encrypt Data**: Secure sensitive backups with encryption tools.
3. **Test Restores**: Regularly verify that your backups can be restored successfully.
4. **Monitor Backups**: Use tools like **Prometheus** to track backup success rates and detect issues.

---

## Conclusion

KubeBackup is an essential tool for maintaining **disaster recovery readiness** in Kubernetes environments. With automated YAML exports and seamless S3 uploads, KubeBackup ensures that you’re always prepared for potential failures. Install it today using Helm and start safeguarding your cluster with reliable backups.
