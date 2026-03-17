---
title: "Kubernetes Cluster Federation with KubeFed: Cross-Cluster Resource Propagation"
date: 2031-03-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KubeFed", "Federation", "Multi-Cluster", "ExternalDNS", "Ingress"]
categories:
- Kubernetes
- Multi-Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Kubernetes cluster federation with KubeFed: type configuration, FederatedDeployment and FederatedService resources, placement policies, replica scheduling across clusters, federated ingress, and global DNS with ExternalDNS."
more_link: "yes"
url: "/kubernetes-cluster-federation-kubefed-cross-cluster-resources/"
---

Managing workloads across multiple Kubernetes clusters presents a fundamental coordination problem: how do you deploy and update applications consistently across dozens of clusters without building brittle custom tooling? Kubernetes Federation (KubeFed) provides a control plane abstraction that treats multiple clusters as a single logical deployment target, enabling unified resource management while preserving per-cluster customization. This guide covers KubeFed's architecture, configuration model, and production patterns for cross-cluster deployment, traffic management, and global DNS.

<!--more-->

# Kubernetes Cluster Federation with KubeFed: Cross-Cluster Resource Propagation

## Section 1: Federation Architecture and Use Cases

### When Federation Applies

Kubernetes cluster federation is appropriate when:
- Applications must run in multiple geographic regions for latency or data sovereignty reasons
- Business continuity requires active-active deployments across multiple clusters
- Organizational structure maps to separate clusters (different teams, business units, security boundaries)
- Hybrid cloud deployments span on-premises and cloud providers

Federation is not appropriate when:
- A single cluster is sufficient (avoid premature complexity)
- GitOps tools (ArgoCD, Flux) already manage consistent deployments across clusters
- Workloads are fundamentally single-cluster (batch jobs, stateful applications with complex replication)

### KubeFed Architecture

KubeFed runs a federation control plane as a set of CRDs and controllers in a designated "host" cluster. Member clusters are registered with the host and receive federated resources.

```
Host Cluster (Federation Control Plane)
├── KubeFed Controllers (running as Pods)
├── FederatedType CRDs (FederatedDeployment, FederatedService, etc.)
├── KubeFedCluster CRDs (registrations for member clusters)
└── Federation Namespace

Member Cluster 1 (us-east-1)     Member Cluster 2 (eu-west-1)
├── Received Deployments          ├── Received Deployments
├── Received Services             ├── Received Services
└── Local controller              └── Local controller
    running as Pods                   running as Pods
```

The host cluster can also be a member cluster, but for production deployments, separating the control plane from workload clusters is recommended.

## Section 2: KubeFed Installation

### Installing KubeFed

```bash
# Create the federation namespace
kubectl create namespace kube-federation-system

# Install KubeFed using Helm
helm repo add kubefed-charts https://raw.githubusercontent.com/kubernetes-sigs/kubefed/master/charts
helm repo update

helm install kubefed kubefed-charts/kubefed \
  --namespace kube-federation-system \
  --create-namespace \
  --set controllermanager.replicaCount=2 \
  --wait

# Verify installation
kubectl -n kube-federation-system get pods
# NAME                                READY   STATUS    RESTARTS   AGE
# kubefed-controller-manager-xxxxx    1/1     Running   0          2m
# kubefed-controller-manager-yyyyy    1/1     Running   0          2m

# Install kubefedctl
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m | sed 's/x86_64/amd64/')
curl -LO "https://github.com/kubernetes-sigs/kubefed/releases/latest/download/kubefedctl-${OS}-${ARCH}"
chmod +x kubefedctl-${OS}-${ARCH}
sudo mv kubefedctl-${OS}-${ARCH} /usr/local/bin/kubefedctl
```

### Registering Member Clusters

