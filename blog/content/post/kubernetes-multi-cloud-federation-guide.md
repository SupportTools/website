---
title: "Multi-Cloud Kubernetes Federation: Workload Distribution Across AWS, GCP, and Azure"
date: 2028-01-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Cloud", "Federation", "KubeFed", "Admiralty", "Liqo", "AWS", "GCP", "Azure"]
categories:
- Kubernetes
- Multi-Cloud
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes multi-cloud federation covering KubeFed, Admiralty, and Liqo for workload distribution across AWS, GCP, and Azure with global load balancing and disaster recovery."
more_link: "yes"
url: "/kubernetes-multi-cloud-federation-guide/"
---

Enterprise organizations running Kubernetes at scale increasingly require workloads to span multiple cloud providers simultaneously. Whether the driver is regulatory compliance, latency optimization, cost arbitrage, or resilience against provider-level outages, multi-cloud federation introduces a distinct set of operational challenges that single-cluster patterns simply cannot address. This guide examines three mature federation approaches—KubeFed, Admiralty, and Liqo—and covers the networking, service discovery, autoscaling, and disaster recovery patterns required to operate federated clusters reliably in production.

<!--more-->

# Multi-Cloud Kubernetes Federation: Workload Distribution Across AWS, GCP, and Azure

## Section 1: Federation Architecture Overview

Multi-cloud Kubernetes federation is not a single technology but a collection of control-plane patterns that coordinate scheduling, networking, and lifecycle management across independent clusters. Before selecting a tool, teams must understand the architectural trade-offs.

### Federation Models

**Host-cluster model**: A dedicated management cluster runs the federation control plane. Member clusters register with the host and receive federated resources. KubeFed version 2 follows this model.

**Peer-to-peer model**: Every cluster participates equally, and a distributed control plane reconciles state. Liqo leans toward this model with its peering concept.

**Proxy-scheduling model**: A virtual kubelet on the local cluster schedules pods onto remote clusters transparently. Admiralty uses this model extensively.

### When to Choose Each Tool

| Tool | Strengths | Limitations |
|------|-----------|-------------|
| KubeFed v2 | Mature API, propagation policies, overrides | Complex setup, limited community momentum |
| Admiralty | Transparent pod scheduling, no API changes | Requires trust between clusters, VPN or peering |
| Liqo | Zero-trust peering, namespace mirroring, dynamic discovery | Newer, fewer production case studies |

## Section 2: KubeFed v2 Deployment and Configuration

### Installing the Federation Control Plane

KubeFed requires a host cluster where `kubefed` operator runs. The remaining clusters join as members.

```bash
# Add the KubeFed Helm repository
helm repo add kubefed-charts https://raw.githubusercontent.com/kubernetes-sigs/kubefed/master/charts
helm repo update

# Install on host cluster (use kubeconfig pointing to host)
kubectl config use-context host-cluster

helm install kubefed kubefed-charts/kubefed \
  --namespace kube-federation-system \
  --create-namespace \
  --version 0.10.0 \
  --set controllermanager.replicaCount=2 \
  --set controllermanager.featureGates.PushReconciler=true
```

### Joining Member Clusters

```bash
# Install kubefedctl CLI
curl -LO https://github.com/kubernetes-sigs/kubefed/releases/download/v0.10.0/kubefedctl-0.10.0-linux-amd64.tgz
tar xzf kubefedctl-0.10.0-linux-amd64.tgz
sudo mv kubefedctl /usr/local/bin/

# Join AWS EKS cluster
kubefedctl join aws-us-east-1 \
  --cluster-context arn:aws:eks:us-east-1:123456789012:cluster/prod-east \
  --host-cluster-context host-cluster \
  --v=2

# Join GCP GKE cluster
kubefedctl join gcp-us-central1 \
  --cluster-context gke_myproject_us-central1_prod-central \
  --host-cluster-context host-cluster \
  --v=2

# Join Azure AKS cluster
kubefedctl join azure-eastus \
  --cluster-context my-aks-cluster \
  --host-cluster-context host-cluster \
  --v=2

# Verify membership
kubectl -n kube-federation-system get kubefedclusters
```

### Federated Namespace

