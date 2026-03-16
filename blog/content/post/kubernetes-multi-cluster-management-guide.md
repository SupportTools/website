---
title: "Kubernetes Multi-Cluster Management: Federation, Fleet Management, and Cross-Cluster Services"
date: 2027-06-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Cluster", "Fleet", "Rancher", "ArgoCD", "Federation"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes multi-cluster management covering topology patterns, Cluster API lifecycle management, Rancher Fleet GitOps, ArgoCD ApplicationSets, cross-cluster networking with Submariner and Cilium Cluster Mesh, and centralized monitoring."
more_link: "yes"
url: "/kubernetes-multi-cluster-management-guide/"
---

Operating a single Kubernetes cluster is tractable. Operating dozens or hundreds of clusters — each with different Kubernetes versions, node configurations, compliance requirements, and workload profiles — demands systematic tooling and well-defined operational patterns. Enterprises that scale beyond three clusters without a multi-cluster strategy accumulate drift, manual toil, and inconsistent security posture that compound over time. This guide covers the topology patterns, lifecycle management tools, GitOps fleet approaches, cross-cluster networking options, and observability architecture required to operate a production multi-cluster environment at scale.

<!--more-->

## Multi-Cluster Topology Patterns

Before selecting tooling, the topology pattern must match the business and technical requirements.

### Active-Active: Multi-Region Horizontal Scaling

All clusters serve production traffic simultaneously. Workloads are deployed identically to all clusters. Global load balancing distributes traffic geographically.

```
Users (global)
      │
      ▼
Global Load Balancer (AWS Global Accelerator / Cloudflare / GCP Anycast)
      │
  ┌───┴───────────────────────────┐
  ▼                               ▼
us-east-1 cluster             eu-west-1 cluster
  │                               │
  ├── Namespace: app-prod         ├── Namespace: app-prod
  ├── Namespace: platform         ├── Namespace: platform
  └── Namespace: monitoring       └── Namespace: monitoring

Shared services:
  - Database (cross-region replication)
  - Message queue (geo-replicated)
  - Secrets management (Vault with DR replication)
```

**Trade-offs**: Maximum resilience and performance. Highest operational complexity. Requires application-level multi-region awareness for stateful services.

### Active-Passive: DR Standby

A primary cluster handles all production traffic. One or more standby clusters are kept synchronized and can accept traffic within a defined RTO if the primary fails.

**Trade-offs**: Simpler than active-active. RTO is measured in minutes (Velero restore) to seconds (pre-warmed standby). Standby cluster cost is non-trivial.

### Regional Isolation: Compliance and Data Residency

Separate clusters per regulatory region (EU, US, APAC). Workloads and data never cross regional boundaries. Shared management plane operates outside regulated regions.

**Trade-offs**: Required for GDPR, data sovereignty laws. Increases cluster count. Management tooling must support regional isolation primitives.

### Specialized Workload Clusters

Separate clusters for distinct workload categories: GPU/ML training clusters, high-security clusters for sensitive workloads, edge clusters running k3s, development/staging clusters per team.

**Trade-offs**: Right-sized infrastructure per workload type. Increased management surface. Requires clear ownership and tenant boundaries.

## Cluster Lifecycle Management with Cluster API

Cluster API (CAPI) is the Kubernetes sub-project for declarative cluster lifecycle management. Clusters, control planes, and node groups are all Kubernetes custom resources managed by controllers running in a management cluster.

### Management Cluster Bootstrap

```bash
# Install clusterctl
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.7.2/clusterctl-linux-amd64 \
  -o clusterctl && chmod +x clusterctl && mv clusterctl /usr/local/bin/

# Initialize the management cluster with AWS provider (CAPA)
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=<key>
export AWS_SECRET_ACCESS_KEY=<secret>

# Encode credentials
export AWS_B64ENCODED_CREDENTIALS=$(clusterawsadm bootstrap credentials encode-as-profile)

clusterctl init \
  --infrastructure aws \
  --control-plane kubeadm \
  --bootstrap kubeadm

# Verify providers are running
kubectl get pods -n capi-system
kubectl get pods -n capa-system
```

### Defining a Workload Cluster

