title: "Deploying the DR-Syncer Controller: Automated Kubernetes Disaster Recovery"
date: 2025-03-13T01:20:00-05:00
draft: false
tags: ["Kubernetes", "Controller", "Operator", "DR-Syncer", "Disaster Recovery"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide for deploying and configuring the DR-Syncer controller for automated Kubernetes disaster recovery."
more_link: "yes"
url: "/deploying-dr-syncer-controller/"
---

The DR-Syncer controller provides a fully automated approach to Kubernetes disaster recovery through a Kubernetes-native operator model, enabling "set it and forget it" DR synchronization between clusters.

<!--more-->

# Deploying the DR-Syncer Controller

## Why Use the Controller Approach?

While the DR-Syncer CLI offers a manual, on-demand approach to disaster recovery operations, the controller provides continuous automation through the Kubernetes operator pattern:

- **Always-on Synchronization**: Automatically keeps your DR environment in sync
- **Kubernetes-native Configuration**: Uses Custom Resource Definitions (CRDs) for declarative configuration
- **Multiple Sync Modes**: Supports scheduled, continuous, and manual synchronization
- **GitOps Friendly**: CRDs can be managed through GitOps workflows
- **Comprehensive Status Reporting**: Built-in status tracking and metrics

The controller is ideal for organizations that:
- Need automated, hands-off DR synchronization
- Prefer a declarative Kubernetes-native approach
- Want to integrate DR into their existing automation workflows
- Require detailed visibility into synchronization status

## Installation

### Prerequisites

Before installing the DR-Syncer controller, ensure you have:

1. A Kubernetes cluster where the controller will run (typically your primary/production cluster)
2. One or more remote clusters for DR synchronization
3. Helm 3.x installed
4. Kubeconfig files with appropriate permissions for all clusters

### Installing with Helm

The recommended way to install the DR-Syncer controller is using Helm:

```bash
# Add the DR-Syncer Helm repository
helm repo add dr-syncer https://supporttools.github.io/dr-syncer/charts

# Update repositories
helm repo update

# Install DR-Syncer in its own namespace
helm install dr-syncer dr-syncer/dr-syncer \
  --namespace dr-syncer-system \
  --create-namespace
```

This installs the controller with default settings. For production environments, you may want to customize the installation:

```bash
# Install with custom values
helm install dr-syncer dr-syncer/dr-syncer \
  --namespace dr-syncer-system \
  --create-namespace \
  --set replicas=2 \
  --set resources.requests.memory=256Mi \
  --set resources.requests.cpu=100m
```

### Verifying the Installation

Check that the controller is running:

```bash
kubectl get pods -n dr-syncer-system
```

You should see the DR-Syncer controller pod running:

```
NAME                        READY   STATUS    RESTARTS   AGE
dr-syncer-7d54b8c65-zt9vw   1/1     Running   0          2m
```

## Configuration

The DR-Syncer controller uses three Custom Resource Definitions (CRDs) for configuration:

1. **RemoteCluster**: Defines the connection to a remote cluster
2. **NamespaceMapping**: Configures synchronization between namespaces
3. **ClusterMapping**: Defines relationships between clusters for multiple namespace mappings

### Connecting to Remote Clusters

First, create a Secret containing the kubeconfig for your remote cluster:

```bash
kubectl create secret generic dr-cluster-kubeconfig \
  --from-file=kubeconfig=/path/to/dr-cluster-kubeconfig \
  --namespace dr-syncer-system
```

Then create a RemoteCluster resource:

```yaml
apiVersion: dr-syncer.io/v1alpha1
kind: RemoteCluster
metadata:
  name: dr-cluster
  namespace: dr-syncer-system
spec:
  kubeconfigSecret: dr-cluster-kubeconfig
```

Apply with:

```bash
kubectl apply -f remote-cluster.yaml
```

### Configuring Namespace Synchronization

Create a NamespaceMapping resource to define what and how to synchronize:

```yaml
apiVersion: dr-syncer.io/v1alpha1
kind: NamespaceMapping
metadata:
  name: production-to-dr
  namespace: dr-syncer-system
spec:
  # Source and destination details
  sourceNamespace: production
  destinationNamespace: production-dr
  destinationCluster: dr-cluster
  
  # Resources to synchronize
  resourceTypes:
    - ConfigMap
    - Secret
    - Deployment
    - Service
    - Ingress
    - PersistentVolumeClaim
  
  # Synchronization mode
  syncMode: Scheduled
  schedule: "0 */6 * * *"  # Every 6 hours
  
  # Additional configuration
  deploymentConfig:
    scaleToZero: true  # Scale deployments to zero in DR
  
  serviceConfig:
    preserveClusterIP: false  # Don't preserve ClusterIP addresses
  
  ingressConfig:
    preserveAnnotations: true  # Keep ingress annotations
    preserveTLS: true  # Keep TLS configurations
```

Apply with:

```bash
kubectl apply -f namespace-mapping.yaml
```

### Understanding Synchronization Modes

The controller supports three synchronization modes:

1. **Manual**: Synchronize only when explicitly triggered
   ```yaml
   syncMode: Manual
   ```

2. **Scheduled**: Synchronize on a cron schedule
   ```yaml
   syncMode: Scheduled
   schedule: "0 */6 * * *"  # Every 6 hours
   ```

3. **Continuous**: Constantly monitor for changes and synchronize in near real-time
   ```yaml
   syncMode: Continuous
   ```

### Multi-Cluster Configuration with ClusterMapping

For organizations with multiple production and DR clusters, the ClusterMapping CRD provides a way to define relationships between clusters:

```yaml
apiVersion: dr-syncer.io/v1alpha1
kind: ClusterMapping
metadata:
  name: multi-region-dr
  namespace: dr-syncer-system
spec:
  sourceClusters:
    - name: us-east-prod
      kubeconfigSecret: us-east-prod-kubeconfig
    - name: us-west-prod
      kubeconfigSecret: us-west-prod-kubeconfig
  
  destinationClusters:
    - name: eu-central-dr
      kubeconfigSecret: eu-central-dr-kubeconfig
    - name: ap-southeast-dr
      kubeconfigSecret: ap-southeast-dr-kubeconfig
  
  mappings:
    - sourceCluster: us-east-prod
      destinationCluster: eu-central-dr
    - sourceCluster: us-west-prod
      destinationCluster: ap-southeast-dr
```

## Advanced Features

### Resource Filtering and Exclusion

You can exclude specific resources from synchronization using labels:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: sensitive-data
  namespace: production
  labels:
    dr-syncer.io/ignore: "true"  # This resource will not be synchronized
```

### Deployment Scale Override

By default, deployments are scaled to zero in DR clusters. You can override this behavior for specific deployments:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-service
  namespace: production
  labels:
    dr-syncer.io/scale-override: "true"  # This deployment will maintain its replicas
```

### PVC Data Synchronization

The controller can synchronize Persistent Volume Claim (PVC) data across clusters:

```yaml
apiVersion: dr-syncer.io/v1alpha1
kind: NamespaceMapping
metadata:
  name: production-to-dr
  namespace: dr-syncer-system
spec:
  # ... other fields
  pvcConfig:
    enableDataSync: true
    storageClassMapping:
      "production-storage": "dr-storage"
    accessModeMapping:
      "ReadWriteOnce": "ReadWriteOnce"
```

This feature deploys a DaemonSet agent on the DR cluster to handle data synchronization securely using SSH and rsync.

## Monitoring and Troubleshooting

### Checking Synchronization Status

Monitor the status of your synchronization:

```bash
kubectl get namespacemappings -n dr-syncer-system
```

For detailed status:

```bash
kubectl describe namespacemapping production-to-dr -n dr-syncer-system
```

The status section provides information about the last synchronization, any errors, and resource counts.

### Common Issues and Solutions

1. **Remote Cluster Connection Issues**

   If the controller can't connect to the remote cluster:
   
   ```bash
   kubectl describe remotecluster dr-cluster -n dr-syncer-system
   ```
   
   Check the status conditions for connection errors. Ensure the kubeconfig secret is correct and has the necessary permissions.

2. **Resource Synchronization Failures**

   For specific resource failures:
   
   ```bash
   kubectl describe namespacemapping production-to-dr -n dr-syncer-system
   ```
   
   Look at the `status.resourceStatus` section for details on failed resources.

3. **PVC Data Sync Issues**

   If PVC data isn't synchronizing:
   
   ```bash
   # Check agent deployment on the DR cluster
   kubectl get daemonset -n dr-syncer-system --context=dr-cluster
   
   # Check agent logs
   kubectl logs -n dr-syncer-system -l app=dr-syncer-agent --context=dr-cluster --tail=100
   ```

### Controller Logs

For detailed controller logs:

```bash
kubectl logs -n dr-syncer-system -l app=dr-syncer --tail=100
```

Remember to always use `--tail` flag to limit log output for better readability.

## Best Practices

1. **Start Small**
   
   Begin with a subset of namespaces and non-critical resources, then gradually expand coverage.

2. **Regular Testing**
   
   Periodically verify DR functionality by performing test cutovers and failbacks.

3. **Namespace Organization**
   
   Use consistent naming patterns for DR namespaces (e.g., adding `-dr` suffix).

4. **Resource Limits**
   
   Configure appropriate resource requests and limits for the controller to ensure stable operation.

5. **Monitoring Integration**
   
   The controller exposes Prometheus metrics - integrate with your monitoring system.

## Conclusion

The DR-Syncer controller provides a robust, automated approach to Kubernetes disaster recovery. By leveraging Kubernetes-native patterns and declarative configuration, it integrates seamlessly into your existing workflows while minimizing operational overhead.

Whether you're setting up a simple DR solution for a single application or a complex multi-cluster DR strategy, the controller offers the flexibility and reliability needed for enterprise disaster recovery planning.

For more information, refer to the [complete controller documentation](https://supporttools.github.io/dr-syncer/docs/controller-usage) or check out the [GitHub repository](https://github.com/supporttools/dr-syncer).