```bash
# Register the first member cluster (us-east-1)
# Assumes kubectl context for the host cluster is current
kubefedctl join us-east-1 \
  --cluster-context=arn:aws:eks:us-east-1:123456789:cluster/prod-us-east-1 \
  --host-cluster-context=arn:aws:eks:us-east-1:123456789:cluster/federation-host \
  --federation-namespace=kube-federation-system \
  --kubefed-namespace=kube-federation-system

# Register the second member cluster (eu-west-1)
kubefedctl join eu-west-1 \
  --cluster-context=arn:aws:eks:eu-west-1:123456789:cluster/prod-eu-west-1 \
  --host-cluster-context=arn:aws:eks:us-east-1:123456789:cluster/federation-host \
  --federation-namespace=kube-federation-system \
  --kubefed-namespace=kube-federation-system

# Register ap-southeast-1
kubefedctl join ap-southeast-1 \
  --cluster-context=arn:aws:eks:ap-southeast-1:123456789:cluster/prod-ap-southeast-1 \
  --host-cluster-context=arn:aws:eks:us-east-1:123456789:cluster/federation-host \
  --federation-namespace=kube-federation-system

# Verify cluster registrations
kubectl -n kube-federation-system get kubefedclusters
# NAME               AGE   READY
# us-east-1          5m    True
# eu-west-1          3m    True
# ap-southeast-1     1m    True
```

### Cluster Labels for Targeting

```yaml
# Add labels to cluster registrations for policy-based placement
apiVersion: core.kubefed.io/v1beta1
kind: KubeFedCluster
metadata:
  name: us-east-1
  namespace: kube-federation-system
  labels:
    region: us-east
    cloud: aws
    tier: production
    datacenter: iad
spec:
  apiEndpoint: https://api.us-east-1.k8s.example.com
  caBundle: <base64-encoded-tls-certificate>
  secretRef:
    name: us-east-1-credentials
---
apiVersion: core.kubefed.io/v1beta1
kind: KubeFedCluster
metadata:
  name: eu-west-1
  namespace: kube-federation-system
  labels:
    region: eu-west
    cloud: aws
    tier: production
    datacenter: dub
    gdpr: "true"  # GDPR compliance label
spec:
  apiEndpoint: https://api.eu-west-1.k8s.example.com
  caBundle: <base64-encoded-tls-certificate>
  secretRef:
    name: eu-west-1-credentials
```

## Section 3: KubeFed Type Configuration

KubeFed uses a TypeConfig mechanism to define which Kubernetes resource types are federation-aware. This controls how resources are propagated, which fields are overridable, and how status is aggregated.

### Enabling Federation for Standard Resources

```bash
# Enable federation for Deployments
kubefedctl enable Deployment --federation-namespace=kube-federation-system

# Enable for Services
kubefedctl enable Service --federation-namespace=kube-federation-system

# Enable for ConfigMaps
kubefedctl enable ConfigMap --federation-namespace=kube-federation-system

# Enable for Ingress
kubefedctl enable Ingress --federation-namespace=kube-federation-system

# List all enabled types
kubectl get federatedtypeconfigs -n kube-federation-system
```

### Custom TypeConfig

```yaml
# Custom FederatedTypeConfig for a CRD
apiVersion: core.kubefed.io/v1beta1
kind: FederatedTypeConfig
metadata:
  name: prometheusrules.monitoring.coreos.com
  namespace: kube-federation-system
spec:
  federatedType:
    group: types.kubefed.io
    kind: FederatedPrometheusRule
    pluralName: federatedprometheusrules
    scope: Namespaced
    version: v1beta1
  propagation: Enabled
  statusCollection: Enabled
  targetType:
    group: monitoring.coreos.com
    kind: PrometheusRule
    pluralName: prometheusrules
    scope: Namespaced
    version: v1
```

```bash
# Generate the federated CRD from an existing CRD
kubefedctl federate PrometheusRule \
  --namespace kube-federation-system \
  --enable-type
```

## Section 4: FederatedDeployment Resources

### Basic FederatedDeployment