```yaml
# workload-cluster.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: production-us-east-1
  namespace: default
  labels:
    environment: production
    region: us-east-1
    tier: platform
spec:
  clusterNetwork:
    pods:
      cidrBlocks: ["10.244.0.0/16"]
    services:
      cidrBlocks: ["10.96.0.0/12"]
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSCluster
    name: production-us-east-1
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: production-us-east-1-control-plane
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
kind: AWSCluster
metadata:
  name: production-us-east-1
  namespace: default
spec:
  region: us-east-1
  sshKeyName: cluster-keypair
  network:
    vpc:
      availabilityZoneUsageLimit: 3
      availabilityZoneSelection: Ordered
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: production-us-east-1-control-plane
  namespace: default
spec:
  replicas: 3
  version: v1.30.2
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
      kind: AWSMachineTemplate
      name: production-us-east-1-control-plane
  kubeadmConfigSpec:
    initConfiguration:
      nodeRegistration:
        name: "{{ ds.meta_data.local_hostname }}"
        kubeletExtraArgs:
          cloud-provider: external
    clusterConfiguration:
      apiServer:
        extraArgs:
          cloud-provider: external
          audit-log-path: /var/log/apiserver/audit.log
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "100"
          audit-policy-file: /etc/kubernetes/audit-policy.yaml
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: production-us-east-1-workers
  namespace: default
spec:
  clusterName: production-us-east-1
  replicas: 5
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: production-us-east-1
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: production-us-east-1
    spec:
      clusterName: production-us-east-1
      version: v1.30.2
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: production-us-east-1-workers
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
        kind: AWSMachineTemplate
        name: production-us-east-1-workers
```

### Cluster Upgrade via CAPI

```bash
# Upgrade control plane to new Kubernetes version
kubectl patch kcp production-us-east-1-control-plane \
  --type=merge \
  -p '{"spec":{"version":"v1.31.0"}}'

# CAPI performs rolling upgrade of control plane nodes
# Monitor progress
kubectl get kcp production-us-east-1-control-plane -w

# After control plane upgrade, upgrade worker nodes
kubectl patch machinedeployment production-us-east-1-workers \
  --type=merge \
  -p '{"spec":{"template":{"spec":{"version":"v1.31.0"}}}}'

# Monitor rolling upgrade
kubectl get machinedeployment production-us-east-1-workers -w
```

## Rancher Fleet for GitOps Across Clusters

Rancher Fleet is a GitOps engine designed specifically for multi-cluster operations. It manages GitRepo resources that define a Git repository and a set of target clusters for deployment.

### Fleet Architecture

```
Management Cluster (Fleet Controller)
    │
    ├── GitRepo: platform-addons (targets all clusters)
    │     └── Sources: Helm charts for cert-manager, external-secrets, etc.
    │
    ├── GitRepo: production-workloads (targets production clusters)
    │     └── Sources: Application Helm charts
    │
    ├── GitRepo: monitoring (targets all clusters)
    │     └── Sources: Prometheus stack, dashboards
    │
    └── ClusterGroup: production
          └── Targets: us-east-1, eu-west-1, ap-southeast-1

Downstream Clusters (Fleet Agents)
    ├── production-us-east-1 (labels: env=prod, region=us-east)
    ├── production-eu-west-1 (labels: env=prod, region=eu-west)
    └── staging-us-east-1 (labels: env=staging, region=us-east)
```

### GitRepo Definition

```yaml
# fleet-gitrepo-platform.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: platform-addons
  namespace: fleet-default
spec:
  repo: https://github.com/example-org/platform-config
  branch: main
  revision: ""

  # Authentication for private repositories
  clientSecretName: github-credentials

  # Poll interval for new commits
  pollingInterval: 15s

  # Deploy to all clusters matching these labels
  targets:
    - clusterGroup: all-clusters
    # Or use cluster selectors directly:
    # - clusterSelector:
    #     matchLabels:
    #       fleet.cattle.io/cluster: "true"

  # Paths within the repository to deploy
  paths:
    - fleet/platform/cert-manager
    - fleet/platform/external-secrets
    - fleet/platform/metrics-server

  # Override values per cluster or cluster group
  helm:
    releaseName: platform
    values:
      global:
        clusterName: override-via-cluster-label

  # Namespace to deploy into
  defaultNamespace: cert-manager

  # Force re-deploy on each sync
  forceSyncGeneration: 0
```

### Per-Cluster Value Overrides with Fleet