```yaml
# federated-namespace.yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedNamespace
metadata:
  name: production
  namespace: production
spec:
  placement:
    clusters:
    - name: aws-us-east-1
    - name: gcp-us-central1
    - name: azure-eastus
```

### Federated Deployment with Overrides

```yaml
# federated-deployment.yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedDeployment
metadata:
  name: api-server
  namespace: production
spec:
  template:
    metadata:
      labels:
        app: api-server
    spec:
      replicas: 3
      selector:
        matchLabels:
          app: api-server
      template:
        metadata:
          labels:
            app: api-server
        spec:
          containers:
          - name: api-server
            image: myregistry.io/api-server:v2.1.0
            resources:
              requests:
                cpu: "500m"
                memory: "512Mi"
              limits:
                cpu: "2"
                memory: "2Gi"
            env:
            - name: CLOUD_PROVIDER
              value: "generic"
  placement:
    clusters:
    - name: aws-us-east-1
    - name: gcp-us-central1
    - name: azure-eastus
  overrides:
  # AWS-specific overrides
  - clusterName: aws-us-east-1
    clusterOverrides:
    - path: "/spec/replicas"
      value: 5
    - path: "/spec/template/spec/containers/0/env"
      op: add
      value:
      - name: CLOUD_PROVIDER
        value: "aws"
      - name: AWS_REGION
        value: "us-east-1"
  # GCP-specific overrides
  - clusterName: gcp-us-central1
    clusterOverrides:
    - path: "/spec/replicas"
      value: 3
    - path: "/spec/template/spec/containers/0/env"
      op: add
      value:
      - name: CLOUD_PROVIDER
        value: "gcp"
      - name: GCP_REGION
        value: "us-central1"
  # Azure-specific overrides
  - clusterName: azure-eastus
    clusterOverrides:
    - path: "/spec/replicas"
      value: 2
    - path: "/spec/template/spec/containers/0/env"
      op: add
      value:
      - name: CLOUD_PROVIDER
        value: "azure"
      - name: AZURE_REGION
        value: "eastus"
```

### Replica Scheduling Policy

KubeFed supports weighted replica distribution across clusters:

```yaml
# replica-scheduling-preference.yaml
apiVersion: scheduling.kubefed.io/v1alpha1
kind: ReplicaSchedulingPreference
metadata:
  name: api-server
  namespace: production
spec:
  targetKind: FederatedDeployment
  totalReplicas: 10
  clusters:
    aws-us-east-1:
      weight: 5
      minReplicas: 2
      maxReplicas: 7
    gcp-us-central1:
      weight: 3
      minReplicas: 1
      maxReplicas: 5
    azure-eastus:
      weight: 2
      minReplicas: 1
      maxReplicas: 4
```

## Section 3: Admiralty for Transparent Multi-Cluster Scheduling

Admiralty extends the Kubernetes scheduler via virtual nodes (virtual kubelets), allowing pods to be scheduled onto remote clusters without modifying the pod spec. The remote cluster appears as a node in the local cluster.

### Installing Admiralty

```bash
# Install on source cluster (AWS EKS)
helm repo add admiralty https://charts.admiralty.io
helm repo update

helm install admiralty admiralty/multicluster-scheduler \
  --namespace admiralty \
  --create-namespace \
  --version 0.15.0 \
  --set webhook.enabled=true

# Install on target cluster (GCP GKE)
kubectl config use-context gke-prod-central
helm install admiralty admiralty/multicluster-scheduler \
  --namespace admiralty \
  --create-namespace \
  --version 0.15.0
```

### Cross-Cluster Trust Configuration

Admiralty uses service accounts with kubeconfig secrets for cross-cluster authentication:

```bash
# On the target cluster (GCP), create a service account for the source cluster
kubectl create serviceaccount admiralty-source \
  --namespace admiralty

kubectl create clusterrolebinding admiralty-source \
  --clusterrole=admiralty-target \
  --serviceaccount=admiralty:admiralty-source

# Extract kubeconfig for the target cluster's service account
TARGET_SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
TARGET_CA=$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
SA_TOKEN=$(kubectl create token admiralty-source -n admiralty --duration=0s)

cat > target-kubeconfig.yaml <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${TARGET_SERVER}
    certificate-authority-data: ${TARGET_CA}
  name: target
contexts:
- context:
    cluster: target
    user: admiralty-source
  name: target
current-context: target
users:
- name: admiralty-source
  user:
    token: ${SA_TOKEN}
EOF

# On the source cluster, register the target
kubectl config use-context aws-prod-east
kubectl create secret generic gcp-central-kubeconfig \
  --from-file=config=target-kubeconfig.yaml \
  --namespace admiralty
```

