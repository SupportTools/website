---
title: "Kubernetes Multi-Cloud Federation: Kubefed and Admiralty for Global Workload Distribution"
date: 2030-10-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Federation", "KubeFed", "Admiralty", "Multi-Cloud", "GitOps", "High Availability"]
categories:
- Kubernetes
- Multi-Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise federation guide: KubeFed v2 architecture, federated resource templates, Admiralty virtual nodes, cross-cluster scheduling policies, geo-aware routing, failover automation, and cloud cost optimization."
more_link: "yes"
url: "/kubernetes-multi-cloud-federation-kubefed-admiralty-global-workloads/"
---

Running Kubernetes workloads across multiple cloud providers and regions solves three distinct enterprise problems: geographic latency reduction, blast radius containment during regional outages, and cloud vendor cost arbitrage. KubeFed v2 and Admiralty represent two complementary approaches to federation — KubeFed handles declarative multi-cluster resource propagation while Admiralty extends the scheduler to treat remote cluster capacity as virtual nodes in a host cluster.

<!--more-->

## Federation Architecture Patterns

### When to Use KubeFed vs Admiralty

**KubeFed** is appropriate when:
- Teams manage independent cluster lifecycles across regions
- Workloads require cluster-local configuration overrides per region
- Multi-cluster RBAC and namespace management is needed
- The federation control plane can tolerate management cluster unavailability

**Admiralty** is appropriate when:
- A single scheduling decision must place pods across clusters
- Workloads need bin-packing across heterogeneous clouds
- The host cluster should be the single pane of glass for all resources
- Fine-grained capacity-aware placement is required

### Combined Architecture for Production

```
┌─────────────────────────────────────────────────────────────────┐
│                    Management Cluster (GKE)                      │
│  ┌─────────────────┐  ┌──────────────────────────────────────┐  │
│  │  KubeFed Host   │  │  Admiralty Multicluster Scheduler    │  │
│  │  Control Plane  │  │  - Capacity aggregation              │  │
│  │  - FederatedXxx │  │  - Cross-cluster bin-packing         │  │
│  │  - Propagation  │  │  - Virtual node representation       │  │
│  └────────┬────────┘  └─────────────────┬────────────────────┘  │
└───────────┼──────────────────────────────┼──────────────────────┘
            │                              │
    ┌───────┼──────────────────────────────┼──────────┐
    │       │                              │          │
    ▼       ▼                              ▼          ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Cluster A    │  │ Cluster B    │  │ Cluster C    │
│ AWS us-east-1│  │ Azure East US│  │ GCP us-east4 │
│ 50 nodes     │  │ 30 nodes     │  │ 40 nodes     │
└──────────────┘  └──────────────┘  └──────────────┘
```

## KubeFed v2 Architecture and Installation

### Control Plane Installation

```bash
# Add the KubeFed Helm chart repository
helm repo add kubefed https://raw.githubusercontent.com/kubernetes-sigs/kubefed/master/charts
helm repo update

# Install KubeFed control plane in the host cluster
helm install kubefed kubefed/kubefed \
  --namespace kube-federation-system \
  --create-namespace \
  --set controllermanager.replicaCount=3 \
  --set controllermanager.resources.requests.cpu=200m \
  --set controllermanager.resources.requests.memory=256Mi \
  --set controllermanager.resources.limits.cpu=1000m \
  --set controllermanager.resources.limits.memory=512Mi \
  --version 0.10.0

# Wait for control plane readiness
kubectl rollout status deployment/kubefed-controller-manager \
  -n kube-federation-system --timeout=300s

# Install kubefedctl CLI
curl -LO https://github.com/kubernetes-sigs/kubefed/releases/download/v0.10.0/kubefedctl-0.10.0-linux-amd64.tgz
tar xzf kubefedctl-0.10.0-linux-amd64.tgz
install -m 755 kubefedctl /usr/local/bin/
```

### Joining Member Clusters