```yaml
# federated-deployment.yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedDeployment
metadata:
  name: web-frontend
  namespace: production
spec:
  # The base template - applies to all clusters
  template:
    metadata:
      labels:
        app: web-frontend
        version: "2.1.0"
    spec:
      replicas: 3
      selector:
        matchLabels:
          app: web-frontend
      template:
        metadata:
          labels:
            app: web-frontend
        spec:
          containers:
          - name: web
            image: myregistry/web-frontend:2.1.0
            ports:
            - containerPort: 8080
            resources:
              requests:
                cpu: 500m
                memory: 512Mi
              limits:
                cpu: 2000m
                memory: 1Gi
            env:
            - name: ENVIRONMENT
              value: production
            livenessProbe:
              httpGet:
                path: /health
                port: 8080
              initialDelaySeconds: 30
              periodSeconds: 10
            readinessProbe:
              httpGet:
                path: /ready
                port: 8080
              initialDelaySeconds: 5
              periodSeconds: 5

  # Placement: which clusters receive this resource
  placement:
    clusters:
    - name: us-east-1
    - name: eu-west-1
    - name: ap-southeast-1

  # Overrides: cluster-specific modifications
  overrides:
  - clusterName: us-east-1
    clusterOverrides:
    - path: "/spec/replicas"
      value: 5  # More replicas in the primary region
    - path: "/spec/template/spec/containers/0/env/0/value"
      value: "production-us"
  - clusterName: eu-west-1
    clusterOverrides:
    - path: "/spec/replicas"
      value: 3
    - path: "/spec/template/spec/containers/0/env/0/value"
      value: "production-eu"
    - path: "/spec/template/spec/containers/0/image"
      value: "eu-registry.company.com/web-frontend:2.1.0"  # EU registry for GDPR
  - clusterName: ap-southeast-1
    clusterOverrides:
    - path: "/spec/replicas"
      value: 2  # Smaller region, fewer replicas
    - path: "/spec/template/spec/containers/0/env/0/value"
      value: "production-ap"
```

```bash
kubectl apply -f federated-deployment.yaml

# Check status across all clusters
kubectl get federateddeployment web-frontend -n production -o yaml
# Status shows per-cluster conditions

# Check deployment in each cluster
for cluster in us-east-1 eu-west-1 ap-southeast-1; do
    echo "=== $cluster ==="
    kubectl --context=$cluster -n production get deployment web-frontend
done
```

### FederatedDeployment with ReplicaSchedulingPreference

For automated replica distribution based on cluster weights or capacity:

```yaml
apiVersion: scheduling.kubefed.io/v1alpha1
kind: ReplicaSchedulingPreference
metadata:
  name: web-frontend
  namespace: production
spec:
  targetKind: FederatedDeployment
  totalReplicas: 10
  rebalance: true
  clusters:
    us-east-1:
      weight: 5       # 50% of replicas
      minReplicas: 2  # At least 2, even if weight says fewer
      maxReplicas: 8
    eu-west-1:
      weight: 3       # 30% of replicas
      minReplicas: 2
      maxReplicas: 5
    ap-southeast-1:
      weight: 2       # 20% of replicas
      minReplicas: 1
      maxReplicas: 3
```

The RSP controller automatically adjusts replica counts in each cluster based on the weights and total count, while respecting per-cluster min/max constraints.

## Section 5: FederatedService Resources

### Basic FederatedService

```yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedService
metadata:
  name: web-frontend
  namespace: production
spec:
  template:
    spec:
      selector:
        app: web-frontend
      ports:
      - port: 80
        targetPort: 8080
        protocol: TCP
        name: http
      type: ClusterIP
  placement:
    clusters:
    - name: us-east-1
    - name: eu-west-1
    - name: ap-southeast-1
```

### Service Type Overrides

Different clusters may need different service types. For example, the primary region uses LoadBalancer while secondary regions use NodePort:

```yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedService
metadata:
  name: web-frontend-external
  namespace: production
spec:
  template:
    spec:
      selector:
        app: web-frontend
      ports:
      - port: 80
        targetPort: 8080
      type: LoadBalancer
  placement:
    clusters:
    - name: us-east-1
    - name: eu-west-1
    - name: ap-southeast-1
  overrides:
  - clusterName: us-east-1
    clusterOverrides:
    - path: "/spec/type"
      value: LoadBalancer
    - path: "/metadata/annotations"
      op: add
      value:
        service.beta.kubernetes.io/aws-load-balancer-type: nlb
        external-dns.alpha.kubernetes.io/hostname: web.us.example.com
  - clusterName: eu-west-1
    clusterOverrides:
    - path: "/spec/type"
      value: LoadBalancer
    - path: "/metadata/annotations"
      op: add
      value:
        service.beta.kubernetes.io/aws-load-balancer-type: nlb
        external-dns.alpha.kubernetes.io/hostname: web.eu.example.com
  - clusterName: ap-southeast-1
    clusterOverrides:
    - path: "/spec/type"
      value: NodePort
```