### Cluster Source and Target Registration

```yaml
# admiralty-source.yaml - applied to source cluster
apiVersion: multicluster.admiralty.io/v1alpha1
kind: ClusterSource
metadata:
  name: gcp-central
spec:
  serviceAccountName: admiralty-source
  kubeconfigSecret:
    name: gcp-central-kubeconfig
    key: config
---
# admiralty-target.yaml - applied on target cluster
apiVersion: multicluster.admiralty.io/v1alpha1
kind: ClusterTarget
metadata:
  name: aws-east-source
spec:
  self: true
```

### Enabling Multi-Cluster Scheduling

Annotate namespaces or pods to trigger multi-cluster scheduling:

```yaml
# namespace annotation to enable multi-cluster scheduling
apiVersion: v1
kind: Namespace
metadata:
  name: production
  annotations:
    multicluster.admiralty.io/elect: ""
---
# Pod spec with cluster affinity
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
  namespace: production
spec:
  replicas: 20
  selector:
    matchLabels:
      app: batch-processor
  template:
    metadata:
      labels:
        app: batch-processor
      annotations:
        # Allow scheduling to remote clusters
        multicluster.admiralty.io/elect: ""
    spec:
      # Admiralty injects a virtual node affinity if it schedules remotely
      containers:
      - name: processor
        image: myregistry.io/batch-processor:v1.0.0
        resources:
          requests:
            cpu: "1"
            memory: "2Gi"
```

## Section 4: Liqo Peer-to-Peer Federation

Liqo takes a different approach: two clusters negotiate a peering relationship, and each can offload pods to the other's virtual node.

### Installing Liqo

```bash
# Install liqoctl
curl -sL https://github.com/liqotech/liqo/releases/download/v0.9.0/liqoctl-linux-amd64 \
  -o liqoctl && chmod +x liqoctl && sudo mv liqotech /usr/local/bin/liqoctl

# Install Liqo on AWS cluster
liqoctl install eks \
  --cluster-name aws-east \
  --region us-east-1 \
  --eks-cluster-name prod-east \
  --set discovery.config.clusterLabels.region=us-east-1 \
  --set discovery.config.clusterLabels.provider=aws

# Install Liqo on GCP cluster
liqoctl install gke \
  --cluster-name gcp-central \
  --project-id myproject \
  --zone us-central1-a \
  --gke-cluster-name prod-central \
  --set discovery.config.clusterLabels.region=us-central1 \
  --set discovery.config.clusterLabels.provider=gcp

# Install Liqo on Azure cluster
liqoctl install aks \
  --cluster-name azure-east \
  --resource-group prod-rg \
  --aks-cluster-name prod-aks \
  --set discovery.config.clusterLabels.region=eastus \
  --set discovery.config.clusterLabels.provider=azure
```

### Establishing Peering

```bash
# Generate peering token on GCP cluster
kubectl config use-context gcp-prod-central
liqoctl generate peer-info --cluster-name gcp-central > gcp-peer-info.yaml

# Apply peering on AWS cluster
kubectl config use-context aws-prod-east
liqoctl peer --remote-info gcp-peer-info.yaml

# Verify peering status
liqoctl status peer
```

### Namespace Offloading

```bash
# Offload a namespace to all peered clusters
kubectl label namespace production liqo.io/enabled=true

# Or selectively offload with cluster selectors
liqoctl offload namespace production \
  --namespace-mapping-strategy EnforceSameName \
  --pod-offloading-strategy LocalAndRemote \
  --selector 'region in (us-central1, eastus)'
```

## Section 5: Cross-Cloud Service Discovery

One of the hardest problems in multi-cloud federation is enabling services in one cluster to discover and reach services in another without complex manual configuration.