```bash
# Join AWS cluster (from the host cluster context)
kubefedctl join aws-us-east-1 \
  --cluster-context aws-us-east-1-admin \
  --host-cluster-context gke-management-admin \
  --v=2

# Join Azure cluster
kubefedctl join azure-east-us \
  --cluster-context azure-east-us-admin \
  --host-cluster-context gke-management-admin \
  --v=2

# Join GCP regional cluster
kubefedctl join gcp-us-east4 \
  --cluster-context gcp-us-east4-admin \
  --host-cluster-context gke-management-admin \
  --v=2

# Verify cluster membership
kubectl get kubefedclusters -n kube-federation-system
# NAME              AGE   READY
# aws-us-east-1     5m    True
# azure-east-us     4m    True
# gcp-us-east4      3m    True

# Check cluster health
kubectl describe kubefedcluster aws-us-east-1 -n kube-federation-system
```

### Enabling Federated Resource Types

```bash
# Enable federation for core resource types
kubefedctl enable namespaces
kubefedctl enable deployments.apps
kubefedctl enable services
kubefedctl enable configmaps
kubefedctl enable secrets
kubefedctl enable serviceaccounts

# Enable federation for custom resource types
kubefedctl enable applications.argoproj.io
kubefedctl enable certificates.cert-manager.io

# List enabled federated types
kubectl get federatedtypeconfigs -n kube-federation-system
```

## Federated Resource Templates

### FederatedDeployment with Per-Cluster Overrides

```yaml
# federated-deployment-api.yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedDeployment
metadata:
  name: payment-api
  namespace: production
spec:
  # Template is the base deployment configuration
  template:
    metadata:
      labels:
        app: payment-api
        version: "2.1.0"
    spec:
      replicas: 3
      selector:
        matchLabels:
          app: payment-api
      template:
        metadata:
          labels:
            app: payment-api
        spec:
          terminationGracePeriodSeconds: 60
          containers:
          - name: payment-api
            image: your-registry.io/payment-api:2.1.0
            ports:
            - containerPort: 8080
            resources:
              requests:
                cpu: 200m
                memory: 256Mi
              limits:
                cpu: 1000m
                memory: 512Mi
            env:
            - name: REGION
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['topology.kubernetes.io/region']
            livenessProbe:
              httpGet:
                path: /healthz
                port: 8080
              initialDelaySeconds: 30
            readinessProbe:
              httpGet:
                path: /readyz
                port: 8080

  # Placement specifies which clusters receive this resource
  placement:
    clusters:
    - name: aws-us-east-1
    - name: azure-east-us
    - name: gcp-us-east4

  # Overrides customize the template per cluster
  overrides:
  - clusterName: aws-us-east-1
    clusterOverrides:
    - path: "/spec/replicas"
      value: 5  # More replicas in primary region
    - path: "/spec/template/spec/containers/0/env"
      op: add
      value:
      - name: CLOUD_PROVIDER
        value: aws
      - name: DB_ENDPOINT
        value: postgres-primary.us-east-1.rds.amazonaws.com:5432

  - clusterName: azure-east-us
    clusterOverrides:
    - path: "/spec/replicas"
      value: 3
    - path: "/spec/template/spec/containers/0/env"
      op: add
      value:
      - name: CLOUD_PROVIDER
        value: azure
      - name: DB_ENDPOINT
        value: postgres-replica.database.azure.com:5432

  - clusterName: gcp-us-east4
    clusterOverrides:
    - path: "/spec/replicas"
      value: 2  # Minimal footprint in GCP for cost optimization
    - path: "/spec/template/spec/containers/0/env"
      op: add
      value:
      - name: CLOUD_PROVIDER
        value: gcp
      - name: DB_ENDPOINT
        value: 10.20.30.40:5432
```

### FederatedNamespace with Resource Quotas

