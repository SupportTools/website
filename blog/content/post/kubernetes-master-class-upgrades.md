---
title: "Kubernetes Master Class: A Seamless Approach to Rancher & Kubernetes Upgrades"
date: 2024-10-15T17:30:00-05:00
draft: false
tags: ["Kubernetes", "Rancher", "RKE1", "RKE2", "Backup", "Upgrades"]
categories:
- Kubernetes
- Rancher
author: "Matthew Mattox - mmattox@support.tools"
description: "A modern guide with detailed rules, backup strategies, and best practices for Rancher and Kubernetes upgrades."
more_link: "yes"
url: "/kubernetes-master-class-upgrades/"
---

## Kubernetes Master Class: A Seamless Approach to Rancher & Kubernetes Upgrades

Upgrading your **Rancher** and **Kubernetes clusters** requires a strategic approach to minimize downtime and ensure seamless operation. This guide covers **rules**, **backup operations**, **planning steps**, and **upgrade procedures** for Rancher and Kubernetes environments using **RKE1** and **RKE2**.

---

## High-Level Rules for Upgrades

0. **Create an upgrade plan**
   - Using the rule listed below, create a plan for all of your upgrades and follow it.
   - You might need to do multiple upgrades to get to the latest version.
   - Please use Rancher Upgrade Tool to help you pick the right version(s) to upgrade to. [Rancher Upgrade Tool](https://rancher.com/docs/rancher/v2.x/en/upgrades/tools/)

1. **Don’t Rush Upgrades:**  
   - Allow at least **24 hours** between upgrades to ensure the stability of each component.
   - Give yourself plenty of time for backups, testing, monitoring, and rollback. I recommend at least 4hr change window for each upgrade.

2. **Don’t Stack Upgrades:**  
   - Avoid upgrading Rancher, Kubernetes, and Docker/Containerd in one session to reduce risk. Perform them **sequentially**.

3. **Backups Are Mandatory:**  
   - Take **ETCD snapshots** and use the **Rancher Backup Operator** to ensure quick recovery in case of failure.

4. **Upgrade Order:**  
   - Follow the sequence: **Rancher → Kubernetes → Docker/Containerd → Operating System**.

5. **Pause CI/CD Pipelines:**  
   - Halt pipelines using the Rancher API to prevent conflicts during upgrades.

6. **Test in Non-Production Environments:**  
   - Always validate upgrades in a **lab environment** before deploying to production.

7. **Review Release Notes and Support Matrix:**  
   - Check the **Rancher release notes** and **Kubernetes support matrix** to avoid issues with version incompatibilities.

8. **Monitor and Verify:**
    - Continuously monitor the health of nodes and pods after each upgrade to ensure everything is running smoothly.

---

## Planning Your Upgrade

### 1. **Backup Plan**  

- Take **ETCD snapshots** and **Rancher backups** before starting any upgrades.  

### 2. **Prepare a Change Control Plan**  

- **Scheduled Windows:**  
  - **Rancher upgrade:** 30 minutes (+30 minutes for rollback)  
  - **Kubernetes upgrade:** 60 minutes (or longer for large clusters)  
- **Effect and Impact:**  
  - **Rancher upgrades:** Only management functions are affected; running workloads remain unaffected.  
  - **Kubernetes upgrades:** May cause **short network blips** as ingress controllers restart.

### 3. **Maintenance Window Recommendations**  

- **Rancher Upgrade:** No strict window, but pause CI/CD pipelines.  
- **Kubernetes Local Cluster:** Prefer **quiet hours** to minimize disruptions.  
- **Downstream Clusters:** Use a **maintenance window** to avoid impact on production workloads.

---

## Rancher Upgrade Procedure

### Rancher Backup Operator: The Key to Seamless Upgrades  

The **Rancher Backup Operator** automates backup and restore operations, ensuring you can recover quickly in case of a failed upgrade.

#### Install the Rancher Backup Operator  

1. **Add the Backup Helm Repository:**

   ```bash
   helm repo add rancher-backup https://charts.rancher.io
   helm repo update
   ```

2. **Install the Backup Operator:**

   ```bash
   helm install rancher-backup rancher-backup/rancher-backup \
   --namespace cattle-resources-system --create-namespace
   ```

3. **Verify Installation:**

   ```bash
   kubectl get pods -n cattle-resources-system
   ```

#### Step 1: Backup Rancher with the Backup Operator  

1. **Create a Backup Resource:**

   ```yaml
   apiVersion: resources.cattle.io/v1
   kind: Backup
   metadata:
     name: rancher-backup
     namespace: cattle-resources-system
   spec:
     storageLocation:
       s3:
         bucketName: rancher-backups
         folder: daily-backup
         endpoint: s3.amazonaws.com
         credentialSecretName: s3-credentials
   ```

2. **Create an S3 Secret for Backup Storage:**

   ```bash
   kubectl create secret generic s3-credentials \
   --namespace cattle-resources-system \
   --from-literal=accessKey=<your-access-key> \
   --from-literal=secretKey=<your-secret-key>
   ```

3. **Apply the Backup Resource:**

   ```bash
   kubectl apply -f rancher-backup.yaml
   ```

4. **Check Backup Status:**

   ```bash
   kubectl get backups -n cattle-resources-system
   ```

#### Step 2: Upgrade Rancher  

1. **Update Helm Repositories:**

   ```bash
   helm repo update
   helm fetch rancher-stable/rancher
   ```

2. **Upgrade Rancher with Helm:**

   ```bash
   helm upgrade --install rancher rancher-stable/rancher \
   --namespace cattle-system \
   --set hostname=rancher.example.com \
   --version 2.9.2
   ```

3. **Verify the Upgrade:**

   ```bash
   kubectl -n cattle-system rollout status deploy/rancher
   kubectl get pods -n cattle-system -o wide
   ```

---

## Kubernetes Upgrade Procedure (RKE1/RKE2)

### Step 1: Take an ETCD Snapshot  

- **RKE1:**

   ```bash
   rke etcd snapshot-save --config cluster.yaml --name pre-upgrade-$(date '+%Y%m%d%H%M%S')
   ```

- **RKE2:**

   ```bash
   etcdctl snapshot save /var/lib/rancher/etcd-snapshots/pre-upgrade-$(date '+%Y%m%d%H%M%S')
   ```

### Step 2: Update the Kubernetes Version  

Edit `cluster.yaml` (RKE1) or `config.yaml` (RKE2):

```yaml
kubernetes_version: "v1.28.0-rancher1-1"
```

### Step 3: Perform the Upgrade  

- **RKE1:**

   ```bash
   rke up --config cluster.yaml
   ```

- **RKE2:**

   ```bash
   rke2-upgrade --version v1.28.0
   ```

---

## Verifying and Rolling Back

### Verify the Upgrade  

Check the health of nodes and pods:

```bash
kubectl get nodes -o wide
kubectl get pods --all-namespaces -o wide | grep -v 'Running\|Completed'
```

### Roll Back with Rancher Backup Operator  

1. **Create a Restore Resource:**

   ```yaml
   apiVersion: resources.cattle.io/v1
   kind: Restore
   metadata:
     name: rancher-restore
     namespace: cattle-resources-system
   spec:
     backupName: rancher-backup
     storageLocation:
       s3:
         bucketName: rancher-backups
         folder: daily-backup
         endpoint: s3.amazonaws.com
         credentialSecretName: s3-credentials
   ```

2. **Apply the Restore Resource:**

   ```bash
   kubectl apply -f rancher-restore.yaml
   ```

3. **Monitor the Restore:**

   ```bash
   kubectl get restores -n cattle-resources-system
   ```

---

## Conclusion

Upgrading **Rancher** and **Kubernetes clusters** requires careful planning, regular backups, and thorough testing. Using the **Rancher Backup Operator** ensures fast recovery from failures. By following the outlined **rules, backup strategies, and upgrade procedures**, you can minimize disruptions and keep your clusters secure and stable.