### Submariner for Cross-Cluster Networking

```bash
# Install subctl
curl -sL https://get.submariner.io | bash
export PATH=$PATH:~/.local/bin

# Deploy broker on host cluster
subctl deploy-broker \
  --kubeconfig host-kubeconfig.yaml \
  --globalnet

# Join AWS cluster to broker
subctl join broker-info.subm \
  --kubeconfig aws-kubeconfig.yaml \
  --clusterid aws-east \
  --natt=false \
  --cable-driver libreswan

# Join GCP cluster to broker
subctl join broker-info.subm \
  --kubeconfig gcp-kubeconfig.yaml \
  --clusterid gcp-central \
  --natt=false \
  --cable-driver libreswan

# Export a service for cross-cluster discovery
kubectl --context aws-prod-east -n production \
  apply -f - <<EOF
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: api-server
  namespace: production
EOF
```

### CoreDNS Stub Zone Configuration for Cross-Cluster DNS

```yaml
# coredns-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health {
            lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
        }
        # Stub zone for cross-cluster DNS
        forward clusterset.local 10.96.100.10 {
            except cluster.local
        }
        prometheus :9153
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
    # AWS cluster services
    aws-east.svc.clusterset.local:53 {
        errors
        cache 30
        forward . 172.20.0.10 {
            prefer_udp
        }
    }
    # GCP cluster services
    gcp-central.svc.clusterset.local:53 {
        errors
        cache 30
        forward . 172.21.0.10 {
            prefer_udp
        }
    }
```

### ServiceImport for Multi-Cluster Services

```yaml
# service-import.yaml
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceImport
metadata:
  name: api-server
  namespace: production
spec:
  type: ClusterSetIP
  ports:
  - port: 8080
    protocol: TCP
```

## Section 6: Federated Horizontal Pod Autoscaler

Standard HPA operates within a single cluster. For multi-cloud environments, a federated HPA must account for aggregate load across all clusters.

### KEDA for Federated Scaling

KEDA (Kubernetes Event-Driven Autoscaling) can read metrics from external systems accessible across clouds:

```yaml
# federated-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-federated
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 50
  cooldownPeriod: 60
  triggers:
  # Scale based on global request rate from Prometheus Federation
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-federation.monitoring.svc:9090
      metricName: global_http_requests_per_second
      query: |
        sum(rate(nginx_ingress_controller_requests[2m]))
        by (cluster)
      threshold: "100"
  # Scale based on SQS queue depth (AWS workloads)
  - type: aws-sqs-queue
    authenticationRef:
      name: keda-aws-credentials
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/work-queue
      queueLength: "50"
      awsRegion: "us-east-1"
```

### Prometheus Federation for Cross-Cluster Metrics

```yaml
# prometheus-federation.yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: federation
  namespace: monitoring
spec:
  replicas: 2
  serviceAccountName: prometheus-federation
  serviceMonitorSelector: {}
  ruleSelector: {}
  retention: 7d
  externalLabels:
    cluster: federation
  # Federate from cluster-level Prometheus instances
  additionalScrapeConfigs:
    name: additional-scrape-configs
    key: prometheus-additional.yaml
---
# additional-scrape-configs secret content
- job_name: 'federate-aws-east'
  scrape_interval: 15s
  honor_labels: true
  metrics_path: /federate
  params:
    match[]:
    - '{job="kubernetes-pods"}'
    - '{__name__=~"container_.*"}'
    - 'nginx_ingress_controller_requests'
  static_configs:
  - targets:
    - prometheus.monitoring.aws-east.svc.clusterset.local:9090
  relabel_configs:
  - source_labels: [__address__]
    target_label: cluster
    replacement: aws-east

- job_name: 'federate-gcp-central'
  scrape_interval: 15s
  honor_labels: true
  metrics_path: /federate
  params:
    match[]:
    - '{job="kubernetes-pods"}'
    - 'nginx_ingress_controller_requests'
  static_configs:
  - targets:
    - prometheus.monitoring.gcp-central.svc.clusterset.local:9090
  relabel_configs:
  - source_labels: [__address__]
    target_label: cluster
    replacement: gcp-central
```