```yaml
# federated-namespace-production.yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedNamespace
metadata:
  name: production
  namespace: production
spec:
  placement:
    clusters:
    - name: aws-us-east-1
    - name: azure-east-us
    - name: gcp-us-east4
  template:
    metadata:
      labels:
        environment: production
        cost-center: platform-engineering
      annotations:
        scheduler.alpha.kubernetes.io/node-selector: "environment=production"
---
# Apply per-cluster resource quotas via FederatedResourceQuota
apiVersion: types.kubefed.io/v1beta1
kind: FederatedResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  template:
    spec:
      hard:
        requests.cpu: "100"
        requests.memory: "200Gi"
        limits.cpu: "400"
        limits.memory: "800Gi"
        pods: "500"
        services: "100"
        persistentvolumeclaims: "50"

  placement:
    clusters:
    - name: aws-us-east-1
    - name: azure-east-us
    - name: gcp-us-east4

  overrides:
  - clusterName: gcp-us-east4
    clusterOverrides:
    - path: "/spec/hard/requests.cpu"
      value: "50"
    - path: "/spec/hard/requests.memory"
      value: "100Gi"
```

### ReplicaSchedulingPreference for Weighted Distribution

```yaml
# replica-scheduling-preference.yaml
apiVersion: scheduling.kubefed.io/v1alpha1
kind: ReplicaSchedulingPreference
metadata:
  name: payment-api
  namespace: production
spec:
  targetKind: FederatedDeployment
  targetName: payment-api

  totalReplicas: 20

  clusters:
    aws-us-east-1:
      weight: 5      # 5/10 = 50% of replicas
      minReplicas: 5
      maxReplicas: 12

    azure-east-us:
      weight: 3      # 3/10 = 30% of replicas
      minReplicas: 3
      maxReplicas: 8

    gcp-us-east4:
      weight: 2      # 2/10 = 20% of replicas
      minReplicas: 2
      maxReplicas: 6

  # Rebalance replicas if a cluster goes offline
  rebalance: true
```

## Admiralty Virtual Nodes

### Installation

```bash
# Install Admiralty in the host cluster
helm repo add admiralty https://charts.admiralty.io
helm repo update

# Install the multicluster-controller in the management cluster
helm install admiralty admiralty/multicluster-scheduler \
  --namespace admiralty \
  --create-namespace \
  --set multiclusterController.enabled=true \
  --set scheduler.enabled=true \
  --set agentController.enabled=false \
  --version 0.16.0

# Install Admiralty agent in each target cluster
for CLUSTER in aws-us-east-1 azure-east-us gcp-us-east4; do
  kubectl config use-context ${CLUSTER}-admin

  helm install admiralty admiralty/multicluster-scheduler \
    --namespace admiralty \
    --create-namespace \
    --set multiclusterController.enabled=false \
    --set scheduler.enabled=false \
    --set agentController.enabled=true \
    --version 0.16.0
done

# Switch back to management cluster
kubectl config use-context gke-management-admin
```

### Cluster Registration and Virtual Nodes

```yaml
# admiralty-cluster-targets.yaml
# Register target clusters in the management cluster
apiVersion: multicluster.admiralty.io/v1alpha1
kind: ClusterTarget
metadata:
  name: aws-us-east-1
spec:
  self: false
  # Kubeconfig secret reference
  kubeconfigSecret:
    name: aws-us-east-1-kubeconfig
    key: kubeconfig
---
apiVersion: multicluster.admiralty.io/v1alpha1
kind: ClusterTarget
metadata:
  name: azure-east-us
spec:
  self: false
  kubeconfigSecret:
    name: azure-east-us-kubeconfig
    key: kubeconfig
---
apiVersion: multicluster.admiralty.io/v1alpha1
kind: ClusterTarget
metadata:
  name: gcp-us-east4
spec:
  self: false
  kubeconfigSecret:
    name: gcp-us-east4-kubeconfig
    key: kubeconfig
```

```bash
# After ClusterTargets are created, Admiralty creates virtual nodes
kubectl get nodes | grep admiralty
# NAME                              STATUS  ROLES   AGE   VERSION
# admiralty-aws-us-east-1           Ready   agent   5m    v1.28.0
# admiralty-azure-east-us           Ready   agent   5m    v1.28.0
# admiralty-gcp-us-east4            Ready   agent   5m    v1.28.0

# Virtual nodes expose the actual capacity of remote clusters
kubectl describe node admiralty-aws-us-east-1 | grep -A20 Capacity
```

