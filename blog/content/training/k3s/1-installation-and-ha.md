---
title: "K3s Installation and High Availability Setup"
date: 2025-01-01T00:00:00-05:00
draft: true
tags: ["K3s", "Kubernetes", "High Availability", "Installation"]
categories:
- K3s
- Training
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to install K3s and set up a highly available cluster"
more_link: "yes"
url: "/training/k3s/installation-and-ha/"
---

This guide walks through the process of installing K3s and setting up a highly available cluster for production environments.

<!--more-->

# [Prerequisites](#prerequisites)

Before starting the installation:

1. **System Requirements**
   - Linux 64-bit (x86_64, armv8, s390x)
   - 512MB RAM (minimum)
   - 1 CPU core (minimum)
   - `/var/lib` with sufficient storage

2. **Network Requirements**
   - Port 6443 for Kubernetes API server
   - Port 6444 for K3s supervisor
   - Port 8472 UDP for VXLAN (Flannel VXLAN)
   - Port 10250 for kubelet metrics

# [Single Node Installation](#single-node)

## Basic Installation
```bash
# Install K3s server
curl -sfL https://get.k3s.io | sh -

# Check status
sudo systemctl status k3s

# Get node status
sudo kubectl get nodes
```

## Configuration
The configuration file is located at `/etc/rancher/k3s/config.yaml`:
```yaml
write-kubeconfig-mode: "0644"
tls-san:
  - "my-kubernetes-domain.com"
node-label:
  - "environment=production"
node-taint:
  - "key1=value1:NoExecute"
```

# [High Availability Setup](#ha-setup)

## Architecture Overview
![K3s HA Architecture](/training/k3s/k3s-architecture-ha-embedded.svg)

The HA setup consists of:
- Multiple server nodes (control plane)
- External datastore (etcd or external DB)
- Worker nodes
- Built-in load balancer

## External Datastore Setup

### Using Embedded etcd
```bash
# First server node
curl -sfL https://get.k3s.io | sh -s - server \
  --cluster-init \
  --tls-san my-kubernetes-domain.com

# Additional server nodes
curl -sfL https://get.k3s.io | sh -s - server \
  --server https://first-server:6443 \
  --token YOUR_TOKEN \
  --tls-san my-kubernetes-domain.com
```

### Using External Database
```bash
# Create database
export K3S_DATASTORE_ENDPOINT='mysql://username:password@tcp(hostname:3306)/database-name'

# Install first server
curl -sfL https://get.k3s.io | sh -s - server \
  --datastore-endpoint="$K3S_DATASTORE_ENDPOINT"

# Additional servers
curl -sfL https://get.k3s.io | sh -s - server \
  --datastore-endpoint="$K3S_DATASTORE_ENDPOINT"
```

# [Adding Worker Nodes](#worker-nodes)

## Worker Node Installation
```bash
# Get node token from server
sudo cat /var/lib/rancher/k3s/server/node-token

# Install worker node
curl -sfL https://get.k3s.io | K3S_URL=https://server:6443 \
  K3S_TOKEN=mynodetoken sh -
```

## Worker Node Configuration
```yaml
# /etc/rancher/k3s/config.yaml
node-label:
  - "node-role.kubernetes.io/worker=true"
  - "workload-type=general"
kubelet-arg:
  - "max-pods=110"
```

# [Load Balancer Configuration](#load-balancer)

## Built-in Load Balancer
The K3s built-in load balancer:
- Runs on each agent node
- Listens on 127.0.0.1:6443
- Provides automatic failover
- Maintains connection pool

## External Load Balancer (Optional)
Example NGINX configuration:
```nginx
stream {
    upstream k3s_servers {
        server 192.168.1.101:6443;
        server 192.168.1.102:6443;
        server 192.168.1.103:6443;
    }

    server {
        listen 6443;
        proxy_pass k3s_servers;
    }
}
```

# [Post-Installation Steps](#post-installation)

## Verify Installation
```bash
# Check nodes
kubectl get nodes -o wide

# Check pods
kubectl get pods -A

# Check etcd health (if using embedded etcd)
kubectl -n kube-system exec -it etcd-server-0 -- etcdctl endpoint health
```

## Security Configuration
1. **RBAC Setup**
   ```bash
   # Create admin role
   kubectl create clusterrolebinding admin-role \
     --clusterrole=cluster-admin \
     --user=admin-user
   ```

2. **Network Policies**
   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: default-deny
   spec:
     podSelector: {}
     policyTypes:
     - Ingress
     - Egress
   ```

# [Maintenance](#maintenance)

## Backup Procedures
```bash
# Backup etcd data
k3s etcd-snapshot save

# Backup configuration
tar -czf k3s-backup.tar.gz /var/lib/rancher/k3s
```

## Upgrading K3s
```bash
# Check current version
k3s --version

# Upgrade using installation script
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_CHANNEL=latest sh -
```

# [Troubleshooting](#troubleshooting)

## Common Issues

1. **Node Not Joining**
   - Check network connectivity
   - Verify node token
   - Check firewall rules

2. **etcd Issues**
   ```bash
   # Check etcd logs
   kubectl -n kube-system logs -l component=etcd
   ```

3. **Load Balancer Problems**
   ```bash
   # Check load balancer status
   systemctl status k3s
   journalctl -u k3s
   ```

# [Best Practices](#best-practices)

1. **Production Setup**
   - Use odd number of server nodes (3,5,7)
   - Configure external load balancer
   - Implement proper monitoring
   - Regular backups

2. **Security**
   - Enable network policies
   - Regular security updates
   - Proper RBAC configuration
   - TLS certificate management

3. **Performance**
   - Monitor resource usage
   - Proper node sizing
   - Regular maintenance
   - Load testing

For more detailed information, visit the [official K3s documentation](https://rancher.com/docs/k3s/latest/en/).