## Section 7: Global Load Balancing with Cloudflare and Route 53

### Cloudflare Load Balancing Configuration

Cloudflare Load Balancer supports health-checked origin pools with geographic steering, making it well-suited for multi-cloud Kubernetes ingress.

```bash
# Create origin pools for each cluster's ingress IP
# AWS EKS ingress: 52.1.2.3
# GCP GKE ingress: 35.4.5.6
# Azure AKS ingress: 20.7.8.9

# Using Terraform for Cloudflare LB configuration
cat > cloudflare-lb.tf <<'EOF'
resource "cloudflare_load_balancer_pool" "aws_east" {
  account_id  = var.cloudflare_account_id
  name        = "aws-us-east-1"
  description = "AWS EKS us-east-1 ingress pool"

  origins {
    name    = "aws-ingress-1"
    address = "52.1.2.3"
    enabled = true
    weight  = 1.0
  }

  health_threshold = 1
  monitor          = cloudflare_load_balancer_monitor.http_check.id
  latitude         = 37.7749
  longitude        = -77.0369
}

resource "cloudflare_load_balancer_pool" "gcp_central" {
  account_id  = var.cloudflare_account_id
  name        = "gcp-us-central1"
  description = "GCP GKE us-central1 ingress pool"

  origins {
    name    = "gcp-ingress-1"
    address = "35.4.5.6"
    enabled = true
    weight  = 1.0
  }

  health_threshold = 1
  monitor          = cloudflare_load_balancer_monitor.http_check.id
  latitude         = 41.8781
  longitude        = -87.6298
}

resource "cloudflare_load_balancer_pool" "azure_east" {
  account_id  = var.cloudflare_account_id
  name        = "azure-eastus"
  description = "Azure AKS eastus ingress pool"

  origins {
    name    = "azure-ingress-1"
    address = "20.7.8.9"
    enabled = true
    weight  = 1.0
  }

  health_threshold = 1
  monitor          = cloudflare_load_balancer_monitor.http_check.id
  latitude         = 38.9072
  longitude        = -77.0369
}

resource "cloudflare_load_balancer_monitor" "http_check" {
  account_id     = var.cloudflare_account_id
  type           = "https"
  path           = "/healthz"
  interval       = 60
  timeout        = 5
  retries        = 2
  expected_codes = "200"
  header {
    header = "Host"
    values = ["api.example.com"]
  }
}

resource "cloudflare_load_balancer" "api" {
  zone_id          = var.cloudflare_zone_id
  name             = "api.example.com"
  description      = "Multi-cloud API load balancer"
  fallback_pool_id = cloudflare_load_balancer_pool.aws_east.id
  default_pool_ids = [
    cloudflare_load_balancer_pool.aws_east.id,
    cloudflare_load_balancer_pool.gcp_central.id,
    cloudflare_load_balancer_pool.azure_east.id,
  ]
  session_affinity         = "cookie"
  session_affinity_ttl     = 300
  steering_policy          = "geo"
  proxied                  = true

  # Geographic steering rules
  rules {
    name      = "route-eu-to-azure"
    condition = "http.request.geo.continent == \"EU\""
    fixed_response {
      # Could also redirect; here we use pool override
    }
    overrides {
      default_pools = [
        cloudflare_load_balancer_pool.azure_east.id,
      ]
    }
  }

  rules {
    name      = "route-asia-to-gcp"
    condition = "http.request.geo.continent == \"AS\""
    overrides {
      default_pools = [
        cloudflare_load_balancer_pool.gcp_central.id,
      ]
    }
  }
}
EOF
```

### Route 53 Latency-Based Routing