### Admiralty-Aware Deployment

```yaml
# admiralty-deployment.yaml
# Pods scheduled here are candidate for multi-cluster placement
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
  namespace: data-processing
  annotations:
    multicluster.admiralty.io/elect: ""  # Enable multi-cluster scheduling
spec:
  replicas: 50  # Admiralty will distribute these across clusters
  selector:
    matchLabels:
      app: batch-processor
  template:
    metadata:
      labels:
        app: batch-processor
      annotations:
        # Constrain placement to specific clusters
        multicluster.admiralty.io/constraints: |
          [
            {
              "clusterName": "aws-us-east-1",
              "weight": 3
            },
            {
              "clusterName": "gcp-us-east4",
              "weight": 2
            }
          ]
    spec:
      # This scheduler handles multi-cluster placement decisions
      schedulerName: admiralty-scheduler
      containers:
      - name: processor
        image: your-registry.io/batch-processor:1.5.2
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
```

## Geo-Aware Routing with ExternalDNS and Weighted Records

### Multi-Cluster Ingress Architecture

```yaml
# global-service-routing.yaml
# Each cluster exposes the service via LoadBalancer
# ExternalDNS creates weighted DNS records pointing to each cluster's IP

# ExternalDNS annotation pattern for Route53 weighted routing
apiVersion: v1
kind: Service
metadata:
  name: payment-api
  namespace: production
  annotations:
    # AWS Route53 specific annotations for geo-weighted routing
    external-dns.alpha.kubernetes.io/hostname: payment-api.example.com
    external-dns.alpha.kubernetes.io/aws-weight: "50"
    external-dns.alpha.kubernetes.io/aws-set-identifier: aws-us-east-1
    # Health check integration
    external-dns.alpha.kubernetes.io/aws-health-check-id: hc-abc123
spec:
  type: LoadBalancer
  selector:
    app: payment-api
  ports:
  - port: 443
    targetPort: 8080
    protocol: TCP
```

### Failover Policy Configuration

```yaml
# cluster-failover-policy.yaml
# KubeFed does not have native failover, but this can be implemented
# via ReplicaSchedulingPreference watching cluster health

# Use this approach: an operator watches KubeFed cluster status
# and updates RSP weights when a cluster becomes unhealthy
apiVersion: batch/v1
kind: CronJob
metadata:
  name: federation-health-checker
  namespace: kube-federation-system
spec:
  schedule: "*/1 * * * *"  # Every minute
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: federation-controller
          restartPolicy: OnFailure
          containers:
          - name: health-checker
            image: your-registry.io/tools/federation-controller:1.0.0
            env:
            - name: KUBECONFIG
              value: /etc/federation/kubeconfig
            command:
            - /bin/sh
            - -c
            - |
              #!/bin/sh
              # Check each cluster's health
              for CLUSTER in aws-us-east-1 azure-east-us gcp-us-east4; do
                STATUS=$(kubectl get kubefedcluster "$CLUSTER" \
                  -n kube-federation-system \
                  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')

                if [ "$STATUS" != "True" ]; then
                  echo "Cluster $CLUSTER is UNHEALTHY, redistributing replicas..."

                  # Update RSP to redistribute load
                  kubectl patch replicaschedulingpreference payment-api \
                    -n production \
                    --type=json \
                    -p "[{\"op\": \"replace\", \"path\": \"/spec/clusters/$CLUSTER/minReplicas\", \"value\": 0}]"
                fi
              done
            volumeMounts:
            - name: kubeconfig
              mountPath: /etc/federation
          volumes:
          - name: kubeconfig
            secret:
              secretName: federation-kubeconfig
```

## Cross-Cluster Service Discovery

### Submariner for Direct Pod-to-Pod Connectivity

