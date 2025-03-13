---
title: "Migrating from RKE1 to RKE2 using YAML Export/Import"
date: 2025-03-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "RKE1", "RKE2", "Migration", "YAML"]
categories:
- Kubernetes
- Migration
author: "Matthew Mattox - mmattox@support.tools"
description: "A step-by-step guide to migrating workloads from RKE1 to RKE2 using YAML Export/Import."
more_link: "yes"
url: "/migrating-rke1-to-rke2-yaml/"
---

Migrating from **RKE1 to RKE2** can be done in multiple ways, and one of the simplest is **YAML Export/Import**. This method is ideal for **stateless workloads** where persistent storage migration is not required. It’s a fast and effective way to move Deployments, Services, ConfigMaps, and other Kubernetes resources with minimal dependencies.

<!--more-->

## When to Use YAML Export/Import
This method is best suited for:
- Stateless applications that do not require Persistent Volumes.
- Simple migrations with minimal infrastructure differences.
- Fast migrations where downtime is acceptable.
- Workloads that do not rely heavily on external dependencies.

## How It Works
The **YAML Export/Import** method involves manually extracting Kubernetes resources from the existing RKE1 cluster and applying them to the new RKE2 cluster.

### **Step 1: Export Workloads from RKE1**
Use the following script to extract all necessary resources from a namespace:
```bash
namespace="your-namespace"
objects="deployments services configmaps secrets ingress"

echo "Namespace: $namespace"
mkdir -p namespace/"$namespace"
for object in $objects
  do
    mkdir -p namespace/"$namespace"/"$object"
    echo "Object: $object"
    for item in `kubectl -n $namespace get $object -o name | awk -F '/' '{print $2}'`
    do
      echo "item: $item"
      kubectl -n $namespace get $object $item -o yaml > namespace/"$namespace"/"$object"/"$item".yaml
    done
  done
```
This script ensures that all specified resources in the namespace are exported to individual YAML files for easier organization and re-application.

### **Step 2: Modify YAML Files (If Needed)**
- Verify Kubernetes API versions for compatibility.
- Adjust namespace settings if moving workloads to a different namespace.
- Remove any `status` fields that may interfere with re-application.

### **Step 3: Import Workloads to RKE2**
Before applying the YAML files, clean them by removing unnecessary fields such as `uuid`, `resourceVersion`, `clusterID`, and `etcd` metadata. Use the following script:
```bash
for file in $(find namespace/your-namespace -type f -name "*.yaml")
do
  echo "Processing: $file"
  sed -i "/uuid:/d" $file
  sed -i "/resourceVersion:/d" $file
  sed -i "/clusterID:/d" $file
  sed -i "/etcd:/d" $file
  sed -i '/status:/,/^$/d' $file
  sed -i '/creationTimestamp:/d' $file
  sed -i '/selfLink:/d' $file
  sed -i '/generation:/d' $file
  sed -i '/managedFields:/,/^$/d' $file
  sed -i '/annotations:/,/^$/d' $file
  sed -i '/finalizers:/,/^$/d' $file
  sed -i '/ownerReferences:/,/^$/d' $file
  sed -i '/spec:/,$!d' $file
  echo "Cleaned: $file"
done
```
Once the YAML files are cleaned, apply them to the new RKE2 cluster:
```bash
kubectl apply -f namespace/your-namespace/
```
This will recreate the workloads and configurations in RKE2.

### **Step 4: Verify the Migration**
Check that all resources have been successfully applied and are running as expected:
```bash
kubectl get pods -A
kubectl get svc -A
kubectl get ingress -A
```
If any workloads are failing, check the logs and events for troubleshooting:
```bash
kubectl logs -f pod-name -n your-namespace
kubectl describe pod pod-name -n your-namespace
```

## Pros and Cons of YAML Export/Import
### **Pros:**
✅ **Simple and fast** – No additional tools required.
✅ **Easy rollback** – YAML files can be reapplied if needed.
✅ **Good for stateless applications** – Quick transition without complex dependencies.

### **Cons:**
❌ **No Persistent Volume (PV) migration** – Storage must be handled separately.
❌ **Manual process** – Risk of human error when handling YAML files.
❌ **Limited suitability for stateful applications** – Not ideal for database workloads.

## Best Practices
- **Back up existing workloads** before migration.
- **Use GitOps (ArgoCD/Flux)** to store YAML files and apply them systematically.
- **Test in a staging environment** before deploying to production.
- **Validate dependencies** (DNS, Ingress, RBAC policies) before migration.

## Conclusion
YAML Export/Import is a quick and effective method for migrating **stateless workloads** from RKE1 to RKE2. While it may not be ideal for stateful applications, it’s a straightforward way to get up and running on RKE2 with minimal effort.

Stay tuned for upcoming blog posts covering **other migration strategies** like **DR-Syncer, Velero/CloudCasa, and Redeploy (GitOps).**

For more Kubernetes migration insights, visit **[support.tools](https://support.tools)**!