## Section 6: Placement Policies and Overrides

### Label Selector-Based Placement

```yaml
# Deploy only to GDPR-compliant clusters (EU clusters)
apiVersion: types.kubefed.io/v1beta1
kind: FederatedDeployment
metadata:
  name: eu-only-service
  namespace: production
spec:
  template:
    spec:
      replicas: 2
      # ... container spec
  placement:
    clusterSelector:
      matchLabels:
        gdpr: "true"
```

### Policy-Based Placement with PropagationPolicy

```yaml
# PropagationPolicy controls how resources are spread
apiVersion: policy.karmada.io/v1alpha1  # Note: KubeFed uses different API
kind: PropagationPolicy
metadata:
  name: web-frontend-policy
  namespace: production
spec:
  resourceSelectors:
  - apiVersion: apps/v1
    kind: Deployment
    name: web-frontend

  placement:
    # Cluster affinity (must be scheduled to clusters matching these labels)
    clusterAffinity:
      matchExpressions:
      - key: tier
        operator: In
        values: [production]
      - key: region
        operator: NotIn
        values: [ap-east-1]  # Exclude certain regions

    # Cluster tolerations (allow scheduling to tainted clusters)
    clusterTolerations:
    - key: "maintenance"
      operator: "Exists"
      effect: "NoSchedule"

    # Spread constraints (ensure distribution)
    spreadConstraints:
    - spreadByField: region
      maxClusters: 3
      minClusters: 2
      spreadByFieldValue: ""

    # Replica scheduling
    replicaScheduling:
      replicaSchedulingType: Divided
      replicaDivisionPreference: Weighted
      weightPreference:
        staticClusterWeight:
        - targetCluster:
            matchLabels:
              region: us-east
          weight: 5
        - targetCluster:
            matchLabels:
              region: eu-west
          weight: 3
        - targetCluster:
            matchLabels:
              region: ap-southeast
          weight: 2
```

### Override Policies

```yaml
apiVersion: policy.kubefed.io/v1alpha1
kind: OverridePolicy
metadata:
  name: regional-overrides
  namespace: production
spec:
  resourceSelectors:
  - apiVersion: apps/v1
    kind: Deployment

  overrideRules:
  # EU-specific overrides for GDPR compliance
  - targetCluster:
      matchLabels:
        gdpr: "true"
    overriders:
      plaintext:
      - path: "/spec/template/spec/containers/0/env"
        operator: add
        value:
        - name: DATA_RESIDENCY
          value: EU
      - path: "/metadata/annotations/data.governance"
        operator: add
        value: "eu-data-residency"

  # Production environment override
  - targetCluster:
      matchLabels:
        tier: production
    overriders:
      plaintext:
      - path: "/spec/replicas"
        operator: replace
        value: 5
      - path: "/spec/template/spec/containers/0/resources/requests/cpu"
        operator: replace
        value: "1000m"
```

## Section 7: Federated Ingress

### FederatedIngress for Multi-Cluster HTTP Routing

```yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedIngress
metadata:
  name: web-frontend-ingress
  namespace: production
spec:
  template:
    metadata:
      annotations:
        nginx.ingress.kubernetes.io/proxy-body-size: "50m"
        nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    spec:
      ingressClassName: nginx
      rules:
      - host: web.global.example.com
        http:
          paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-frontend
                port:
                  number: 80
      tls:
      - hosts:
        - web.global.example.com
        secretName: web-tls-cert
  placement:
    clusters:
    - name: us-east-1
    - name: eu-west-1
    - name: ap-southeast-1
  overrides:
  # Each cluster uses region-specific hostname in addition to global hostname
  - clusterName: us-east-1
    clusterOverrides:
    - path: "/spec/rules/0/host"
      value: "web.us.example.com"
    - path: "/spec/tls/0/hosts/0"
      value: "web.us.example.com"
    - path: "/spec/tls/0/secretName"
      value: "web-tls-us"
  - clusterName: eu-west-1
    clusterOverrides:
    - path: "/spec/rules/0/host"
      value: "web.eu.example.com"
    - path: "/spec/tls/0/hosts/0"
      value: "web.eu.example.com"
    - path: "/spec/tls/0/secretName"
      value: "web-tls-eu"
```