```bash
# Install Submariner broker in the management cluster
helm install submariner-k8s-broker submariner-latest/submariner-k8s-broker \
  --namespace submariner-k8s-broker \
  --create-namespace

# Join clusters to the Submariner broker
subctl join broker-info.subm \
  --natt=false \
  --clusterid aws-us-east-1 \
  --kubecontext aws-us-east-1-admin

subctl join broker-info.subm \
  --natt=false \
  --clusterid azure-east-us \
  --kubecontext azure-east-us-admin

subctl join broker-info.subm \
  --natt=false \
  --clusterid gcp-us-east4 \
  --kubecontext gcp-us-east4-admin

# Verify cross-cluster connectivity
subctl verify aws-us-east-1 azure-east-us --only connectivity,service-discovery
```

### ServiceExport for Multi-Cluster DNS

```yaml
# service-export.yaml
# Export the payment-api service for cross-cluster discovery
# ServiceExport is a Kubernetes multi-cluster SIG resource
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: payment-api
  namespace: production
  # This must exist in every cluster that runs the service
---
# In other clusters, consume the exported service via ServiceImport
# ServiceImport is created automatically by the MCS controller
# Name format: <service-name>.<namespace>.svc.clusterset.local
```

## Cost Optimization Across Cloud Providers

### Spot/Preemptible Instance Integration

```yaml
# spot-instance-nodepool-aws.yaml
# AWS: Use node labels to indicate spot capacity
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-cost-profile
  namespace: kube-federation-system
data:
  aws-us-east-1: |
    on-demand-nodes: 10
    spot-nodes: 40
    spot-discount: 70
    spot-interruption-rate: low
  azure-east-us: |
    on-demand-nodes: 15
    spot-nodes: 15
    spot-discount: 60
    spot-interruption-rate: medium
  gcp-us-east4: |
    on-demand-nodes: 20
    spot-nodes: 20
    spot-discount: 80
    spot-interruption-rate: very-low
```

```yaml
# cost-aware-deployment.yaml
# Use Admiralty with placement constraints to route batch workloads
# to the lowest-cost clusters while keeping latency-sensitive workloads
# on-demand
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-ml-training
  namespace: ml-workloads
  annotations:
    multicluster.admiralty.io/elect: ""
spec:
  replicas: 100
  selector:
    matchLabels:
      app: batch-ml-training
  template:
    metadata:
      labels:
        app: batch-ml-training
        workload-class: batch
      annotations:
        # Prefer GCP preemptible for lowest cost
        multicluster.admiralty.io/constraints: |
          [
            {"clusterName": "gcp-us-east4", "weight": 5},
            {"clusterName": "aws-us-east-1", "weight": 2},
            {"clusterName": "azure-east-us", "weight": 1}
          ]
    spec:
      schedulerName: admiralty-scheduler
      tolerations:
      - key: cloud.google.com/gke-preemptible
        operator: Equal
        value: "true"
        effect: NoSchedule
      - key: kubernetes.azure.com/scalesetpriority
        operator: Equal
        value: spot
        effect: NoSchedule
      - key: karpenter.sh/interruption
        operator: Exists
        effect: NoSchedule
      containers:
      - name: training
        image: your-registry.io/ml/trainer:3.0.0
        resources:
          requests:
            cpu: "4"
            memory: 8Gi
            nvidia.com/gpu: "1"
```

## GitOps Federation with ArgoCD ApplicationSets

```yaml
# argocd-federated-appset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payment-api-federation
  namespace: argocd
spec:
  generators:
  - list:
      elements:
      - cluster: aws-us-east-1
        url: https://api.aws-us-east-1.example.com
        env: production
        replicas: "5"
        dbEndpoint: postgres-primary.us-east-1.rds.amazonaws.com:5432

      - cluster: azure-east-us
        url: https://api.azure-east-us.example.com
        env: production
        replicas: "3"
        dbEndpoint: postgres-replica.database.azure.com:5432

      - cluster: gcp-us-east4
        url: https://api.gcp-us-east4.example.com
        env: production
        replicas: "2"
        dbEndpoint: 10.20.30.40:5432

  template:
    metadata:
      name: payment-api-{{cluster}}
      labels:
        cluster: "{{cluster}}"
        app: payment-api
    spec:
      project: production

      source:
        repoURL: https://git.internal.example.com/platform/kubernetes-apps.git
        targetRevision: HEAD
        path: apps/payment-api
        helm:
          valueFiles:
          - values.yaml
          - values-{{env}}.yaml
          parameters:
          - name: replicaCount
            value: "{{replicas}}"
          - name: database.endpoint
            value: "{{dbEndpoint}}"
          - name: cluster.name
            value: "{{cluster}}"

      destination:
        server: "{{url}}"
        namespace: production

      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
        - CreateNamespace=true
        - PrunePropagationPolicy=foreground
        retry:
          limit: 5
          backoff:
            duration: 10s
            factor: 2
            maxDuration: 5m
```

