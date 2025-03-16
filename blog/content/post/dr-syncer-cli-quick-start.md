---
title: "DR-Syncer CLI Quick Start: Kubernetes Disaster Recovery Made Simple"
date: 2025-03-13T01:10:00-05:00
draft: false
tags: ["Kubernetes", "CLI", "DevOps", "DR-Syncer", "Disaster Recovery"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to getting started with the DR-Syncer CLI tool for Kubernetes disaster recovery operations."
more_link: "yes"
url: "/dr-syncer-cli-quick-start/"
---

The DR-Syncer CLI provides a powerful yet simple way to perform disaster recovery operations between Kubernetes clusters without needing to deploy any additional components.

<!--more-->

# DR-Syncer CLI Quick Start Guide

## Overview

The DR-Syncer CLI is a standalone tool that allows you to perform disaster recovery operations directly from your command line. Unlike the controller-based approach, the CLI doesn't require deploying anything to your clusters, making it perfect for:

- Manual DR operations
- Testing and validation
- One-off synchronization tasks
- Organizations that prefer not to deploy additional controllers

This quick start guide will help you get up and running with the DR-Syncer CLI in minutes.

## Installation

### Building from Source

1. Clone the repository:
   ```bash
   git clone https://github.com/supporttools/dr-syncer.git
   cd dr-syncer
   ```

2. Build the CLI binary:
   ```bash
   make build
   ```

3. The CLI binary will be available at `bin/dr-syncer-cli`

## Basic Command Structure

The DR-Syncer CLI uses a straightforward command structure:

```bash
bin/dr-syncer-cli \
  --source-kubeconfig=/path/to/source/kubeconfig \
  --dest-kubeconfig=/path/to/destination/kubeconfig \
  --source-namespace=my-namespace \
  --dest-namespace=my-namespace-dr \
  --mode=<Mode>
```

Key parameters:
- `--source-kubeconfig`: Path to the kubeconfig file for your source (primary) cluster
- `--dest-kubeconfig`: Path to the kubeconfig file for your destination (DR) cluster
- `--source-namespace`: The namespace in the source cluster to replicate from
- `--dest-namespace`: The namespace in the destination cluster to replicate to
- `--mode`: Operation mode (Stage, Cutover, or Failback)

## Operation Modes

The CLI supports three primary operation modes, each designed for a specific stage of the DR lifecycle:

### 1. Stage Mode

Stage mode prepares your DR environment by synchronizing resources from the source to the destination cluster, while scaling down deployments to 0 replicas in the destination.

```bash
bin/dr-syncer-cli \
  --source-kubeconfig=/path/to/source/kubeconfig \
  --dest-kubeconfig=/path/to/destination/kubeconfig \
  --source-namespace=my-namespace \
  --dest-namespace=my-namespace-dr \
  --mode=Stage
```

Use Stage mode for:
- Initial DR environment setup
- Regular updates to keep DR in sync with production
- Testing DR readiness without activating workloads

### 2. Cutover Mode

Cutover mode activates your DR environment by synchronizing resources, scaling down source deployments, and scaling up destination deployments.

```bash
bin/dr-syncer-cli \
  --source-kubeconfig=/path/to/source/kubeconfig \
  --dest-kubeconfig=/path/to/destination/kubeconfig \
  --source-namespace=my-namespace \
  --dest-namespace=my-namespace-dr \
  --mode=Cutover
```

Use Cutover mode when:
- You need to activate your DR environment
- You're performing a planned failover to DR
- You're responding to an incident affecting your primary environment

### 3. Failback Mode

Failback mode reverses the cutover process, scaling down destination deployments and scaling up source deployments.

```bash
bin/dr-syncer-cli \
  --source-kubeconfig=/path/to/source/kubeconfig \
  --dest-kubeconfig=/path/to/destination/kubeconfig \
  --source-namespace=my-namespace \
  --dest-namespace=my-namespace-dr \
  --mode=Failback
```

Use Failback mode when:
- You're returning operations to the primary environment
- The primary environment has been restored after an incident
- You're completing DR testing and returning to normal operations

## Advanced Options

### Resource Filtering

You can specify which resource types to include in the synchronization:

```bash
bin/dr-syncer-cli \
  --source-kubeconfig=/path/to/source/kubeconfig \
  --dest-kubeconfig=/path/to/destination/kubeconfig \
  --source-namespace=my-namespace \
  --dest-namespace=my-namespace-dr \
  --mode=Stage \
  --resource-types=configmaps,secrets,deployments
```

### Including Custom Resources

For environments with custom resources:

```bash
bin/dr-syncer-cli \
  --source-kubeconfig=/path/to/source/kubeconfig \
  --dest-kubeconfig=/path/to/destination/kubeconfig \
  --source-namespace=my-namespace \
  --dest-namespace=my-namespace-dr \
  --mode=Stage \
  --include-custom-resources=true
```

### PVC Data Migration

To synchronize data stored in Persistent Volume Claims:

```bash
bin/dr-syncer-cli \
  --source-kubeconfig=/path/to/source/kubeconfig \
  --dest-kubeconfig=/path/to/destination/kubeconfig \
  --source-namespace=my-namespace \
  --dest-namespace=my-namespace-dr \
  --mode=Stage \
  --migrate-pvc-data=true
```

### Storage Class Mapping

For environments with different storage classes between clusters:

```bash
bin/dr-syncer-cli \
  --source-kubeconfig=/path/to/source/kubeconfig \
  --dest-kubeconfig=/path/to/destination/kubeconfig \
  --source-namespace=my-namespace \
  --dest-namespace=my-namespace-dr \
  --mode=Stage \
  --storage-class-mapping="source-storage-class=destination-storage-class"
```

## Troubleshooting Tips

### Checking Operation Status

The CLI provides verbose output to help track the synchronization process. If you encounter issues:

1. Use the `--verbose` flag for detailed logging:
   ```bash
   bin/dr-syncer-cli --verbose ...
   ```

2. Check resource synchronization status in both clusters:
   ```bash
   kubectl get all -n my-namespace
   kubectl get all -n my-namespace-dr --context=dr-cluster
   ```

### Common Issues

1. **Authentication Issues**: Ensure your kubeconfig files have valid credentials for both clusters
2. **Permission Issues**: The user in your kubeconfig must have appropriate permissions in both clusters
3. **Resource Conflicts**: Pre-existing resources in the destination may cause conflicts

## Practical Examples

### Disaster Recovery Testing

Test your DR plan without disrupting production:

```bash
# 1. Stage resources to DR
bin/dr-syncer-cli \
  --source-kubeconfig=prod.kubeconfig \
  --dest-kubeconfig=dr.kubeconfig \
  --source-namespace=application \
  --dest-namespace=application-dr \
  --mode=Stage

# 2. Verify resources are created but not running
kubectl get all -n application-dr --context=dr-cluster

# 3. Perform test cutover
bin/dr-syncer-cli \
  --source-kubeconfig=prod.kubeconfig \
  --dest-kubeconfig=dr.kubeconfig \
  --source-namespace=application \
  --dest-namespace=application-dr \
  --mode=Cutover

# 4. Test functionality in DR environment

# 5. Failback to complete test
bin/dr-syncer-cli \
  --source-kubeconfig=prod.kubeconfig \
  --dest-kubeconfig=dr.kubeconfig \
  --source-namespace=application \
  --dest-namespace=application-dr \
  --mode=Failback
```

## Conclusion

The DR-Syncer CLI offers a flexible, lightweight approach to Kubernetes disaster recovery operations. Whether you're setting up a new DR environment, testing your recovery processes, or performing an actual failover, the CLI provides the tools you need to manage the process efficiently.

For more detailed information, refer to the [complete CLI documentation](https://supporttools.github.io/dr-syncer/docs/cli-usage) or check out the [GitHub repository](https://github.com/supporttools/dr-syncer).
