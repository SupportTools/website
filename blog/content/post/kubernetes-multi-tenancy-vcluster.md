---
title: "Kubernetes Multi-Tenancy with vCluster 0.20: Virtual Clusters, Networking, and Storage Isolation"
date: 2030-02-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "vCluster", "Multi-Tenancy", "Virtual Clusters", "Networking", "Storage", "Isolation"]
categories: ["Kubernetes", "Multi-Tenancy"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to deploying vCluster 0.20 for Kubernetes multi-tenancy, covering syncer configuration, per-vcluster CNI, storage class isolation, and host cluster resource quotas."
more_link: "yes"
url: "/kubernetes-multi-tenancy-vcluster/"
---

Virtual clusters represent one of the most practical solutions for Kubernetes multi-tenancy in production environments. Rather than forcing teams to share API servers, etcd, and control planes — with all the namespace-scoping limitations that entails — vCluster creates isolated Kubernetes API servers inside regular namespaces on a host cluster. Each tenant gets a full Kubernetes experience, including the ability to create their own CRDs, cluster-scoped resources, and RBAC policies, without touching the host cluster's control plane.

This guide covers a production deployment of vCluster 0.20 with full networking isolation using dedicated CNI instances per virtual cluster, storage class isolation with per-tenant provisioners, and host cluster resource quotas that enforce hard limits on what each tenant can consume.

<!--more-->

## Why vCluster for Multi-Tenancy

Traditional namespace-based multi-tenancy has well-known limitations. Cluster-scoped resources like ClusterRoles, CRDs, and StorageClasses cannot be namespaced. Tenants cannot install operators that require cluster-admin. Node affinity and taints are visible to all tenants. A misconfigured admission webhook in one namespace can affect all namespaces.

Namespace-per-team works for simple workloads but breaks down when tenants need:

- Custom CRDs for their applications
- Operators that require cluster-level RBAC
- Different Kubernetes versions for compatibility testing
- API server audit log isolation
- Independent upgrade schedules

vCluster solves these by running a full Kubernetes control plane (typically k3s or k8s distro) as a pod inside a namespace on the host cluster. The tenant's workloads run as pods on the host, but the tenant's API server is isolated. The syncer component translates between the virtual cluster's object model and the host cluster's actual resources.

## Architecture Overview

```
Host Cluster (management plane)
├── Namespace: tenant-alpha
│   ├── vcluster-alpha (StatefulSet)
│   │   ├── API Server (k3s/k8s)
│   │   ├── etcd
│   │   └── Syncer
│   ├── ResourceQuota: tenant-alpha-quota
│   ├── NetworkPolicy: tenant-alpha-isolation
│   └── PodDisruptionBudget: vcluster-alpha-pdb
│
├── Namespace: tenant-beta
│   ├── vcluster-beta (StatefulSet)
│   └── ResourceQuota: tenant-beta-quota
│
└── Shared Infrastructure
    ├── CNI: Cilium (host network fabric)
    ├── StorageClasses: fast-ssd, standard-hdd
    └── cert-manager, external-dns
```

Each virtual cluster gets its own namespace, its own resource quota on the host, and optionally its own isolated CNI configuration. The syncer handles translating virtual pod specs to host pods, mapping virtual service accounts to host service accounts, and syncing ConfigMaps/Secrets that need to land on nodes.

## Prerequisites

```bash
# Host cluster requirements
kubectl version --short
# Server Version: v1.29.x or later

# Install vCluster CLI
curl -L -o /usr/local/bin/vcluster \
  "https://github.com/loft-sh/vcluster/releases/download/v0.20.0/vcluster-linux-amd64"
chmod +x /usr/local/bin/vcluster

vcluster version
# vcluster version 0.20.0

# Install Helm 3.14+
helm version --short
# v3.14.x

# Verify host cluster has sufficient resources
kubectl top nodes
```

## Installing vCluster with Helm

vCluster 0.20 ships with a significantly revamped Helm chart that separates control plane configuration from sync configuration. This separation makes it much cleaner to configure what resources get synced between virtual and host clusters.

### Tenant Alpha: Full Isolation Configuration

```yaml
# values-tenant-alpha.yaml
controlPlane:
  distro:
    k8s:
      enabled: true
      version: "1.29.4"
      apiServer:
        extraArgs:
          - "--audit-log-path=/var/log/audit.log"
          - "--audit-log-maxage=7"
          - "--audit-log-maxbackup=3"
          - "--audit-log-maxsize=100"
          - "--audit-policy-file=/etc/audit/policy.yaml"
        volumeMounts:
          - name: audit-policy
            mountPath: /etc/audit
            readOnly: true
        volumes:
          - name: audit-policy
            configMap:
              name: audit-policy
      controllerManager:
        extraArgs:
          - "--node-cidr-mask-size=24"
  statefulSet:
    resources:
      requests:
        cpu: "500m"
        memory: "1Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
    persistence:
      volumeClaimTemplates:
        - metadata:
            name: data
          spec:
            accessModes: ["ReadWriteOnce"]
            storageClassName: fast-ssd
            resources:
              requests:
                storage: 10Gi
  service:
    type: ClusterIP

sync:
  toHost:
    pods:
      enabled: true
      enforceTolerations:
        - key: "tenant"
          operator: "Equal"
          value: "alpha"
          effect: "NoSchedule"
      rewriteHosts:
        enabled: true
        initContainerImage: "ghcr.io/loft-sh/vcluster-rewrite-hosts:0.20.0"
    services:
      enabled: true
    configMaps:
      enabled: true
      all: false
    secrets:
      enabled: true
      all: false
    endpoints:
      enabled: true
    persistentVolumeClaims:
      enabled: true
    storageClasses:
      enabled: false  # We provide dedicated storage classes
    networkPolicies:
      enabled: true
    volumeSnapshots:
      enabled: true
    podDisruptionBudgets:
      enabled: true
    serviceAccounts:
      enabled: true
  fromHost:
    nodes:
      enabled: true
      selector:
        labelSelector:
          tenant: alpha
      syncAllNodes: false
    storageClasses:
      enabled: false
    ingressClasses:
      enabled: true
    csiNodes:
      enabled: true
    csiDrivers:
      enabled: true
    csiStorageCapacities:
      enabled: true

networking:
  replicateServices:
    fromHost: []
    toHost: []

policies:
  resourceQuota:
    enabled: true
    quota:
      requests.cpu: "20"
      requests.memory: "40Gi"
      limits.cpu: "40"
      limits.memory: "80Gi"
      requests.storage: "500Gi"
      persistentvolumeclaims: "50"
      pods: "200"
      services: "50"
      secrets: "200"
      configmaps: "200"
  limitRange:
    enabled: true
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "8"
      memory: "16Gi"

rbac:
  clusterRole:
    enabled: true
    extraRules:
      - apiGroups: [""]
        resources: ["nodes"]
        verbs: ["get", "list", "watch"]

exportKubeConfig:
  server: ""
  secret:
    name: vc-tenant-alpha-kubeconfig
```

```bash
# Create the tenant namespace
kubectl create namespace tenant-alpha
kubectl label namespace tenant-alpha \
  tenant=alpha \
  vcluster.loft.sh/managed=true \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.29

# Create audit policy ConfigMap before installing
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: audit-policy
  namespace: tenant-alpha
data:
  policy.yaml: |
    apiVersion: audit.k8s.io/v1
    kind: Policy
    rules:
      - level: Metadata
        resources:
          - group: ""
            resources: ["secrets", "configmaps"]
      - level: RequestResponse
        resources:
          - group: ""
            resources: ["pods"]
        verbs: ["create", "delete", "patch"]
      - level: None
        resources:
          - group: ""
            resources: ["events"]
EOF

# Install vCluster
helm repo add loft-sh https://charts.loft.sh
helm repo update

helm install vc-alpha loft-sh/vcluster \
  --namespace tenant-alpha \
  --version 0.20.0 \
  --values values-tenant-alpha.yaml \
  --wait \
  --timeout 5m

# Verify the installation
kubectl get pods -n tenant-alpha
# NAME                                   READY   STATUS    RESTARTS   AGE
# vc-alpha-0                             1/1     Running   0          2m
# vc-alpha-1                             1/1     Running   0          2m
# vc-alpha-2                             1/1     Running   0          2m
```

## Networking Isolation with Cilium

The key challenge with vCluster networking is that pods from multiple virtual clusters run on the same host nodes. Without proper isolation, pods from tenant-alpha can reach pods from tenant-beta at the network layer. This section covers how to enforce strict L3/L4 isolation using Cilium network policies.

### Host-Level Network Policy for vCluster Namespaces

```yaml
# host-netpol-tenant-alpha.yaml
apiVersion: cilium.io/v1alpha1
kind: CiliumNetworkPolicy
metadata:
  name: tenant-alpha-isolation
  namespace: tenant-alpha
spec:
  endpointSelector:
    matchLabels:
      vcluster.loft.sh/object.kind: Pod
  ingress:
    - fromEndpoints:
        - matchLabels:
            vcluster.loft.sh/object.namespace: tenant-alpha
    - fromEndpoints:
        - matchLabels:
            app: vc-alpha  # Allow vCluster control plane
  egress:
    - toEndpoints:
        - matchLabels:
            vcluster.loft.sh/object.namespace: tenant-alpha
    - toEndpoints:
        - matchLabels:
            app: vc-alpha
    - toFQDNs:
        - matchPattern: "*.cluster.local"
    - toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"
```

### Per-vCluster CNI with Cilium Cluster Mesh

For environments where tenants need distinct IP address ranges and routing domains, Cilium Cluster Mesh provides a production-grade solution. Each virtual cluster gets its own CIDR block, and cross-tenant communication is explicitly denied at the network fabric level.

```bash
# Configure Cilium with per-namespace CIDR allocation
cat > cilium-values.yaml <<'EOF'
# Cilium Helm values for vCluster multi-tenancy
ipam:
  mode: cluster-pool
  operator:
    clusterPoolIPv4PodCIDRList:
      - "10.244.0.0/16"

# Enable per-namespace CIDR blocks
alibabacloud:
  enabled: false

# vCluster-specific networking
k8s:
  requireIPv4PodCIDR: false

hubble:
  enabled: true
  relay:
    enabled: true
  ui:
    enabled: true

# Enable network policy enforcement
policyEnforcementMode: "default"
EOF

helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --values cilium-values.yaml \
  --reuse-values
```

### Kubernetes Network Policies Inside Virtual Clusters

Inside each virtual cluster, tenants can create their own NetworkPolicy objects. The syncer translates these to host-level policies. Here is a standard baseline policy that should be deployed in every virtual cluster namespace:

```yaml
# applied inside the virtual cluster
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector: {}
  egress:
    - to:
        - podSelector: {}
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-from-loadbalancer
  namespace: production
spec:
  podSelector:
    matchLabels:
      expose: "true"
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
```

## Storage Class Isolation

Storage isolation in vCluster requires careful coordination between what the virtual cluster exposes to tenants and what the host cluster actually provisions. The goal is to prevent tenants from consuming storage from classes meant for other tenants, and to enable per-tenant storage pricing and quota enforcement.

### Dedicated StorageClass per Tenant

```yaml
# host-storageclasses.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: tenant-alpha-fast
  labels:
    tenant: alpha
    tier: fast
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/alpha-tenant-key"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Delete
allowedTopologies:
  - matchLabelExpressions:
      - key: topology.kubernetes.io/zone
        values:
          - us-east-1a
          - us-east-1b
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: tenant-alpha-standard
  labels:
    tenant: alpha
    tier: standard
provisioner: ebs.csi.aws.com
parameters:
  type: gp2
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/alpha-tenant-key"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Delete
```

### vCluster StorageClass Mapping

The vCluster syncer can remap virtual StorageClass names to host StorageClass names. This allows tenants to use generic names like "fast" or "standard" inside their virtual cluster, while the syncer maps these to the correct host-level classes:

```yaml
# Add to values-tenant-alpha.yaml under sync.toHost
sync:
  toHost:
    persistentVolumeClaims:
      enabled: true
      storageClassMapping:
        fast: tenant-alpha-fast
        standard: tenant-alpha-standard
        default: tenant-alpha-standard
```

### OPA Gatekeeper Policy for Storage Isolation

Even with StorageClass mapping, add a Gatekeeper constraint to prevent tenants from bypassing the mapping by directly specifying host StorageClass names:

```yaml
# gatekeeper-storageclassconstraint.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPAllowedStorageClasses
metadata:
  name: tenant-alpha-storage-classes
  namespace: tenant-alpha
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["PersistentVolumeClaim"]
    namespaces: ["tenant-alpha"]
  parameters:
    allowedStorageClasses:
      - "tenant-alpha-fast"
      - "tenant-alpha-standard"
      - ""
```

### Volume Snapshot Configuration

```yaml
# volume-snapshot-class.yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: tenant-alpha-snapshots
  labels:
    tenant: alpha
driver: ebs.csi.aws.com
deletionPolicy: Delete
parameters:
  tagSpecification_1: "tenant=alpha"
  tagSpecification_2: "managed-by=vcluster"
```

## Resource Quota Enforcement

Host cluster resource quotas are the final enforcement layer. Even if a tenant finds a way to create more virtual pods than their quota allows, the host quota prevents those pods from scheduling.

### Hierarchical Resource Quotas

```yaml
# resource-quota-tenant-alpha.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-alpha-compute
  namespace: tenant-alpha
spec:
  hard:
    # Compute
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "80Gi"
    # Storage
    requests.storage: "2Ti"
    persistentvolumeclaims: "100"
    # Objects
    pods: "500"
    services: "100"
    services.loadbalancers: "5"
    services.nodeports: "0"
    secrets: "500"
    configmaps: "500"
    # GPU quota
    requests.nvidia.com/gpu: "4"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-alpha-storage-fast
  namespace: tenant-alpha
spec:
  hard:
    tenant-alpha-fast.storageclass.storage.k8s.io/requests.storage: "500Gi"
    tenant-alpha-fast.storageclass.storage.k8s.io/persistentvolumeclaims: "20"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-alpha-storage-standard
  namespace: tenant-alpha
spec:
  hard:
    tenant-alpha-standard.storageclass.storage.k8s.io/requests.storage: "1500Gi"
    tenant-alpha-standard.storageclass.storage.k8s.io/persistentvolumeclaims: "80"
```

### LimitRange for Default Pod Resources

```yaml
# limitrange-tenant-alpha.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: tenant-alpha-limits
  namespace: tenant-alpha
spec:
  limits:
    - type: Pod
      max:
        cpu: "16"
        memory: "32Gi"
      min:
        cpu: "10m"
        memory: "16Mi"
    - type: Container
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      max:
        cpu: "8"
        memory: "16Gi"
      min:
        cpu: "10m"
        memory: "16Mi"
    - type: PersistentVolumeClaim
      max:
        storage: "1Ti"
      min:
        storage: "1Gi"
```

## vCluster Syncer Configuration Deep Dive

The syncer is the most critical component of vCluster. Understanding what it syncs, what it blocks, and how to configure it is essential for a secure multi-tenant deployment.

### What the Syncer Does

The syncer runs inside the vCluster pod and watches both the virtual API server and the host API server. When a tenant creates a Pod in the virtual cluster, the syncer:

1. Validates the pod spec against virtual admission controllers
2. Translates service account references to host-level equivalents
3. Rewrites image pull secrets to use host-level secrets
4. Applies node selectors and tolerations for tenant isolation
5. Creates the pod on the host under the tenant namespace
6. Syncs status back to the virtual pod

### Custom Syncer Hooks

vCluster 0.20 supports custom hooks that run before or after sync operations. This allows you to inject tenant-specific labels, modify resource specs, or block certain operations:

```go
// custom-hook/main.go
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/loft-sh/vcluster/pkg/plugin/v2"
	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func main() {
	plugin.Init(plugin.Options{
		Name: "tenant-alpha-hook",
	})

	plugin.MutateCreatePhysical(func(
		ctx context.Context,
		event plugin.MutateCreatePhysicalEvent[*corev1.Pod],
	) (*corev1.Pod, error) {
		pod := event.Physical

		// Enforce resource limits on all pods
		for i := range pod.Spec.Containers {
			if pod.Spec.Containers[i].Resources.Limits == nil {
				pod.Spec.Containers[i].Resources.Limits = corev1.ResourceList{}
			}
			// Ensure no container runs without limits
			if _, ok := pod.Spec.Containers[i].Resources.Limits[corev1.ResourceCPU]; !ok {
				return nil, fmt.Errorf("container %s must specify CPU limits",
					pod.Spec.Containers[i].Name)
			}
		}

		// Add tenant label to all host pods
		if pod.Labels == nil {
			pod.Labels = make(map[string]string)
		}
		pod.Labels["tenant"] = "alpha"
		pod.Labels["cost-center"] = os.Getenv("COST_CENTER")

		return pod, nil
	})

	plugin.Serve()
}
```

```yaml
# plugin deployment in vCluster values
plugin:
  tenant-alpha-hook:
    image: registry.internal/vcluster-plugins/tenant-alpha-hook:1.0.0
    rbac:
      role:
        extraRules:
          - apiGroups: [""]
            resources: ["pods"]
            verbs: ["get", "list", "watch", "update", "patch"]
```

## Accessing the Virtual Cluster

```bash
# Get the kubeconfig for the virtual cluster
vcluster connect vc-alpha \
  --namespace tenant-alpha \
  --kube-config ./tenant-alpha.kubeconfig

# Or using the exported secret
kubectl get secret vc-tenant-alpha-kubeconfig \
  -n tenant-alpha \
  -o jsonpath='{.data.config}' | base64 -d > tenant-alpha.kubeconfig

# Test the virtual cluster
export KUBECONFIG=./tenant-alpha.kubeconfig
kubectl get nodes
# NAME              STATUS   ROLES    AGE   VERSION
# node-1            Ready    <none>   5m    v1.29.4
# node-2            Ready    <none>   5m    v1.29.4

kubectl get storageclasses
# NAME        PROVISIONER   RECLAIMPOLICY   VOLUMEBINDINGMODE   ALLOWVOLUMEEXPANSION
# fast        (translated)  Delete          WaitForFirstConsumer   true
# standard    (translated)  Delete          WaitForFirstConsumer   true
```

## High Availability vCluster Setup

For production workloads, vCluster should be deployed in HA mode with 3 replicas sharing an etcd:

```yaml
# ha-values.yaml
controlPlane:
  statefulSet:
    highAvailability:
      replicas: 3
      leaseDuration: 60
      renewDeadline: 40
      retryPeriod: 15
    scheduling:
      podManagementPolicy: Parallel
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: vc-alpha

  backingStore:
    etcd:
      embedded:
        enabled: true
        migrateFromDeployedEtcd: false
```

## Monitoring vCluster Operations

### Prometheus Metrics Collection

```yaml
# servicemonitor-vcluster.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vcluster-metrics
  namespace: tenant-alpha
  labels:
    prometheus: kube-prometheus
spec:
  endpoints:
    - interval: 30s
      port: metrics
      path: /metrics
      scheme: http
  namespaceSelector:
    matchNames:
      - tenant-alpha
  selector:
    matchLabels:
      app: vc-alpha
```

### Key Alerts

```yaml
# vcluster-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vcluster-alerts
  namespace: monitoring
spec:
  groups:
    - name: vcluster.rules
      rules:
        - alert: VClusterSyncerDown
          expr: |
            absent(up{job="vcluster-metrics", namespace="tenant-alpha"} == 1)
          for: 5m
          labels:
            severity: critical
            tenant: alpha
          annotations:
            summary: "vCluster syncer is down for tenant-alpha"
            description: "The vCluster syncer has been down for more than 5 minutes"

        - alert: VClusterResourceQuotaExceeded
          expr: |
            (
              kube_resourcequota{namespace="tenant-alpha", type="used"}
              /
              kube_resourcequota{namespace="tenant-alpha", type="hard"}
            ) > 0.9
          for: 15m
          labels:
            severity: warning
            tenant: alpha
          annotations:
            summary: "Resource quota near limit for tenant-alpha"
            description: "{{ $labels.resource }} is at {{ $value | humanizePercentage }} of quota"

        - alert: VClusterEtcdLowSpace
          expr: |
            etcd_mvcc_db_total_size_in_bytes{namespace="tenant-alpha"} > 6e9
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "vCluster etcd database is getting large"
```

## Automating Tenant Provisioning

In production, you want a GitOps-driven process for creating new virtual clusters. Here is a Helm chart wrapper that can be applied via ArgoCD:

```yaml
# tenant-chart/templates/vcluster.yaml
{{- range .Values.tenants }}
---
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .name }}
  labels:
    tenant: {{ .id }}
    vcluster.loft.sh/managed: "true"
    pod-security.kubernetes.io/enforce: restricted
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: {{ .name }}-quota
  namespace: {{ .name }}
spec:
  hard:
    requests.cpu: {{ .quota.cpu | quote }}
    requests.memory: {{ .quota.memory | quote }}
    limits.cpu: {{ .quota.cpuLimit | quote }}
    limits.memory: {{ .quota.memoryLimit | quote }}
    requests.storage: {{ .quota.storage | quote }}
    pods: {{ .quota.pods | quote }}
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: vcluster-{{ .id }}
  namespace: argocd
spec:
  project: tenant-vclusters
  source:
    repoURL: https://charts.loft.sh
    targetRevision: 0.20.0
    chart: vcluster
    helm:
      values: |
        controlPlane:
          distro:
            k8s:
              enabled: true
              version: {{ .kubernetesVersion | quote }}
        sync:
          toHost:
            pods:
              enforceTolerations:
                - key: "tenant"
                  operator: "Equal"
                  value: {{ .id | quote }}
                  effect: "NoSchedule"
  destination:
    server: https://kubernetes.default.svc
    namespace: {{ .name }}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
{{- end }}
```

## Upgrading vCluster

```bash
# Check current version
helm list -n tenant-alpha

# Upgrade to new patch version
helm upgrade vc-alpha loft-sh/vcluster \
  --namespace tenant-alpha \
  --version 0.20.1 \
  --values values-tenant-alpha.yaml \
  --atomic \
  --timeout 10m

# Verify upgrade
kubectl get pods -n tenant-alpha
kubectl rollout status statefulset/vc-alpha -n tenant-alpha

# Test virtual cluster after upgrade
export KUBECONFIG=./tenant-alpha.kubeconfig
kubectl get nodes
kubectl get pods -A
```

## Troubleshooting Common Issues

### Syncer Not Starting

```bash
# Check syncer logs
kubectl logs -n tenant-alpha vc-alpha-0 -c syncer --tail=100

# Common issue: RBAC permissions
kubectl auth can-i create pods \
  --as=system:serviceaccount:tenant-alpha:vc-alpha \
  -n tenant-alpha

# Check syncer leader election
kubectl get lease -n tenant-alpha
```

### Pod Not Syncing to Host

```bash
# Check virtual pod status
export KUBECONFIG=./tenant-alpha.kubeconfig
kubectl describe pod <pod-name> -n production

# Check host pod creation
unset KUBECONFIG
kubectl get pods -n tenant-alpha -l vcluster.loft.sh/object.name=<pod-name>

# Check syncer debug logs
kubectl exec -n tenant-alpha vc-alpha-0 -c syncer -- \
  /vcluster syncer \
  --log-level=debug 2>&1 | head -50
```

### Storage Class Not Available in Virtual Cluster

```bash
# Verify host storage class exists
kubectl get sc tenant-alpha-fast

# Check syncer storage class sync config
kubectl exec -n tenant-alpha vc-alpha-0 -- \
  cat /var/vcluster/config/config.yaml | grep -A 20 storageClass

# Force storage class sync
kubectl annotate sc tenant-alpha-fast \
  vcluster.loft.sh/force-sync=true
```

## Key Takeaways

Deploying vCluster in production for multi-tenancy requires attention to several independent isolation layers:

**Control Plane Isolation**: Each tenant gets their own API server, etcd, and admission chain. This eliminates cross-tenant CRD conflicts and allows independent operator deployments.

**Network Isolation**: Host-level network policies (Cilium) enforce L3/L4 isolation between tenants even though their pods share physical nodes. Virtual cluster NetworkPolicies are synced and enforced at the host level.

**Storage Isolation**: Dedicated StorageClasses per tenant, combined with OPA Gatekeeper constraints, prevent storage cross-contamination. KMS key isolation ensures storage is encrypted with tenant-specific keys.

**Resource Isolation**: Host ResourceQuotas are the hard enforcement layer. Even if the virtual cluster API allows creating resources, the host quota prevents them from consuming cluster capacity.

**Operational Visibility**: The syncer provides a natural audit trail. All host resources are labeled with tenant identifiers, making cost attribution and debugging straightforward.

vCluster 0.20 represents a mature solution for the multi-tenancy problem. The architectural separation between control plane isolation (virtual API server) and workload execution (host nodes) provides the best of both worlds: tenant freedom with operator control.