## Monitoring Federation Health

```yaml
# federation-monitoring-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubefed-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: kubefed.rules
    interval: 30s
    rules:
    - alert: FederatedClusterUnhealthy
      expr: |
        kubefed_cluster_health_status{condition="Ready"} == 0
      for: 2m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Federated cluster {{ $labels.cluster_name }} is unhealthy"
        description: "Cluster {{ $labels.cluster_name }} has been in NOT_READY state for 2 minutes. Federated workloads may not be scheduling."
        runbook: https://wiki.internal.example.com/runbooks/federation-cluster-unhealthy

    - alert: FederatedReplicaShortfall
      expr: |
        (
          kubefed_desired_replicas - kubefed_actual_replicas
        ) / kubefed_desired_replicas > 0.2
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Federated deployment {{ $labels.name }} has more than 20% replica shortfall"
        description: "{{ $labels.name }} in namespace {{ $labels.namespace }} is running at {{ $value | humanizePercentage }} below desired replica count."

    - alert: CrossClusterNetworkLatencyHigh
      expr: |
        histogram_quantile(0.99,
          rate(admiralty_proxy_pod_relay_latency_seconds_bucket[5m])
        ) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Cross-cluster relay latency above 100ms P99"
        description: "Admiralty cross-cluster relay latency from {{ $labels.source_cluster }} to {{ $labels.target_cluster }} is {{ $value | humanizeDuration }} at P99."
```

## Disaster Recovery and Failover Testing

```bash
#!/bin/bash
# federation-failover-test.sh
# Test automatic failover when a cluster becomes unavailable

set -euo pipefail

NAMESPACE="production"
DEPLOYMENT="payment-api"
TARGET_CLUSTER="aws-us-east-1"  # Cluster to simulate failure

echo "=== Federation Failover Test ==="
echo "Target cluster: $TARGET_CLUSTER"

# Record baseline
echo "--- Baseline replica distribution ---"
kubectl get replicaschedulingpreference "$DEPLOYMENT" -n "$NAMESPACE" -o yaml

# Simulate cluster failure by cordoning all virtual nodes
echo "--- Simulating cluster failure ---"
kubectl cordon "admiralty-${TARGET_CLUSTER}"

# Wait for rebalancing
echo "--- Waiting for rebalancing (60s) ---"
sleep 60

# Check redistribution
echo "--- Post-failure replica distribution ---"
for CLUSTER in aws-us-east-1 azure-east-us gcp-us-east4; do
  PODS=$(kubectl --context="${CLUSTER}-admin" get pods -n "$NAMESPACE" \
    -l "app=${DEPLOYMENT}" --no-headers 2>/dev/null | wc -l)
  echo "  $CLUSTER: $PODS pods"
done

# Verify traffic is still flowing via geo-DNS
echo "--- Verifying traffic continuity ---"
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code} from %{remote_ip}\n" \
    --connect-timeout 5 \
    https://payment-api.example.com/healthz
done

# Restore the cluster
echo "--- Restoring cluster ---"
kubectl uncordon "admiralty-${TARGET_CLUSTER}"

echo "=== Failover test complete ==="
```

Multi-cloud federation introduces operational complexity that must be justified by concrete reliability or cost requirements. The Kubefed + Admiralty combination provides the flexibility to address both declarative propagation and intelligent scheduling, but both tools require investment in tooling, monitoring, and runbooks before they deliver production-grade reliability.