### FederatedSecret for TLS Certificates

```yaml
# Propagate TLS secrets to all clusters
apiVersion: types.kubefed.io/v1beta1
kind: FederatedSecret
metadata:
  name: web-tls-cert
  namespace: production
spec:
  template:
    type: kubernetes.io/tls
    data:
      tls.crt: <base64-encoded-tls-certificate>
      tls.key: <base64-encoded-placeholder>  # Never commit real keys; use ExternalSecrets
  placement:
    clusters:
    - name: us-east-1
    - name: eu-west-1
    - name: ap-southeast-1
```

For production, use ExternalSecrets to pull certificates from Vault or AWS Secrets Manager in each cluster rather than propagating secrets through the federation control plane.

## Section 8: Global DNS with ExternalDNS

ExternalDNS integrates with Kubernetes Services and Ingresses to automatically create DNS records in Route53, Google Cloud DNS, or other providers. Combined with federation, it enables global traffic management.

### Architecture: GeoDNS with ExternalDNS

```
DNS Layer (Route53 Geolocation Routing):
├── web.example.com → us-east-1 LoadBalancer IP (US users)
├── web.example.com → eu-west-1 LoadBalancer IP (EU users)
└── web.example.com → ap-southeast-1 LoadBalancer IP (APAC users)

Each ExternalDNS instance runs in each member cluster:
├── us-east-1 ExternalDNS → Creates web.example.com A record (US routing policy)
├── eu-west-1 ExternalDNS → Creates web.example.com A record (EU routing policy)
└── ap-southeast-1 ExternalDNS → Creates web.example.com A record (APAC routing policy)
```

### ExternalDNS Deployment per Cluster

```yaml
# Deploy ExternalDNS in each member cluster via FederatedDeployment
apiVersion: types.kubefed.io/v1beta1
kind: FederatedDeployment
metadata:
  name: external-dns
  namespace: kube-system
spec:
  template:
    spec:
      serviceAccountName: external-dns
      containers:
      - name: external-dns
        image: registry.k8s.io/external-dns/external-dns:v0.14.0
        args:
        - --source=service
        - --source=ingress
        - --provider=aws
        - --aws-zone-type=public
        - --registry=txt
        - --txt-owner-id=cluster-placeholder  # Will be overridden per cluster
  placement:
    clusters:
    - name: us-east-1
    - name: eu-west-1
    - name: ap-southeast-1
  overrides:
  - clusterName: us-east-1
    clusterOverrides:
    - path: "/spec/template/spec/containers/0/args"
      value:
      - --source=service
      - --source=ingress
      - --provider=aws
      - --aws-zone-type=public
      - --registry=txt
      - --txt-owner-id=us-east-1
      - --annotation-filter=external-dns.alpha.kubernetes.io/region=us-east-1
  - clusterName: eu-west-1
    clusterOverrides:
    - path: "/spec/template/spec/containers/0/args"
      value:
      - --source=service
      - --source=ingress
      - --provider=aws
      - --aws-zone-type=public
      - --registry=txt
      - --txt-owner-id=eu-west-1
      - --annotation-filter=external-dns.alpha.kubernetes.io/region=eu-west-1
```

### Route53 Geolocation Routing Configuration

