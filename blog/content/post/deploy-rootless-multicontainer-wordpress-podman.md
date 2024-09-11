---
title: "Deploying a Rootless Multi-Container WordPress Application with Podman"  
date: 2024-09-04T19:26:00-05:00  
draft: false  
tags: ["Podman", "WordPress", "Containers", "Rootless", "Kubernetes"]  
categories:  
- Podman  
- WordPress  
- Containers  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to deploy a rootless multi-container WordPress application using Podman, including persistent storage and SELinux configuration."  
more_link: "yes"  
url: "/deploy-rootless-multicontainer-wordpress-podman/"  
---

In this post, we will explore how to deploy a WordPress application using Podman in a rootless environment. This setup includes persistent storage for the database and configuring environment variables.

<!--more-->

### The Plan

We've already covered most of the Podman basics in a previous post. Now, we'll focus on deploying a multi-container WordPress application, setting up persistent storage, and managing environment variables. This deployment will be done entirely with rootless containers.

### Podman Task 5: Deploy a WordPress Application

We will deploy a rootless WordPress application that meets the following requirements:

- Containers must run as a non-root user.
- Use a persistent MySQL database storage.
- Apply correct SELinux contexts for container access.
- Deploy WordPress and MySQL containers under a single Podman pod.

### Steps for Deployment

#### 1. Create a Directory for Persistent Storage

Start by creating a directory for the MySQL database data:

```bash
mkdir -p $HOME/wpdb_podman
```

#### 2. Apply the Correct SELinux Context

Check the current SELinux context:

```bash
ls -Zd $HOME/wpdb_podman
```

Next, set the proper SELinux context for containers to access the directory:

```bash
sudo semanage fcontext -a -t container_file_t "$HOME/wpdb_podman(/.*)?"
sudo restorecon -Rv $HOME/wpdb_podman
```

Verify that the SELinux context has been correctly applied:

```bash
ls -Zd $HOME/wpdb_podman
```

#### 3. Adjust UID/GID for Rootless Containers

Since we're using rootless Podman containers, we must adjust the UID and GID for the volume directory to match MySQL's container user:

```bash
podman unshare chown -R 27:27 $HOME/wpdb_podman
```

#### 4. Create the Pod and MySQL Container

Create a new Podman pod named `wp` with port forwarding:

```bash
podman pod create --name wp -p 8080:80
```

Run the MySQL container within the pod and use persistent storage:

```bash
podman run -d \
  --pod wp \
  --name wpdb \
  -e MYSQL_ROOT_PASSWORD="ex180AdminPassword" \
  -e MYSQL_USER="wpuser" \
  -e MYSQL_PASSWORD="ex180UserPassword" \
  -e MYSQL_DATABASE="wordpress" \
  --volume $HOME/wpdb_podman:/var/lib/mysql/data \
  registry.access.redhat.com/rhscl/mysql-57-rhel7:5.7-49
```

#### 5. Verify the MySQL Database

Ensure the MySQL container is running and verify that the data directory has been populated:

```bash
podman logs --tail=1 wpdb
ls -ln $HOME/wpdb_podman/
```

#### 6. Deploy the WordPress Container

Run the WordPress container in the same pod:

```bash
podman run -d \
  --pod wp \
  --name wpapp \
  -e WORDPRESS_DB_HOST="127.0.0.1" \
  -e WORDPRESS_DB_USER="wpuser" \
  -e WORDPRESS_DB_PASSWORD="ex180UserPassword" \
  -e WORDPRESS_DB_NAME="wordpress" \
  docker.io/library/wordpress:latest
```

#### 7. Verify the Deployment

Check that both containers are running inside the pod:

```bash
podman ps
podman pod ps
```

Use `curl` to access the WordPress website:

```bash
curl -L http://127.0.0.1:8080
```

### Final Thoughts

Using Podman, we’ve successfully deployed a rootless, multi-container WordPress application with persistent storage and SELinux configuration. This setup is lightweight and fully open-source.

## [Deploying a Rootless Multi-Container WordPress Application with Podman](#deploying-a-rootless-multi-container-wordpress-application-with-podman)

Follow this guide to deploy a WordPress application in a secure, rootless environment using Podman.