Fleet supports cluster-specific Helm value overrides using `values.yaml` files in path-specific directories:

```
fleet/platform/cert-manager/
├── Chart.yaml               # Optional chart metadata
├── fleet.yaml               # Fleet bundle configuration
├── values.yaml              # Default values for all clusters
└── overlays/
    ├── production/
    │   └── values.yaml      # Override for production cluster group
    └── us-east-1/
        └── values.yaml      # Override for specific cluster
```

```yaml
# fleet/platform/cert-manager/fleet.yaml
defaultNamespace: cert-manager
helm:
  chart: cert-manager
  repo: https://charts.jetstack.io
  version: v1.15.0
  releaseName: cert-manager
  values:
    installCRDs: true
    global:
      logLevel: 2

targetCustomizations:
  - name: production
    clusterGroup: production
    helm:
      values:
        replicaCount: 3
        resources:
          requests:
            cpu: 50m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi

  - name: staging
    clusterGroup: staging
    helm:
      values:
        replicaCount: 1
        resources:
          requests:
            cpu: 10m
            memory: 64Mi
```

## ArgoCD ApplicationSet for Multi-Cluster

ArgoCD ApplicationSets extend ArgoCD to generate Application objects dynamically for multiple clusters. Generators define the matrix of cluster + parameter combinations.

### Cluster Generator

The cluster generator creates one Application per registered ArgoCD cluster:

```yaml
# appset-platform.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-addons
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            argocd.argoproj.io/secret-type: cluster
            environment: production
  template:
    metadata:
      name: "platform-addons-{{name}}"
      labels:
        cluster: "{{name}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/example-org/platform-config
        targetRevision: main
        path: "clusters/{{name}}/platform"
      destination:
        server: "{{server}}"
        namespace: argocd
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
          - ApplyOutOfSyncOnly=true
      ignoreDifferences:
        - group: apps
          kind: Deployment
          jsonPointers:
            - /spec/replicas
```

### Matrix Generator

The matrix generator creates a cross-product of two generators, enabling per-application per-cluster deployments:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: production-services
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # First generator: list of clusters
          - clusters:
              selector:
                matchLabels:
                  environment: production
          # Second generator: list of applications
          - list:
              elements:
                - appName: api-gateway
                  appPath: apps/api-gateway
                  appNamespace: api-gateway
                - appName: user-service
                  appPath: apps/user-service
                  appNamespace: user-service
                - appName: payment-service
                  appPath: apps/payment-service
                  appNamespace: payment-service
  template:
    metadata:
      name: "{{appName}}-{{name}}"
    spec:
      project: production
      source:
        repoURL: https://github.com/example-org/app-config
        targetRevision: main
        path: "{{appPath}}"
        helm:
          valueFiles:
            - values.yaml
            - "values-{{name}}.yaml"  # Per-cluster overrides
      destination:
        server: "{{server}}"
        namespace: "{{appNamespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Pull Request Generator for Preview Environments

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: preview-environments
  namespace: argocd
spec:
  generators:
    - pullRequest:
        github:
          owner: example-org
          repo: app-config
          tokenRef:
            secretName: github-token
            key: token
          labels:
            - preview
        requeueAfterSeconds: 30
  template:
    metadata:
      name: "preview-{{branch}}-{{number}}"
    spec:
      project: preview
      source:
        repoURL: https://github.com/example-org/app-config
        targetRevision: "{{head_sha}}"
        path: apps/api
        helm:
          parameters:
            - name: image.tag
              value: "pr-{{number}}"
            - name: ingress.host
              value: "pr-{{number}}.preview.example.com"
      destination:
        server: https://staging-cluster.example.com
        namespace: "preview-{{number}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

## Cross-Cluster Service Discovery with Submariner

Submariner enables direct pod and service networking between Kubernetes clusters. It creates encrypted tunnels between cluster nodes and federates ServiceExports/ServiceImports using the Multicluster Services API.

### Submariner Architecture

```
Cluster A (us-east-1)          Cluster B (eu-west-1)
Pod CIDR: 10.244.0.0/16        Pod CIDR: 10.245.0.0/16
Svc CIDR: 10.96.0.0/12         Svc CIDR: 10.97.0.0/12

  ┌─────────────────────┐       ┌─────────────────────┐
  │ Submariner Gateway  │◄─────►│ Submariner Gateway  │
  │ (IPsec tunnel)      │       │ (IPsec tunnel)      │
  └─────────────────────┘       └─────────────────────┘
         │                              │
         ▼                              ▼
  Service: database               Service: api
  Exported as ServiceExport        Exported as ServiceExport
         │                              │
         └─────────── Broker ───────────┘
                   (central state)
```