```yaml
# FederatedService with geolocation DNS annotations
apiVersion: types.kubefed.io/v1beta1
kind: FederatedService
metadata:
  name: web-frontend-lb
  namespace: production
spec:
  template:
    metadata:
      annotations:
        external-dns.alpha.kubernetes.io/hostname: "web.example.com"
        external-dns.alpha.kubernetes.io/ttl: "30"
    spec:
      type: LoadBalancer
      selector:
        app: web-frontend
      ports:
      - port: 443
        targetPort: 8443
  placement:
    clusters:
    - name: us-east-1
    - name: eu-west-1
    - name: ap-southeast-1
  overrides:
  - clusterName: us-east-1
    clusterOverrides:
    - path: "/metadata/annotations"
      op: merge
      value:
        external-dns.alpha.kubernetes.io/hostname: "web.example.com"
        external-dns.alpha.kubernetes.io/aws-geolocation-country-code: "US"
        external-dns.alpha.kubernetes.io/region: "us-east-1"
        external-dns.alpha.kubernetes.io/set-identifier: "us-east-1"
  - clusterName: eu-west-1
    clusterOverrides:
    - path: "/metadata/annotations"
      op: merge
      value:
        external-dns.alpha.kubernetes.io/hostname: "web.example.com"
        external-dns.alpha.kubernetes.io/aws-geolocation-continent-code: "EU"
        external-dns.alpha.kubernetes.io/region: "eu-west-1"
        external-dns.alpha.kubernetes.io/set-identifier: "eu-west-1"
  - clusterName: ap-southeast-1
    clusterOverrides:
    - path: "/metadata/annotations"
      op: merge
      value:
        external-dns.alpha.kubernetes.io/hostname: "web.example.com"
        external-dns.alpha.kubernetes.io/aws-geolocation-continent-code: "AS"
        external-dns.alpha.kubernetes.io/region: "ap-southeast-1"
        external-dns.alpha.kubernetes.io/set-identifier: "ap-southeast-1"
```

### Health-Based DNS Failover

```yaml
# Route53 Health Checks integrated with ExternalDNS
apiVersion: v1
kind: ConfigMap
metadata:
  name: external-dns-config
  namespace: kube-system
data:
  external-dns.yaml: |
    # ExternalDNS with Route53 health check creation
    provider: aws
    aws-zone-type: public
    registry: txt
    policy: sync
    interval: 30s
    # Create health checks automatically for LoadBalancer services
    aws-health-check:
      create: true
      path: /health
      port: 443
      protocol: HTTPS
      threshold: 3
      interval: 30
```

## Section 9: Federated ConfigMaps and Namespaces

### FederatedNamespace

Namespaces must exist in each member cluster before federated resources can be created there:

```yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedNamespace
metadata:
  name: production
  namespace: kube-federation-system
spec:
  placement:
    clusters:
    - name: us-east-1
    - name: eu-west-1
    - name: ap-southeast-1
  template:
    metadata:
      labels:
        environment: production
        cost-center: engineering
```

### FederatedConfigMap for Global Configuration

```yaml
apiVersion: types.kubefed.io/v1beta1
kind: FederatedConfigMap
metadata:
  name: app-config
  namespace: production
spec:
  template:
    data:
      LOG_LEVEL: "info"
      METRICS_ENABLED: "true"
      FEATURE_FLAG_X: "true"
      # Global defaults - overridden per cluster below
      REGION: "global"
      DB_POOL_SIZE: "10"
  placement:
    clusters:
    - name: us-east-1
    - name: eu-west-1
    - name: ap-southeast-1
  overrides:
  - clusterName: us-east-1
    clusterOverrides:
    - path: "/data/REGION"
      value: "us-east-1"
    - path: "/data/DB_HOST"
      value: "postgres.us-east-1.internal"
    - path: "/data/DB_POOL_SIZE"
      value: "20"  # Primary region gets larger pool
  - clusterName: eu-west-1
    clusterOverrides:
    - path: "/data/REGION"
      value: "eu-west-1"
    - path: "/data/DB_HOST"
      value: "postgres.eu-west-1.internal"
    - path: "/data/GDPR_MODE"
      value: "true"
  - clusterName: ap-southeast-1
    clusterOverrides:
    - path: "/data/REGION"
      value: "ap-southeast-1"
    - path: "/data/DB_HOST"
      value: "postgres.ap-southeast-1.internal"
```

## Section 10: Monitoring and Troubleshooting Federation

### Status Aggregation

```bash
# Check propagation status for all clusters
kubectl get federateddeployment web-frontend -n production -o json | \
  jq '.status.clusters[] | {cluster: .name, status: .conditions[-1].type}'

# Expected output when healthy:
# {"cluster": "us-east-1", "status": "Propagated"}
# {"cluster": "eu-west-1", "status": "Propagated"}
# {"cluster": "ap-southeast-1", "status": "Propagated"}

# Check for propagation failures
kubectl get federateddeployment -n production -o json | \
  jq '.items[] | select(.status.clusters[].conditions[].status != "True") |
  {name: .metadata.name, failures: .status.clusters[]}'
```

### KubeFed Controller Metrics

