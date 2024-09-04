---
title: "Rsync: Backup Tool"  
date: 2024-09-04T19:26:00-05:00  
draft: false  
tags: ["Rsync", "Backup", "Linux", "SSH", "Cron"]  
categories:  
- Linux  
- Backup  
- Tools  
author: "Matthew Mattox - mmattox@support.tools."  
description: "A guide to using Rsync for file backups and remote synchronization on Linux."  
more_link: "yes"  
url: "/rsync-backup-tool/"  
---

Rsync is a powerful command-line tool used in Linux for efficient file synchronization and data transfer. It minimizes data transfer by only copying file differences, making it ideal for backups and remote synchronization.

<!--more-->

### Introduction

Rsync is widely used for backups because of its ability to perform full and incremental backups, preserve file permissions, and automate the backup process. In this guide, we’ll walk through setting up Rsync for local and remote backups, and even automate the process using `cron`.

### Lab Setup

I have set up two RedHat VMs on VMware Workstation Pro 17, using NAT networking with an IP range of `10.10.10.0/24`. However, you can use any cloud provider, VirtualBox, or other virtualization tools.

First, let’s update the system and install Rsync:

```bash
sudo yum update -y
sudo yum install rsync -y
```

If you are using Ubuntu, you can use `apt` or `apt-get` for installation.

### Local Backup

To create a local backup, we’ll start by creating a folder on **Server A**, populating it with files, and then backing them up to a different directory.

#### Syntax for Local Backup

```bash
sudo rsync -avz /path/to/source/ /path/to/destination/
```

Explanation of options:

- `-a`: Archive mode preserves file permissions, timestamps, and symbolic links.
- `-v`: Verbose mode for detailed output.
- `-z`: Compression to improve transfer speed.
- `--progress`: Displays transfer progress.

Make sure the source path ends with a `/` to sync the contents of the directory instead of the directory itself.

After running the command, verify that the files have been copied to the destination folder.

### Backup Over the Network

Now, let’s back up the folder from **Server A** to a remote **Backup Server** using the Rsync command over the network.

```bash
sudo rsync -avz important_Files/ Test@10.10.10.133:~/Backup
```

This command transfers all files and subdirectories from the source directory to the target location. The `Backup` folder on the remote server will contain the contents of the `important_Files` directory.

### Automating Backups with Cron

To automate the backup process, we’ll set up a scheduled job using `cron`. First, you need to configure SSH key-based authentication between **Server A** and the remote **Backup Server** to allow passwordless logins.

#### SSH Setup

1. Generate an SSH key pair using `ssh-keygen`.
2. Copy the public key to the remote server using `ssh-copy-id`.
3. Test the SSH connection to verify passwordless login.

#### Setting Up Cron Job

Edit the crontab using `crontab -e` and add the following line to schedule a backup every midnight:

```bash
0 0 * * * rsync -avz -e "ssh" important_Files/ Test@10.10.10.133:~/Backup
```

This cron job will run Rsync every night at midnight, using SSH for secure connections, and automatically back up the folder to the remote server.

### Final Thoughts

Rsync is a versatile and efficient tool for backing up data locally and over the network. By integrating SSH for secure transfers and cron for automation, you can create a robust and reliable backup solution.

Happy learning and exploring!
