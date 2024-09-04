---
title: "How to Mount an AWS S3 Bucket Locally on Linux Using Mountpoint"
date: 2024-09-04T19:26:00-05:00
draft: false
tags: ["AWS", "S3", "Mountpoint", "Linux", "cloud storage"]
categories:
- AWS
- Linux
- Cloud Storage
author: "Matthew Mattox - mmattox@support.tools."
description: "A guide on mounting an AWS S3 bucket as a local file system on Linux using Mountpoint."
more_link: "yes"
url: "/mount-aws-s3-bucket-linux-mountpoint/"
---

Mountpoint for AWS S3 is a high-performance, open-source file client that lets you mount an Amazon S3 bucket as a local file system on Linux. This guide walks you through the steps to install and configure Mountpoint, enabling seamless access to your S3 bucket as if it were part of your local storage.

<!--more-->

The day has finally arrived! Mountpoint for Amazon S3 is now generally available, a feature long awaited by cloud enthusiasts and developers alike.

### What is Mountpoint for AWS S3?

Mountpoint for AWS S3 is an open-source file client that allows you to mount an Amazon S3 bucket as a local file system on Linux. By translating file operations into S3 object API calls, Mountpoint provides access to S3’s elastic storage and throughput through a file-based interface.

### Installation

To get started, install Mountpoint on your Linux system.

#### Debian-based systems

```bash
MOUNTPOINT_VERSION="1.0.0"
curl -fsSL -o mount-s3.deb "https://s3.amazonaws.com/mountpoint-s3-release/${MOUNTPOINT_VERSION}/x86_64/mount-s3-${MOUNTPOINT_VERSION}-x86_64.deb"
sudo apt install ./mount-s3.deb
mount-s3 --version
```

#### RHEL-based systems

```bash
MOUNTPOINT_VERSION="1.0.0"
curl -fsSL -o mount-s3.rpm "https://s3.amazonaws.com/mountpoint-s3-release/${MOUNTPOINT_VERSION}/x86_64/mount-s3-${MOUNTPOINT_VERSION}-x86_64.rpm"
sudo yum install ./mount-s3.rpm
mount-s3 --version
```

### Configuration

Before you can use Mountpoint for S3, you need valid AWS credentials that have permissions for the S3 bucket you want to access. You can configure these credentials in `~/.aws/credentials`.

After configuring your credentials, create a directory to act as the mount point for your bucket:

```bash
mkdir ~/mnt
```

Now, mount your S3 bucket (in this case, named `my-s3-bucket-name`) by specifying the AWS profile and region you want to use:

```bash
mount-s3 --profile default --region eu-west-2 my-s3-bucket-name ~/mnt
```

### Unmounting the S3 Bucket

When you're done working with the S3 bucket and want to unmount it, simply use the following command:

```bash
umount ~/mnt
```

### Final Thoughts

Mountpoint for Amazon S3 is an exciting new tool, offering seamless access to S3 buckets as local file systems. By leveraging the power of Amazon S3 and making it accessible with familiar file operations, it’s a game-changer for anyone working with cloud storage.