```bash
# Port-forward to KubeFed controller metrics
kubectl -n kube-federation-system port-forward \
  deployment/kubefed-controller-manager 10358:10358

# Query metrics
curl http://localhost:10358/metrics | grep -E "kubefed_"

# Key metrics:
# kubefed_controller_reconcile_attempts_total
# kubefed_controller_reconcile_errors_total
# kubefed_controller_reconcile_duration_seconds
# kubefed_cluster_health
```

### Debugging Propagation Issues

```bash
# Check KubeFed controller logs
kubectl -n kube-federation-system logs \
  deployment/kubefed-controller-manager \
  --since=10m | grep -E "ERROR|WARN|propagat"

# Check if member cluster is reachable
kubefedctl check-unjoin us-east-1 \
  --federation-namespace=kube-federation-system

# Force reconciliation of a specific resource
kubectl annotate federateddeployment web-frontend \
  -n production \
  federation.kubernetes.io/reconcile=force \
  --overwrite

# Check member cluster credentials
kubectl -n kube-federation-system get secret us-east-1

# Test connectivity from host to member
kubectl -n kube-federation-system exec \
  deployment/kubefed-controller-manager -- \
  kubectl --kubeconfig /tmp/member-kubeconfig get nodes
```

### Cluster Health Monitoring

```yaml
# Prometheus alerting rules for federation health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubefed-alerts
  namespace: monitoring
spec:
  groups:
  - name: kubefed
    rules:
    - alert: KubeFedClusterUnhealthy
      expr: kubefed_cluster_health == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "KubeFed cluster {{ $labels.cluster_name }} is unhealthy"
        description: "The KubeFed cluster {{ $labels.cluster_name }} has been unreachable for more than 5 minutes"

    - alert: KubeFedPropagationErrors
      expr: rate(kubefed_controller_reconcile_errors_total[5m]) > 0.1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "KubeFed propagation errors detected"
        description: "KubeFed controller is experiencing propagation errors: {{ $value }} errors/s"
```

## Section 11: Karmada as an Alternative

While this guide focuses on KubeFed (the Kubernetes SIG project), Karmada is increasingly the preferred choice for new deployments. It offers a more complete feature set and active development. The concepts are transferable:

```yaml
# Karmada equivalent of FederatedDeployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
  namespace: production
---
# Karmada PropagationPolicy (separate from the resource itself)
apiVersion: policy.karmada.io/v1alpha1
kind: PropagationPolicy
metadata:
  name: web-frontend
  namespace: production
spec:
  resourceSelectors:
  - apiVersion: apps/v1
    kind: Deployment
    name: web-frontend
  placement:
    clusterAffinity:
      matchLabels:
        tier: production
    spreadConstraints:
    - spreadByField: cluster
      maxClusters: 3
      minClusters: 2
    replicaScheduling:
      replicaSchedulingType: Divided
      replicaDivisionPreference: Weighted
      weightPreference:
        staticClusterWeight:
        - targetCluster:
            matchLabels:
              region: us-east
          weight: 5
        - targetCluster:
            matchLabels:
              region: eu-west
          weight: 3
```

The key advantage of Karmada's model: the base resource (the Deployment) is a standard Kubernetes object, not a wrapped FederatedDeployment. Tooling that works with regular Kubernetes resources (Helm, kustomize) works without modification.

## Summary

KubeFed provides a powerful control plane for managing Kubernetes resources across multiple clusters. The key architectural decisions for production deployments:

- Separate the federation host cluster from workload clusters to avoid a single point of failure in the control plane
- Use ClusterSelector-based placement for policy-driven targeting rather than hardcoded cluster name lists, which reduces the overhead of updating policies when clusters are added or removed
- ReplicaSchedulingPreference enables dynamic replica distribution that can respond to cluster failures by automatically increasing replicas in remaining healthy clusters
- FederatedIngress combined with ExternalDNS provides the cleanest path to global traffic management with geo-routing and automatic DNS failover
- For new deployments, evaluate Karmada as an alternative to KubeFed - its native resource model (PropagationPolicy separate from resources) provides better compatibility with existing Kubernetes tooling
- Monitor federation health actively; silent propagation failures where resources appear to exist but are actually stale are the most dangerous operational failure mode