```bash
# Terraform for Route 53 latency-based routing
cat > route53-lb.tf <<'EOF'
resource "aws_route53_record" "api_aws" {
  zone_id        = var.route53_zone_id
  name           = "api.example.com"
  type           = "A"
  set_identifier = "aws-us-east-1"

  latency_routing_policy {
    region = "us-east-1"
  }

  alias {
    name                   = aws_lb.eks_ingress.dns_name
    zone_id                = aws_lb.eks_ingress.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "api_gcp" {
  zone_id        = var.route53_zone_id
  name           = "api.example.com"
  type           = "A"
  set_identifier = "gcp-us-central1"

  latency_routing_policy {
    region = "us-central-1"
  }

  ttl     = 60
  records = ["35.4.5.6"]

  health_check_id = aws_route53_health_check.gcp_check.id
}

resource "aws_route53_record" "api_azure" {
  zone_id        = var.route53_zone_id
  name           = "api.example.com"
  type           = "A"
  set_identifier = "azure-eastus"

  latency_routing_policy {
    region = "us-east-1"
  }

  ttl     = 60
  records = ["20.7.8.9"]

  health_check_id = aws_route53_health_check.azure_check.id
}

resource "aws_route53_health_check" "gcp_check" {
  fqdn              = "gcp-ingress.example.com"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = "3"
  request_interval  = "30"
  regions           = ["us-east-1", "us-west-2", "eu-west-1"]
}

resource "aws_route53_health_check" "azure_check" {
  fqdn              = "azure-ingress.example.com"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = "3"
  request_interval  = "30"
  regions           = ["us-east-1", "us-west-2", "eu-west-1"]
}
EOF
```

## Section 8: Disaster Recovery Across Clouds

### Active-Active vs Active-Passive Strategies

**Active-active**: All clusters serve traffic simultaneously. Failover is automatic via DNS or load balancer health checks. Requires data replication and conflict resolution.

**Active-passive**: One cluster handles production traffic; others are warm standby. Simpler but higher RTO (Recovery Time Objective).

### Velero for Cross-Cloud Backup

```yaml
# velero-backup-schedule.yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-cross-cloud-backup
  namespace: velero
spec:
  schedule: "0 2 * * *"
  template:
    includedNamespaces:
    - production
    - staging
    storageLocation: s3-backup-location
    volumeSnapshotLocations:
    - aws-snapshots
    ttl: 720h
    hooks:
      resources:
      - name: freeze-databases
        includedNamespaces:
        - production
        labelSelector:
          matchLabels:
            backup-hook: "true"
        pre:
        - exec:
            container: postgresql
            command:
            - /bin/bash
            - -c
            - "psql -c 'CHECKPOINT;'"
            onError: Continue
            timeout: 30s
---
# Backup storage location pointing to cross-region S3
apiVersion: velero.io/v1
kind: BackupStorageLocation
metadata:
  name: s3-backup-location
  namespace: velero
spec:
  provider: aws
  objectStorage:
    bucket: cross-cloud-backup-store
    prefix: velero
  config:
    region: us-east-1
    s3ForcePathStyle: "false"
    s3Url: ""
    serverSideEncryption: aws:kms
    kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-placeholder-key-id"
```

### Automated Failover with External DNS

```yaml
# external-dns-annotation-for-failover.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-server
  namespace: production
  annotations:
    # External DNS will manage Route 53 records
    external-dns.alpha.kubernetes.io/hostname: api.example.com
    external-dns.alpha.kubernetes.io/ttl: "30"
    # Health check endpoint for Route 53
    external-dns.alpha.kubernetes.io/aws-health-check-path: /healthz
    # Failover routing policy
    external-dns.alpha.kubernetes.io/aws-failover: primary
    external-dns.alpha.kubernetes.io/set-identifier: aws-primary
spec:
  ingressClassName: nginx
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-server
            port:
              number: 8080
```

## Section 9: Cost Optimization Across Providers

### Spot/Preemptible Instance Arbitrage

Different cloud providers have varying spot instance availability and pricing. Karpenter (AWS) and similar tools can be configured to prefer cheaper instance types:

```yaml
# karpenter-nodepool-spot.yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: spot-workers
spec:
  template:
    metadata:
      labels:
        node-type: spot
        cost-tier: low
    spec:
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot"]
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]
      - key: node.kubernetes.io/instance-type
        operator: In
        values:
        - m5.2xlarge
        - m5a.2xlarge
        - m5d.2xlarge
        - m4.2xlarge
        - r5.xlarge
        - r5a.xlarge
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: default
  limits:
    cpu: 1000
    memory: 2000Gi
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    budgets:
    - nodes: "10%"
```

### Kubecost for Multi-Cluster Cost Allocation