### Installing Submariner

```bash
# Install subctl CLI
curl -Ls https://get.submariner.io | bash
export PATH=$PATH:~/.local/bin

# Set up the broker cluster (typically the management cluster)
subctl deploy-broker \
  --kubeconfig ~/.kube/management-cluster.yaml \
  --service-discovery

# Join the first cluster
subctl join broker-info.subm \
  --kubeconfig ~/.kube/cluster-a.yaml \
  --clusterid cluster-a \
  --natt=false \
  --cable-driver libreswan

# Join the second cluster
subctl join broker-info.subm \
  --kubeconfig ~/.kube/cluster-b.yaml \
  --clusterid cluster-b \
  --natt=false \
  --cable-driver libreswan

# Verify connectivity
subctl verify ~/.kube/cluster-a.yaml ~/.kube/cluster-b.yaml --only connectivity,service-discovery
```

### Cross-Cluster Service Export

```yaml
# Export a service from Cluster A to be accessible from Cluster B
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: database
  namespace: data-services
  # This creates a ServiceImport visible in all joined clusters
---
# The exported service is then accessible from Cluster B as:
# database.data-services.svc.clusterset.local
```

## Cilium Cluster Mesh

Cilium Cluster Mesh provides multi-cluster networking at the eBPF layer without the need for IPsec tunnels or overlays. It enables native Pod IP routing across clusters, shared service load balancing, and network policies that span cluster boundaries.

### Setting Up Cilium Cluster Mesh

```bash
# Install Cilium with cluster-mesh support on both clusters
# Cluster A
helm upgrade --install cilium cilium/cilium \
  --namespace kube-system \
  --set cluster.name=cluster-a \
  --set cluster.id=1 \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.replicas=2 \
  --set clustermesh.apiserver.service.type=LoadBalancer \
  --set clustermesh.apiserver.kvstoremesh.enabled=true \
  --kube-context cluster-a

# Cluster B
helm upgrade --install cilium cilium/cilium \
  --namespace kube-system \
  --set cluster.name=cluster-b \
  --set cluster.id=2 \
  --set clustermesh.useAPIServer=true \
  --set clustermesh.apiserver.replicas=2 \
  --set clustermesh.apiserver.service.type=LoadBalancer \
  --kube-context cluster-b

# Connect the clusters
cilium clustermesh connect \
  --context cluster-a \
  --destination-context cluster-b

# Verify mesh status
cilium clustermesh status --context cluster-a
```

### Global Services with Cilium Cluster Mesh

```yaml
# Service annotated as a global service — load balanced across both clusters
apiVersion: v1
kind: Service
metadata:
  name: api-backend
  namespace: production
  annotations:
    # Enable global load balancing
    service.cilium.io/global: "true"
    # Prefer local cluster endpoints, fall back to remote
    service.cilium.io/affinity: "local"
spec:
  type: ClusterIP
  selector:
    app: api-backend
  ports:
    - port: 8080
      targetPort: 8080
```

## Global Load Balancing with ExternalDNS

ExternalDNS integrates with cloud DNS providers to create DNS records that route traffic across clusters based on health and geography.

```yaml
# externaldns-multicluster.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
  namespace: external-dns
spec:
  template:
    spec:
      containers:
        - name: external-dns
          image: registry.k8s.io/external-dns/external-dns:v0.14.2
          args:
            - --source=service
            - --source=ingress
            - --domain-filter=example.com
            - --provider=aws
            - --aws-zone-type=public
            # Use weighted routing for multi-cluster traffic splitting
            - --aws-prefer-cname
            - --policy=upsert-only
            - --registry=txt
            - --txt-owner-id=cluster-a
            - --txt-prefix=cluster-a-
          env:
            - name: AWS_REGION
              value: us-east-1
```

For Route53 weighted routing across clusters:

```yaml
# Annotate services to create weighted Route53 records
# Cluster A service (50% of traffic)
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: api.example.com
    external-dns.alpha.kubernetes.io/aws-weight: "50"
    external-dns.alpha.kubernetes.io/set-identifier: cluster-a

# Cluster B service (50% of traffic)
metadata:
  annotations:
    external-dns.alpha.kubernetes.io/hostname: api.example.com
    external-dns.alpha.kubernetes.io/aws-weight: "50"
    external-dns.alpha.kubernetes.io/set-identifier: cluster-b
```

## Cluster Identity and RBAC Federation

Centralizing authentication and authorization across clusters eliminates per-cluster user management.

### OIDC Integration with Dex

Dex acts as an identity broker that federates multiple identity providers (LDAP, GitHub, SAML) into a single OIDC endpoint used by all cluster API servers.

```yaml
# dex-config.yaml
issuer: https://dex.platform.example.com/dex

connectors:
  - type: ldap
    id: ldap
    name: Corporate LDAP
    config:
      host: ldap.corp.example.com:636
      insecureNoSSL: false
      bindDN: cn=dex,ou=service-accounts,dc=example,dc=com
      bindPW: $LDAP_BIND_PASSWORD
      usernamePrompt: Corporate Username
      userSearch:
        baseDN: ou=Users,dc=example,dc=com
        filter: "(objectClass=person)"
        username: sAMAccountName
        idAttr: DN
        emailAttr: mail
        nameAttr: displayName
      groupSearch:
        baseDN: ou=Groups,dc=example,dc=com
        filter: "(objectClass=groupOfNames)"
        groupAttr: member
        nameAttr: cn
```

Each API server is configured to use Dex:

```yaml
# kube-apiserver flags (via kubeadm or cloud provider config)
apiServer:
  extraArgs:
    oidc-issuer-url: https://dex.platform.example.com/dex
    oidc-client-id: kubernetes
    oidc-username-claim: email
    oidc-groups-claim: groups
    oidc-username-prefix: "oidc:"
    oidc-groups-prefix: "oidc:"
```

### ClusterRole Standardization

A standardized set of ClusterRoles deployed to all clusters provides consistent RBAC semantics:

```yaml
# rbac-standards.yaml
# Deployed via Fleet/ArgoCD to all clusters

# Read-only access for all engineers
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform:engineer:view
  labels:
    rbac.platform.example.com/managed: "true"
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps", "events", "namespaces"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "daemonsets", "statefulsets", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["get", "list", "watch"]
---
# Namespace-scoped edit access for application teams
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform:engineer:namespace-admin
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps", "secrets", "persistentvolumeclaims"]
    verbs: ["*"]
  - apiGroups: ["apps"]
    resources: ["deployments", "daemonsets", "statefulsets"]
    verbs: ["*"]
  - apiGroups: ["autoscaling"]
    resources: ["*"]
    verbs: ["*"]
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["*"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses", "networkpolicies"]
    verbs: ["*"]
---
# ClusterRoleBinding that maps OIDC groups to roles
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: platform:engineer:view
subjects:
  - kind: Group
    name: "oidc:platform-engineers"
    apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: platform:engineer:view
```

## Centralized Monitoring with Thanos

Each cluster runs a Prometheus instance that remote-writes metrics to a centralized Thanos cluster. Thanos Querier aggregates metrics across all clusters for unified dashboards and alerting.

```yaml
# thanos-remote-write.yaml
# Applied to each cluster's Prometheus configuration

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: thanos-recording-rules
  namespace: monitoring
---
# Prometheus additional config for Thanos remote write
additionalScrapeConfigs:
  - job_name: 'thanos-sidecar'
    static_configs:
      - targets: ['thanos-sidecar:10902']

# Prometheus remote write config
remoteWrite:
  - url: "https://thanos-receive.platform.example.com/api/v1/receive"
    sigv4:
      region: us-east-1
    writeRelabelConfigs:
      - targetLabel: cluster
        replacement: "$(CLUSTER_NAME)"
      - targetLabel: environment
        replacement: "$(ENVIRONMENT)"
    queueConfig:
      maxSamplesPerSend: 10000
      maxShards: 30
      capacity: 100000
```

Thanos Querier configuration for multi-cluster queries:

```yaml
# thanos-querier.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-querier
  namespace: monitoring
spec:
  template:
    spec:
      containers:
        - name: thanos
          image: quay.io/thanos/thanos:v0.36.0
          args:
            - query
            - --log.level=info
            - --query.auto-downsampling
            # Deduplicate metrics across clusters using the replica label
            - --query.replica-label=prometheus_replica
            - --query.replica-label=cluster
            # Store gateway endpoints (one per cluster)
            - --endpoint=thanos-store-us-east-1.monitoring.svc:10901
            - --endpoint=thanos-store-eu-west-1.monitoring.svc:10901
            - --endpoint=thanos-store-ap-southeast-1.monitoring.svc:10901
            # Query timeout
            - --query.timeout=5m
          ports:
            - name: http
              containerPort: 10902
            - name: grpc
              containerPort: 10901
```

### Cross-Cluster PromQL Queries

With Thanos, metrics from all clusters are queryable from a single endpoint:

```promql
# Total CPU usage across all production clusters
sum by (cluster) (
  rate(container_cpu_usage_seconds_total{
    namespace!="",
    environment="production"
  }[5m])
)

# Memory pressure across all clusters
count by (cluster) (
  node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1
)

# Compare pod counts across clusters
sum by (cluster, namespace) (
  kube_pod_status_phase{phase="Running"}
)
```

## Operational Runbook: Cluster Onboarding

When adding a new cluster to the fleet, the following steps ensure consistent configuration:

```bash
#!/bin/bash
# onboard-cluster.sh
# Onboards a new cluster to the platform fleet

set -euo pipefail

CLUSTER_NAME="${1:?Cluster name required}"
CLUSTER_ENV="${2:?Environment (production|staging|dev) required}"
CLUSTER_REGION="${3:?Region required}"
KUBECONFIG_PATH="${4:?Kubeconfig path required}"

echo "Onboarding cluster: ${CLUSTER_NAME}"

# 1. Label the cluster for Fleet targeting
kubectl label cluster "${CLUSTER_NAME}" \
  environment="${CLUSTER_ENV}" \
  region="${CLUSTER_REGION}" \
  --kubeconfig "${KUBECONFIG_PATH}" \
  --overwrite

# 2. Register cluster with ArgoCD
argocd cluster add "${CLUSTER_NAME}" \
  --kubeconfig "${KUBECONFIG_PATH}" \
  --label environment="${CLUSTER_ENV}" \
  --label region="${CLUSTER_REGION}" \
  --label tier=managed

# 3. Register cluster with Rancher Fleet
kubectl apply -f - <<EOF
apiVersion: fleet.cattle.io/v1alpha1
kind: Cluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: fleet-default
  labels:
    environment: ${CLUSTER_ENV}
    region: ${CLUSTER_REGION}
spec:
  kubeConfigSecret: kubeconfig-${CLUSTER_NAME}
EOF

# 4. Apply baseline security and RBAC
kubectl apply -f platform/rbac/ --kubeconfig "${KUBECONFIG_PATH}"
kubectl apply -f platform/network-policies/ --kubeconfig "${KUBECONFIG_PATH}"
kubectl apply -f platform/pod-security/ --kubeconfig "${KUBECONFIG_PATH}"

# 5. Install Prometheus operator and configure remote write
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.remoteWrite[0].url=https://thanos-receive.platform.example.com/api/v1/receive \
  --set prometheus.prometheusSpec.externalLabels.cluster="${CLUSTER_NAME}" \
  --set prometheus.prometheusSpec.externalLabels.environment="${CLUSTER_ENV}" \
  --kubeconfig "${KUBECONFIG_PATH}"

# 6. Join Submariner mesh (if cross-cluster networking required)
if [[ "${CLUSTER_ENV}" == "production" ]]; then
  subctl join broker-info.subm \
    --kubeconfig "${KUBECONFIG_PATH}" \
    --clusterid "${CLUSTER_NAME}" \
    --cable-driver libreswan
fi

echo "Cluster ${CLUSTER_NAME} onboarded successfully"
echo "Fleet should begin deploying platform addons within 60 seconds"
```

Multi-cluster management transitions from ad-hoc scripts to a systematic engineering discipline when Cluster API handles lifecycle, Fleet or ArgoCD ApplicationSets handle GitOps configuration drift, Submariner or Cilium Cluster Mesh handles cross-cluster networking, and Thanos provides unified observability. The investment in this foundation pays dividends as cluster count grows — each additional cluster costs minutes of onboarding time rather than days of manual configuration.
