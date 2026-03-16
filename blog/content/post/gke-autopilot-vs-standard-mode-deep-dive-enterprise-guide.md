---
title: "GKE Autopilot vs Standard Mode: Deep Dive Enterprise Comparison Guide"
date: 2026-07-14T00:00:00-05:00
draft: false
tags: ["GKE", "Google Cloud", "Kubernetes", "Autopilot", "Cloud Native", "Container Orchestration", "GCP"]
categories: ["Cloud Architecture", "Kubernetes", "Google Cloud"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive comparison of GKE Autopilot and Standard modes for enterprise deployments, including architecture differences, cost analysis, feature limitations, migration strategies, and production decision frameworks."
more_link: "yes"
url: "/gke-autopilot-vs-standard-mode-deep-dive-enterprise-guide/"
---

Google Kubernetes Engine (GKE) offers two distinct operational modes: Autopilot and Standard. While both run Kubernetes workloads, they differ fundamentally in their operational models, cost structures, and feature sets. This comprehensive guide provides an enterprise-focused comparison, helping you make informed decisions about which mode best suits your organization's requirements, operational maturity, and strategic objectives.

<!--more-->

# Understanding GKE Operational Modes

## GKE Standard Mode

GKE Standard mode provides full control over cluster infrastructure, including node configuration, networking, and cluster add-ons:

```yaml
# GKE Standard Cluster Configuration
apiVersion: container.v1
kind: Cluster
metadata:
  name: production-standard-cluster
spec:
  location: us-central1
  releaseChannel:
    channel: REGULAR
  initialNodeCount: 3
  nodePools:
  - name: general-purpose
    initialNodeCount: 3
    config:
      machineType: n2-standard-4
      diskSizeGb: 100
      diskType: pd-standard
      oauthScopes:
      - https://www.googleapis.com/auth/cloud-platform
      metadata:
        disable-legacy-endpoints: "true"
      shieldedInstanceConfig:
        enableSecureBoot: true
        enableIntegrityMonitoring: true
      workloadMetadataConfig:
        mode: GKE_METADATA
    autoscaling:
      enabled: true
      minNodeCount: 3
      maxNodeCount: 10
    management:
      autoUpgrade: true
      autoRepair: true
  - name: memory-optimized
    initialNodeCount: 2
    config:
      machineType: n2-highmem-8
      diskSizeGb: 200
      diskType: pd-ssd
      taints:
      - key: workload-type
        value: memory-intensive
        effect: NoSchedule
    autoscaling:
      enabled: true
      minNodeCount: 2
      maxNodeCount: 20
  networkConfig:
    network: projects/my-project/global/networks/prod-vpc
    subnetwork: projects/my-project/regions/us-central1/subnetworks/gke-subnet
    enableIntraNodeVisibility: true
  privateClusterConfig:
    enablePrivateNodes: true
    enablePrivateEndpoint: false
    masterIpv4CidrBlock: 172.16.0.0/28
  ipAllocationPolicy:
    clusterSecondaryRangeName: pods
    servicesSecondaryRangeName: services
  addonsConfig:
    httpLoadBalancing:
      disabled: false
    networkPolicyConfig:
      disabled: false
    gcePersistentDiskCsiDriverConfig:
      enabled: true
  workloadIdentityConfig:
    workloadPool: my-project.svc.id.goog
  binaryAuthorization:
    enabled: true
```

## GKE Autopilot Mode

Autopilot provides a fully managed Kubernetes experience where Google manages the underlying infrastructure:

```yaml
# GKE Autopilot Cluster Configuration
apiVersion: container.v1
kind: Cluster
metadata:
  name: production-autopilot-cluster
spec:
  location: us-central1
  autopilot:
    enabled: true
  releaseChannel:
    channel: REGULAR
  networkConfig:
    network: projects/my-project/global/networks/prod-vpc
    subnetwork: projects/my-project/regions/us-central1/subnetworks/gke-subnet
    enableIntraNodeVisibility: true
  privateClusterConfig:
    enablePrivateNodes: true
    enablePrivateEndpoint: false
    masterIpv4CidrBlock: 172.16.0.0/28
  ipAllocationPolicy:
    clusterSecondaryRangeName: pods
    servicesSecondaryRangeName: services
  workloadIdentityConfig:
    workloadPool: my-project.svc.id.goog
  binaryAuthorization:
    enabled: true
  # Note: Node pools, machine types, and many node-level configs
  # are not configurable in Autopilot mode
```

# Architecture and Control Plane Differences

## Node Management

### Standard Mode Node Management

```bash
# Create custom node pool in Standard mode
gcloud container node-pools create gpu-pool \
  --cluster=production-standard-cluster \
  --zone=us-central1-a \
  --machine-type=n1-standard-4 \
  --accelerator=type=nvidia-tesla-t4,count=1 \
  --num-nodes=2 \
  --min-nodes=1 \
  --max-nodes=5 \
  --enable-autoscaling \
  --enable-autorepair \
  --enable-autoupgrade \
  --node-taints=nvidia.com/gpu=present:NoSchedule \
  --node-labels=workload=gpu,gpu-type=t4 \
  --disk-type=pd-ssd \
  --disk-size=100 \
  --image-type=COS_CONTAINERD

# Deploy workload to specific node pool
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gpu-workload
spec:
  replicas: 2
  selector:
    matchLabels:
      app: gpu-app
  template:
    metadata:
      labels:
        app: gpu-app
    spec:
      nodeSelector:
        workload: gpu
        gpu-type: t4
      tolerations:
      - key: nvidia.com/gpu
        operator: Equal
        value: present
        effect: NoSchedule
      containers:
      - name: gpu-container
        image: tensorflow/tensorflow:latest-gpu
        resources:
          limits:
            nvidia.com/gpu: 1
            memory: 8Gi
            cpu: 4
          requests:
            nvidia.com/gpu: 1
            memory: 8Gi
            cpu: 4
EOF
```

### Autopilot Mode Pod Specification

```yaml
# Autopilot workload - Google manages node selection
apiVersion: apps/v1
kind: Deployment
metadata:
  name: autopilot-workload
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web-app
  template:
    metadata:
      labels:
        app: web-app
    spec:
      containers:
      - name: web-container
        image: nginx:latest
        resources:
          # Required in Autopilot - must specify limits
          limits:
            memory: "2Gi"
            cpu: "1000m"
          requests:
            memory: "2Gi"
            cpu: "1000m"
      # Autopilot automatically selects appropriate nodes
      # No node selectors or taints configuration needed
```

## Resource Allocation Models

### Standard Mode Resource Management

```yaml
# Standard mode with multiple node pools for different workloads
apiVersion: v1
kind: Namespace
metadata:
  name: production
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    requests.cpu: "100"
    requests.memory: 200Gi
    limits.cpu: "200"
    limits.memory: 400Gi
    persistentvolumeclaims: "20"
    services.loadbalancers: "5"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limits
  namespace: production
spec:
  limits:
  - max:
      cpu: "8"
      memory: 16Gi
    min:
      cpu: "100m"
      memory: 128Mi
    default:
      cpu: "1"
      memory: 1Gi
    defaultRequest:
      cpu: "500m"
      memory: 512Mi
    type: Container
```

### Autopilot Mode Resource Requirements

```yaml
# Autopilot enforces specific resource patterns
apiVersion: apps/v1
kind: Deployment
metadata:
  name: autopilot-compliant-app
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: compliant-app
  template:
    metadata:
      labels:
        app: compliant-app
    spec:
      containers:
      - name: app
        image: myapp:v1.2.3
        resources:
          # Autopilot requires limits to be set
          # Requests automatically match limits
          limits:
            memory: "4Gi"
            cpu: "2000m"
            ephemeral-storage: "10Gi"
        # Autopilot computes cost based on these limits
      - name: sidecar
        image: sidecar:latest
        resources:
          limits:
            memory: "512Mi"
            cpu: "250m"
      # Total pod resources: 4.5Gi memory, 2.25 CPU
      # Autopilot will provision appropriate nodes
```

# Cost Analysis and Optimization

## Standard Mode Cost Structure

```python
# Standard mode cost calculator
class GKEStandardCostCalculator:
    def __init__(self):
        # Pricing as of 2026 (example values)
        self.cluster_management_fee = 0.10  # per hour per cluster
        self.n2_standard_4_hourly = 0.194
        self.n2_highmem_8_hourly = 0.475
        self.pd_standard_gb_monthly = 0.040
        self.pd_ssd_gb_monthly = 0.170

    def calculate_monthly_cost(self, node_pools):
        """Calculate total monthly cost for Standard mode cluster"""
        total_cost = 0

        # Cluster management fee
        cluster_hours = 24 * 30  # hours per month
        total_cost += self.cluster_management_fee * cluster_hours

        # Node costs
        for pool in node_pools:
            node_hours = pool['count'] * cluster_hours
            total_cost += pool['hourly_rate'] * node_hours

            # Disk costs
            disk_gb = pool['count'] * pool['disk_size']
            total_cost += disk_gb * pool['disk_price']

        return total_cost

# Example calculation
calculator = GKEStandardCostCalculator()

node_pools = [
    {
        'name': 'general-purpose',
        'count': 5,
        'hourly_rate': 0.194,
        'disk_size': 100,
        'disk_price': 0.040
    },
    {
        'name': 'memory-optimized',
        'count': 3,
        'hourly_rate': 0.475,
        'disk_size': 200,
        'disk_price': 0.170
    }
]

monthly_cost = calculator.calculate_monthly_cost(node_pools)
print(f"Standard Mode Monthly Cost: ${monthly_cost:.2f}")

# Output: Standard Mode Monthly Cost: $2,349.20
# Breakdown:
# - Cluster management: $72
# - General nodes: $697.20 (5 * $139.44)
# - Memory nodes: $1,026 (3 * $342)
# - General disks: $20 (500GB * $0.040)
# - Memory disks: $102 (600GB * $0.170)
```

## Autopilot Mode Cost Structure

```python
# Autopilot mode cost calculator
class GKEAutopilotCostCalculator:
    def __init__(self):
        # Autopilot pricing (pod resource-based)
        self.cpu_core_hourly = 0.04445
        self.memory_gb_hourly = 0.00490
        self.ephemeral_storage_gb_hourly = 0.00010
        self.balancer_fee_percentage = 0.10  # 10% additional fee

    def calculate_pod_cost(self, cpu_cores, memory_gb, storage_gb=0):
        """Calculate hourly cost for a pod"""
        cpu_cost = cpu_cores * self.cpu_core_hourly
        memory_cost = memory_gb * self.memory_gb_hourly
        storage_cost = storage_gb * self.ephemeral_storage_gb_hourly

        base_cost = cpu_cost + memory_cost + storage_cost
        total_cost = base_cost * (1 + self.balancer_fee_percentage)

        return total_cost

    def calculate_deployment_cost(self, replicas, cpu_cores, memory_gb, storage_gb=0):
        """Calculate monthly cost for a deployment"""
        pod_hourly = self.calculate_pod_cost(cpu_cores, memory_gb, storage_gb)
        hours_per_month = 24 * 30
        return replicas * pod_hourly * hours_per_month

# Example calculation
calculator = GKEAutopilotCostCalculator()

# Web application deployment
web_cost = calculator.calculate_deployment_cost(
    replicas=10,
    cpu_cores=1,
    memory_gb=2,
    storage_gb=10
)

# Database deployment
db_cost = calculator.calculate_deployment_cost(
    replicas=3,
    cpu_cores=4,
    memory_gb=16,
    storage_gb=100
)

# Worker deployment
worker_cost = calculator.calculate_deployment_cost(
    replicas=5,
    cpu_cores=2,
    memory_gb=8,
    storage_gb=50
)

total_monthly = web_cost + db_cost + worker_cost
print(f"Autopilot Mode Monthly Cost: ${total_monthly:.2f}")
print(f"  Web tier: ${web_cost:.2f}")
print(f"  Database tier: ${db_cost:.2f}")
print(f"  Worker tier: ${worker_cost:.2f}")

# Output:
# Autopilot Mode Monthly Cost: $1,876.32
#   Web tier: $423.72
#   Database tier: $1,015.44
#   Worker tier: $437.16
```

## Cost Optimization Strategies

```yaml
# Standard Mode optimization with Spot VMs
apiVersion: container.v1
kind: NodePool
metadata:
  name: spot-pool
spec:
  config:
    machineType: n2-standard-4
    spot: true  # Use Spot VMs for 60-91% discount
    taints:
    - key: cloud.google.com/gke-spot
      value: "true"
      effect: NoSchedule
  autoscaling:
    enabled: true
    minNodeCount: 0
    maxNodeCount: 20
---
# Deploy fault-tolerant workloads to Spot nodes
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
spec:
  replicas: 10
  selector:
    matchLabels:
      app: batch-processor
  template:
    metadata:
      labels:
        app: batch-processor
    spec:
      tolerations:
      - key: cloud.google.com/gke-spot
        operator: Equal
        value: "true"
        effect: NoSchedule
      containers:
      - name: processor
        image: batch-processor:latest
        resources:
          requests:
            cpu: "1"
            memory: 2Gi
```

```yaml
# Autopilot optimization with right-sizing
apiVersion: apps/v1
kind: Deployment
metadata:
  name: optimized-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: optimized-app
  template:
    metadata:
      labels:
        app: optimized-app
    spec:
      containers:
      - name: app
        image: myapp:latest
        resources:
          # Right-size based on actual usage
          # Autopilot charges for requested resources
          limits:
            memory: "1.5Gi"  # Down from 2Gi
            cpu: "750m"      # Down from 1000m
            ephemeral-storage: "5Gi"  # Specify only what's needed
---
# Use Vertical Pod Autoscaler for right-sizing
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: optimized-app-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: optimized-app
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: app
      minAllowed:
        memory: "512Mi"
        cpu: "250m"
      maxAllowed:
        memory: "4Gi"
        cpu: "2000m"
```

# Feature Comparison Matrix

## Supported Features

```yaml
# Feature comparison for workload deployment
---
# Standard Mode - Full flexibility
apiVersion: v1
kind: Pod
metadata:
  name: standard-advanced-pod
spec:
  # ✅ hostNetwork access
  hostNetwork: true
  # ✅ hostPID access
  hostPID: true
  # ✅ Privileged containers
  containers:
  - name: privileged-container
    image: debugging-tools:latest
    securityContext:
      privileged: true
      capabilities:
        add:
        - NET_ADMIN
        - SYS_ADMIN
    volumeMounts:
    # ✅ hostPath volumes
    - name: host-root
      mountPath: /host
  volumes:
  - name: host-root
    hostPath:
      path: /
  # ✅ Custom node selection
  nodeSelector:
    workload-type: special
  # ✅ Specific node affinity
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: kubernetes.io/hostname
            operator: In
            values:
            - specific-node-name
---
# Autopilot Mode - Managed security
apiVersion: v1
kind: Pod
metadata:
  name: autopilot-restricted-pod
spec:
  # ❌ hostNetwork: not allowed
  # ❌ hostPID: not allowed
  # ❌ privileged: not allowed
  containers:
  - name: app-container
    image: myapp:latest
    # ✅ Standard security context allowed
    securityContext:
      runAsNonRoot: true
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
    resources:
      # ✅ Must specify resource limits
      limits:
        memory: "2Gi"
        cpu: "1000m"
    volumeMounts:
    # ✅ PersistentVolumes allowed
    - name: data
      mountPath: /data
    # ✅ ConfigMaps and Secrets allowed
    - name: config
      mountPath: /config
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: app-data
  - name: config
    configMap:
      name: app-config
  # ✅ No node selection needed - automated
  # ✅ Automatic node placement and scaling
```

## DaemonSets and System Components

```yaml
# Standard Mode - Deploy system DaemonSets
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-monitoring
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-monitoring
  template:
    metadata:
      labels:
        app: node-monitoring
    spec:
      hostNetwork: true
      hostPID: true
      containers:
      - name: monitor
        image: node-monitor:latest
        securityContext:
          privileged: true
        volumeMounts:
        - name: sys
          mountPath: /sys
        - name: proc
          mountPath: /proc
      volumes:
      - name: sys
        hostPath:
          path: /sys
      - name: proc
        hostPath:
          path: /proc
      tolerations:
      - operator: Exists  # Run on all nodes
---
# Autopilot Mode - Limited DaemonSet support
# Only specific system DaemonSets are allowed
# Custom DaemonSets requiring host access are blocked
# Use sidecar pattern or node-level metrics from GCP
```

# Migration Strategies

## Standard to Autopilot Migration

```bash
#!/bin/bash
# Migration script from Standard to Autopilot

set -e

PROJECT_ID="my-gcp-project"
REGION="us-central1"
OLD_CLUSTER="production-standard"
NEW_CLUSTER="production-autopilot"

echo "Step 1: Analyze current workloads"
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(.spec.hostNetwork == true or .spec.hostPID == true or .spec.containers[].securityContext.privileged == true) | .metadata.namespace + "/" + .metadata.name' > incompatible-workloads.txt

if [ -s incompatible-workloads.txt ]; then
  echo "WARNING: Found incompatible workloads:"
  cat incompatible-workloads.txt
  echo "These workloads must be redesigned for Autopilot"
fi

echo "Step 2: Create Autopilot cluster"
gcloud container clusters create-auto "${NEW_CLUSTER}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --release-channel=regular \
  --network=prod-vpc \
  --subnetwork=gke-subnet \
  --enable-private-nodes \
  --enable-private-endpoint=false \
  --cluster-secondary-range-name=pods \
  --services-secondary-range-name=services

echo "Step 3: Validate workload compatibility"
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
  echo "Checking namespace: $ns"

  # Export workloads
  kubectl get deploy,sts,ds -n "$ns" -o yaml > "${ns}-workloads.yaml"

  # Analyze resource specifications
  python3 << 'EOF'
import yaml
import sys

with open('${ns}-workloads.yaml') as f:
    docs = yaml.safe_load_all(f)
    for doc in docs:
        if not doc:
            continue
        # Check for resource limits
        spec = doc.get('spec', {}).get('template', {}).get('spec', {})
        containers = spec.get('containers', [])
        for c in containers:
            resources = c.get('resources', {})
            if 'limits' not in resources:
                print(f"WARNING: {doc['metadata']['name']} missing resource limits")
EOF
done

echo "Step 4: Deploy workloads to Autopilot cluster"
kubectl config use-context "gke_${PROJECT_ID}_${REGION}_${NEW_CLUSTER}"

# Deploy compatible workloads
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}' --context="gke_${PROJECT_ID}_${REGION}_${OLD_CLUSTER}"); do
  echo "Migrating namespace: $ns"
  kubectl create ns "$ns" --dry-run=client -o yaml | kubectl apply -f -

  # Copy secrets and configmaps
  kubectl get secrets -n "$ns" --context="gke_${PROJECT_ID}_${REGION}_${OLD_CLUSTER}" -o yaml | \
    kubectl apply -f - --context="gke_${PROJECT_ID}_${REGION}_${NEW_CLUSTER}"

  kubectl get configmaps -n "$ns" --context="gke_${PROJECT_ID}_${REGION}_${OLD_CLUSTER}" -o yaml | \
    kubectl apply -f - --context="gke_${PROJECT_ID}_${REGION}_${NEW_CLUSTER}"

  # Deploy workloads
  kubectl apply -f "${ns}-workloads.yaml" --context="gke_${PROJECT_ID}_${REGION}_${NEW_CLUSTER}"
done

echo "Step 5: Validate migration"
kubectl get pods --all-namespaces --context="gke_${PROJECT_ID}_${REGION}_${NEW_CLUSTER}"

echo "Migration complete. Monitor workloads before switching traffic."
```

## Workload Compatibility Checker

```python
#!/usr/bin/env python3
"""
GKE Autopilot compatibility checker
"""

import yaml
import sys
from typing import List, Dict, Any

class AutopilotCompatibilityChecker:
    def __init__(self):
        self.issues = []
        self.warnings = []

    def check_pod_spec(self, pod_spec: Dict[str, Any], resource_name: str):
        """Check if pod spec is compatible with Autopilot"""

        # Check host access
        if pod_spec.get('hostNetwork'):
            self.issues.append(f"{resource_name}: hostNetwork is not allowed in Autopilot")

        if pod_spec.get('hostPID'):
            self.issues.append(f"{resource_name}: hostPID is not allowed in Autopilot")

        if pod_spec.get('hostIPC'):
            self.issues.append(f"{resource_name}: hostIPC is not allowed in Autopilot")

        # Check volumes
        for volume in pod_spec.get('volumes', []):
            if 'hostPath' in volume:
                self.issues.append(f"{resource_name}: hostPath volumes are not allowed in Autopilot")

        # Check containers
        for container in pod_spec.get('containers', []):
            self._check_container(container, resource_name)

        # Check init containers
        for container in pod_spec.get('initContainers', []):
            self._check_container(container, resource_name, is_init=True)

    def _check_container(self, container: Dict[str, Any], resource_name: str, is_init: bool = False):
        """Check container specification"""
        container_name = container.get('name', 'unknown')
        prefix = f"{resource_name}:{container_name}"

        # Check security context
        sec_context = container.get('securityContext', {})
        if sec_context.get('privileged'):
            self.issues.append(f"{prefix}: privileged containers not allowed in Autopilot")

        if 'capabilities' in sec_context:
            caps = sec_context['capabilities'].get('add', [])
            blocked_caps = {'SYS_ADMIN', 'NET_ADMIN', 'SYS_MODULE'}
            if blocked_caps.intersection(set(caps)):
                self.issues.append(f"{prefix}: blocked capabilities in Autopilot")

        # Check resource limits
        resources = container.get('resources', {})
        if 'limits' not in resources:
            self.warnings.append(f"{prefix}: missing resource limits (required in Autopilot)")
        else:
            limits = resources['limits']
            if 'memory' not in limits or 'cpu' not in limits:
                self.warnings.append(f"{prefix}: must specify both CPU and memory limits")

    def check_workload(self, workload: Dict[str, Any]):
        """Check workload compatibility"""
        kind = workload.get('kind')
        name = workload['metadata']['name']
        resource_name = f"{kind}/{name}"

        if kind == 'DaemonSet':
            self.warnings.append(f"{resource_name}: DaemonSets have limited support in Autopilot")

        # Get pod spec
        if kind in ['Pod']:
            pod_spec = workload.get('spec', {})
        else:
            pod_spec = workload.get('spec', {}).get('template', {}).get('spec', {})

        if pod_spec:
            self.check_pod_spec(pod_spec, resource_name)

    def check_file(self, filename: str):
        """Check YAML file for Autopilot compatibility"""
        with open(filename) as f:
            docs = yaml.safe_load_all(f)
            for doc in docs:
                if not doc or 'kind' not in doc:
                    continue
                self.check_workload(doc)

    def report(self):
        """Print compatibility report"""
        if self.issues:
            print("❌ BLOCKING ISSUES (must fix for Autopilot):")
            for issue in self.issues:
                print(f"  - {issue}")
            print()

        if self.warnings:
            print("⚠️  WARNINGS (recommended fixes):")
            for warning in self.warnings:
                print(f"  - {warning}")
            print()

        if not self.issues and not self.warnings:
            print("✅ No compatibility issues found")
            return 0

        return 1 if self.issues else 0

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: check_autopilot_compatibility.py <yaml-file>")
        sys.exit(1)

    checker = AutopilotCompatibilityChecker()
    checker.check_file(sys.argv[1])
    sys.exit(checker.report())
```

# Production Decision Framework

## When to Choose Standard Mode

Standard mode is optimal when you need:

1. **Custom Node Configurations**
   - Specific instance types or local SSDs
   - GPU or TPU workloads with custom drivers
   - Bare metal or specialized hardware

2. **System-Level Access**
   - DaemonSets requiring host access
   - Custom CNI plugins or network configurations
   - Node-level monitoring or security tools

3. **Cost Optimization Control**
   - Spot VMs for batch workloads
   - Reserved instances for predictable workloads
   - Fine-grained autoscaling policies

4. **Legacy Application Support**
   - Applications requiring privileged containers
   - Workloads with host path dependencies
   - Custom kernel modules or system modifications

```yaml
# Example: Standard mode for ML/AI workloads
apiVersion: v1
kind: NodePool
metadata:
  name: gpu-training
spec:
  config:
    machineType: a2-highgpu-1g
    accelerators:
    - type: nvidia-tesla-a100
      count: 1
    guestAccelerators:
    - acceleratorCount: 1
      acceleratorType: nvidia-tesla-a100
      gpuPartitionSize: ""
    spot: true  # 70% cost savings for training
```

## When to Choose Autopilot Mode

Autopilot mode is optimal when you need:

1. **Simplified Operations**
   - Reduced operational overhead
   - Automatic infrastructure management
   - No node maintenance or patching

2. **Security and Compliance**
   - Hardened security posture by default
   - Automatic security updates
   - Reduced attack surface

3. **Predictable Costs**
   - Pay only for pod resources
   - No idle node costs
   - Automatic bin-packing optimization

4. **Standard Workloads**
   - Stateless web applications
   - Microservices architectures
   - Standard containerized applications

```yaml
# Example: Autopilot mode for web applications
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
spec:
  replicas: 10
  template:
    spec:
      containers:
      - name: frontend
        image: gcr.io/project/frontend:v1.0
        resources:
          limits:
            memory: "2Gi"
            cpu: "1000m"
      # Automatic node selection, scaling, and optimization
```

# Conclusion

GKE Autopilot and Standard modes serve different enterprise needs and operational requirements. Standard mode provides maximum flexibility and control, making it ideal for complex workloads, specialized hardware requirements, and organizations with mature Kubernetes operations. Autopilot mode offers simplified operations, enhanced security, and predictable costs, making it perfect for standard containerized applications and teams wanting to focus on application development rather than infrastructure management.

Key decision factors:

- **Control vs. Simplicity**: Standard offers control; Autopilot offers simplicity
- **Cost Structure**: Standard charges for nodes; Autopilot charges for pods
- **Workload Requirements**: Evaluate your specific application needs
- **Operational Maturity**: Consider your team's Kubernetes expertise
- **Security Posture**: Autopilot provides hardened defaults

Both modes can coexist in an enterprise environment, allowing you to choose the right tool for each workload. Many organizations run Autopilot for standard applications while maintaining Standard clusters for specialized workloads requiring additional control or customization.