```yaml
# kubecost-values.yaml for Helm installation
global:
  grafana:
    enabled: true
  prometheus:
    enabled: true

kubecostModel:
  allocation:
    enabled: true
  # Connect to federated Prometheus
  prometheusEndpoint: "http://prometheus-federation.monitoring.svc:9090"

kubecostFrontend:
  enabled: true

serviceMonitor:
  enabled: true

# Multi-cluster configuration
multiCluster:
  enabled: true
  clusters:
  - id: aws-us-east-1
    name: AWS US East 1
    address: https://kubecost.aws-east.internal
  - id: gcp-us-central1
    name: GCP US Central 1
    address: https://kubecost.gcp-central.internal
  - id: azure-eastus
    name: Azure East US
    address: https://kubecost.azure-east.internal
```

## Section 10: Observability and Troubleshooting

### Cross-Cluster Distributed Tracing

```yaml
# jaeger-alloy-collector.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger-collector
  namespace: tracing
spec:
  replicas: 3
  selector:
    matchLabels:
      app: jaeger-collector
  template:
    metadata:
      labels:
        app: jaeger-collector
    spec:
      containers:
      - name: jaeger-collector
        image: jaegertracing/jaeger-collector:1.50.0
        args:
        - "--span-storage.type=elasticsearch"
        - "--es.server-urls=http://elasticsearch:9200"
        - "--collector.otlp.enabled=true"
        - "--collector.grpc.tls.enabled=false"
        env:
        - name: SPAN_STORAGE_TYPE
          value: elasticsearch
        ports:
        - containerPort: 14250
          name: grpc
        - containerPort: 14268
          name: http
        - containerPort: 4317
          name: otlp-grpc
        - containerPort: 4318
          name: otlp-http
```

### Health Check Aggregator

```bash
#!/bin/bash
# federation-health-check.sh
# Check health of all federated clusters

CLUSTERS=(
  "aws-prod-east:arn:aws:eks:us-east-1:123456789012:cluster/prod-east"
  "gcp-prod-central:gke_myproject_us-central1_prod-central"
  "azure-prod-east:my-aks-cluster"
)

declare -A CLUSTER_STATUS

for entry in "${CLUSTERS[@]}"; do
  name="${entry%%:*}"
  context="${entry##*:}"

  # Check API server health
  if kubectl --context="${context}" get nodes --no-headers 2>/dev/null | grep -q "Ready"; then
    CLUSTER_STATUS["${name}"]="healthy"
  else
    CLUSTER_STATUS["${name}"]="unhealthy"
    echo "ALERT: Cluster ${name} is not healthy"
  fi

  # Check critical workloads
  NOT_READY=$(kubectl --context="${context}" -n production \
    get pods --no-headers 2>/dev/null | \
    grep -v "Running\|Completed" | wc -l)

  if [[ "${NOT_READY}" -gt 5 ]]; then
    echo "WARN: Cluster ${name} has ${NOT_READY} non-ready pods in production"
  fi
done

# Print summary
echo ""
echo "Federation Health Summary:"
for cluster in "${!CLUSTER_STATUS[@]}"; do
  echo "  ${cluster}: ${CLUSTER_STATUS[${cluster}]}"
done
```

## Section 11: Security Considerations for Multi-Cloud Federation

### Network Policy Enforcement Across Clusters

Each cluster must enforce its own network policies, but policies should reflect the broader federated topology:

```yaml
# federated-network-policy.yaml
# Applied to each cluster individually
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-federation-ingress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-server
  policyTypes:
  - Ingress
  ingress:
  # Allow traffic from within the cluster
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: production
    ports:
    - protocol: TCP
      port: 8080
  # Allow traffic from federation gateway IPs
  - from:
    - ipBlock:
        cidr: 10.0.0.0/8
        except:
        - 10.255.0.0/16
    ports:
    - protocol: TCP
      port: 8080
```

### RBAC for Federation Control Plane

```yaml
# kubefed-admin-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubefed-admin
rules:
- apiGroups: ["types.kubefed.io"]
  resources: ["*"]
  verbs: ["*"]
- apiGroups: ["core.kubefed.io"]
  resources: ["kubefedclusters", "kubefedconfigs"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: ["scheduling.kubefed.io"]
  resources: ["replicaschedulingpreferences"]
  verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubefed-admin-binding
subjects:
- kind: ServiceAccount
  name: federation-controller
  namespace: kube-federation-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubefed-admin
```

## Section 12: Operational Runbooks

### Adding a New Cluster to Federation

```bash
#!/bin/bash
# add-cluster-to-federation.sh
# Usage: ./add-cluster-to-federation.sh <cluster-name> <kubeconfig-path> <provider>

CLUSTER_NAME="$1"
KUBECONFIG_PATH="$2"
PROVIDER="$3"

if [[ -z "${CLUSTER_NAME}" || -z "${KUBECONFIG_PATH}" || -z "${PROVIDER}" ]]; then
  echo "Usage: $0 <cluster-name> <kubeconfig-path> <provider>"
  exit 1
fi

echo "Step 1: Joining cluster to KubeFed..."
kubefedctl join "${CLUSTER_NAME}" \
  --cluster-context "$(kubectl --kubeconfig="${KUBECONFIG_PATH}" config current-context)" \
  --host-cluster-context host-cluster \
  --v=2

echo "Step 2: Labeling cluster with provider metadata..."
kubectl -n kube-federation-system \
  label kubefedcluster "${CLUSTER_NAME}" \
  provider="${PROVIDER}" \
  managed=true

echo "Step 3: Deploying monitoring stack to new cluster..."
helm --kubeconfig="${KUBECONFIG_PATH}" upgrade --install \
  kube-prometheus-stack kube-prometheus-stack \
  --repo https://prometheus-community.github.io/helm-charts \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.externalLabels.cluster="${CLUSTER_NAME}" \
  --set prometheus.prometheusSpec.externalLabels.provider="${PROVIDER}"

echo "Step 4: Adding cluster to Kubecost federation..."
# Update kubecost values and upgrade

echo "Step 5: Updating DNS health checks..."
# Trigger Terraform apply for new health check endpoints

echo "Cluster ${CLUSTER_NAME} successfully joined federation."
```

### Cluster Evacuation Procedure

```bash
#!/bin/bash
# evacuate-cluster.sh
# Gracefully drain workloads from a cluster before maintenance or removal

CLUSTER_CONTEXT="$1"
NAMESPACE="${2:-production}"

echo "Starting evacuation of cluster: ${CLUSTER_CONTEXT}"
echo "Namespace: ${NAMESPACE}"

# Step 1: Update ReplicaSchedulingPreference to 0 replicas for this cluster
kubectl patch replicaschedulingpreference api-server \
  -n "${NAMESPACE}" \
  --type merge \
  -p "{\"spec\":{\"clusters\":{\"${CLUSTER_CONTEXT}\":{\"maxReplicas\":0}}}}"

# Step 2: Wait for pods to terminate
echo "Waiting for pods to evacuate..."
timeout 300 bash -c "
  while kubectl --context=${CLUSTER_CONTEXT} -n ${NAMESPACE} \
    get pods --no-headers 2>/dev/null | grep -v Terminating | grep -q Running; do
    echo 'Waiting for pods to evacuate...'
    sleep 10
  done
"

# Step 3: Remove cluster from load balancer pools
echo "Removing cluster from Cloudflare load balancer pool..."
# Trigger Terraform apply with cluster removed from pool

# Step 4: Update DNS health check to mark as secondary
echo "Evacuation complete for cluster: ${CLUSTER_CONTEXT}"
```

## Conclusion

Multi-cloud Kubernetes federation requires careful consideration of the operational model, networking architecture, and automation framework. KubeFed v2 provides the most mature API surface for declarative multi-cluster management, while Admiralty offers transparent pod scheduling for burst scenarios. Liqo introduces a modern peer-to-peer model that reduces centralized control-plane dependencies.

Regardless of the federation tool selected, the supporting infrastructure—cross-cluster networking via Submariner, global load balancing with Cloudflare or Route 53, federated metrics via Prometheus federation, and automated failover—determines whether the federation operates reliably under production conditions. The investment in these patterns yields measurable resilience: provider-level outages become absorbed by the federation rather than causing customer-visible incidents.
